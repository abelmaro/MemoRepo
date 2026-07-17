import type {
  AgentLoginAttempt,
  AgentProviderStatus,
  AgentRunInput,
  AgentToolResult,
  JsonValue
} from "@memorepo/agent-runtime";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { rmSync } from "node:fs";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import type { AppDatabase } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { schema } from "../src/db/schema.js";
import { AgentService, type AgentRuntimePort } from "../src/services/agentService.js";
import type { CbmService } from "../src/services/cbmService.js";
import { McpGateway } from "../src/services/mcpGateway.js";
import { SnapshotQueryService } from "../src/services/snapshotQueryService.js";
import { SnapshotService } from "../src/services/snapshotService.js";
import { SpaceService } from "../src/services/spaceService.js";

test("agent chats stay pinned and persist sanitized tool-backed transcripts", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  const runtime = new FakeAgentRuntime();
  const queryLog: QueryLog = { definitions: [], calls: [] };
  const guardCalls: string[] = [];
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries(queryLog),
    snapshotGuard(guardCalls)
  );

  try {
    const created = await service.createChat("spc_test");
    assert.equal(created.chat.snapshot.id, "snp_one");
    assert.equal(created.chat.snapshot.version, 1);
    assert.equal(created.chat.continuable, true);

    activateSecondSnapshot(database);
    const pinnedBeforeTurn = service.getChat("spc_test", created.chat.id).chat;
    assert.equal(pinnedBeforeTurn.usesLatestSnapshot, false);
    assert.equal(pinnedBeforeTurn.continuable, true);
    assert.deepEqual(pinnedBeforeTurn.activeSnapshot, { id: "snp_two", version: 2 });

    const sent = await service.sendMessage("spc_test", created.chat.id, "Where is the answer built?");
    assert.equal(runtime.runs[0]?.input.sessionId, created.chat.id);
    assert.match(runtime.runs[0]?.input.systemPrompt ?? "", /snapshot version 1/);
    assert.match(runtime.runs[0]?.input.systemPrompt ?? "", /Investigation protocol/);
    assert.match(runtime.runs[0]?.input.systemPrompt ?? "", /Gateway workflow for the pinned snapshot/);
    assert.deepEqual(runtime.runs[0]?.input.tools.map((tool) => tool.name), ["search_code"]);

    const blocked = await runtime.requestTool(sent.turn.id, "delete_file", {});
    assert.deepEqual(blocked, {
      ok: false,
      error: { code: "unknown_tool", message: "The requested snapshot tool is not available" }
    });
    assert.equal(queryLog.calls.length, 0);

    await assert.rejects(
      () => service.sendMessage("spc_test", created.chat.id, "Can I send this concurrently?"),
      (error: unknown) =>
        (error as { statusCode?: number }).statusCode === 409 &&
        (error as Error).message.includes("current answer")
    );

    await runtime.completeRun(sent.turn.id, {
      answer: "It is built in the indexed service.",
      tool: { name: "search_code", arguments: { query: "answerQuestion" } }
    });

    assert.deepEqual(service.getTurn(sent.turn.id), {
      ...sent.turn,
      status: "completed",
      metrics: {
        stopReason: "stop",
        providerRoundCount: 2,
        lengthStopCount: 0,
        toolCallCount: 1,
        usage: { input: 120, output: 50, reasoning: 20, cacheRead: 10, cacheWrite: 0, total: 200 }
      },
      finishedAt: service.getTurn(sent.turn.id).finishedAt
    });
    assert.deepEqual(queryLog.calls, [
      {
        spaceId: "spc_test",
        snapshotId: "snp_one",
        toolName: "search_code",
        args: { query: "answerQuestion" }
      }
    ]);
    assert.ok(queryLog.definitions.length >= 2);
    assert.equal(queryLog.definitions.every((entry) => entry.snapshotId === "snp_one"), true);
    assert.deepEqual(guardCalls, ["snp_one", "snp_one"]);

    const detail = service.getChat("spc_test", created.chat.id);
    assert.equal(detail.messages.length, 2);
    assert.equal(detail.messages[1]?.content, "It is built in the indexed service.");
    assert.deepEqual(detail.messages[1]?.sources, [
      { tool: "search_code", project: "memo", path: "src/example.ts", symbol: "answerQuestion" }
    ]);
    const serialized = JSON.stringify(detail);
    assert.equal(serialized.includes("C:"), false);
    assert.equal(serialized.includes("must-not-be-a-source"), false);
    assert.equal(serialized.includes("localPath"), false);

    database.sqlite.prepare("DELETE FROM space_snapshots WHERE id = ?").run("snp_one");
    const pruned = service.getChat("spc_test", created.chat.id);
    assert.equal(pruned.chat.snapshot.id, null);
    assert.equal(pruned.chat.continuable, false);
    assert.equal(pruned.chat.continuationReason, "Its pinned snapshot was pruned");
    assert.equal(pruned.messages[1]?.content, "It is built in the indexed service.");
    assert.deepEqual(pruned.messages[1]?.sources, detail.messages[1]?.sources);
  } finally {
    await service.close();
    database.sqlite.close();
  }
});

test("deleting the last chat removes its orphaned account session", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  const runtime = new FakeAgentRuntime();
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries({ definitions: [], calls: [] }),
    snapshotGuard()
  );

  try {
    const created = await service.createChat("spc_test");
    const sessionId = (
      database.sqlite
        .prepare("SELECT account_session_id AS accountSessionId FROM agent_chats WHERE id = ?")
        .get(created.chat.id) as { accountSessionId: string }
    ).accountSessionId;

    await service.deleteChat("spc_test", created.chat.id);

    assert.equal(database.sqlite.prepare("SELECT COUNT(*) FROM agent_chats").pluck().get(), 0);
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) FROM agent_account_sessions WHERE id = ?").pluck().get(sessionId),
      0
    );
  } finally {
    await service.close();
    database.sqlite.close();
  }
});

