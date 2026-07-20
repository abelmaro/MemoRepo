import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { AppConfig } from "../src/config.js";
import { CbmService, CbmToolExecutionError, createCbmEnvironment, parseCbmToolResult } from "../src/services/cbmService.js";

test("CBM receives only allowlisted system variables and explicit overrides", () => {
  const environment = createCbmEnvironment(
    "/tmp/cbm-cache",
    {
      Path: "/usr/local/bin:/usr/bin",
      TEMP: "/tmp",
      HOME: "/home/memorepo",
      GITHUB_ACCESS_TOKEN: "github-secret",
      MEMOREPO_CONTROL_TOKEN: "control-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock"
    }
  );

  assert.deepEqual(environment, {
    PATH: "/usr/local/bin:/usr/bin",
    TEMP: "/tmp",
    HOME: "/home/memorepo",
    CBM_CACHE_DIR: "/tmp/cbm-cache",
    CBM_LOG_LEVEL: "warn"
  });
  assert.equal(environment.GITHUB_ACCESS_TOKEN, undefined);
  assert.equal(environment.MEMOREPO_CONTROL_TOKEN, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.SSH_AUTH_SOCK, undefined);
});

test("CBM disables automatic indexing and watching before opening a snapshot cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-config-"));
  const cacheDir = path.join(root, "snapshot");
  let autoIndex = true;
  let autoWatch = true;
  const calls: string[][] = [];
  const service = new CbmService({ memorepoHome: root } as AppConfig, async (options) => {
    calls.push(options.args);
    if (options.args[0] === "config" && options.args[1] === "set") {
      if (options.args[2] === "auto_index") autoIndex = false;
      if (options.args[2] === "auto_watch") autoWatch = false;
      return processResult("");
    }
    return processResult(
      `Configuration:\n  auto_index = ${String(autoIndex)}\n  auto_watch = ${String(autoWatch)}\n`
    );
  });

  try {
    const configure = (service as unknown as {
      ensureImmutableCacheConfiguration(cacheDir: string): Promise<void>;
    }).ensureImmutableCacheConfiguration.bind(service);
    await configure(cacheDir);
    await configure(cacheDir);

    assert.equal(autoIndex, false);
    assert.equal(autoWatch, false);
    assert.deepEqual(calls, [
      ["config", "list"],
      ["config", "set", "auto_index", "false"],
      ["config", "set", "auto_watch", "false"],
      ["config", "list"]
    ]);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CBM sends CLI input through stdin instead of deprecated raw JSON arguments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-cli-stdin-"));
  const calls: Array<{ args: string[]; stdin?: string | Buffer }> = [];
  const service = new CbmService({ memorepoHome: root } as AppConfig, async (options) => {
    calls.push({ args: options.args, stdin: options.stdin });
    if (options.args[0] === "config") {
      return processResult("Configuration:\n  auto_index = false\n  auto_watch = false\n");
    }
    return processResult(JSON.stringify({ status: "indexed" }));
  });

  try {
    const input = { repo_path: "/tmp/example", mode: "fast", persistence: false };
    const runCli = (service as unknown as {
      cli<T>(tool: string, value: Record<string, unknown>, options: { cacheDir: string }): Promise<T>;
    }).cli.bind(service);
    await runCli("index_repository", input, { cacheDir: path.join(root, "cache") });

    const cliCall = calls.find((call) => call.args[0] === "cli");
    assert.deepEqual(cliCall?.args, ["cli", "index_repository"]);
    assert.equal(cliCall?.stdin, JSON.stringify(input));
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CBM tool execution errors preserve plain-text feedback", () => {
  assert.throws(
    () => parseCbmToolResult("detect_changes", {
      isError: true,
      content: [{ type: "text", text: "project is required" }]
    }),
    (error: unknown) => error instanceof CbmToolExecutionError && error.message === "project is required"
  );
});

test("CBM tool execution errors extract JSON error messages", () => {
  assert.throws(
    () => parseCbmToolResult("search_code", {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: "project not found" }) }]
    }),
    (error: unknown) => error instanceof CbmToolExecutionError && error.message === "project not found"
  );
});

