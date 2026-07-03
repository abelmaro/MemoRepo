import assert from "node:assert/strict";
import { test } from "node:test";
import { runProcess } from "../src/services/process.js";

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
