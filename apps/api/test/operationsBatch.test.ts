import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/db/schema.js";
import { migrate } from "../src/db/migrate.js";
import { JobRunner } from "../src/services/jobRunner.js";
import { OperationsService } from "../src/services/operationsService.js";
import { SpaceService } from "../src/services/spaceService.js";

function fixture(snapshotOnlyIndexing: boolean, cbmIndexMode: "fast" | "moderate" | "full" = "fast") {
  const sqlite = new Database(":memory:");
  migrate(sqlite);
  const database = { sqlite, db: drizzle(sqlite, { schema }) };
  for (const id of ["spc_batch", "spc_single", "spc_sequential"]) {
    sqlite.prepare(
      `INSERT INTO spaces (id, name, slug, root_path, snapshot_status, snapshot_status_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'none', ?, ?, ?)`
    ).run(id, id, id, `/tmp/${id}`, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  }
  const jobs = new JobRunner(database, 0);
  let sequence = 0;
  const repositories: Array<Record<string, unknown>> = [];
  const spaces = {
    assertSpaceAcceptsWork: (_spaceId: string) => undefined,
    assertNoActiveSpaceJobs: (_spaceId: string) => undefined,
    assertRepositoriesCanBeAdded: (_spaceId: string, _repositoryIds: string[]) => undefined,
    addRepositoryToSpace: (spaceId: string, githubRepositoryId: string) => {
      const repository = {
        id: `spr_${++sequence}`,
        space_id: spaceId,
        github_repository_id: githubRepositoryId,
        selected_commit: null,
        clone_status: "not_cloned",
        index_status: "not_indexed",
        full_name: `owner/${githubRepositoryId}`
      };
      repositories.push(repository);
      return repository;
    },
    listSpaceRepositories: (spaceId: string) => repositories.filter((repository) => repository.space_id === spaceId),
    getSpaceRepository: (spaceRepositoryId: string) => repositories.find((repository) => repository.id === spaceRepositoryId)
  };
  const operations = new OperationsService(
    database,
    { snapshotOnlyIndexing, cbmIndexMode } as never,
    spaces as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    jobs
  );
  return { sqlite, jobs, operations };
}

test("batch ingestion creates one rebuild depending on every repository index", () => {
  const value = fixture(false);
  try {
    const result = value.operations.enqueueAddRepositories("spc_batch", ["repo_a", "repo_b", "repo_c"]);
    assert.equal(result.spaceRepositories.length, 3);
    assert.equal(result.jobs.filter((job) => job.type === "clone_space_repository").length, 3);
    assert.equal(result.jobs.filter((job) => job.type === "checkout_space_repository").length, 3);
    assert.equal(result.jobs.filter((job) => job.type === "index_space_repository").length, 3);
    assert.equal(result.jobs.filter((job) => job.type === "rebuild_space_snapshot").length, 1);
    const dependencies = value.jobs.getJobDependencies(result.snapshotJob.id) as Array<{ type: string }>;
    assert.equal(dependencies.length, 3);
    assert.equal(dependencies.every((dependency) => dependency.type === "index_space_repository"), true);
  } finally { value.sqlite.close(); }
});

test("snapshot-only batch avoids mutable duplicate indexes and keeps one rebuild", () => {
  const value = fixture(true, "full");
  try {
    const result = value.operations.enqueueAddRepositories("spc_batch", ["repo_a", "repo_b", "repo_c"]);
    assert.equal(result.jobs.some((job) => job.type === "index_space_repository"), false);
    assert.equal(result.jobs.filter((job) => job.type === "rebuild_space_snapshot").length, 1);
    const snapshotPayload = value.sqlite.prepare("SELECT payload_json FROM jobs WHERE id = ?")
      .get(result.snapshotJob.id) as { payload_json: string };
    assert.equal((JSON.parse(snapshotPayload.payload_json) as { mode: string }).mode, "full");
    const dependencies = value.jobs.getJobDependencies(result.snapshotJob.id) as Array<{ type: string }>;
    assert.equal(dependencies.length, 3);
    assert.equal(dependencies.every((dependency) => dependency.type === "checkout_space_repository"), true);
  } finally { value.sqlite.close(); }
});

test("single-repository ingestion preserves its response shape", () => {
  const value = fixture(false);
  try {
    const result = value.operations.enqueueAddRepository("spc_single", "repo_a");
    assert.equal(result.spaceRepository.github_repository_id, "repo_a");
    assert.deepEqual(result.jobs.map((job) => job.type), [
      "clone_space_repository",
      "checkout_space_repository",
      "index_space_repository",
      "rebuild_space_snapshot"
    ]);
  } finally { value.sqlite.close(); }
});

test("batch ingestion rejects empty batches and coalesces duplicate repository IDs", () => {
  const value = fixture(false);
  try {
    assert.throws(() => value.operations.enqueueAddRepositories("spc_batch", []), /between 1 and 50/);
    const result = value.operations.enqueueAddRepositories("spc_batch", ["repo_a", "repo_a"]);
    assert.equal(result.spaceRepositories.length, 1);
  } finally { value.sqlite.close(); }
});

test("sequential additions coalesce into one pending rebuild with every terminal dependency", () => {
  const value = fixture(false);
  try {
    const first = value.operations.enqueueAddRepository("spc_sequential", "repo_a");
    const second = value.operations.enqueueAddRepository("spc_sequential", "repo_b");
    const firstSnapshot = first.jobs.find((job) => job.type === "rebuild_space_snapshot");
    const secondSnapshot = second.jobs.find((job) => job.type === "rebuild_space_snapshot");
    assert.ok(firstSnapshot);
    assert.equal(secondSnapshot?.id, firstSnapshot.id);
    const snapshots = value.sqlite.prepare(
      "SELECT id, payload_json FROM jobs WHERE space_id = ? AND type = 'rebuild_space_snapshot'"
    ).all("spc_sequential") as Array<{ id: string; payload_json: string }>;
    assert.equal(snapshots.length, 1);
    assert.match((JSON.parse(snapshots[0]!.payload_json) as { inputFingerprint: string }).inputFingerprint, /^[a-f0-9]{64}$/u);
    const dependencies = value.jobs.getJobDependencies(firstSnapshot.id) as Array<{ type: string }>;
    assert.equal(dependencies.length, 2);
    assert.equal(dependencies.every((dependency) => dependency.type === "index_space_repository"), true);
  } finally { value.sqlite.close(); }
});

test("batch requests are idempotent and reject request ID reuse with different repositories", () => {
  const value = fixture(true);
  try {
    const first = value.operations.enqueueAddRepositories("spc_batch", ["repo_a", "repo_b"], "request-fixed");
    const repeated = value.operations.enqueueAddRepositories("spc_batch", ["repo_b", "repo_a"], "request-fixed");
    assert.equal(repeated.batch.id, first.batch.id);
    assert.equal((value.sqlite.prepare("SELECT COUNT(*) AS count FROM repository_batches").get() as { count: number }).count, 1);
    assert.equal((value.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count, 5);
    assert.throws(
      () => value.operations.enqueueAddRepositories("spc_batch", ["repo_c"], "request-fixed"),
      /different repositories/
    );
  } finally { value.sqlite.close(); }
});

test("cancel and retry operate on the complete repository batch", () => {
  const value = fixture(true);
  try {
    const created = value.operations.enqueueAddRepositories("spc_batch", ["repo_a", "repo_b"], "request-cancel");
    const cancelled = value.operations.cancelRepositoryBatch(created.batch.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(
      (value.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending', 'running')").get() as { count: number }).count,
      0
    );

    const retried = value.operations.retryRepositoryBatch(created.batch.id);
    assert.equal(retried.batch.status, "running");
    assert.notEqual(retried.snapshotJob?.id, created.snapshotJob.id);
    assert.equal(
      (value.sqlite.prepare("SELECT COUNT(*) AS count FROM repository_batch_jobs WHERE batch_id = ?").get(created.batch.id) as { count: number }).count,
      10
    );
  } finally { value.sqlite.close(); }
});

test("batch validation and enqueue are atomic when a later repository insert fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-batch-atomic-"));
  const sqlite = new Database(":memory:");
  migrate(sqlite);
  const database = { sqlite, db: drizzle(sqlite, { schema }) };
  const config = {
    memorepoHome: root,
    spacesDir: path.join(root, "spaces"),
    repoIndexesDir: path.join(root, "indexes", "repositories"),
    snapshotIndexesDir: path.join(root, "indexes", "snapshots"),
    revisionSourcesDir: path.join(root, "indexes", "sources"),
    tmpDir: path.join(root, "tmp"),
    snapshotOnlyIndexing: true,
    cbmIndexMode: "fast"
  } as never;
  const spaces = new SpaceService(database, config, {} as never);
  const space = spaces.createSpace("Atomic Batch");
  const timestamp = new Date().toISOString();
  for (const [id, name] of [["repo_a", "alpha"], ["repo_b", "beta"]]) {
    sqlite.prepare(
      `INSERT INTO github_repositories
       (id, github_id, owner, name, full_name, html_url, clone_url, default_branch, private, archived, fork, topics_json, last_seen_at, created_at, updated_at)
       VALUES (?, ?, 'owner', ?, ?, ?, ?, 'main', 0, 0, 0, '[]', ?, ?, ?)`
    ).run(id, id === "repo_a" ? 1 : 2, name, `owner/${name}`, `https://example.invalid/${name}`, `https://example.invalid/${name}.git`, timestamp, timestamp, timestamp);
  }
  const jobs = new JobRunner(database, 0);
  const operations = new OperationsService(database, config, spaces, {} as never, {} as never, {} as never, {} as never, jobs);

  try {
    assert.throws(
      () => operations.enqueueAddRepositories(space.id, ["repo_a", "missing"], "request-validation"),
      /not found/
    );
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM space_repositories").get() as { count: number }).count, 0);

    sqlite.exec(`
      CREATE TRIGGER fail_second_repository BEFORE INSERT ON space_repositories
      WHEN NEW.github_repository_id = 'repo_b'
      BEGIN
        SELECT RAISE(ABORT, 'forced second insert failure');
      END;
    `);
    assert.throws(
      () => operations.enqueueAddRepositories(space.id, ["repo_a", "repo_b"], "request-atomic"),
      /forced second insert failure/
    );
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM space_repositories").get() as { count: number }).count, 0);
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM repository_batches").get() as { count: number }).count, 0);
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count, 0);
  } finally {
    sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