test("CBM rejects legacy embedded errors even when isError is missing", () => {
  assert.throws(
    () => parseCbmToolResult("get_graph_schema", {
      content: [{ type: "text", text: JSON.stringify({ error: "project not found or not indexed" }) }]
    }),
    /project not found or not indexed/
  );
});

test("CBM parses successful structured tool content", () => {
  assert.deepEqual(
    parseCbmToolResult("search_graph", {
      content: [{ type: "text", text: JSON.stringify({ results: [{ name: "target" }] }) }]
    }),
    { results: [{ name: "target" }] }
  );
});

test("CBM paginates tools/list, preserves descriptors, deduplicates names, and caches the catalog per session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-tool-pages-"));
  const server = scriptedMcpProcess((_request, index) => index === 0
    ? {
        tools: [
          {
            name: "search_graph",
            description: "Search the graph",
            inputSchema: { type: "object", properties: { query: { type: "string" } } }
          },
          { name: "query_graph", description: "First description" },
          { name: 42 },
          null
        ],
        nextCursor: "page-two"
      }
    : {
        tools: [
          { name: "query_graph", description: "Duplicate description" },
          { name: "trace_path", inputSchema: { type: "object" } }
        ]
      });
  const service = new CbmService(
    { memorepoHome: root } as AppConfig,
    immutableConfigRunner,
    () => server.child
  );

  try {
    const cacheDir = path.join(root, "cache");
    const [descriptors, names, concurrentNames] = await Promise.all([
      service.listToolDescriptors(cacheDir),
      service.listTools(cacheDir),
      service.listTools(cacheDir)
    ]);

    assert.deepEqual(descriptors, [
      {
        name: "search_graph",
        description: "Search the graph",
        inputSchema: { type: "object", properties: { query: { type: "string" } } }
      },
      { name: "query_graph", description: "First description" },
      { name: "trace_path", inputSchema: { type: "object" } }
    ]);
    assert.deepEqual(names, ["search_graph", "query_graph", "trace_path"]);
    assert.deepEqual(concurrentNames, names);
    assert.deepEqual(server.listRequests, [{}, { cursor: "page-two" }]);

    await service.listToolDescriptors(cacheDir);
    assert.equal(server.listRequests.length, 2);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CBM capability preflight combines the cached runtime version with the paginated session catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-capability-preflight-"));
  let versionCalls = 0;
  const descriptors = capabilityToolDescriptors();
  const server = scriptedMcpProcess((_request, index) => index === 0
    ? { tools: descriptors.slice(0, 8), nextCursor: "remaining" }
    : { tools: descriptors.slice(8) });
  const service = new CbmService(
    { memorepoHome: root } as AppConfig,
    async (options) => {
      if (options.args[0] === "--version") {
        versionCalls += 1;
        return processResult("codebase-memory-mcp 0.9.0");
      }
      return immutableConfigRunner();
    },
    () => server.child
  );

  try {
    const cacheDir = path.join(root, "cache");
    const [first, second] = await Promise.all([
      service.capabilities(cacheDir),
      service.capabilities(cacheDir)
    ]);
    assert.equal(first.compatible, true);
    assert.equal(first.semanticSearch, true);
    assert.deepEqual(second, first);
    assert.equal(versionCalls, 1);
    assert.deepEqual(server.listRequests, [{}, { cursor: "remaining" }]);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CBM capability preflight fails closed when a required paginated tool is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-capability-missing-"));
  const server = scriptedMcpProcess(() => ({
    tools: capabilityToolDescriptors().filter(({ name }) => name !== "query_graph")
  }));
  const service = new CbmService(
    { memorepoHome: root } as AppConfig,
    async (options) => options.args[0] === "--version"
      ? processResult("codebase-memory-mcp 0.9.0")
      : immutableConfigRunner(),
    () => server.child
  );

  try {
    await assert.rejects(
      service.capabilities(path.join(root, "cache")),
      /missing required tools: query_graph/
    );
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CBM accepts an empty tools/list catalog", async () => {
  await withScriptedToolList(() => ({ tools: [] }), async (service, cacheDir, server) => {
    assert.deepEqual(await service.listTools(cacheDir), []);
    assert.deepEqual(server.listRequests, [{}]);
  });
});

test("CBM rejects a malformed tools/list collection", async () => {
  await withScriptedToolList(() => ({ tools: "not-an-array" }), async (service, cacheDir) => {
    await assert.rejects(service.listTools(cacheDir), /invalid tools collection/);
  });
});

test("CBM rejects a malformed tools/list result", async () => {
  await withScriptedToolList(() => null, async (service, cacheDir) => {
    await assert.rejects(service.listTools(cacheDir), /invalid result/);
  });
});

for (const nextCursor of ["", 42, false, null] as const) {
  test(`CBM rejects invalid tools/list nextCursor ${JSON.stringify(nextCursor)}`, async () => {
    await withScriptedToolList(() => ({ tools: [], nextCursor }), async (service, cacheDir) => {
      await assert.rejects(service.listTools(cacheDir), /invalid nextCursor/);
    });
  });
}

test("CBM rejects a repeated tools/list cursor", async () => {
  await withScriptedToolList(
    () => ({ tools: [], nextCursor: "same-cursor" }),
    async (service, cacheDir, server) => {
      await assert.rejects(service.listTools(cacheDir), /repeated nextCursor/);
      assert.deepEqual(server.listRequests, [{}, { cursor: "same-cursor" }]);
    }
  );
});

test("CBM limits the number of tools/list pages", async () => {
  await withScriptedToolList(
    (_request, index) => ({ tools: [], nextCursor: `cursor-${index}` }),
    async (service, cacheDir, server) => {
      await assert.rejects(service.listTools(cacheDir), /exceeded 16 pages/);
      assert.equal(server.listRequests.length, 16);
    }
  );
});

test("CBM limits the total tools/list candidates before deduplication", async () => {
  await withScriptedToolList(
    () => ({ tools: Array.from({ length: 257 }, () => ({ name: "duplicate" })) }),
    async (service, cacheDir) => {
      await assert.rejects(service.listTools(cacheDir), /exceeded 256 tools/);
    }
  );
});

test("CBM cancellation waits for bounded session shutdown and ignores a late tool result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-cancel-"));
  const operation = deferred<{ results: unknown[] }>();
  const closeStarted = deferred<void>();
  const closeAccounted = deferred<void>();
  const sessionStarted = deferred<void>();
  const service = new CbmService({ memorepoHome: root } as AppConfig, immutableConfigRunner);
  Object.defineProperty(service, "isolatedSession", {
    value: () => {
      sessionStarted.resolve();
      return {
        callTool: () => operation.promise,
        close: () => {
          closeStarted.resolve();
          return closeAccounted.promise;
        }
      };
    }
  });

  try {
    const controller = new AbortController();
    const call = service.tool("search_code", { pattern: "stalled" }, path.join(root, "cache"), 10_000, controller.signal);
    let settled = false;
    void call.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await sessionStarted.promise;
    controller.abort();
    await closeStarted.promise;
    await Promise.resolve();
    assert.equal(settled, false);

    closeAccounted.resolve();
    await assert.rejects(call, (error: unknown) => (error as Error).name === "AbortError");
    operation.resolve({ results: [{ file_path: "src/late.ts" }] });
    await Promise.resolve();
    assert.equal(settled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CBM terminates the MCP child after a malformed response frame", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-malformed-"));
  const processStarted = deferred<void>();
  const killSignals: Array<NodeJS.Signals | number | undefined> = [];
  let stdout: PassThrough | undefined;
  const service = new CbmService(
    { memorepoHome: root } as AppConfig,
    immutableConfigRunner,
    () => {
      const fake = fakeMcpProcess(killSignals);
      stdout = fake.stdout;
      processStarted.resolve();
      return fake.child;
    }
  );

  try {
    const tools = service.listTools(path.join(root, "cache"));
    await processStarted.promise;
    stdout?.write("Invalid-Header: 1\r\n\r\nx");

    await assert.rejects(tools, /Invalid codebase-memory-mcp response header/);
    await service.close();
    assert.deepEqual(killSignals, ["SIGTERM"]);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CBM converts stdin error events into a fixed session failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-stdin-event-"));
  const processStarted = deferred<void>();
  const killSignals: Array<NodeJS.Signals | number | undefined> = [];
  let stdin: PassThrough | undefined;
  const service = new CbmService(
    { memorepoHome: root } as AppConfig,
    immutableConfigRunner,
    () => {
      const fake = fakeMcpProcess(killSignals);
      stdin = fake.stdin;
      processStarted.resolve();
      return fake.child;
    }
  );

  try {
    const tools = service.listTools(path.join(root, "cache"));
    await processStarted.promise;
    stdin?.emit("error", Object.assign(new Error("EPIPE sensitive-detail"), { code: "EPIPE" }));

    await assert.rejects(
      tools,
      (error: unknown) => error instanceof Error
        && error.message === "codebase-memory-mcp input stream failed"
        && !error.message.includes("sensitive-detail")
    );
    await service.close();
    assert.deepEqual(killSignals, ["SIGTERM"]);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const failureMode of ["throw", "callback"] as const) {
  test(`CBM converts ${failureMode} stdin write errors into a fixed session failure`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), `memorepo-cbm-stdin-${failureMode}-`));
    const killSignals: Array<NodeJS.Signals | number | undefined> = [];
    const service = new CbmService(
      { memorepoHome: root } as AppConfig,
      immutableConfigRunner,
      () => {
        const fake = fakeMcpProcess(killSignals);
        Object.defineProperty(fake.stdin, "write", {
          value: (_frame: string, callback: (error?: Error | null) => void) => {
            const error = Object.assign(new Error("EPIPE sensitive-detail"), { code: "EPIPE" });
            if (failureMode === "throw") {
              throw error;
            }
            queueMicrotask(() => callback(error));
            return true;
          }
        });
        return fake.child;
      }
    );

    try {
      await assert.rejects(
        service.listTools(path.join(root, "cache")),
        (error: unknown) => error instanceof Error
          && error.message === "codebase-memory-mcp input stream failed"
          && !error.message.includes("sensitive-detail")
      );
      await service.close();
      assert.deepEqual(killSignals, ["SIGTERM"]);
    } finally {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("CBM waits for process close after escalating a stalled shutdown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-force-close-"));
  const killSignals: Array<NodeJS.Signals | number | undefined> = [];
  const processStarted = deferred<void>();
  let stdout: PassThrough | undefined;
  let closeEmitted = false;
  const service = new CbmService(
    { memorepoHome: root } as AppConfig,
    immutableConfigRunner,
    () => {
      const fake = stubbornMcpProcess(killSignals, () => {
        closeEmitted = true;
      });
      stdout = fake.stdout;
      processStarted.resolve();
      return fake.child;
    }
  );

  try {
    const tools = service.listTools(path.join(root, "cache"));
    await processStarted.promise;
    stdout?.write("Invalid-Header: 1\r\n\r\nx");
    await assert.rejects(tools, /Invalid codebase-memory-mcp response header/);

    await service.close();

    assert.equal(closeEmitted, true);
    assert.deepEqual(killSignals, ["SIGTERM", "SIGKILL"]);
  } finally {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CBM retains a child that fails to terminate so shutdown can be retried", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-retry-close-"));
  const cacheDir = path.join(root, "cache");
  const processStarted = deferred<void>();
  const killSignals: Array<NodeJS.Signals | number | undefined> = [];
  let stdout: PassThrough | undefined;
  let killAttempts = 0;
  const service = new CbmService(
    { memorepoHome: root } as AppConfig,
    immutableConfigRunner,
    () => {
      const child = new EventEmitter();
      const stdin = new PassThrough();
      stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        stdin,
        stdout,
        stderr,
        exitCode: null,
        signalCode: null,
        unref: () => child,
        kill: (signal?: NodeJS.Signals | number) => {
          killSignals.push(signal);
          killAttempts += 1;
          if (killAttempts === 1) return false;
          queueMicrotask(() => {
            Object.assign(child, { signalCode: typeof signal === "string" ? signal : null });
            child.emit("close", null, signal);
          });
          return true;
        }
      });
      processStarted.resolve();
      return child as unknown as ChildProcessWithoutNullStreams;
    }
  );

  try {
    const tools = service.listTools(cacheDir);
    await processStarted.promise;
    stdout?.write("Invalid-Header: 1\r\n\r\nx");
    await assert.rejects(tools, /Invalid codebase-memory-mcp response header/);

    await service.closeSession(cacheDir);

    assert.deepEqual(killSignals, ["SIGTERM", "SIGTERM"]);
  } finally {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

for (const oversizedFrame of [
  {
    name: "header",
    payload: "X".repeat(20 * 1024),
    message: /response header exceeded the maximum size/
  },
  {
    name: "body",
    payload: `Content-Length: ${64 * 1024 * 1024}\r\n\r\n`,
    message: /response body exceeded the maximum size/
  }
] as const) {
  test(`CBM rejects an oversized MCP response ${oversizedFrame.name}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), `memorepo-cbm-large-${oversizedFrame.name}-`));
    const processStarted = deferred<void>();
    let stdout: PassThrough | undefined;
    const service = new CbmService(
      { memorepoHome: root } as AppConfig,
      immutableConfigRunner,
      () => {
        const fake = fakeMcpProcess([]);
        stdout = fake.stdout;
        processStarted.resolve();
        return fake.child;
      }
    );

    try {
      const tools = service.listTools(path.join(root, "cache"));
      await processStarted.promise;
      stdout?.write(oversizedFrame.payload);
      await assert.rejects(tools, oversizedFrame.message);
      await service.close();
    } finally {
      await service.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("CBM caps retained stderr from a noisy child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-stderr-cap-"));
  const processStarted = deferred<void>();
  let child: EventEmitter | undefined;
  let stderr: PassThrough | undefined;
  const service = new CbmService(
    { memorepoHome: root } as AppConfig,
    immutableConfigRunner,
    () => {
      child = new EventEmitter();
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      stderr = new PassThrough();
      Object.assign(child, {
        stdin,
        stdout,
        stderr,
        exitCode: null,
        signalCode: null,
        unref: () => child,
        kill: () => true
      });
      processStarted.resolve();
      return child as unknown as ChildProcessWithoutNullStreams;
    }
  );

  try {
    const tools = service.listTools(path.join(root, "cache"));
    await processStarted.promise;
    stderr?.write("x".repeat(256 * 1024));
    Object.assign(child!, { exitCode: 1 });
    child!.emit("close", 1, null);

    const error = await tools.then(
      () => null,
      (reason: unknown) => reason instanceof Error ? reason : new Error(String(reason))
    );
    assert.ok(error);
    assert.match(error.message, /codebase-memory-mcp server closed/);
    assert.ok(error.message.length < 70_000);
    await service.close();
  } finally {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("CBM cancellation is isolated from concurrent tool calls on the same snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-isolation-"));
  const firstOperation = deferred<{ results: unknown[] }>();
  const secondOperation = deferred<{ results: unknown[] }>();
  let firstCloseCalls = 0;
  let secondCloseCalls = 0;
  let sessionNumber = 0;
  const sessionsStarted = deferred<void>();
  const service = new CbmService({ memorepoHome: root } as AppConfig, immutableConfigRunner);
  Object.defineProperty(service, "isolatedSession", {
    value: () => {
      sessionNumber += 1;
      if (sessionNumber === 2) sessionsStarted.resolve();
      const first = sessionNumber === 1;
      let closed = false;
      return {
        callTool: () => first ? firstOperation.promise : secondOperation.promise,
        close: async () => {
          if (closed) return;
          closed = true;
          if (first) firstCloseCalls += 1;
          else secondCloseCalls += 1;
        }
      };
    }
  });

  try {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const cacheDir = path.join(root, "cache");
    const firstCall = service.tool<{ results: unknown[] }>(
      "search_code",
      { pattern: "first" },
      cacheDir,
      10_000,
      firstController.signal
    );
    const secondCall = service.tool<{ results: unknown[] }>(
      "search_code",
      { pattern: "second" },
      cacheDir,
      10_000,
      secondController.signal
    );

    await sessionsStarted.promise;
    firstController.abort();
    await assert.rejects(firstCall, (error: unknown) => (error as Error).name === "AbortError");
    assert.equal(firstCloseCalls, 1);
    assert.equal(secondCloseCalls, 0);

    secondOperation.resolve({ results: [{ file_path: "src/second.ts" }] });
    assert.deepEqual(await secondCall, { results: [{ file_path: "src/second.ts" }] });
    assert.equal(secondCloseCalls, 1);

    firstOperation.resolve({ results: [{ file_path: "src/late.ts" }] });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CBM bounds concurrent isolated agent sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-concurrency-"));
  const operations = Array.from({ length: 5 }, () => deferred<{ results: unknown[] }>());
  let sessionsCreated = 0;
  const fourSessionsStarted = deferred<void>();
  const service = new CbmService(
    { memorepoHome: root, cbmInteractiveConcurrency: 4 } as AppConfig,
    immutableConfigRunner
  );
  Object.defineProperty(service, "isolatedSession", {
    value: () => {
      const operation = operations[sessionsCreated];
      sessionsCreated += 1;
      if (sessionsCreated === 4) fourSessionsStarted.resolve();
      return {
        callTool: () => operation?.promise,
        close: async () => {}
      };
    }
  });

  try {
    const calls = operations.map((_operation, index) => {
      const controller = new AbortController();
      return service.tool<{ results: unknown[] }>(
        "search_code",
        { pattern: `query-${index}` },
        path.join(root, "cache"),
        10_000,
        controller.signal
      );
    });

    await fourSessionsStarted.promise;
    assert.equal(sessionsCreated, 4);

    operations[0]?.resolve({ results: [] });
    await calls[0];
    await Promise.resolve();
    assert.equal(sessionsCreated, 5);

    for (const operation of operations.slice(1)) operation.resolve({ results: [] });
    await Promise.all(calls.slice(1));
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CBM reuses one isolated session for every tool call in an agent turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-turn-session-"));
  let sessionsCreated = 0;
  let closeCalls = 0;
  let toolCalls = 0;
  const service = new CbmService(
    { memorepoHome: root, cbmInteractiveConcurrency: 4 } as AppConfig,
    immutableConfigRunner
  );
  Object.defineProperty(service, "isolatedSession", {
    value: () => {
      sessionsCreated += 1;
      return {
        callTool: async () => ({ results: [{ call: ++toolCalls }] }),
        close: async () => {
          closeCalls += 1;
        }
      };
    }
  });

  try {
    const controller = new AbortController();
    const cacheDir = path.join(root, "cache");
    assert.deepEqual(
      await service.tool("search_code", { pattern: "first" }, cacheDir, 10_000, controller.signal, "turn-one"),
      { results: [{ call: 1 }] }
    );
    assert.deepEqual(
      await service.tool("search_code", { pattern: "second" }, cacheDir, 10_000, controller.signal, "turn-one"),
      { results: [{ call: 2 }] }
    );
    assert.equal(sessionsCreated, 1);
    assert.equal(closeCalls, 0);

    await service.closeTurnSession("turn-one");
    assert.equal(closeCalls, 1);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CBM serializes background indexing while leaving interactive capacity independent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-index-lane-"));
  const firstIndex = deferred<ReturnType<typeof processResult>>();
  const secondIndex = deferred<ReturnType<typeof processResult>>();
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  let indexCalls = 0;
  let interactiveCalls = 0;
  const service = new CbmService(
    { memorepoHome: root, cbmIndexConcurrency: 1, cbmInteractiveConcurrency: 2 } as AppConfig,
    async (options) => {
      if (options.args[0] === "cli" && options.args[1] === "index_repository") {
        indexCalls += 1;
        if (indexCalls === 1) {
          firstStarted.resolve();
          return firstIndex.promise;
        }
        secondStarted.resolve();
        return secondIndex.promise;
      }
      if (options.args[0] === "cli" && options.args[1] === "list_projects") {
        return processResult(JSON.stringify({ projects: [{ name: "fixture", root_path: path.join(root, "fixture"), nodes: 1, edges: 0 }] }));
      }
      if (options.args[0] === "cli" && options.args[1] === "index_status") {
        return processResult(JSON.stringify({ project: "fixture", nodes: 1, edges: 0 }));
      }
      return immutableConfigRunner();
    }
  );
  Object.defineProperty(service, "isolatedSession", {
    value: () => ({
      callTool: async () => {
        interactiveCalls += 1;
        return { results: [{ path: "src/live.ts" }] };
      },
      close: async () => undefined
    })
  });

  try {
    const cacheDir = path.join(root, "cache");
    const first = service.indexRepository(path.join(root, "repo-one"), cacheDir);
    const second = service.indexRepository(path.join(root, "repo-two"), cacheDir);
    await firstStarted.promise;
    await Promise.resolve();
    assert.equal(indexCalls, 1);

    const interactive = await service.tool(
      "search_code", { project: "fixture", pattern: "live" }, cacheDir, 1_000, new AbortController().signal
    );
    assert.deepEqual(interactive, { results: [{ path: "src/live.ts" }] });
    assert.equal(interactiveCalls, 1);
    assert.equal(indexCalls, 1);

    firstIndex.resolve(processResult(JSON.stringify({ status: "indexed" })));
    await secondStarted.promise;
    assert.equal(indexCalls, 2);
    secondIndex.resolve(processResult(JSON.stringify({ status: "indexed" })));
    await Promise.all([first, second]);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function processResult(stdout: string) {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false
  };
}

async function immutableConfigRunner() {
  return processResult("Configuration:\n  auto_index = false\n  auto_watch = false\n");
}

async function withScriptedToolList(
  handler: (request: Record<string, unknown>, index: number) => unknown,
  assertion: (
    service: CbmService,
    cacheDir: string,
    server: ReturnType<typeof scriptedMcpProcess>
  ) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-cbm-tool-list-"));
  const server = scriptedMcpProcess(handler);
  const service = new CbmService(
    { memorepoHome: root } as AppConfig,
    immutableConfigRunner,
    () => server.child
  );
  try {
    await assertion(service, path.join(root, "cache"), server);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}

function scriptedMcpProcess(
  handler: (request: Record<string, unknown>, index: number) => unknown
): {
  child: ChildProcessWithoutNullStreams;
  listRequests: Array<Record<string, unknown>>;
} {
  const fake = fakeMcpProcess([]);
  const listRequests: Array<Record<string, unknown>> = [];
  let input = Buffer.alloc(0);

  fake.stdin.on("data", (chunk: Buffer) => {
    input = Buffer.concat([input, chunk]);
    while (true) {
      const headerEnd = input.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = input.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      assert.ok(lengthMatch?.[1]);
      const contentLength = Number(lengthMatch[1]);
      const frameEnd = headerEnd + 4 + contentLength;
      if (input.length < frameEnd) return;

      const message = JSON.parse(input.subarray(headerEnd + 4, frameEnd).toString("utf8")) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      input = input.subarray(frameEnd);
      if (message.id === undefined) continue;

      let result: unknown;
      if (message.method === "initialize") {
        result = {};
      } else {
        assert.equal(message.method, "tools/list");
        const params = message.params ?? {};
        const index = listRequests.length;
        listRequests.push(params);
        result = handler(params, index);
      }
      const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      fake.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    }
  });

  return { child: fake.child, listRequests };
}

function capabilityToolDescriptors(): Array<{
  name: string;
  inputSchema: { type: string; properties: Record<string, unknown> };
}> {
  return [
    "list_projects",
    "index_status",
    "get_architecture",
    "get_graph_schema",
    "search_graph",
    "search_code",
    "trace_path",
    "get_code_snippet",
    "query_graph",
    "detect_changes",
    "index_repository"
  ].map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: name === "search_graph" ? { semantic_query: {} } : {}
    }
  }));
}

function fakeMcpProcess(killSignals: Array<NodeJS.Signals | number | undefined>): {
  child: ChildProcessWithoutNullStreams;
  stdin: PassThrough;
  stdout: PassThrough;
} {
  const child = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    unref: () => child,
    kill: (signal?: NodeJS.Signals | number) => {
      killSignals.push(signal);
      queueMicrotask(() => {
        Object.assign(child, { signalCode: typeof signal === "string" ? signal : null });
        child.emit("close", null, signal);
      });
      return true;
    }
  });
  return { child: child as unknown as ChildProcessWithoutNullStreams, stdin, stdout };
}

function stubbornMcpProcess(
  killSignals: Array<NodeJS.Signals | number | undefined>,
  onClose: () => void
): { child: ChildProcessWithoutNullStreams; stdout: PassThrough } {
  const child = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    unref: () => child,
    kill: (signal?: NodeJS.Signals | number) => {
      killSignals.push(signal);
      if (signal === "SIGKILL") {
        setTimeout(() => {
          Object.assign(child, { signalCode: "SIGKILL" });
          onClose();
          child.emit("close", null, signal);
        }, 20);
      }
      return true;
    }
  });
  return { child: child as unknown as ChildProcessWithoutNullStreams, stdout };
}
