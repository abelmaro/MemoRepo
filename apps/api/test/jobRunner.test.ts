import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { schema } from "../src/db/schema.js";
import { JOB_EVENT_MESSAGE_MAX_BYTES, JOB_LOG_EVENT_MAX_COUNT, JobRunner } from "../src/services/jobRunner.js";
import { SpaceService } from "../src/services/spaceService.js";
import { DashboardEventBus } from "../src/services/dashboardEventBus.js";

test("terminal snapshot jobs invalidate jobs, the space, and snapshots without forwarding logs", async () => {
  const database = createTestDatabase();
  const dashboardEvents = new DashboardEventBus(1);
  const jobs = new JobRunner(database, 1, dashboardEvents);
  const events: Array<{ resources: Array<{ type: string; jobId?: string; spaceId?: string }> }> = [];
  dashboardEvents.subscribe((event) => events.push(event));
  jobs.register("rebuild_space_snapshot", async (_payload, context) => context.log("private operation output"));

  try {
    const job = jobs.enqueue({ type: "rebuild_space_snapshot", spaceId: "spc_test", payload: { spaceId: "spc_test" } });
    await waitFor(() => (jobs.getJob(job.id) as { status: string }).status === "succeeded");
    await waitFor(() => events.some((event) => event.resources.some((resource) => resource.type === "snapshots")));
    const serialized = JSON.stringify(events);
    assert.match(serialized, /"type":"jobs"/);
    assert.match(serialized, /"type":"job","jobId":"[^"]+"/);
    assert.match(serialized, /"type":"space","spaceId":"spc_test"/);
    assert.match(serialized, /"type":"snapshots","spaceId":"spc_test"/);
    assert.equal(serialized.includes("private operation output"), false);
  } finally {
    jobs.stop();
    dashboardEvents.close();
    database.sqlite.close();
  }
});

