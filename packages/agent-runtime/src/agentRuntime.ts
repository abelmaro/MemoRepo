import type { AgentRuntimeAdapter } from "./agentRuntimeAdapter.js";
import type {
  AgentLoginAttempt,
  AgentProviderStatus,
  AgentProviderTurnObservation,
  AgentRunCompletionReason,
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
  maxProviderRounds?: number;
  finalizationReserveMs?: number;
  finalizationReserveToolCalls?: number;
  finalizationReserveProviderRounds?: number;
  maxNoProgressRounds?: number;
  maxRepeatedToolCalls?: number;
  maxConsecutiveToolErrors?: number;
}

const DEFAULT_MAX_RUN_MS = 1_800_000;
const DEFAULT_MAX_TOOL_CALLS = 200;
const DEFAULT_MAX_PROVIDER_ROUNDS = 50;
const DEFAULT_FINALIZATION_RESERVE_MS = 180_000;
const DEFAULT_FINALIZATION_RESERVE_TOOL_CALLS = 20;
const DEFAULT_FINALIZATION_RESERVE_PROVIDER_ROUNDS = 5;
const DEFAULT_MAX_NO_PROGRESS_ROUNDS = 4;
const DEFAULT_MAX_REPEATED_TOOL_CALLS = 3;
const DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS = 3;

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
  private readonly maxProviderRounds: number;
  private readonly finalizationReserveMs: number;
  private readonly finalizationReserveToolCalls: number;
  private readonly finalizationReserveProviderRounds: number;
  private readonly maxNoProgressRounds: number;
  private readonly maxRepeatedToolCalls: number;
  private readonly maxConsecutiveToolErrors: number;

  constructor(private readonly adapter: AgentRuntimeAdapter, options: AgentRuntimeOptions = {}) {
    this.maxRunMs = positiveInteger(options.maxRunMs, DEFAULT_MAX_RUN_MS);
    this.maxToolCalls = positiveInteger(options.maxToolCalls, DEFAULT_MAX_TOOL_CALLS);
    this.maxProviderRounds = positiveInteger(options.maxProviderRounds, DEFAULT_MAX_PROVIDER_ROUNDS);
    this.finalizationReserveMs = positiveInteger(options.finalizationReserveMs, DEFAULT_FINALIZATION_RESERVE_MS);
    this.finalizationReserveToolCalls = positiveInteger(
      options.finalizationReserveToolCalls,
      DEFAULT_FINALIZATION_RESERVE_TOOL_CALLS
    );
    this.finalizationReserveProviderRounds = positiveInteger(
      options.finalizationReserveProviderRounds,
      DEFAULT_FINALIZATION_RESERVE_PROVIDER_ROUNDS
    );
    this.maxNoProgressRounds = positiveInteger(options.maxNoProgressRounds, DEFAULT_MAX_NO_PROGRESS_ROUNDS);
    this.maxRepeatedToolCalls = positiveInteger(
      options.maxRepeatedToolCalls,
      DEFAULT_MAX_REPEATED_TOOL_CALLS
    );
    this.maxConsecutiveToolErrors = positiveInteger(
      options.maxConsecutiveToolErrors,
      DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS
    );
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
    let finalizationReason: AgentRunCompletionReason | null = null;
    let consecutiveToolErrors = 0;
    let noProgressRounds = 0;
    let observedSuccessfulResultCount = 0;
    const successfulResultFingerprints = new Set<string>();
    const toolCallCounts = new Map<string, number>();
    const providerObservations: AgentProviderTurnObservation[] = [];
    const startedAt = Date.now();
    const maxRunMs = boundedPositiveInteger(input.limits?.maxRunMs, this.maxRunMs);
    const maxToolCalls = boundedPositiveInteger(input.limits?.maxToolCalls, this.maxToolCalls);
    const maxProviderRounds = boundedPositiveInteger(input.limits?.maxProviderRounds, this.maxProviderRounds);
    const finalizationReserveMs = boundedReserve(
      input.limits?.finalizationReserveMs,
      this.finalizationReserveMs,
      maxRunMs
    );
    const finalizationReserveToolCalls = boundedReserve(
      input.limits?.finalizationReserveToolCalls,
      this.finalizationReserveToolCalls,
      maxToolCalls
    );
    const finalizationReserveProviderRounds = boundedReserve(
      input.limits?.finalizationReserveProviderRounds,
      this.finalizationReserveProviderRounds,
      maxProviderRounds
    );
    const maxNoProgressRounds = boundedPositiveInteger(
      input.limits?.maxNoProgressRounds,
      this.maxNoProgressRounds
    );
    const maxRepeatedToolCalls = boundedPositiveInteger(
      input.limits?.maxRepeatedToolCalls,
      this.maxRepeatedToolCalls
    );
    const maxConsecutiveToolErrors = boundedPositiveInteger(
      input.limits?.maxConsecutiveToolErrors,
      this.maxConsecutiveToolErrors
    );
    const researchRunMs = Math.max(1, maxRunMs - finalizationReserveMs);
    const researchToolCalls = Math.max(1, maxToolCalls - finalizationReserveToolCalls);
    const researchProviderRounds = Math.max(1, maxProviderRounds - finalizationReserveProviderRounds);
    const requestFinalization = (reason: AgentRunCompletionReason) => {
      finalizationReason ??= reason;
    };
    const deadline = setTimeout(() => {
      abort.abort(
        new AgentRunLimitError(
          `Agent run exceeded the configured ${Math.ceil(maxRunMs / 1_000)}-second limit (MR-AGENT-TIME-LIMIT)`
        )
      );
    }, maxRunMs);
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
          const signature = `${request.name}:${stableJson(request.arguments)}`;
          const signatureCount = (toolCallCounts.get(signature) ?? 0) + 1;
          toolCallCounts.set(signature, signatureCount);
          if (signatureCount >= maxRepeatedToolCalls) requestFinalization("no_progress");
          if (toolCalls >= researchToolCalls) requestFinalization("budget");
          if (toolCalls > maxToolCalls) {
            requestFinalization("budget");
            return {
              ok: false,
              error: {
                code: "research_budget_reached",
                message: "The research budget is complete. Answer with the evidence already collected.",
                retryable: false
              }
            };
          }
          const result = await input.requestTool(request, abort.signal);
          if (result.ok) {
            consecutiveToolErrors = 0;
            successfulResultFingerprints.add(stableJson(result.value));
          } else {
            consecutiveToolErrors += 1;
            if (consecutiveToolErrors >= maxConsecutiveToolErrors) requestFinalization("no_progress");
          }
          return result;
        },
        signal: abort.signal,
        onEvent: emit,
        onProviderTurn: (observation) => {
          providerObservations.push(observation);
          if (observation.stopReason !== "toolUse") return;
          if (successfulResultFingerprints.size === observedSuccessfulResultCount && providerObservations.length > 1) {
            noProgressRounds += 1;
          } else {
            noProgressRounds = 0;
            observedSuccessfulResultCount = successfulResultFingerprints.size;
          }
          if (noProgressRounds >= maxNoProgressRounds) requestFinalization("no_progress");
          if (providerObservations.length >= researchProviderRounds) requestFinalization("budget");
          if (providerObservations.length >= maxProviderRounds) {
            abort.abort(
              new AgentRunLimitError(
                `Agent run exceeded the configured ${maxProviderRounds} provider-round limit (MR-AGENT-ROUND-LIMIT)`
              )
            );
          }
        },
        finalizationReason: () => {
          if (Date.now() - startedAt >= researchRunMs) requestFinalization("budget");
          return finalizationReason;
        }
      });
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(deadline);
    }

    if (failure === null && abort.signal.aborted) failure = abort.signal.reason;

    const limited = abort.signal.reason instanceof AgentRunLimitError;
    const interrupted = failure !== null && (abort.signal.aborted || isAbortError(failure));
    const status = failure === null ? "completed" : interrupted ? "interrupted" : "failed";
    const completionReason: AgentRunCompletionReason =
      failure === null
        ? finalizationReason ?? "natural"
        : limited
          ? "budget"
          : interrupted
            ? "cancelled"
            : "provider_failure";
    const terminal: AgentRuntimeEvent = {
      type: "run.completed",
      runId: input.runId,
      status,
      error: failure === null || interrupted ? null : publicRuntimeError(),
      metrics: runMetrics(providerObservations, toolCalls),
      completionReason,
      answerQuality: failure !== null || finalizationReason || limited ? "best_effort" : "complete",
      resumable: status !== "completed"
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
      metrics: terminal.metrics,
      completionReason: terminal.completionReason,
      answerQuality: terminal.answerQuality,
      resumable: terminal.resumable
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

function boundedPositiveInteger(value: number | undefined, maximum: number): number {
  return Math.min(positiveInteger(value, maximum), maximum);
}

function boundedReserve(value: number | undefined, fallback: number, maximum: number): number {
  if (maximum <= 1) return 0;
  return Math.min(positiveInteger(value, fallback), maximum - 1);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
