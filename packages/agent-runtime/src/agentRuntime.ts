import type { AgentRuntimeAdapter } from "./agentRuntimeAdapter.js";
import type {
  AgentLoginAttempt,
  AgentProviderStatus,
  AgentProviderTurnObservation,
  AgentRunInput,
  AgentRunMetrics,
  AgentRuntimeEvent,
  AgentTokenUsage
} from "./contracts.js";

interface ActiveRun {
  sessionId: string;
  abort: AbortController;
  settled: Promise<void>;
}

export interface AgentRuntimeOptions {
  maxRunMs?: number;
  maxToolCalls?: number;
}

const DEFAULT_MAX_RUN_MS = 600_000;
const DEFAULT_MAX_TOOL_CALLS = 96;

export class AgentRuntime {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly sessions = new Map<string, string>();
  private closed = false;
  private authenticationChanging = false;
  private authenticationEpoch = 0;
  private activeLoginId: string | null = null;
  private loginStartTask: Promise<AgentLoginAttempt> | null = null;
  private logoutTask: Promise<void> | null = null;

  private readonly maxRunMs: number;
  private readonly maxToolCalls: number;

  constructor(private readonly adapter: AgentRuntimeAdapter, options: AgentRuntimeOptions = {}) {
    this.maxRunMs = positiveInteger(options.maxRunMs, DEFAULT_MAX_RUN_MS);
    this.maxToolCalls = positiveInteger(options.maxToolCalls, DEFAULT_MAX_TOOL_CALLS);
  }

  async status(): Promise<AgentProviderStatus> {
    await this.reconcileActiveLogin();
    const epoch = this.authenticationEpoch;
    const status = await this.adapter.status();
    if (epoch !== this.authenticationEpoch || this.authenticationChanging) {
      return authenticationChangingStatus(status);
    }
    return status;
  }

  startLogin(): Promise<AgentLoginAttempt> {
    if (this.closed) throw new AgentRuntimeUnavailableError("Agent runtime is closed");
    if (this.authenticationChanging) throw new AgentRuntimeConflictError("Agent authentication is changing");
    if (this.runs.size > 0) throw new AgentRuntimeConflictError("Wait for active agent runs before connecting");
    this.beginAuthenticationChange();
    const task = this.adapter
      .startLogin()
      .then((attempt) => {
        if (attempt.status === "pending") {
          this.activeLoginId = attempt.loginId;
        } else {
          this.finishLoginChange(attempt.loginId);
        }
        return attempt;
      })
      .catch((error) => {
        this.finishLoginChange();
        throw error;
      })
      .finally(() => {
        if (this.loginStartTask === task) this.loginStartTask = null;
      });
    this.loginStartTask = task;
    return task;
  }

  async loginStatus(loginId: string): Promise<AgentLoginAttempt> {
    const attempt = await this.adapter.loginStatus(loginId);
    if (attempt.status !== "pending") this.finishLoginChange(loginId);
    return attempt;
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.adapter.cancelLogin(loginId);
    this.finishLoginChange(loginId);
  }

  logout(): Promise<void> {
    if (this.logoutTask) return this.logoutTask;
    if (this.closed) return Promise.reject(new AgentRuntimeUnavailableError("Agent runtime is closed"));
    this.beginAuthenticationChange();
    const task = (async () => {
      await this.interruptAll();
      await this.adapter.logout();
      await this.interruptAll();
    })().finally(() => {
      if (this.logoutTask === task) this.logoutTask = null;
      this.activeLoginId = null;
      this.endAuthenticationChange();
    });
    this.logoutTask = task;
    return task;
  }

  startRun(input: AgentRunInput): void {
    if (this.closed) throw new AgentRuntimeUnavailableError("Agent runtime is closed");
    if (this.authenticationChanging) throw new AgentRuntimeConflictError("Agent authentication is changing");
    if (this.runs.has(input.runId)) throw new AgentRuntimeConflictError("Agent run is already active");
    if (this.sessions.has(input.sessionId)) throw new AgentRuntimeConflictError("Agent session already has an active run");

    const abort = new AbortController();
    const active: ActiveRun = {
      sessionId: input.sessionId,
      abort,
      settled: Promise.resolve()
    };
    this.runs.set(input.runId, active);
    this.sessions.set(input.sessionId, input.runId);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.runs.delete(input.runId);
      if (this.sessions.get(input.sessionId) === input.runId) this.sessions.delete(input.sessionId);
    };

