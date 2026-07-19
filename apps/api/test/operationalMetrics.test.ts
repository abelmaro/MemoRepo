import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { schema } from "../src/db/schema.js";
import { classifyProcessTermination, readCgroupMemoryMetrics, recordCbmOperationMetric } from "../src/services/operationalMetrics.js";

test("process diagnostics distinguish timeout, cancellation, signals, and possible OOM", () => {
  assert.equal(classifyProcessTermination({ exitCode: 0 }), "completed");
  assert.equal(classifyProcessTermination({ error: new Error("operation timed out after 100ms") }), "timeout");
  const cancelled = new Error("cancelled by user"); cancelled.name = "AbortError";
  assert.equal(classifyProcessTermination({ error: cancelled }), "cancelled");
  assert.equal(classifyProcessTermination({ exitCode: 137 }), "possible_oom");
  assert.equal(classifyProcessTermination({ signal: "SIGKILL" }), "possible_oom");
  assert.equal(classifyProcessTermination({ signal: "SIGTERM" }), "signal");
  assert.equal(classifyProcessTermination({ exitCode: 1 }), "failed");
  assert.equal(classifyProcessTermination({ exitCode: 1, cgroupOomKills: 1 }), "possible_oom");
});

test("cgroup v2 metrics parse bounded counters without failing outside containers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-cgroup-"));
  try {
    fs.writeFileSync(path.join(root, "memory.current"), "1024\n");
    fs.writeFileSync(path.join(root, "memory.peak"), "4096\n");
    fs.writeFileSync(path.join(root, "memory.max"), "8192\n");
    fs.writeFileSync(path.join(root, "memory.events"), "low 0\nhigh 2\nmax 3\noom 4\noom_kill 1\n");
    assert.deepEqual(readCgroupMemoryMetrics(root), {
      currentBytes: 1024, peakBytes: 4096, limitBytes: 8192, oomEvents: 4, oomKillEvents: 1
    });
    fs.writeFileSync(path.join(root, "memory.max"), "max\n");
    assert.equal(readCgroupMemoryMetrics(root).limitBytes, null);
    assert.deepEqual(readCgroupMemoryMetrics(path.join(root, "missing")), {
      currentBytes: null, peakBytes: null, limitBytes: null, oomEvents: 0, oomKillEvents: 0
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("operational metrics migration and recorder persist metadata without source or query payloads", () => {
  const sqlite = new Database(":memory:");
  const database = { sqlite, db: drizzle(sqlite, { schema }) };
  try {
    migrate(sqlite);
    const toolColumns = sqlite.pragma("table_info(mcp_tool_stats)") as Array<{ name: string }>;
    for (const column of ["total_duration_ms", "max_duration_ms", "error_count", "cache_hit_count", "truncated_count"]) {
      assert.ok(toolColumns.some((candidate) => candidate.name === column));
    }
    recordCbmOperationMetric(database, {
      operation: "index_repository", status: "indexed", durationMs: 12.6, spaceId: "spc_test",
      projectName: "fixture", engineVersion: "0.9.0", indexMode: "fast", nodes: 37, edges: 44,
      skippedCount: 0, artifactBytes: 1024, cgroupPeakBytes: 2048, terminationKind: "completed"
    });
    const row = sqlite.prepare("SELECT * FROM cbm_operation_metrics").get() as Record<string, unknown>;
    assert.equal(row.duration_ms, 13);
    assert.equal(row.cache_hit, 0);
    assert.equal(row.cgroup_peak_bytes, 2048);
    assert.equal("query" in row, false);
    assert.equal("payload" in row, false);
    assert.equal("response" in row, false);
  } finally { sqlite.close(); }
});