test("enqueue returns the existing active logical job and releases the key for terminal jobs", () => {
  const database = createTestDatabase();
  const jobs = new JobRunner(database, 0);

  try {
    const input = {
      type: "index_space_repository",
      spaceId: "spc_test",
      spaceRepositoryId: "spr_test",
      payload: { spaceRepositoryId: "spr_test", options: { mode: "fast", force: false } }
    };

    const first = jobs.enqueue(input);
    const duplicatePending = jobs.enqueue({
      ...input,
      payload: { options: { force: false, mode: "fast" }, spaceRepositoryId: "spr_test" }
    });
    assert.equal(duplicatePending.id, first.id);
    assert.equal(countJobs(database), 1);
    assert.equal(countEvents(database), 1);

    database.sqlite
      .prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?")
      .run(new Date().toISOString(), first.id);
    const duplicateRunning = jobs.enqueue(input);
    assert.equal(duplicateRunning.id, first.id);
    assert.equal(duplicateRunning.status, "running");
    assert.ok(duplicateRunning.startedAt);
    assert.equal(countJobs(database), 1);

    database.sqlite
      .prepare("UPDATE jobs SET status = 'succeeded', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), first.id);
    const afterSuccess = jobs.enqueue(input);
    assert.notEqual(afterSuccess.id, first.id);
    assert.equal(countJobs(database), 2);

    database.sqlite
      .prepare("UPDATE jobs SET status = 'failed', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), afterSuccess.id);
    const afterFailure = jobs.enqueue(input);
    assert.notEqual(afterFailure.id, afterSuccess.id);
    assert.equal(countJobs(database), 3);
  } finally {
    database.sqlite.close();
  }
});

test("logical job identity includes payload and dependency", () => {
  const database = createTestDatabase();
  const jobs = new JobRunner(database, 0);

  try {
    const base = {
      type: "rebuild_space_snapshot",
      spaceId: "spc_test",
      payload: { spaceId: "spc_test" }
    };
    const first = jobs.enqueue({ ...base, dependsOnJobId: "job_index_one" });
    const differentDependency = jobs.enqueue({ ...base, dependsOnJobId: "job_index_two" });
    const differentPayload = jobs.enqueue({
      ...base,
      dependsOnJobId: "job_index_one",
      payload: { spaceId: "spc_test", force: true }
    });

    assert.notEqual(differentDependency.id, first.id);
    assert.notEqual(differentPayload.id, first.id);
    assert.equal(countJobs(database), 3);
  } finally {
    database.sqlite.close();
  }
});

test("public job projections exclude the internal deduplication key", () => {
  const database = createTestDatabase();
  const jobs = new JobRunner(database, 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-job-projection-"));

  try {
    const parent = jobs.enqueue({ type: "parent_job", payload: { value: 1 } });
    const child = jobs.enqueue({ type: "child_job", dependsOnJobId: parent.id, payload: { value: 2 } });
    const rawParent = database.sqlite.prepare("SELECT deduplication_key FROM jobs WHERE id = ?").get(parent.id) as {
      deduplication_key: string | null;
    };
    assert.ok(rawParent.deduplication_key);

    assertNoDeduplicationKey(jobs.getJob(parent.id));
    assertNoDeduplicationKey(jobs.getJobDependency(child.id));
    for (const dependent of jobs.getJobDependents(parent.id)) {
      assertNoDeduplicationKey(dependent);
    }

    const spaces = new SpaceService(database, {
      memorepoHome: root,
      spacesDir: path.join(root, "spaces"),
      repoIndexesDir: path.join(root, "indexes", "repositories"),
      snapshotIndexesDir: path.join(root, "indexes", "snapshots"),
      tmpDir: path.join(root, "tmp")
    } as never, {} as never);
    const latestChild = (spaces.latestJobs() as Array<Record<string, unknown>>).find((job) => job.id === child.id);
    assertNoDeduplicationKey(latestChild);
    assert.equal(latestChild?.dependency_status, "pending");
  } finally {
    database.sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migration upgrades existing job tables before creating the active deduplication index", () => {
  const sqlite = new Database(":memory:");

  try {
    sqlite.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        space_id TEXT,
        space_repository_id TEXT,
        depends_on_job_id TEXT,
        payload_json TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
    `);

    migrate(sqlite);

    const columns = sqlite.pragma("table_info(jobs)") as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "deduplication_key"));
    const index = sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'jobs_active_deduplication_unique'")
      .get() as { sql: string } | undefined;
    assert.match(index?.sql ?? "", /UNIQUE INDEX/);
    assert.match(index?.sql ?? "", /status IN \('pending', 'running'\)/);
  } finally {
    sqlite.close();
  }
});

test("job output is bounded by message size and retained log count", async () => {
  const database = createTestDatabase();
  const jobs = new JobRunner(database, 1);
  jobs.register("noisy_job", async (_payload, context) => {
    context.log("x".repeat(JOB_EVENT_MESSAGE_MAX_BYTES * 2));
    for (let index = 0; index < JOB_LOG_EVENT_MAX_COUNT + 25; index += 1) {
      context.log(`line-${index}`);
    }
  });

  try {
    jobs.start();
    const job = jobs.enqueue({ type: "noisy_job" });
    await waitForTerminalJob(database, job.id);
    const completed = jobs.getJob(job.id) as { status: string; error: string | null };
    assert.equal(completed.status, "succeeded", completed.error ?? undefined);

    const events = jobs.getJobEvents(job.id) as Array<{ event_type: string; message: string }>;
    const logs = events.filter((event) => event.event_type === "log");
    assert.equal(logs.length, JOB_LOG_EVENT_MAX_COUNT);
    assert.ok(Buffer.byteLength(logs[0]!.message, "utf8") <= JOB_EVENT_MESSAGE_MAX_BYTES);
    assert.match(logs[0]!.message, /\[message truncated\]$/);
    assert.equal(events.filter((event) => event.event_type === "log_truncated").length, 1);
    assert.equal(events.at(-1)?.message, "succeeded");
  } finally {
    jobs.stop();
    database.sqlite.close();
  }
});

test("running jobs can be cancelled and receive an abort signal", async () => {
  const database = createTestDatabase();
  const jobs = new JobRunner(database, 1);
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  jobs.register("blocking_job", async (_payload, context) => {
    markStarted();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(context.signal.reason);
      context.signal.addEventListener("abort", onAbort, { once: true });
      if (context.signal.aborted) onAbort();
    });
  });

  try {
    jobs.start();
    const job = jobs.enqueue({ type: "blocking_job" });
    await started;
    const cancelling = jobs.cancelJob(job.id) as { status: string };
    assert.equal(cancelling.status, "running");
    await waitForTerminalJob(database, job.id);

    const cancelled = jobs.getJob(job.id) as { status: string; error: string | null };
    assert.equal(cancelled.status, "cancelled");
    assert.match(cancelled.error ?? "", /MR-JOB-CANCELLED/);
    const events = jobs.getJobEvents(job.id) as Array<{ event_type: string; message: string }>;
    assert.ok(events.some((event) => event.event_type === "cancellation_requested"));
    assert.equal(events.at(-1)?.message, "cancelled");
  } finally {
    jobs.stop();
    database.sqlite.close();
  }
});

function createTestDatabase(): AppDatabase {
  const sqlite = new Database(":memory:");
  migrate(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function countJobs(database: AppDatabase): number {
  return (database.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count;
}

function countEvents(database: AppDatabase): number {
  return (database.sqlite.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count;
}

function assertNoDeduplicationKey(row: unknown): asserts row is Record<string, unknown> {
  assert.ok(row && typeof row === "object");
  assert.equal(Object.prototype.hasOwnProperty.call(row, "deduplication_key"), false);
}

async function waitForTerminalJob(database: AppDatabase, jobId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const row = database.sqlite.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string };
    if (["succeeded", "failed", "cancelled", "skipped"].includes(row.status)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for job completion");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