test("transient disconnected and unavailable status checks preserve the active account session", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  const runtime = new FakeAgentRuntime();
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries({ definitions: [], calls: [] }),
    snapshotGuard()
  );

  try {
    const created = await service.createChat("spc_test");
    const sessionId = (
      database.sqlite
        .prepare("SELECT account_session_id AS accountSessionId FROM agent_chats WHERE id = ?")
        .get(created.chat.id) as { accountSessionId: string }
    ).accountSessionId;

    runtime.connected = false;
    runtime.available = false;
    const unavailable = await service.status();
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.connected, false);
    assert.equal(service.getChat("spc_test", created.chat.id).chat.continuable, true);

    runtime.statusError = new Error("Temporary status lookup failure");
    const unknown = await service.status();
    assert.equal(unknown.available, false);
    assert.equal(unknown.connected, false);
    assert.equal(service.getChat("spc_test", created.chat.id).chat.continuable, true);

    const persisted = database.sqlite
      .prepare(
        "SELECT id, disconnected_at AS disconnectedAt FROM agent_account_sessions WHERE id = ?"
      )
      .get(sessionId) as { id: string; disconnectedAt: string | null };
    assert.equal(persisted.disconnectedAt, null);

    runtime.statusError = null;
    runtime.available = true;
    runtime.connected = true;
    const sent = await service.sendMessage("spc_test", created.chat.id, "Continue after reconnecting");
    await runtime.completeRun(sent.turn.id, { answer: "The original chat remains active." });
    assert.equal(service.getTurn(sent.turn.id).status, "completed");
  } finally {
    await service.close();
    database.sqlite.close();
  }
});

test("explicit logout closes the active account session", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  const runtime = new FakeAgentRuntime();
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries({ definitions: [], calls: [] }),
    snapshotGuard()
  );

  try {
    const created = await service.createChat("spc_test");
    const sessionId = (
      database.sqlite
        .prepare("SELECT account_session_id AS accountSessionId FROM agent_chats WHERE id = ?")
        .get(created.chat.id) as { accountSessionId: string }
    ).accountSessionId;
    await service.logout();

    const persisted = database.sqlite
      .prepare(
        "SELECT disconnected_at AS disconnectedAt FROM agent_account_sessions WHERE id = ?"
      )
      .get(sessionId) as { disconnectedAt: string | null };
    assert.notEqual(persisted.disconnectedAt, null);
    const chat = service.getChat("spc_test", created.chat.id).chat;
    assert.equal(chat.continuable, false);
    assert.equal(chat.continuationReason, "It belongs to a previous agent connection");
  } finally {
    await service.close();
    database.sqlite.close();
  }
});

test("logout blocks chats and turns that race credential removal", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  const runtime = new FakeAgentRuntime();
  const logoutStarted = deferred<void>();
  const finishLogout = deferred<void>();
  runtime.logoutStarted = () => logoutStarted.resolve();
  runtime.logoutGate = finishLogout.promise;
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries({ definitions: [], calls: [] }),
    snapshotGuard()
  );

  try {
    const created = await service.createChat("spc_test");
    const logout = service.logout();
    await logoutStarted.promise;

    await assert.rejects(
      () => service.sendMessage("spc_test", created.chat.id, "Race the sign-out"),
      (error: unknown) =>
        (error as { statusCode?: number }).statusCode === 409 &&
        (error as Error).message === "Agent authentication is changing"
    );
    await assert.rejects(
      () => service.createChat("spc_test"),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    );
    assert.equal(runtime.runs.length, 0);
    assert.equal(service.getChat("spc_test", created.chat.id).messages.length, 0);

    finishLogout.resolve();
    await logout;
  } finally {
    finishLogout.resolve();
    await service.close();
    database.sqlite.close();
  }
});

test("a completed authentication transition invalidates chat creation waiting on tool discovery", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  const runtime = new FakeAgentRuntime();
  const toolDiscoveryStarted = deferred<void>();
  const releaseToolDiscovery = deferred<void>();
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries({ definitions: [], calls: [] }, async () => {
      toolDiscoveryStarted.resolve();
      await releaseToolDiscovery.promise;
    }),
    snapshotGuard()
  );

  try {
    const creation = service.createChat("spc_test");
    const rejected = assert.rejects(
      creation,
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    );
    await toolDiscoveryStarted.promise;

    await service.logout();
    runtime.connected = true;
    runtime.accountKey = "reader-two@example.test";
    await service.status();
    releaseToolDiscovery.resolve();

    await rejected;
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) FROM agent_chats").pluck().get(), 0);
  } finally {
    releaseToolDiscovery.resolve();
    await service.close();
    database.sqlite.close();
  }
});

test("a completed authentication transition invalidates a turn waiting on tool discovery", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  const runtime = new FakeAgentRuntime();
  const toolDiscoveryStarted = deferred<void>();
  const releaseToolDiscovery = deferred<void>();
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries({ definitions: [], calls: [] }, async (call) => {
      if (call !== 2) return;
      toolDiscoveryStarted.resolve();
      await releaseToolDiscovery.promise;
    }),
    snapshotGuard()
  );

  try {
    const created = await service.createChat("spc_test");
    const sending = service.sendMessage("spc_test", created.chat.id, "Race a completed connection change");
    const rejected = assert.rejects(
      sending,
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    );
    await toolDiscoveryStarted.promise;

    await service.logout();
    runtime.connected = true;
    runtime.accountKey = "reader-two@example.test";
    await service.status();
    releaseToolDiscovery.resolve();

    await rejected;
    assert.equal(runtime.runs.length, 0);
    assert.equal(service.getChat("spc_test", created.chat.id).messages.length, 0);
  } finally {
    releaseToolDiscovery.resolve();
    await service.close();
    database.sqlite.close();
  }
});

test("a stale status read cannot recreate an account session after logout", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  const runtime = new FakeAgentRuntime();
  const statusStarted = deferred<void>();
  const releaseStatus = deferred<void>();
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries({ definitions: [], calls: [] }),
    snapshotGuard()
  );

  try {
    await service.createChat("spc_test");
    runtime.nextStatusStarted = () => statusStarted.resolve();
    runtime.nextStatusGate = releaseStatus.promise;
    const staleStatus = service.status();
    await statusStarted.promise;

    await service.logout();
    releaseStatus.resolve();
    const result = await staleStatus;

    assert.equal(result.connected, false);
    const activeSessions = database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM agent_account_sessions WHERE disconnected_at IS NULL")
      .get() as { count: number };
    assert.equal(activeSessions.count, 0);
  } finally {
    releaseStatus.resolve();
    await service.close();
    database.sqlite.close();
  }
});

test("status reconciles a completed login when the original client stops polling", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  const runtime = new FakeAgentRuntime();
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries({ definitions: [], calls: [] }),
    snapshotGuard()
  );

  try {
    const login = await service.startLogin();
    assert.equal(login.status, "pending");
    await assert.rejects(
      () => service.createChat("spc_test"),
      (error: unknown) =>
        (error as { statusCode?: number }).statusCode === 409 &&
        (error as Error).message === "Agent authentication is changing"
    );

    const status = await service.status();
    assert.equal(status.connected, true);
    const created = await service.createChat("spc_test");
    assert.equal(created.chat.continuable, true);
  } finally {
    await service.close();
    database.sqlite.close();
  }
});

