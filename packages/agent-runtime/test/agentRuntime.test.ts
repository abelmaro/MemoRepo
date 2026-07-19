import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentProviderFailureError,
  AgentRuntime,
  AgentRuntimeConflictError,
  AgentRuntimeUnavailableError,
  type AgentAdapterRunInput,
  type AgentLoginAttempt,
  type AgentProviderStatus,
  type AgentRunInput,
  type AgentRuntimeAdapter,
  type AgentRuntimeEvent,
  type AgentToolRequest
} from "../src/index.js";

const providerStatus: AgentProviderStatus = {
  configured: true,
  available: true,
  connected: true,
  providerId: "fake",
  providerName: "Fake provider",
  modelId: "fake-model",
  modelName: "Fake model",
  authSource: "test",
  accountKey: "test-account",
  runtimeVersion: "test",
  message: null
};

const loginAttempt: AgentLoginAttempt = {
  loginId: "login-1",
  status: "completed",
  verificationUrl: null,
  userCode: null,
  instructions: null,
  error: null
};

class FakeAdapter implements AgentRuntimeAdapter {
  readonly runs: AgentAdapterRunInput[] = [];
  closeCalls = 0;
  logoutHandler: () => Promise<void> = async () => {};
  startLoginAttempt: AgentLoginAttempt = loginAttempt;
  currentLoginAttempt: AgentLoginAttempt = loginAttempt;

  constructor(private readonly executeRun: (input: AgentAdapterRunInput) => Promise<void>) {}

  async status(): Promise<AgentProviderStatus> {
    return providerStatus;
  }

  async startLogin(): Promise<AgentLoginAttempt> {
    return this.startLoginAttempt;
  }

  async loginStatus(): Promise<AgentLoginAttempt> {
    return this.currentLoginAttempt;
  }

  async cancelLogin(): Promise<void> {}

  logout(): Promise<void> {
    return this.logoutHandler();
  }

