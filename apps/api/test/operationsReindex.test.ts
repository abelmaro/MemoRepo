import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/db/schema.js";
import { migrate } from "../src/db/migrate.js";
import { JobRunner } from "../src/services/jobRunner.js";
import { OperationsService } from "../src/services/operationsService.js";

const INITIAL_COMMIT = "a".repeat(40);
const UPDATED_COMMIT = "b".repeat(40);

test("snapshot-only update checks ignore stale mutable index state when the commit is unchanged", async () => {
  const value = fixture(INITIAL_COMMIT);
  try {
    const job = value.operations.enqueueReindexSpace("spc_update");
    await waitForTerminalJob(value.jobs, job.id);

    assert.equal(value.jobs.getJob(job.id)?.status, "succeeded");
    assert.equal(value.checkoutCalls(), 0);
    assert.equal(value.indexCalls(), 0);
    assert.equal(value.snapshotCalls(), 0);
    const events = value.jobs.getJobEvents(job.id) as Array<{ message: string }>;
    assert.ok(events.some((event) => event.message.includes("is up to date")));
  } finally {
    value.close();
  }
});

test("snapshot-only update checks checkout changed commits and rebuild without a mutable index", async () => {
  const value = fixture(UPDATED_COMMIT);
  try {
    const job = value.operations.enqueueReindexSpace("spc_update");
    await waitForTerminalJob(value.jobs, job.id);

    assert.equal(value.jobs.getJob(job.id)?.status, "succeeded");
    assert.equal(value.checkoutCalls(), 1);
    assert.equal(value.indexCalls(), 0);
    assert.equal(value.snapshotCalls(), 1);
    const repository = value.sqlite.prepare(
      "SELECT selected_commit, index_status FROM space_repositories WHERE id = ?"
    ).get("spr_update") as { selected_commit: string; index_status: string };
    assert.equal(repository.selected_commit, UPDATED_COMMIT);
    assert.equal(repository.index_status, "stale");
    assert.equal((value.sqlite.prepare("SELECT COUNT(*) AS count FROM repo_indexes").get() as { count: number }).count, 0);
  } finally {
    value.close();
  }
});

function fixture(remoteCommit: string) {
  const sqlite = new Database(":memory:");
  migrate(sqlite);
  const database = { sqlite, db: drizzle(sqlite, { schema }) };
  const timestamp = new Date().toISOString();
  sqlite.prepare(
    `INSERT INTO spaces
     (id, name, slug, root_path, snapshot_status, snapshot_status_updated_at, created_at, updated_at)
     VALUES ('spc_update', 'Update Space', 'update-space', '/tmp/update-space', 'active', ?, ?, ?)`
  ).run(timestamp, timestamp, timestamp);
  sqlite.prepare(
    `INSERT INTO github_repositories
     (id, github_id, owner, name, full_name, html_url, clone_url, default_branch, private, archived, fork, topics_json, last_seen_at, created_at, updated_at)
     VALUES ('repo_update', 1, 'owner', 'example', 'owner/example', 'https://example.invalid/example',
       'https://example.invalid/example.git', 'main', 0, 0, 0, '[]', ?, ?, ?)`
  ).run(timestamp, timestamp, timestamp);
  sqlite.prepare(
    `INSERT INTO space_repositories
     (id, space_id, github_repository_id, local_path, selected_branch, selected_commit, remote_ref,
       clone_status, index_status, snapshot_included, branches_json, created_at, updated_at)
     VALUES ('spr_update', 'spc_update', 'repo_update', '/tmp/update-space/example', 'main', ?,
       'refs/remotes/origin/main', 'cloned', 'stale', 1, '["main"]', ?, ?)`
  ).run(INITIAL_COMMIT, timestamp, timestamp);

  let snapshotStatus = "active";
  let checkoutCount = 0;
  let indexCount = 0;
  let snapshotCount = 0;
  const spaces = {
    assertSpaceAcceptsWork: (_spaceId: string) => undefined,
    listSpaceRepositories: (_spaceId: string) => [sqlite.prepare(
      `SELECT sr.*, gr.full_name, gr.default_branch
       FROM space_repositories sr JOIN github_repositories gr ON gr.id = sr.github_repository_id
       WHERE sr.id = 'spr_update'`
    ).get()],
    getSpaceById: (_spaceId: string) => ({ snapshotStatus }),
    markSpaceStale: (_spaceId: string) => { snapshotStatus = "stale"; }
  };
  const git = {
    fetchBranchState: async () => ({ branches: ["main"], commit: remoteCommit }),
    checkoutFetchedRemoteBranch: async () => {
      checkoutCount += 1;
      return remoteCommit;
    }
  };
  const cbm = {
    indexRepository: async () => {
      indexCount += 1;
      throw new Error("Mutable indexing must not run in snapshot-only mode");
    }
  };
  const snapshots = {
    buildSpaceSnapshot: async () => {
      snapshotCount += 1;
      return { version: 2 };
    }
  };
  const jobs = new JobRunner(database, 1);
  const operations = new OperationsService(
    database,
    { snapshotOnlyIndexing: true, cbmIndexMode: "fast" } as never,
    spaces as never,
    {} as never,
    git as never,
    cbm as never,
    snapshots as never,
    jobs
  );
  operations.registerJobHandlers();
  jobs.start();

  return {
    sqlite,
    jobs,
    operations,
    checkoutCalls: () => checkoutCount,
    indexCalls: () => indexCount,
    snapshotCalls: () => snapshotCount,
    close: () => {
      jobs.stop();
      sqlite.close();
    }
  };
}

async function waitForTerminalJob(jobs: JobRunner, jobId: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const status = jobs.getJob(jobId)?.status;
    if (status && ["succeeded", "failed", "cancelled", "skipped"].includes(status)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${jobId}`);
}
