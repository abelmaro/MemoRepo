import assert from "node:assert/strict";
import { test } from "node:test";
import { createSafeProcessEnvironment, runProcess } from "../src/services/process.js";

test("safe process environments preserve runtime paths without application secrets", () => {
  const environment = createSafeProcessEnvironment({
    Path: "/usr/local/bin:/usr/bin",
    HOME: "/home/memorepo",
    MEMOREPO_CONTROL_TOKEN: "control-secret",
    MEMOREPO_MCP_TOKEN: "mcp-secret",
    AWS_SECRET_ACCESS_KEY: "cloud-secret"
  });

  assert.deepEqual(environment, {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/memorepo"
  });
});

test("runProcess resolves with captured, line-split output", async () => {
  const lines: string[] = [];
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "console.log('first'); console.log('second');"],
    timeoutMs: 30_000,
    onOutput: (line) => lines.push(line)
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /first/);
  assert.deepEqual(lines, ["first", "second"]);
});

test("runProcess can replace the inherited environment", async () => {
  const secretName = "MEMOREPO_TEST_PARENT_SECRET";
  const previousSecret = process.env[secretName];
  process.env[secretName] = "must-not-be-inherited";

  try {
    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(JSON.stringify({ secret: process.env.${secretName}, visible: process.env.MEMOREPO_TEST_CHILD_VALUE }))`
      ],
      env: { MEMOREPO_TEST_CHILD_VALUE: "available" },
      inheritEnv: false,
      timeoutMs: 30_000
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { visible: "available" });
  } finally {
    if (previousSecret === undefined) {
      delete process.env[secretName];
    } else {
      process.env[secretName] = previousSecret;
    }
  }
});

test("runProcess escalates to SIGKILL when a timed out process ignores SIGTERM", async () => {
  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      timeoutMs: 250,
      killGraceMs: 250
    }),
    /timed out after 250ms/
  );
});

test("runProcess bounds captured streams and marks truncation", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('a'.repeat(4096)); process.stderr.write('b'.repeat(4096));"],
    timeoutMs: 30_000,
    maxCaptureBytes: 256
  });

  assert.equal(Buffer.byteLength(result.stdout), 256);
  assert.equal(Buffer.byteLength(result.stderr), 256);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});

test("runProcess bounds unterminated output lines before emitting them", async () => {
  const lines: string[] = [];
  await runProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(4096));"],
    timeoutMs: 30_000,
    maxLineBytes: 128,
    onOutput: (line) => lines.push(line)
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[output truncated\] /);
  assert.ok(Buffer.byteLength(lines[0]!) < 180);
});