  async run(input: AgentAdapterRunInput): Promise<void> {
    this.runs.push(input);
    await this.executeRun(input);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

test("emits a successful lifecycle and forwards deltas and tool execution", async () => {
  const events = collectEvents();
  const toolRequests: AgentToolRequest[] = [];
  const adapter = new FakeAdapter(async (input) => {
    await input.onEvent({ type: "assistant.delta", runId: input.runId, delta: "Found " });

    const request: AgentToolRequest = {
      runId: input.runId,
      sessionId: input.sessionId,
      requestId: "tool-1",
      name: "search_snapshot",
      arguments: { query: "AgentRuntime" }
    };
    await input.onEvent({
      type: "tool.started",
      runId: input.runId,
      requestId: request.requestId,
      name: request.name
    });
    const result = await input.requestTool(request, input.signal);
    assert.deepEqual(result, { ok: true, value: { matches: 1 } });
    await input.onEvent({
      type: "tool.completed",
      runId: input.runId,
      requestId: request.requestId,
      name: request.name,
      success: result.ok
    });
    await input.onEvent({ type: "assistant.delta", runId: input.runId, delta: "one match." });
    await input.onProviderTurn({
      stopReason: "stop",
      usage: { input: 120, output: 42, reasoning: 18, cacheRead: 20, cacheWrite: 4, total: 204 }
    });
  });
  const runtime = new AgentRuntime(adapter);

  runtime.startRun(
    makeRunInput({
      onEvent: events.onEvent,
      requestTool: async (request, signal) => {
        assert.equal(signal.aborted, false);
        toolRequests.push(request);
        return { ok: true, value: { matches: 1 } };
      }
    })
  );

  const completed = await events.completed.promise;
  assert.deepEqual(normalizedCompleted(completed), {
    type: "run.completed",
    runId: "run-1",
    status: "completed",
    error: null,
    failureDiagnostic: null,
    metrics: {
      stopReason: "stop",
      providerRoundCount: 1,
      lengthStopCount: 0,
      toolCallCount: 1,
      attemptDurationMs: 0,
      timeToFirstProviderEventMs: 0,
      usage: { input: 120, output: 42, reasoning: 18, cacheRead: 20, cacheWrite: 4, total: 204 }
    },
    completionReason: "natural",
    answerQuality: "complete",
    resumable: false
  });
  assert.deepEqual(
    events.values.map((event) => event.type),
    ["run.started", "assistant.delta", "tool.started", "tool.completed", "assistant.delta", "run.completed"]
  );
  assert.deepEqual(toolRequests, [
    {
      runId: "run-1",
      sessionId: "session-1",
      requestId: "tool-1",
      name: "search_snapshot",
      arguments: { query: "AgentRuntime" }
    }
  ]);
  assert.equal(adapter.runs.length, 1);

  await runtime.close();
});

test("retries a failed terminal consumer, observes the detached run, and releases the session", async () => {
  const adapter = new FakeAdapter(async () => {});
  const runtime = new AgentRuntime(adapter);
  const terminalEvents: Array<Extract<AgentRuntimeEvent, { type: "run.completed" }>> = [];
  const retried = deferred<Extract<AgentRuntimeEvent, { type: "run.completed" }>>();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    runtime.startRun(
      makeRunInput({
        onEvent(event) {
          if (event.type !== "run.completed") return;
          terminalEvents.push(event);
          if (terminalEvents.length === 1) throw new Error("transient persistence failure");
          retried.resolve(event);
        }
      })
    );

    assert.deepEqual(normalizedCompleted(await retried.promise), {
      type: "run.completed",
      runId: "run-1",
      status: "failed",
      error: "Agent event handling failed",
      failureDiagnostic: null,
      metrics: emptyMetrics(),
      completionReason: "natural",
      answerQuality: "complete",
      resumable: false
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      terminalEvents.map((event) => event.status),
      ["completed", "failed"]
    );
    assert.deepEqual(unhandled, []);

    const second = collectEvents();
    runtime.startRun(makeRunInput({ runId: "run-2", sessionId: "session-1", onEvent: second.onEvent }));
    assert.equal((await second.completed.promise).status, "completed");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await runtime.close();
  }
});

test("does not expose adapter error details through terminal events", async () => {
  const events = collectEvents();
  const adapter = new FakeAdapter(async () => {
    throw new Error("Authorization: Bearer secret-access-token refresh_token=secret-refresh-token");
  });
  const runtime = new AgentRuntime(adapter);

  runtime.startRun(makeRunInput({ onEvent: events.onEvent }));

  assert.deepEqual(normalizedCompleted(await events.completed.promise), {
    type: "run.completed",
    runId: "run-1",
    status: "failed",
    error: "Agent run failed",
    failureDiagnostic: {
      category: "unknown",
      stage: "unknown",
      providerCode: null,
      httpStatus: null,
      providerRequestId: null,
      providerResponseId: null,
      transport: null,
      retryable: true,
      retryAfterMs: null,
      summary: "The provider run failed for an unknown reason."
    },
    metrics: emptyMetrics(),
    completionReason: "provider_failure",
    answerQuality: "best_effort",
    resumable: true
  });
  await runtime.close();
});

test("propagates a typed provider diagnostic and records first provider activity", async () => {
  const events = collectEvents();
  const diagnostic = {
    category: "timeout",
    stage: "connection",
    providerCode: "ETIMEDOUT",
    httpStatus: null,
    providerRequestId: "req-safe-1",
    providerResponseId: null,
    transport: "websocket",
    retryable: true,
    retryAfterMs: 2_000,
    summary: "The provider request timed out during connection."
  } as const;
  const adapter = new FakeAdapter(async (input) => {
    input.onProviderActivity?.();
    throw new AgentProviderFailureError(diagnostic);
  });
  const runtime = new AgentRuntime(adapter);

  runtime.startRun(makeRunInput({ onEvent: events.onEvent }));

  const completed = await events.completed.promise;
  assert.equal(completed.error, "Agent run failed");
  assert.deepEqual(completed.failureDiagnostic, diagnostic);
  assert.notEqual(completed.metrics.timeToFirstProviderEventMs, null);
  assert.ok((completed.metrics.timeToFirstProviderEventMs ?? -1) <= completed.metrics.attemptDurationMs);
  await runtime.close();
});

test("rejects a concurrent run for the same session", async () => {
  const entered = deferred<void>();
  const events = collectEvents();
  const adapter = new FakeAdapter(async (input) => {
    entered.resolve();
    await rejectWhenAborted(input.signal);
  });
  const runtime = new AgentRuntime(adapter);

  runtime.startRun(makeRunInput({ onEvent: events.onEvent }));
  await entered.promise;

  assert.throws(
    () =>
      runtime.startRun(
        makeRunInput({
          runId: "run-2",
          sessionId: "session-1"
        })
      ),
    (error: unknown) =>
      error instanceof AgentRuntimeConflictError &&
      error.statusCode === 409 &&
      error.message === "Agent session already has an active run"
  );

  await runtime.interrupt("run-1");
  assert.equal((await events.completed.promise).status, "interrupted");
  await runtime.close();
});

test("interrupt aborts the adapter run and completes it as interrupted", async () => {
  const entered = deferred<void>();
  const events = collectEvents();
  let adapterSignal: AbortSignal | null = null;
  const adapter = new FakeAdapter(async (input) => {
    adapterSignal = input.signal;
    entered.resolve();
    await rejectWhenAborted(input.signal);
  });
  const runtime = new AgentRuntime(adapter);

  runtime.startRun(makeRunInput({ onEvent: events.onEvent }));
  await entered.promise;
  await runtime.interrupt("run-1");

  assert.equal(adapterSignal?.aborted, true);
  assert.deepEqual(normalizedCompleted(await events.completed.promise), {
    type: "run.completed",
    runId: "run-1",
    status: "interrupted",
    error: null,
    failureDiagnostic: null,
    metrics: emptyMetrics(),
    completionReason: "cancelled",
    answerQuality: "best_effort",
    resumable: true
  });
  await runtime.close();
});

test("preserves a run that exceeds its hard deadline as resumable", async () => {
  const events = collectEvents();
  const adapter = new FakeAdapter(async (input) => rejectWhenAborted(input.signal));
  const runtime = new AgentRuntime(adapter, { maxRunMs: 10 });

  runtime.startRun(makeRunInput({ onEvent: events.onEvent }));

  assert.deepEqual(normalizedCompleted(await events.completed.promise), {
    type: "run.completed",
    runId: "run-1",
    status: "interrupted",
    error: null,
    failureDiagnostic: null,
    metrics: emptyMetrics(),
    completionReason: "budget",
    answerQuality: "best_effort",
    resumable: true
  });

  const next = collectEvents();
  runtime.startRun(makeRunInput({ runId: "run-2", sessionId: "session-1", onEvent: next.onEvent }));
  assert.equal((await next.completed.promise).status, "interrupted");
  await runtime.close();
});

test("requests graceful finalization after the configured tool-call budget", async () => {
  const events = collectEvents();
  const toolResults: unknown[] = [];
  const adapter = new FakeAdapter(async (input) => {
    const request = (requestId: string): AgentToolRequest => ({
      runId: input.runId,
      sessionId: input.sessionId,
      requestId,
      name: "search_snapshot",
      arguments: {}
    });
    toolResults.push(await input.requestTool(request("tool-1"), input.signal));
    toolResults.push(await input.requestTool(request("tool-2"), input.signal));
    if (input.signal.aborted) throw input.signal.reason;
  });
  const runtime = new AgentRuntime(adapter, { maxToolCalls: 1 });

  runtime.startRun(makeRunInput({ onEvent: events.onEvent }));

  const completed = await events.completed.promise;
  assert.equal(completed.status, "completed");
  assert.equal(completed.completionReason, "budget");
  assert.equal(completed.answerQuality, "best_effort");
  assert.deepEqual(toolResults, [
    { ok: true, value: null },
    {
      ok: false,
      error: {
        code: "research_budget_reached",
        message: "The research budget is complete. Answer with the evidence already collected.",
        retryable: false
      }
    }
  ]);
  await runtime.close();
});

test("applies stricter per-run tool and provider-round budgets", async () => {
  const toolEvents = collectEvents();
  const toolResults: unknown[] = [];
  const toolAdapter = new FakeAdapter(async (input) => {
    const request = (requestId: string): AgentToolRequest => ({
      runId: input.runId,
      sessionId: input.sessionId,
      requestId,
      name: "search_snapshot",
      arguments: {}
    });
    toolResults.push(await input.requestTool(request("tool-1"), input.signal));
    toolResults.push(await input.requestTool(request("tool-2"), input.signal));
    if (input.signal.aborted) throw input.signal.reason;
  });
  const toolRuntime = new AgentRuntime(toolAdapter, { maxToolCalls: 10 });
  toolRuntime.startRun(
    makeRunInput({
      limits: { maxRunMs: 60_000, maxToolCalls: 1, maxProviderRounds: 8 },
      onEvent: toolEvents.onEvent
    })
  );

  const toolCompleted = await toolEvents.completed.promise;
  assert.equal(toolCompleted.status, "completed");
  assert.equal(toolCompleted.completionReason, "budget");
  assert.equal((toolResults[1] as { error?: { code?: string } }).error?.code, "research_budget_reached");
  await toolRuntime.close();

  const roundEvents = collectEvents();
  const roundAdapter = new FakeAdapter(async (input) => {
    const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    await input.onProviderTurn({ stopReason: "toolUse", usage });
    await input.onProviderTurn({ stopReason: "toolUse", usage });
    if (input.signal.aborted) throw input.signal.reason;
  });
  const roundRuntime = new AgentRuntime(roundAdapter, { maxProviderRounds: 10 });
  roundRuntime.startRun(
    makeRunInput({
      limits: { maxRunMs: 60_000, maxToolCalls: 10, maxProviderRounds: 2 },
      onEvent: roundEvents.onEvent
    })
  );

  const roundCompleted = await roundEvents.completed.promise;
  assert.equal(roundCompleted.status, "interrupted");
  assert.equal(roundCompleted.error, null);
  assert.equal(roundCompleted.completionReason, "budget");
  assert.equal(roundCompleted.metrics.providerRoundCount, 2);
  await roundRuntime.close();
});

test("requests best-effort synthesis when research stops making progress", async () => {
  const repeatedEvents = collectEvents();
  const repeatedAdapter = new FakeAdapter(async (input) => {
    for (let index = 0; index < 3; index += 1) {
      await input.requestTool(
        {
          runId: input.runId,
          sessionId: input.sessionId,
          requestId: `tool-${index}`,
          name: "search_snapshot",
          arguments: { query: "same evidence" }
        },
        input.signal
      );
    }
    assert.equal(input.finalizationReason?.(), "no_progress");
  });
  const repeatedRuntime = new AgentRuntime(repeatedAdapter, {
    maxToolCalls: 20,
    finalizationReserveToolCalls: 1,
    maxRepeatedToolCalls: 3
  });
  repeatedRuntime.startRun(makeRunInput({ onEvent: repeatedEvents.onEvent }));
  const repeated = await repeatedEvents.completed.promise;
  assert.equal(repeated.status, "completed");
  assert.equal(repeated.completionReason, "no_progress");
  assert.equal(repeated.answerQuality, "best_effort");
  await repeatedRuntime.close();

  const stalledEvents = collectEvents();
  const stalledAdapter = new FakeAdapter(async (input) => {
    const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    for (let index = 0; index < 5; index += 1) {
      await input.onProviderTurn({ stopReason: "toolUse", usage });
    }
    assert.equal(input.finalizationReason?.(), "no_progress");
  });
  const stalledRuntime = new AgentRuntime(stalledAdapter, {
    maxProviderRounds: 20,
    finalizationReserveProviderRounds: 1,
    maxNoProgressRounds: 4
  });
  stalledRuntime.startRun(makeRunInput({ onEvent: stalledEvents.onEvent }));
  const stalled = await stalledEvents.completed.promise;
  assert.equal(stalled.status, "completed");
  assert.equal(stalled.completionReason, "no_progress");
  assert.equal(stalled.metrics.providerRoundCount, 5);
  await stalledRuntime.close();
});

test("logout blocks new runs and login attempts until credential removal settles", async () => {
  const logoutStarted = deferred<void>();
  const finishLogout = deferred<void>();
  const adapter = new FakeAdapter(async () => {});
  adapter.logoutHandler = async () => {
    logoutStarted.resolve();
    await finishLogout.promise;
  };
  const runtime = new AgentRuntime(adapter);

  const logout = runtime.logout();
  await logoutStarted.promise;
  assert.throws(
    () => runtime.startRun(makeRunInput()),
    (error: unknown) => error instanceof AgentRuntimeConflictError && error.statusCode === 409
  );
  assert.throws(
    () => runtime.startLogin(),
    (error: unknown) => error instanceof AgentRuntimeConflictError && error.statusCode === 409
  );

  finishLogout.resolve();
  await logout;
  runtime.startRun(makeRunInput({ runId: "run-after-logout", sessionId: "session-after-logout" }));
  await runtime.close();
});

test("an active run blocks login until the run settles", async () => {
  const entered = deferred<void>();
  const adapter = new FakeAdapter(async (input) => {
    entered.resolve();
    await rejectWhenAborted(input.signal);
  });
  const runtime = new AgentRuntime(adapter);

  runtime.startRun(makeRunInput());
  await entered.promise;
  assert.throws(
    () => runtime.startLogin(),
    (error: unknown) =>
      error instanceof AgentRuntimeConflictError && error.message === "Wait for active agent runs before connecting"
  );

  await runtime.interrupt("run-1");
  const login = await runtime.startLogin();
  assert.equal(login.status, "completed");
  await runtime.close();
});

test("a pending login blocks runs and status reconciles a terminal login without explicit polling", async () => {
  const pending: AgentLoginAttempt = {
    ...loginAttempt,
    status: "pending",
    verificationUrl: "https://auth.example.test/device",
    userCode: "ABCD-EFGH"
  };
  const adapter = new FakeAdapter(async () => {});
  adapter.startLoginAttempt = pending;
  adapter.currentLoginAttempt = pending;
  const runtime = new AgentRuntime(adapter);

  const started = await runtime.startLogin();
  assert.equal(started.status, "pending");
  assert.throws(
    () => runtime.startRun(makeRunInput()),
    (error: unknown) => error instanceof AgentRuntimeConflictError && error.message === "Agent authentication is changing"
  );
  const pendingStatus = await runtime.status();
  assert.equal(pendingStatus.connected, false);
  assert.equal(pendingStatus.accountKey, null);
  assert.equal(pendingStatus.message, "Agent authentication is changing");

  adapter.currentLoginAttempt = loginAttempt;
  const connected = await runtime.status();
  assert.equal(connected.connected, true);
  const events = collectEvents();
  runtime.startRun(makeRunInput({ runId: "run-after-login", sessionId: "session-after-login", onEvent: events.onEvent }));
  assert.equal((await events.completed.promise).status, "completed");
  await runtime.close();
});

test("close interrupts active runs, closes the adapter once, and rejects new runs", async () => {
  const entered = deferred<void>();
  const events = collectEvents();
  const adapter = new FakeAdapter(async (input) => {
    entered.resolve();
    await rejectWhenAborted(input.signal);
  });
  const runtime = new AgentRuntime(adapter);

  runtime.startRun(makeRunInput({ onEvent: events.onEvent }));
  await entered.promise;
  await runtime.close();

  assert.equal((await events.completed.promise).status, "interrupted");
  assert.equal(adapter.closeCalls, 1);
  assert.throws(
    () => runtime.startRun(makeRunInput({ runId: "run-after-close" })),
    (error: unknown) => error instanceof AgentRuntimeUnavailableError && error.statusCode === 503
  );

  await runtime.close();
  assert.equal(adapter.closeCalls, 1);
});

function makeRunInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: "run-1",
    sessionId: "session-1",
    systemPrompt: "Answer only from the pinned snapshot.",
    history: [{ role: "user", content: "Earlier question", timestamp: 1 }],
    tools: [
      {
        name: "search_snapshot",
        description: "Search the pinned snapshot",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false
        }
      }
    ],
    requestTool: async () => ({ ok: true, value: null }),
    onEvent: () => {},
    ...overrides
  };
}