    active.settled = this.execute(input, abort, release).finally(release);
    // Runs are intentionally detached from the HTTP request. Observe the promise so
    // a failing event consumer can never become an unhandled rejection.
    void active.settled.catch(() => undefined);
  }

  async interrupt(runId: string): Promise<void> {
    const active = this.runs.get(runId);
    if (!active) return;
    active.abort.abort(new Error("Agent run interrupted"));
    await active.settled;
  }

  async interruptAll(): Promise<void> {
    const active = [...this.runs.values()];
    for (const run of active) run.abort.abort(new Error("Agent run interrupted"));
    await Promise.allSettled(active.map((run) => run.settled));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.logoutTask?.catch(() => undefined);
    await this.interruptAll();
    await this.adapter.close();
  }

  private beginAuthenticationChange(): void {
    this.authenticationChanging = true;
    this.authenticationEpoch += 1;
  }

  private endAuthenticationChange(): void {
    this.authenticationChanging = false;
    this.authenticationEpoch += 1;
  }

  private finishLoginChange(loginId?: string): void {
    if (loginId && this.activeLoginId && this.activeLoginId !== loginId) return;
    if (!this.authenticationChanging || this.logoutTask) return;
    this.activeLoginId = null;
    this.endAuthenticationChange();
  }

  private async reconcileActiveLogin(): Promise<void> {
    const loginId = this.activeLoginId;
    if (!loginId || this.logoutTask) return;
    try {
      const attempt = await this.adapter.loginStatus(loginId);
      if (attempt.status !== "pending") this.finishLoginChange(loginId);
    } catch (error) {
      if ((error as { statusCode?: number } | null)?.statusCode === 404) this.finishLoginChange(loginId);
    }
  }

  private async execute(input: AgentRunInput, abort: AbortController, release: () => void): Promise<void> {
    const emit = async (event: AgentRuntimeEvent) => {
      await input.onEvent(event);
    };
    let failure: unknown = null;
    let toolCalls = 0;
    const providerObservations: AgentProviderTurnObservation[] = [];
    const deadline = setTimeout(() => {
      abort.abort(
        new AgentRunLimitError(
          `Agent run exceeded the configured ${Math.ceil(this.maxRunMs / 1_000)}-second limit (MR-AGENT-TIME-LIMIT)`
        )
      );
    }, this.maxRunMs);
    try {
      await emit({ type: "run.started", runId: input.runId });
      await this.adapter.run({
        runId: input.runId,
        sessionId: input.sessionId,
        systemPrompt: input.systemPrompt,
        history: input.history,
        tools: input.tools,
        requestTool: async (request) => {
          toolCalls += 1;
          if (toolCalls > this.maxToolCalls) {
            abort.abort(
              new AgentRunLimitError(
                `Agent run exceeded the configured ${this.maxToolCalls} tool-call limit (MR-AGENT-TOOL-LIMIT)`
              )
            );
            return {
              ok: false,
              error: {
                code: "MR-AGENT-TOOL-LIMIT",
                message: `Agent run exceeded the configured ${this.maxToolCalls} tool-call limit`,
                retryable: false
              }
            };
          }
          return input.requestTool(request, abort.signal);
        },
        signal: abort.signal,
        onEvent: emit,
        onProviderTurn: (observation) => {
          providerObservations.push(observation);
        }
      });
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(deadline);
    }

    if (failure === null && abort.signal.aborted) failure = abort.signal.reason;

    const limited = abort.signal.reason instanceof AgentRunLimitError;
    const interrupted = failure !== null && !limited && (abort.signal.aborted || isAbortError(failure));
    const terminal: AgentRuntimeEvent = {
      type: "run.completed",
      runId: input.runId,
      status: failure === null ? "completed" : interrupted ? "interrupted" : "failed",
      error: failure === null || interrupted ? null : limited ? abort.signal.reason.message : publicRuntimeError(),
      metrics: runMetrics(providerObservations, toolCalls)
    };
    // AgentService durably closes the turn inside this callback. Release the
    // runtime session first so a client reacting to that terminal event cannot
    // race with the detached promise's finalizer.
    release();
    try {
      await emit(terminal);
      return;
    } catch {
      // A terminal consumer may fail before making its durable transition. Give it
      // one idempotent retry with a fixed public error, then let run cleanup proceed.
    }

    await emit({
      type: "run.completed",
      runId: input.runId,
      status: terminal.status === "interrupted" ? "interrupted" : "failed",
      error: terminal.status === "interrupted" ? null : "Agent event handling failed",
      metrics: terminal.metrics
    }).catch(() => undefined);
  }
}

function runMetrics(observations: AgentProviderTurnObservation[], toolCallCount: number): AgentRunMetrics {
  return {
    stopReason: observations.at(-1)?.stopReason ?? null,
    providerRoundCount: observations.length,
    lengthStopCount: observations.filter((observation) => observation.stopReason === "length").length,
    toolCallCount,
    usage: observations.reduce<AgentTokenUsage>(
      (total, observation) => ({
        input: total.input + observation.usage.input,
        output: total.output + observation.usage.output,
        reasoning: total.reasoning + observation.usage.reasoning,
        cacheRead: total.cacheRead + observation.usage.cacheRead,
        cacheWrite: total.cacheWrite + observation.usage.cacheWrite,
        total: total.total + observation.usage.total
      }),
      emptyTokenUsage()
    )
  };
}

function emptyTokenUsage(): AgentTokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export class AgentRuntimeUnavailableError extends Error {
  readonly statusCode = 503;

  constructor(message = "Agent runtime is unavailable") {
    super(message);
    this.name = "AgentRuntimeUnavailableError";
  }
}

export class AgentRuntimeConflictError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeConflictError";
  }
}

class AgentRunLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunLimitError";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && /abort|interrupt/i.test(`${error.name} ${error.message}`);
}

function publicRuntimeError(): string {
  return "Agent run failed";
}

function authenticationChangingStatus(status: AgentProviderStatus): AgentProviderStatus {
  return {
    ...status,
    connected: false,
    authSource: null,
    accountKey: null,
    message: "Agent authentication is changing"
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}