test("logout preserves the account session when an external credential remains active", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  const runtime = new FakeAgentRuntime();
  runtime.logoutKeepsConnected = true;
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries({ definitions: [], calls: [] }),
    snapshotGuard()
  );

  try {
    const created = await service.createChat("spc_test");
    const sessionId = (
      database.sqlite
        .prepare("SELECT account_session_id AS accountSessionId FROM agent_chats WHERE id = ?")
        .get(created.chat.id) as { accountSessionId: string }
    ).accountSessionId;

    await assert.rejects(
      () => service.logout(),
      (error: unknown) =>
        (error as { statusCode?: number }).statusCode === 409 &&
        (error as Error).message === "Agent sign-out did not remove the active credential"
    );

    const persisted = database.sqlite
      .prepare("SELECT disconnected_at AS disconnectedAt FROM agent_account_sessions WHERE id = ?")
      .get(sessionId) as { disconnectedAt: string | null };
    assert.equal(persisted.disconnectedAt, null);
    assert.equal(service.getChat("spc_test", created.chat.id).chat.continuable, true);
  } finally {
    await service.close();
    database.sqlite.close();
  }
});

test("a chat from a previous provider session remains readable but not continuable", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  const runtime = new FakeAgentRuntime();
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries({ definitions: [], calls: [] }),
    snapshotGuard()
  );

  try {
    const created = await service.createChat("spc_test");
    runtime.connected = false;
    await service.status();
    runtime.connected = true;
    runtime.accountKey = "reader-two@example.test";
    await service.status();

    const previous = service.getChat("spc_test", created.chat.id).chat;
    assert.equal(previous.continuable, false);
    assert.equal(previous.continuationReason, "It belongs to a previous agent connection");
    await assert.rejects(
      () => service.sendMessage("spc_test", created.chat.id, "Continue the old chat"),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    );

    const sessions = database.sqlite
      .prepare(
        "SELECT account_key AS accountKey, disconnected_at AS disconnectedAt " +
          "FROM agent_account_sessions ORDER BY connected_at, rowid"
      )
      .all() as Array<{ accountKey: string; disconnectedAt: string | null }>;
    assert.deepEqual(
      sessions.map((session) => session.accountKey),
      ["reader-one@example.test", "reader-two@example.test"]
    );
    assert.notEqual(sessions[0]?.disconnectedAt, null);
    assert.equal(sessions[1]?.disconnectedAt, null);
  } finally {
    await service.close();
    database.sqlite.close();
  }
});

test("an interrupted turn releases the chat for a later successful turn", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  const runtime = new FakeAgentRuntime();
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries({ definitions: [], calls: [] }),
    snapshotGuard()
  );

  try {
    const created = await service.createChat("spc_test");
    const first = await service.sendMessage("spc_test", created.chat.id, "First question");
    await service.interruptTurn("spc_test", created.chat.id, first.turn.id);
    assert.equal(service.getTurn(first.turn.id).status, "interrupted");
    assert.equal(service.getChat("spc_test", created.chat.id).messages[1]?.status, "interrupted");

    const second = await service.sendMessage("spc_test", created.chat.id, "Second question");
    await runtime.completeRun(second.turn.id, { answer: "Recovered answer." });
    assert.equal(service.getTurn(second.turn.id).status, "completed");
    const recovered = service.getChat("spc_test", created.chat.id);
    assert.equal(recovered.chat.activeTurnId, null);
    assert.equal(recovered.messages[3]?.content, "Recovered answer.");
    assert.deepEqual(runtime.interruptCalls, [first.turn.id]);
  } finally {
    await service.close();
    database.sqlite.close();
  }
});

test("interrupt waits for stalled snapshot query cancellation and ignores late results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-agent-cancel-"));
  await mkdir(path.join(root, "indexes", "s", "snapshot-one", "sources", "memo"), { recursive: true });
  const database = memoryDatabase();
  seedSpace(database, root);
  const runtime = new FakeAgentRuntime();
  const queryStarted = deferred<AbortSignal>();
  const cancellationStarted = deferred<void>();
  const cancellationAccounted = deferred<void>();
  const lateResult = deferred<unknown>();
  const lateResultObserved = deferred<void>();
  const config = testConfig(root);
  const cbm = {
    async listTools() {
      return ["search_code"];
    },
    async tool(
      _toolName: string,
      _args: Record<string, unknown>,
      _cacheDir: string,
      _timeoutMs: number,
      signal?: AbortSignal
    ) {
      assert.ok(signal);
      queryStarted.resolve(signal);
      return new Promise<unknown>((resolve, reject) => {
        let cancelled = false;
        signal.addEventListener(
          "abort",
          () => {
            cancellationStarted.resolve();
            void cancellationAccounted.promise.then(() => {
              cancelled = true;
              const error = new Error("Snapshot query was interrupted");
              error.name = "AbortError";
              reject(error);
            });
          },
          { once: true }
        );
        void lateResult.promise.then((value) => {
          lateResultObserved.resolve();
          if (!cancelled) resolve(value);
        });
      });
    }
  } as unknown as CbmService;
  const spaces = new SpaceService(database, config, cbm);
  const gateway = new McpGateway(database, config, spaces, cbm);
  const service = new AgentService(
    database,
    config,
    runtime,
    new SnapshotQueryService(gateway),
    snapshotGuard()
  );

  try {
    const created = await service.createChat("spc_test");
    const sent = await service.sendMessage("spc_test", created.chat.id, "Find a stalled symbol");
    const toolRequest = runtime.requestTool(sent.turn.id, "search_code", { pattern: "stalled", project: "memo" });
    await Promise.race([
      queryStarted.promise,
      toolRequest.then((result) => {
        throw new Error(`Snapshot query completed before stalling: ${JSON.stringify(result)}`);
      })
    ]);

    let interruptSettled = false;
    const interrupt = service.interruptTurn("spc_test", created.chat.id, sent.turn.id).then(() => {
      interruptSettled = true;
    });
    await cancellationStarted.promise;
    await Promise.resolve();
    assert.equal(interruptSettled, false);
    assert.equal(service.getTurn(sent.turn.id).status, "running");

    cancellationAccounted.resolve();
    await completesWithin(interrupt, 1_000);
    assert.deepEqual(await toolRequest, {
      ok: false,
      error: { code: "interrupted", message: "The agent answer was interrupted" }
    });
    assert.equal(service.getTurn(sent.turn.id).status, "interrupted");
    assert.equal(service.getChat("spc_test", created.chat.id).messages[1]?.sources.length, 0);

    lateResult.resolve({
      results: [{ project: "memo", file_path: "src/late.ts", qualified_name: "lateAnswer" }]
    });
    await lateResultObserved.promise;
    await Promise.resolve();
    const afterLateResult = service.getChat("spc_test", created.chat.id);
    assert.equal(afterLateResult.messages[1]?.sources.length, 0);
    assert.equal(afterLateResult.messages[1]?.content, "");
    assert.equal(afterLateResult.chat.activeTurnId, null);
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) FROM mcp_tool_stats WHERE space_id = ?").pluck().get("spc_test"),
      0
    );
  } finally {
    await service.close();
    database.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing turn event listener cannot prevent durable completion or leak the active run", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  const runtime = new FakeAgentRuntime();
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries({ definitions: [], calls: [] }),
    snapshotGuard()
  );

  try {
    const created = await service.createChat("spc_test");
    const sent = await service.sendMessage("spc_test", created.chat.id, "Complete despite a stale listener");
    service.onTurnEvent(sent.turn.id, () => {
      throw new Error("stale SSE connection");
    });
    service.onTurnEvent(sent.turn.id, async () => {
      throw new Error("rejected SSE write");
    });

    await runtime.completeRun(sent.turn.id, { answer: "The durable answer." });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(service.getTurn(sent.turn.id).status, "completed");
    const completed = service.getChat("spc_test", created.chat.id);
    assert.equal(completed.chat.activeTurnId, null);
    assert.equal(completed.messages[1]?.content, "The durable answer.");

    const next = await service.sendMessage("spc_test", created.chat.id, "Start another turn");
    await runtime.completeRun(next.turn.id, { answer: "The run slot was released." });
    assert.equal(service.getTurn(next.turn.id).status, "completed");
  } finally {
    await service.close();
    database.sqlite.close();
  }
});