function collectEvents() {
  const values: AgentRuntimeEvent[] = [];
  const completed = deferred<Extract<AgentRuntimeEvent, { type: "run.completed" }>>();
  return {
    values,
    completed,
    onEvent(event: AgentRuntimeEvent) {
      values.push(event);
      if (event.type === "run.completed") completed.resolve(event);
    }
  };
}

function emptyMetrics() {
  return {
    stopReason: null,
    providerRoundCount: 0,
    lengthStopCount: 0,
    toolCallCount: 0,
    attemptDurationMs: 0,
    timeToFirstProviderEventMs: null,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  } as const;
}

function normalizedCompleted(event: Extract<AgentRuntimeEvent, { type: "run.completed" }>) {
  assert.ok(Number.isInteger(event.metrics.attemptDurationMs));
  assert.ok(event.metrics.attemptDurationMs >= 0);
  if (event.metrics.timeToFirstProviderEventMs !== null) {
    assert.ok(Number.isInteger(event.metrics.timeToFirstProviderEventMs));
    assert.ok(event.metrics.timeToFirstProviderEventMs >= 0);
    assert.ok(event.metrics.timeToFirstProviderEventMs <= event.metrics.attemptDurationMs);
  }
  return {
    ...event,
    metrics: {
      ...event.metrics,
      attemptDurationMs: 0,
      timeToFirstProviderEventMs: event.metrics.timeToFirstProviderEventMs === null ? null : 0
    }
  };
}

async function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  if (!signal.aborted) {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
  const error = new Error("Agent run aborted");
  error.name = "AbortError";
  throw error;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
