import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/db/schema.js";
import { migrate } from "../src/db/migrate.js";
import { JobRunner } from "../src/services/jobRunner.js";
import { OperationsService } from "../src/services/operationsService.js";

function fixture(snapshotOnlyIndexing: boolean, cbmIndexMode: "fast" | "moderate" | "full" = "fast") {
  const sqlite = new Database(":memory:");
  migrate(sqlite);
  const database = { sqlite, db: drizzle(sqlite, { schema }) };
  const jobs = new JobRunner(database, 0);
  let sequence = 0;
  const repositories: Array<Record<string, unknown>> = [];
  const spaces = {
    assertSpaceAcceptsWork: (_spaceId: string) => undefined,
    addRepositoryToSpace: (spaceId: string, githubRepositoryId: string) => {
      const repository = {
        id: `spr_${++sequence}`,
        space_id: spaceId,
        github_repository_id: githubRepositoryId,
        selected_commit: null
      };
      repositories.push(repository);
      return repository;
    },
    listSpaceRepositories: (spaceId: string) => repositories.filter((repository) => repository.space_id === spaceId)
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