test("runtime history contains only complete turn pairs plus the current user within a bounded window", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  const runtime = new FakeAgentRuntime();
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries({ definitions: [], calls: [] }),
    snapshotGuard()
  );

  try {
    const created = await service.createChat("spc_test");
    const first = await service.sendMessage("spc_test", created.chat.id, "First complete question");
    await runtime.completeRun(first.turn.id, { answer: "First complete answer" });

    const interrupted = await service.sendMessage("spc_test", created.chat.id, "Interrupted question");
    const interruptedRun = runtime.runs.find((run) => run.input.runId === interrupted.turn.id);
    assert.ok(interruptedRun);
    await interruptedRun.input.onEvent({
      type: "assistant.delta",
      runId: interrupted.turn.id,
      delta: "Partial answer that must not become history"
    });
    await service.interruptTurn("spc_test", created.chat.id, interrupted.turn.id);

    const current = await service.sendMessage("spc_test", created.chat.id, "Current question");
    assert.deepEqual(
      runtime.runs.find((run) => run.input.runId === current.turn.id)?.input.history.map(({ role, content }) => ({ role, content })),
      [
        { role: "user", content: "First complete question" },
        { role: "assistant", content: "First complete answer" },
        { role: "user", content: "Current question" }
      ]
    );
  } finally {
    await service.close();
    database.sqlite.close();
  }
});

test("service construction recovers orphaned running agent turns", async () => {
  const database = memoryDatabase();
  seedSpace(database);
  seedOrphanedTurn(database);
  const runtime = new FakeAgentRuntime();
  const service = new AgentService(
    database,
    testConfig(),
    runtime,
    snapshotQueries({ definitions: [], calls: [] }),
    snapshotGuard()
  );

  try {
    assert.equal(service.getTurn("atr_orphan").status, "interrupted");
    const detail = service.getChat("spc_test", "ach_orphan");
    assert.equal(detail.messages[1]?.status, "interrupted");
    assert.notEqual(detail.messages[1]?.completedAt, null);
    assert.equal(detail.chat.activeTurnId, null);
  } finally {
    await service.close();
    database.sqlite.close();
  }
});

