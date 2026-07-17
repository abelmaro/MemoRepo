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
  const service = new CbmService({ memorepoHome: root } as AppConfig, immutableConfigRunner);
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
