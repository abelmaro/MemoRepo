import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  aggregateJobs,
  BaselineInputError,
  DashboardSseParser,
  parseBaselineArguments,
  type JobMeasurement
} from "../src/performanceBaseline.js";

const TOKEN = "a".repeat(43);

test("performance baseline arguments require exactly three repositories", () => {
  assert.throws(
    () => parseBaselineArguments(["--repositories", "owner/one,owner/two"], { MEMOREPO_CONTROL_TOKEN: TOKEN }),
    BaselineInputError
  );

  const config = parseBaselineArguments(
    ["--repositories", "owner/one,owner/two,owner/three", "--include-agents", "--idle-seconds", "0"],
    { MEMOREPO_CONTROL_TOKEN: TOKEN, MEMOREPO_HOME: "./managed-data" },
    os.tmpdir()
  );

  assert.deepEqual(config.repositories, ["owner/one", "owner/two", "owner/three"]);
  assert.equal(config.includeAgents, true);
  assert.equal(config.idleSeconds, 0);
  assert.equal(config.storageRoot, path.resolve("./managed-data"));
  assert.match(config.outputPath, /memorepo-performance[\\/]baseline-/);
});

test("dashboard stream parser counts typed events and heartbeat comments across chunks", () => {
  const parser = new DashboardSseParser();
  parser.push(": heartbeat\r\n\r\ndata: {\"type\":\"ready\",\"eventId\":\"ignored");
  parser.push("\"}\n\nevent: invalidate\ndata: {\"eventId\":\"ignored\",\"resources\":[]}\n\n");
  parser.push("data: {\"type\":\"discarded");
  parser.discardIncompleteFrame();
  parser.push("data: {\"type\":\"future-event\",\"optional\":true}\n\n");

  assert.deepEqual(parser.counts, {
    total: 3,
    ready: 1,
    invalidations: 1,
    other: 1,
    heartbeats: 1
  });
});

test("performance baseline accepts environment-backed repository configuration", () => {
  const config = parseBaselineArguments([], {
    MEMOREPO_CONTROL_TOKEN: TOKEN,
    MEMOREPO_PERF_REPOSITORIES: "owner/one, owner/two, owner/three",
    MEMOREPO_PUBLIC_API_URL: "http://127.0.0.1:9999/"
  });

  assert.deepEqual(config.repositories, ["owner/one", "owner/two", "owner/three"]);
  assert.equal(config.apiUrl, "http://127.0.0.1:9999");
  assert.equal(config.includeAgents, false);
});

test("job aggregation reports duration distributions without retaining identifiers", () => {
  const jobs: JobMeasurement[] = [
    { type: "clone", status: "succeeded", queueMs: 1, runMs: 10, totalMs: 11 },
    { type: "clone", status: "succeeded", queueMs: 2, runMs: 20, totalMs: 22 },
    { type: "snapshot", status: "failed", queueMs: 3, runMs: null, totalMs: 3 }
  ];

  assert.deepEqual(aggregateJobs(jobs), {
    clone: {
      count: 2,
      succeeded: 2,
      failed: 0,
      totalRunMs: 30,
      medianRunMs: 10,
      p95RunMs: 20,
      maxRunMs: 20
    },
    snapshot: {
      count: 1,
      succeeded: 0,
      failed: 1,
      totalRunMs: 0,
      medianRunMs: null,
      p95RunMs: null,
      maxRunMs: null
    }
  });
});
