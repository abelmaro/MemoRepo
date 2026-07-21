import assert from "node:assert/strict";
import test from "node:test";
import { runIngestionBenchmark } from "./ingestionBenchmark.js";

test("snapshot-only batch proves one rebuild, N primary indexes, and at least 50% less ingestion", async () => {
  const report = await runIngestionBenchmark({ repetitions: 1, cloneMs: 1, checkoutMs: 1, primaryIndexMs: 1 });
  assert.equal(report.gates.passed, true);
  assert.deepEqual(report.comparisons.map((value) => value.repositories), [1, 3, 5]);
  for (const value of report.comparisons) {
    assert.equal(value.legacy.jobCount, value.repositories * 3 + 1);
    assert.equal(value.batch.jobCount, value.repositories * 2 + 1);
    assert.equal(value.legacy.primaryIndexCount, value.repositories * 2);
    assert.equal(value.batch.primaryIndexCount, value.repositories);
    assert.equal(value.legacy.snapshotRebuildCount, 1);
    assert.equal(value.batch.snapshotRebuildCount, 1);
    assert.equal(value.sequential.snapshotRebuildCount, value.repositories);
    assert.equal(value.sequential.primaryIndexCount, value.repositories * (value.repositories + 1) / 2);
    assert.equal(value.ingestionReduction, 0.5);
    assert.equal(
      value.workflowReduction,
      (value.sequential.primaryIndexCount - value.batch.primaryIndexCount) / value.sequential.primaryIndexCount
    );
    assert.ok(value.batch.simulatedElapsedMs < value.legacy.simulatedElapsedMs);
    assert.ok(value.legacy.realElapsedMs > 0 && value.batch.realElapsedMs > 0);
  }
  assert.equal(report.gates.workflowReductionAtFiveAtLeast60Percent, true);
});