test("snapshot pruning uses agent tables and the agent turn start guard", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-agent-prune-"));
  const database = memoryDatabase();
  const snapshotRoot = path.join(root, "snapshot-indexes");
  const oldArtifact = path.join(snapshotRoot, "snp_prune_one");
  const activeArtifact = path.join(snapshotRoot, "snp_prune_two");
  await mkdir(oldArtifact, { recursive: true });
  await mkdir(activeArtifact, { recursive: true });
  const config = { ...testConfig(root), snapshotIndexesDir: snapshotRoot, snapshotRetentionDefault: 1 };
  const closeStarted = deferred<void>();
  const closeGate = deferred<void>();
  let closeCalls = 0;
  const cbm = {
    async closeSession() {
      closeCalls += 1;
      closeStarted.resolve();
      await closeGate.promise;
    }
  } as unknown as CbmService;
  const snapshots = new SnapshotService(database, config, cbm);

  try {
    seedPruningState(database, root, oldArtifact, activeArtifact);

    await assert.rejects(
      () => snapshots.pruneSpaceSnapshots("spc_prune", 1),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    );
    assert.equal(closeCalls, 0);
    await access(oldArtifact);
    assert.ok(database.sqlite.prepare("SELECT id FROM space_snapshots WHERE id = 'snp_prune_one'").get());

    database.sqlite.prepare("UPDATE agent_turns SET status = 'completed' WHERE id = 'atr_prune'").run();
    const pruning = snapshots.pruneSpaceSnapshots("spc_prune", 1);
    await closeStarted.promise;
    assert.throws(
      () => snapshots.assertAgentTurnCanStart("snp_prune_one"),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    );
    closeGate.resolve();
    await pruning;
    await assert.rejects(() => access(oldArtifact));
  } finally {
    closeGate.resolve();
    database.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot pruning preserves chats when artifact deletion fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-agent-prune-failure-"));
  const database = memoryDatabase();
  const snapshotRoot = path.join(root, "snapshot-indexes");
  const oldArtifact = path.join(snapshotRoot, "snp_prune_one");
  const activeArtifact = path.join(snapshotRoot, "snp_prune_two");
  await mkdir(oldArtifact, { recursive: true });
  await mkdir(activeArtifact, { recursive: true });
  const config = { ...testConfig(root), snapshotIndexesDir: snapshotRoot, snapshotRetentionDefault: 1 };
  const cbm = { closeSession: async () => undefined } as unknown as CbmService;
  const snapshots = new SnapshotService(database, config, cbm, () => {
    throw new Error("Injected artifact deletion failure");
  });

  try {
    seedPruningState(database, root, oldArtifact, activeArtifact);
    database.sqlite.prepare("UPDATE agent_turns SET status = 'completed' WHERE id = 'atr_prune'").run();

    await assert.rejects(
      () => snapshots.pruneSpaceSnapshots("spc_prune", 1),
      /Injected artifact deletion failure/
    );

    await access(oldArtifact);
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) FROM space_snapshots WHERE id = 'snp_prune_one'").pluck().get(),
      1
    );
    assert.equal(
      database.sqlite.prepare("SELECT snapshot_id FROM agent_chats WHERE id = 'ach_prune'").pluck().get(),
      "snp_prune_one"
    );
    assert.ok(database.sqlite.prepare("SELECT id FROM space_snapshots WHERE id = 'snp_prune_two'").get());
  } finally {
    database.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup completes a prune interrupted after artifact removal without exposing a broken chat", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-agent-prune-recovery-"));
  const snapshotRoot = path.join(root, "snapshot-indexes");
  const oldArtifact = path.join(snapshotRoot, "snp_prune_one");
  const activeArtifact = path.join(snapshotRoot, "snp_prune_two");
  await mkdir(oldArtifact, { recursive: true });
  await mkdir(activeArtifact, { recursive: true });
  const database = memoryDatabase();
  const config = { ...testConfig(root), snapshotIndexesDir: snapshotRoot, snapshotRetentionDefault: 1 };
  const cbm = { closeSession: async () => undefined } as unknown as CbmService;
  const snapshots = new SnapshotService(database, config, cbm, (_root, artifactPath) => {
    rmSync(artifactPath, { recursive: true, force: true });
    throw new Error("Injected crash after artifact removal");
  });

  try {
    seedPruningState(database, root, oldArtifact, activeArtifact);
    database.sqlite.prepare("UPDATE agent_turns SET status = 'completed' WHERE id = 'atr_prune'").run();

    await assert.rejects(
      () => snapshots.pruneSpaceSnapshots("spc_prune", 1),
      /Injected crash after artifact removal/
    );
    assert.equal(
      database.sqlite.prepare("SELECT status FROM space_snapshots WHERE id = 'snp_prune_one'").pluck().get(),
      "pruning"
    );
    assert.ok(database.sqlite.prepare("SELECT id FROM agent_chats WHERE id = 'ach_prune'").get());
    assert.throws(
      () => snapshots.assertAgentTurnCanStart("snp_prune_one"),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    );

    new SnapshotService(database, config, cbm);
    assert.equal(database.sqlite.prepare("SELECT id FROM space_snapshots WHERE id = 'snp_prune_one'").get(), undefined);
    assert.deepEqual(
      database.sqlite.prepare("SELECT id, snapshot_id AS snapshotId FROM agent_chats WHERE id = 'ach_prune'").get(),
      { id: "ach_prune", snapshotId: null }
    );
  } finally {
    database.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot pruning reports partial progress when a later artifact deletion fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-agent-prune-partial-"));
  const snapshotRoot = path.join(root, "snapshot-indexes");
  const olderArtifact = path.join(snapshotRoot, "snp_prune_zero");
  const oldArtifact = path.join(snapshotRoot, "snp_prune_one");
  const activeArtifact = path.join(snapshotRoot, "snp_prune_two");
  await mkdir(olderArtifact, { recursive: true });
  await mkdir(oldArtifact, { recursive: true });
  await mkdir(activeArtifact, { recursive: true });
  const database = memoryDatabase();
  const config = { ...testConfig(root), snapshotIndexesDir: snapshotRoot, snapshotRetentionDefault: 1 };
  const cbm = { closeSession: async () => undefined } as unknown as CbmService;
  let removalCall = 0;
  const snapshots = new SnapshotService(database, config, cbm, (_home, artifactPath) => {
    removalCall += 1;
    if (removalCall === 2) throw new Error(`Injected later failure at ${artifactPath}`);
    rmSync(artifactPath, { recursive: true, force: true });
    return { path: artifactPath, existed: true, sizeBytes: 1 };
  });

  try {
    seedPruningState(database, root, oldArtifact, activeArtifact);
    database.sqlite
      .prepare(
        `INSERT INTO space_snapshots
          (id, space_id, version, status, artifact_path, manifest_json, created_at, activated_at, error)
         VALUES ('snp_prune_zero', 'spc_prune', 0, 'inactive', ?, '{}', ?, ?, NULL)`
      )
      .run(olderArtifact, "2025-12-31T00:00:00.000Z", "2025-12-31T00:00:00.000Z");
    database.sqlite.prepare("UPDATE agent_turns SET status = 'completed' WHERE id = 'atr_prune'").run();

    const result = await snapshots.pruneSpaceSnapshots("spc_prune", 1);

    assert.equal(result.incomplete, true);
    assert.equal(result.deletedCount, 1);
    assert.equal(result.remainingDeleteCount, 1);
    assert.match(result.error ?? "", /Injected later failure/);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) FROM space_snapshots WHERE id = 'snp_prune_one'").pluck().get(), 0);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) FROM space_snapshots WHERE id = 'snp_prune_zero'").pluck().get(), 1);
    await assert.rejects(() => access(oldArtifact));
    await access(olderArtifact);
  } finally {
    database.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot pruning rejects unmanaged artifact paths before changing persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-agent-prune-safety-"));
  const database = memoryDatabase();
  const snapshotRoot = path.join(root, "snapshot-indexes");
  const oldArtifact = path.join(snapshotRoot, "snp_prune_one");
  const activeArtifact = path.join(snapshotRoot, "snp_prune_two");
  const outsideArtifact = path.join(root, "spaces", "must-remain");
  await mkdir(oldArtifact, { recursive: true });
  await mkdir(activeArtifact, { recursive: true });
  await mkdir(outsideArtifact, { recursive: true });
  const config = { ...testConfig(root), snapshotIndexesDir: snapshotRoot, snapshotRetentionDefault: 1 };
  let closeCalls = 0;
  let removalCalls = 0;
  const cbm = {
    async closeSession() {
      closeCalls += 1;
    }
  } as unknown as CbmService;
  const snapshots = new SnapshotService(database, config, cbm, () => {
    removalCalls += 1;
    return { path: outsideArtifact, existed: true, sizeBytes: 0 };
  });

  try {
    seedPruningState(database, root, oldArtifact, activeArtifact);
    database.sqlite.prepare("UPDATE agent_turns SET status = 'completed' WHERE id = 'atr_prune'").run();
    database.sqlite
      .prepare("UPDATE space_snapshots SET artifact_path = ? WHERE id = 'snp_prune_one'")
      .run(outsideArtifact);

    await assert.rejects(() => snapshots.pruneSpaceSnapshots("spc_prune", 1), /escapes MEMOREPO_HOME/);

    assert.equal(closeCalls, 0);
    assert.equal(removalCalls, 0);
    assert.ok(database.sqlite.prepare("SELECT id FROM space_snapshots WHERE id = 'snp_prune_one'").get());
    assert.equal(
      database.sqlite.prepare("SELECT snapshot_id FROM agent_chats WHERE id = 'ach_prune'").pluck().get(),
      "snp_prune_one"
    );
    await access(outsideArtifact);
  } finally {
    database.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot pruning rejects a row redirected to another snapshot's artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-agent-prune-identity-"));
  const database = memoryDatabase();
  const snapshotRoot = path.join(root, "snapshot-indexes");
  const oldArtifact = path.join(snapshotRoot, "snp_prune_one");
  const activeArtifact = path.join(snapshotRoot, "snp_prune_two");
  await mkdir(oldArtifact, { recursive: true });
  await mkdir(activeArtifact, { recursive: true });
  const config = { ...testConfig(root), snapshotIndexesDir: snapshotRoot, snapshotRetentionDefault: 1 };
  let closeCalls = 0;
  const cbm = {
    async closeSession() {
      closeCalls += 1;
    }
  } as unknown as CbmService;
  const snapshots = new SnapshotService(database, config, cbm);

  try {
    seedPruningState(database, root, oldArtifact, activeArtifact);
    database.sqlite.prepare("UPDATE agent_turns SET status = 'completed' WHERE id = 'atr_prune'").run();
    database.sqlite
      .prepare("UPDATE space_snapshots SET artifact_path = ? WHERE id = 'snp_prune_one'")
      .run(activeArtifact);

    await assert.rejects(
      () => snapshots.pruneSpaceSnapshots("spc_prune", 1),
      /does not match its snapshot ID/
    );
    assert.equal(closeCalls, 0);
    assert.ok(database.sqlite.prepare("SELECT id FROM space_snapshots WHERE id = 'snp_prune_one'").get());
    await access(activeArtifact);
  } finally {
    database.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup marks abandoned snapshot builds as failed and repairs the Space status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-snapshot-build-recovery-"));
  const database = memoryDatabase();
  const snapshotRoot = path.join(root, "snapshot-indexes");
  const artifactPath = path.join(snapshotRoot, "snp_build_interrupted");
  const spaceRoot = path.join(root, "spaces", "build-space");
  const timestamp = "2026-01-01T00:00:00.000Z";
  await mkdir(artifactPath, { recursive: true });
  await mkdir(spaceRoot, { recursive: true });
  database.sqlite
    .prepare(
      `INSERT INTO spaces
        (id, name, slug, root_path, active_snapshot_id, snapshot_status, snapshot_status_updated_at, created_at, updated_at)
       VALUES ('spc_build', 'Build', 'build', ?, NULL, 'building', ?, ?, ?)`
    )
    .run(spaceRoot, timestamp, timestamp, timestamp);
  database.sqlite
    .prepare(
      `INSERT INTO space_snapshots
        (id, space_id, version, status, artifact_path, manifest_json, created_at, activated_at, error)
       VALUES ('snp_build_interrupted', 'spc_build', 1, 'building', ?, '{}', ?, NULL, NULL)`
    )
    .run(artifactPath, timestamp);
  const config = { ...testConfig(root), snapshotIndexesDir: snapshotRoot };
  const cbm = { closeSession: async () => undefined } as unknown as CbmService;

  try {
    new SnapshotService(database, config, cbm);
    const snapshot = database.sqlite
      .prepare("SELECT status, error FROM space_snapshots WHERE id = 'snp_build_interrupted'")
      .get() as { status: string; error: string };
    assert.equal(snapshot.status, "failed");
    assert.match(snapshot.error, /interrupted by a previous shutdown/);
    assert.equal(database.sqlite.prepare("SELECT snapshot_status FROM spaces WHERE id = 'spc_build'").pluck().get(), "failed");
    await access(artifactPath);
  } finally {
    database.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

interface FakeRun {
  input: AgentRunInput;
  controller: AbortController;
  finished: boolean;
}

class FakeAgentRuntime implements AgentRuntimePort {
  connected = true;
  available = true;
  accountKey = "reader-one@example.test";
  statusError: Error | null = null;
  logoutKeepsConnected = false;
  logoutGate: Promise<void> | null = null;
  logoutStarted: (() => void) | null = null;
  nextStatusGate: Promise<void> | null = null;
  nextStatusStarted: (() => void) | null = null;
  readonly runs: FakeRun[] = [];
  readonly toolResults: AgentToolResult[] = [];
  readonly interruptCalls: string[] = [];
  closeCalls = 0;
  private requestSequence = 0;
  private readonly activeToolRequests = new Map<string, Set<Promise<AgentToolResult>>>();

  async status(): Promise<AgentProviderStatus> {
    if (this.statusError) throw this.statusError;
    const status: AgentProviderStatus = {
      configured: true,
      available: this.available,
      connected: this.connected,
      providerId: "test-provider",
      providerName: "Test Provider",
      modelId: "test-model",
      modelName: "Test Model",
      authSource: this.connected ? "test" : null,
      accountKey: this.connected ? this.accountKey : null,
      runtimeVersion: "test",
      message: null
    };
    const gate = this.nextStatusGate;
    const started = this.nextStatusStarted;
    this.nextStatusGate = null;
    this.nextStatusStarted = null;
    started?.();
    await gate;
    return status;
  }

  async startLogin(): Promise<AgentLoginAttempt> {
    return {
      loginId: "login-test",
      status: "pending",
      verificationUrl: "https://example.test/device",
      userCode: "ABCD-EFGH",
      instructions: "Complete the test login",
      error: null
    };
  }

  async loginStatus(loginId: string): Promise<AgentLoginAttempt> {
    return {
      loginId,
      status: "completed",
      verificationUrl: null,
      userCode: null,
      instructions: null,
      error: null
    };
  }

  async cancelLogin(): Promise<void> {}

  async logout(): Promise<void> {
    this.logoutStarted?.();
    await this.logoutGate;
    if (!this.logoutKeepsConnected) this.connected = false;
    for (const run of this.runs.filter((candidate) => !candidate.finished)) await this.interrupt(run.input.runId);
  }

  startRun(input: AgentRunInput): void {
    this.runs.push({ input, controller: new AbortController(), finished: false });
  }

  async requestTool(
    runId: string,
    name: string,
    arguments_: Record<string, JsonValue>
  ): Promise<AgentToolResult> {
    const run = this.run(runId);
    const requestId = "tool-" + ++this.requestSequence;
    const result = await this.trackToolRequest(
      runId,
      run.input.requestTool(
        { runId, sessionId: run.input.sessionId, requestId, name, arguments: arguments_ },
        run.controller.signal
      )
    );
    this.toolResults.push(result);
    return result;
  }

  async completeRun(
    runId: string,
    options: { answer: string; tool?: { name: string; arguments: Record<string, JsonValue> } }
  ): Promise<void> {
    const run = this.run(runId);
    assert.equal(run.finished, false);
    await run.input.onEvent({ type: "run.started", runId });
    if (options.tool) {
      const requestId = "tool-" + ++this.requestSequence;
      await run.input.onEvent({ type: "tool.started", runId, requestId, name: options.tool.name });
      const result = await this.trackToolRequest(
        runId,
        run.input.requestTool(
          {
            runId,
            sessionId: run.input.sessionId,
            requestId,
            name: options.tool.name,
            arguments: options.tool.arguments
          },
          run.controller.signal
        )
      );
      this.toolResults.push(result);
      await run.input.onEvent({
        type: "tool.completed",
        runId,
        requestId,
        name: options.tool.name,
        success: result.ok
      });
    }
    await run.input.onEvent({ type: "assistant.delta", runId, delta: options.answer });
    run.finished = true;
    await run.input.onEvent({
      type: "run.completed",
      runId,
      status: "completed",
      error: null,
      metrics: {
        stopReason: "stop",
        providerRoundCount: 2,
        lengthStopCount: 0,
        toolCallCount: options.tool ? 1 : 0,
        usage: { input: 120, output: 50, reasoning: 20, cacheRead: 10, cacheWrite: 0, total: 200 }
      }
    });
  }

  async interrupt(runId: string): Promise<void> {
    this.interruptCalls.push(runId);
    const run = this.runs.find((candidate) => candidate.input.runId === runId);
    if (!run || run.finished) return;
    run.controller.abort(new Error("Agent run interrupted"));
    await Promise.allSettled([...(this.activeToolRequests.get(runId) ?? [])]);
    run.finished = true;
    await run.input.onEvent({
      type: "run.completed",
      runId,
      status: "interrupted",
      error: null,
      metrics: emptyRunMetrics()
    });
  }

  async close(): Promise<void> {
    if (this.closeCalls > 0) return;
    this.closeCalls += 1;
    for (const run of this.runs.filter((candidate) => !candidate.finished)) await this.interrupt(run.input.runId);
  }

  private run(runId: string): FakeRun {
    const run = this.runs.find((candidate) => candidate.input.runId === runId);
    if (!run) throw new Error("Fake agent run not found: " + runId);
    return run;
  }

  private trackToolRequest(runId: string, request: Promise<AgentToolResult>): Promise<AgentToolResult> {
    const active = this.activeToolRequests.get(runId) ?? new Set<Promise<AgentToolResult>>();
    this.activeToolRequests.set(runId, active);
    const tracked = request.finally(() => {
      active.delete(tracked);
      if (active.size === 0) this.activeToolRequests.delete(runId);
    });
    active.add(tracked);
    return tracked;
  }
}

interface QueryLog {
  definitions: Array<{ spaceId: string; snapshotId: string }>;
  calls: Array<{
    spaceId: string;
    snapshotId: string;
    toolName: string;
    args: Record<string, unknown>;
  }>;
}

function snapshotQueries(log: QueryLog, beforeDefinitions?: (call: number) => Promise<void>): SnapshotQueryService {
  let definitionCall = 0;
  const gateway = {
    instructionsForSnapshot() {
      return "Gateway workflow for the pinned snapshot: list repositories, inspect architecture, search, trace, and fetch snippets.";
    },
    async toolDefinitionsForSnapshot(spaceId: string, snapshotId: string) {
      log.definitions.push({ spaceId, snapshotId });
      await beforeDefinitions?.(++definitionCall);
      return [
        {
          name: "search_code",
          description: "Search indexed code",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false
          }
        }
      ];
    },
    async callSnapshotTool(
      spaceId: string,
      snapshotId: string,
      toolName: string,
      args: Record<string, unknown>
    ) {
      log.calls.push({ spaceId, snapshotId, toolName, args });
      return {
        results: [
          {
            project: "memo",
            file_path: "src/example.ts",
            qualified_name: "answerQuestion",
            internal_path: "C:\\private\\must-not-be-a-source"
          }
        ]
      };
    }
  } as unknown as McpGateway;
  return new SnapshotQueryService(gateway);
}

function emptyRunMetrics() {
  return {
    stopReason: null,
    providerRoundCount: 0,
    lengthStopCount: 0,
    toolCallCount: 0,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  } as const;
}

function snapshotGuard(calls: string[] = []): Pick<SnapshotService, "assertAgentTurnCanStart"> {
  return {
    assertAgentTurnCanStart(snapshotId: string) {
      calls.push(snapshotId);
    }
  };
}

function memoryDatabase(): AppDatabase {
  const sqlite = new Database(":memory:");
  migrate(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function seedSpace(database: AppDatabase, root = "C:\\private"): void {
  const artifactPath = path.join(root, "indexes", "s", "snapshot-one");
  const manifest = {
    snapshotId: "snp_one",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    repositories: [
      {
        spaceRepositoryId: "spr_one",
        githubRepositoryId: "ghr_one",
        fullName: "example/memo",
        branch: "main",
        commit: "abc123",
        projectName: "memo",
        localPath: path.join(artifactPath, "sources", "memo")
      }
    ]
  };
  database.sqlite
    .prepare(
      `INSERT INTO spaces
        (id, name, slug, root_path, active_snapshot_id, snapshot_status, snapshot_status_updated_at, created_at, updated_at)
       VALUES ('spc_test', 'Memo', 'memo', ?, NULL, 'active', ?, ?, ?)`
    )
    .run(path.join(root, "spaces", "memo"), manifest.createdAt, manifest.createdAt, manifest.createdAt);
  database.sqlite
    .prepare(
      `INSERT INTO space_snapshots
        (id, space_id, version, status, artifact_path, manifest_json, created_at, activated_at, error)
       VALUES ('snp_one', 'spc_test', 1, 'active', ?, ?, ?, ?, NULL)`
    )
    .run(artifactPath, JSON.stringify(manifest), manifest.createdAt, manifest.createdAt);
  database.sqlite.prepare("UPDATE spaces SET active_snapshot_id = 'snp_one' WHERE id = 'spc_test'").run();
}

function activateSecondSnapshot(database: AppDatabase): void {
  const manifest = {
    snapshotId: "snp_two",
    version: 2,
    createdAt: "2026-01-02T00:00:00.000Z",
    repositories: []
  };
  database.sqlite
    .prepare(
      `INSERT INTO space_snapshots
        (id, space_id, version, status, artifact_path, manifest_json, created_at, activated_at, error)
       VALUES ('snp_two', 'spc_test', 2, 'active', 'C:\\private\\snapshot-two', ?, ?, ?, NULL)`
    )
    .run(JSON.stringify(manifest), manifest.createdAt, manifest.createdAt);
  database.sqlite.prepare("UPDATE space_snapshots SET status = 'inactive' WHERE id = 'snp_one'").run();
  database.sqlite.prepare("UPDATE spaces SET active_snapshot_id = 'snp_two' WHERE id = 'spc_test'").run();
}

function seedOrphanedTurn(database: AppDatabase): void {
  const at = "2026-01-03T00:00:00.000Z";
  database.sqlite
    .prepare(
      "INSERT INTO agent_account_sessions " +
        "(id, provider_id, account_key, connected_at, disconnected_at) VALUES (?, ?, ?, ?, NULL)"
    )
    .run("aas_orphan", "test-provider", "reader-one@example.test", at);
  database.sqlite
    .prepare(
      `INSERT INTO agent_chats
        (id, space_id, account_session_id, snapshot_id, snapshot_version, snapshot_meta_json,
         title, status, created_at, updated_at, archived_at)
       VALUES ('ach_orphan', 'spc_test', 'aas_orphan', 'snp_one', 1, '{}', 'Orphan', 'active', ?, ?, NULL)`
    )
    .run(at, at);
  database.sqlite
    .prepare(
      `INSERT INTO agent_messages
        (id, chat_id, sequence, role, status, content, sources_json, error, created_at, completed_at)
       VALUES ('agm_orphan_user', 'ach_orphan', 1, 'user', 'completed', 'Question', '[]', NULL, ?, ?),
              ('agm_orphan_assistant', 'ach_orphan', 2, 'assistant', 'running', '', '[]', NULL, ?, NULL)`
    )
    .run(at, at, at);
  database.sqlite
    .prepare(
      `INSERT INTO agent_turns
        (id, chat_id, user_message_id, assistant_message_id, status, error, created_at, started_at, finished_at)
       VALUES ('atr_orphan', 'ach_orphan', 'agm_orphan_user', 'agm_orphan_assistant', 'running', NULL, ?, ?, NULL)`
    )
    .run(at, at);
}

function seedPruningState(
  database: AppDatabase,
  root: string,
  oldArtifact: string,
  activeArtifact: string
): void {
  const first = "2026-01-01T00:00:00.000Z";
  const second = "2026-01-02T00:00:00.000Z";
  database.sqlite
    .prepare(
      `INSERT INTO spaces
        (id, name, slug, root_path, active_snapshot_id, snapshot_status, snapshot_status_updated_at, created_at, updated_at)
       VALUES ('spc_prune', 'Prune', 'prune', ?, NULL, 'active', ?, ?, ?)`
    )
    .run(root, first, first, first);
  database.sqlite
    .prepare(
      `INSERT INTO space_snapshots
        (id, space_id, version, status, artifact_path, manifest_json, created_at, activated_at, error)
       VALUES (?, 'spc_prune', 1, 'inactive', ?, '{}', ?, ?, NULL),
              (?, 'spc_prune', 2, 'active', ?, '{}', ?, ?, NULL)`
    )
    .run("snp_prune_one", oldArtifact, first, first, "snp_prune_two", activeArtifact, second, second);
  database.sqlite.prepare("UPDATE spaces SET active_snapshot_id = 'snp_prune_two' WHERE id = 'spc_prune'").run();
  database.sqlite
    .prepare(
      "INSERT INTO agent_account_sessions " +
        "(id, provider_id, account_key, connected_at, disconnected_at) VALUES ('aas_prune', 'test', 'reader', ?, NULL)"
    )
    .run(first);
  database.sqlite
    .prepare(
      `INSERT INTO agent_chats
        (id, space_id, account_session_id, snapshot_id, snapshot_version, snapshot_meta_json,
         title, status, created_at, updated_at, archived_at)
       VALUES ('ach_prune', 'spc_prune', 'aas_prune', 'snp_prune_one', 1, '{}', 'Active', 'active', ?, ?, NULL)`
    )
    .run(first, first);
  database.sqlite
    .prepare(
      `INSERT INTO agent_messages
        (id, chat_id, sequence, role, status, content, sources_json, error, created_at, completed_at)
       VALUES ('agm_prune_user', 'ach_prune', 1, 'user', 'completed', 'Question', '[]', NULL, ?, ?),
              ('agm_prune_assistant', 'ach_prune', 2, 'assistant', 'running', '', '[]', NULL, ?, NULL)`
    )
    .run(first, first, first);
  database.sqlite
    .prepare(
      `INSERT INTO agent_turns
        (id, chat_id, user_message_id, assistant_message_id, status, error, created_at, started_at, finished_at)
       VALUES ('atr_prune', 'ach_prune', 'agm_prune_user', 'agm_prune_assistant', 'running', NULL, ?, ?, NULL)`
    )
    .run(first, first);
}

function testConfig(root = "C:\\private"): AppConfig {
  return {
    apiHost: "127.0.0.1",
    apiPort: 8787,
    publicApiUrl: "http://127.0.0.1:8787",
    frontendOrigin: "http://127.0.0.1:5173",
    githubToken: null,
    githubOAuthClientId: "test",
    memorepoHome: root,
    secretsDir: path.join(root, "secrets"),
    githubCredentialKeyPath: path.join(root, "secrets", "github.key"),
    dataDir: path.join(root, "data"),
    spacesDir: path.join(root, "spaces"),
    indexesDir: path.join(root, "indexes"),
    repoIndexesDir: path.join(root, "indexes", "r"),
    snapshotIndexesDir: path.join(root, "indexes", "s"),
    logsDir: path.join(root, "logs"),
    tmpDir: path.join(root, "tmp"),
    binDir: path.join(root, "bin"),
    databasePath: ":memory:",
    mcpContainerName: "test",
    agentProvider: "test-provider",
    agentModel: "test-model",
    agentCredentialPath: path.join(root, "secrets", "agent-credentials.json"),
    snapshotRetentionDefault: 3,
    jobRetentionDaysDefault: 30,
    jobConcurrency: 2
  };
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

async function completesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation did not complete within ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
