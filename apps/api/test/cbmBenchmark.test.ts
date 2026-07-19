import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { aggregateRetrievalRankings, CbmBenchmarkInputError, parseCbmBenchmarkArguments, summarizeDurations } from "./cbmBenchmark.js";

test("CBM benchmark arguments default outside the repository with a deterministic timestamp", () => {
  const config = parseCbmBenchmarkArguments([], new Date("2026-07-19T01:02:03.004Z"));
  assert.equal(config.mode, "fast");
  assert.equal(config.warmRepetitions, 5);
  assert.equal(config.keepWorkdir, false);
  assert.equal(config.outputPath, path.join(os.tmpdir(), "memorepo-cbm", "benchmark-2026-07-19T01-02-03-004Z.json"));
});

test("CBM benchmark arguments accept bounded overrides", () => {
  const output = path.resolve("custom-report.json");
  assert.deepEqual(parseCbmBenchmarkArguments(["--mode", "moderate", "--warm-repetitions", "7", "--output", output, "--keep-workdir"]),
    { mode: "moderate", warmRepetitions: 7, outputPath: output, keepWorkdir: true });
  assert.throws(() => parseCbmBenchmarkArguments(["--mode", "turbo"]), CbmBenchmarkInputError);
  assert.throws(() => parseCbmBenchmarkArguments(["--warm-repetitions", "0"]), /between 1 and 20/u);
  assert.throws(() => parseCbmBenchmarkArguments(["--unknown", "x"]), /Unknown argument/u);
});

test("duration summaries use nearest-rank percentiles", () => {
  assert.deepEqual(summarizeDurations([100, 10, 30, 20, 40]), { count: 5, minMs: 10, medianMs: 30, p95Ms: 100, maxMs: 100 });
  assert.deepEqual(summarizeDurations([]), { count: 0, minMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 });
});

test("retrieval aggregation computes hit at one and five from deterministic rankings", () => {
  const aggregate = aggregateRetrievalRankings([
    { results: [{ qualified_name: "validateOrder" }] },
    { items: [{ name: "unrelated" }, { name: "formatOrder" }] },
    { nodes: [{ name: "one" }, { name: "two" }, { name: "three" }, { name: "four" }, { name: "five" }, { name: "normalize" }] }
  ], ["validateOrder", "formatOrder", "normalize"]);
  assert.deepEqual(aggregate, { queries: 3, hitAt1: 1, hitAt5: 2 });
  assert.throws(() => aggregateRetrievalRankings([], ["missing"]), /requires one expected/u);
});
