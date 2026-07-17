import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { insertRecord, updateRecord } from "../src/db/sql.js";
import { createId, sha256 } from "../src/domain/ids.js";
import { nowIso } from "../src/domain/time.js";
import { createServices } from "../src/services/appServices.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const testsRoot = path.join(repoRoot, ".tmp-memorepo-tests");

test("managed deletion gates new work, waits for MCP readers, and revalidates jobs after session close", async () => {
  const testRoot = createTestRoot("space-delete-gate-");
  const services = createServices();

  try {
    const fixture = createSnapshotFixture(services, "Delete Gate Space");
    const listEntered = deferred<void>();
    const releaseList = deferred<string[]>();
    const closeEntered = deferred<void>();
    const releaseClose = deferred<void>();
    let closeCalls = 0;

    services.cbm.listTools = async () => {
      listEntered.resolve();
      return releaseList.promise;
    };
    services.cbm.closeSession = async () => {
      closeCalls += 1;
      closeEntered.resolve();
      await releaseClose.promise;
    };

    const activeReader = services.mcp.toolDefinitionsForSnapshot(fixture.space.id, fixture.snapshotId);
    await listEntered.promise;
    const deletion = services.spaces.deleteSpaceWithManagedData(fixture.space.id);
    await Promise.resolve();

    assert.equal(closeCalls, 0, "session close must wait until the active MCP reader exits");
    assert.throws(
      () => services.operations.enqueueReindexSpace(fixture.space.id),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    );
    assert.throws(
      () => services.spaces.renameSpace(fixture.space.id, "Renamed during deletion"),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    );
    await assert.rejects(
      () => services.mcp.toolDefinitionsForSnapshot(fixture.space.id, fixture.snapshotId),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    );

    releaseList.resolve(["list_projects", "query_graph"]);
    await activeReader;
    await closeEntered.promise;

    const jobId = createId("job");
    const timestamp = nowIso();
    insertRecord(services.database, "jobs", {
      id: jobId,
      type: "reindex_space",
      status: "pending",
      spaceId: fixture.space.id,
      spaceRepositoryId: null,
      dependsOnJobId: null,
      payloadJson: JSON.stringify({ spaceId: fixture.space.id }),
      deduplicationKey: null,
      error: null,
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null
    });
    insertRecord(services.database, "job_events", {
      id: createId("evt"),
      jobId,
      eventType: "status",
      message: "pending",
      createdAt: timestamp
    });

    releaseClose.resolve();
    await assert.rejects(
      deletion,
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    );
    assert.equal(fs.existsSync(fixture.snapshotPath), true);
    assert.equal(services.spaces.getSpaceById(fixture.space.id).id, fixture.space.id);

    updateRecord(
      services.database,
      "jobs",
      { status: "succeeded", startedAt: timestamp, finishedAt: nowIso() },
      "id",
      jobId
    );
    services.cbm.closeSession = async () => {};

    const result = await services.spaces.deleteSpaceWithManagedData(fixture.space.id);
    assert.equal(result.cleanupPending, false);
    assert.equal(result.jobsDeleted, 1);
    assert.equal(fs.existsSync(fixture.snapshotPath), false);
    assert.equal(services.database.sqlite.prepare("SELECT 1 FROM jobs WHERE id = ?").get(jobId), undefined);
    assert.equal(services.database.sqlite.prepare("SELECT 1 FROM job_events WHERE job_id = ?").get(jobId), undefined);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("startup retries a committed deletion tombstone for clone, repository index, and snapshot paths", () => {
  const testRoot = createTestRoot("space-delete-recovery-");
  const first = createServices();
  const space = first.spaces.createSpace("Recovery Space");
  const clonePath = path.join(space.rootPath, "repository");
  const repoIndexPath = path.join(first.config.repoIndexesDir, "recovery-index");
  const snapshotPath = path.join(first.config.snapshotIndexesDir, "recovery-snapshot");
  const tombstonesDir = path.join(first.config.tmpDir, "space-deletions");
  const tombstonePath = path.join(tombstonesDir, `${sha256(space.id)}.json`);

  try {
    for (const target of [clonePath, repoIndexPath, snapshotPath]) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "marker.txt"), "delete on recovery");
    }
    fs.writeFileSync(
      tombstonePath,
      JSON.stringify({
        version: 1,
        spaceId: space.id,
        createdAt: nowIso(),
        clonePaths: [clonePath],
        repoIndexPaths: [repoIndexPath],
        snapshotArtifactPaths: [snapshotPath],
        spaceRootPath: space.rootPath
      })
    );
    first.database.sqlite.prepare("DELETE FROM spaces WHERE id = ?").run(space.id);
    first.database.sqlite.close();

    const restarted = createServices();
    try {
      assert.equal(fs.existsSync(clonePath), false);
      assert.equal(fs.existsSync(repoIndexPath), false);
      assert.equal(fs.existsSync(snapshotPath), false);
      assert.equal(fs.existsSync(space.rootPath), false);
      assert.equal(fs.existsSync(tombstonePath), false);
    } finally {
      restarted.database.sqlite.close();
    }
  } finally {
    if (first.database.sqlite.open) first.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("startup discards a stale tombstone without touching files when the Space still exists", () => {
  const testRoot = createTestRoot("space-delete-stale-tombstone-");
  const first = createServices();
  const space = first.spaces.createSpace("Existing Space");
  const markerPath = path.join(space.rootPath, "keep.txt");
  const tombstonePath = path.join(first.config.tmpDir, "space-deletions", `${sha256(space.id)}.json`);

  try {
    fs.writeFileSync(markerPath, "keep");
    fs.writeFileSync(
      tombstonePath,
      JSON.stringify({
        version: 1,
        spaceId: space.id,
        createdAt: nowIso(),
        clonePaths: [space.rootPath],
        repoIndexPaths: [],
        snapshotArtifactPaths: [],
        spaceRootPath: space.rootPath
      })
    );
    first.database.sqlite.close();

    const restarted = createServices();
    try {
      assert.equal(fs.existsSync(markerPath), true);
      assert.equal(fs.existsSync(tombstonePath), false);
      assert.equal(restarted.spaces.getSpaceById(space.id).id, space.id);
    } finally {
      restarted.database.sqlite.close();
    }
  } finally {
    if (first.database.sqlite.open) first.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("startup leaves an unsafe tombstone untouched and never crosses a configured deletion root", () => {
  const testRoot = createTestRoot("space-delete-unsafe-tombstone-");
  const first = createServices();
  const space = first.spaces.createSpace("Unsafe Tombstone Space");
  const protectedPath = path.join(first.config.repoIndexesDir, "must-remain");
  const markerPath = path.join(protectedPath, "keep.txt");
  const tombstonePath = path.join(
    first.config.tmpDir,
    "space-deletions",
    `${sha256(space.id)}.json`
  );

  try {
    fs.mkdirSync(protectedPath, { recursive: true });
    fs.writeFileSync(markerPath, "keep");
    fs.writeFileSync(
      tombstonePath,
      JSON.stringify({
        version: 1,
        spaceId: space.id,
        createdAt: nowIso(),
        clonePaths: [protectedPath],
        repoIndexPaths: [],
        snapshotArtifactPaths: [],
        spaceRootPath: space.rootPath
      })
    );
    first.database.sqlite.prepare("DELETE FROM spaces WHERE id = ?").run(space.id);
    first.database.sqlite.close();

    const restarted = createServices();
    try {
      assert.equal(fs.existsSync(markerPath), true);
      assert.equal(fs.existsSync(tombstonePath), true);
    } finally {
      restarted.database.sqlite.close();
    }
  } finally {
    if (first.database.sqlite.open) first.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("startup never lets a tombstone delete another Space's live managed data", () => {
  const testRoot = createTestRoot("space-delete-live-overlap-");
  const first = createServices();
  const liveSpace = first.spaces.createSpace("Live Space");
  const markerPath = path.join(liveSpace.rootPath, "keep.txt");
  const deletedSpaceId = createId("spc");
  const tombstonePath = path.join(
    first.config.tmpDir,
    "space-deletions",
    `${sha256(deletedSpaceId)}.json`
  );

  try {
    fs.writeFileSync(markerPath, "keep");
    fs.writeFileSync(
      tombstonePath,
      JSON.stringify({
        version: 1,
        spaceId: deletedSpaceId,
        createdAt: nowIso(),
        clonePaths: [],
        repoIndexPaths: [],
        snapshotArtifactPaths: [],
        spaceRootPath: liveSpace.rootPath
      })
    );
    first.database.sqlite.close();

    const restarted = createServices();
    try {
      assert.equal(fs.existsSync(markerPath), true);
      assert.equal(fs.existsSync(tombstonePath), true);
      assert.equal(restarted.spaces.getSpaceById(liveSpace.id).id, liveSpace.id);
    } finally {
      restarted.database.sqlite.close();
    }
  } finally {
    if (first.database.sqlite.open) first.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("a recreated Space with the same slug never reuses a path retained by an older tombstone", () => {
  const testRoot = createTestRoot("space-delete-root-identity-");
  const first = createServices();
  const deletedSpace = first.spaces.createSpace("Reusable Name");
  const tombstonePath = path.join(
    first.config.tmpDir,
    "space-deletions",
    `${sha256(deletedSpace.id)}.json`
  );

  try {
    fs.writeFileSync(path.join(deletedSpace.rootPath, "old.txt"), "old");
    fs.writeFileSync(
      tombstonePath,
      JSON.stringify({
        version: 1,
        spaceId: deletedSpace.id,
        createdAt: nowIso(),
        clonePaths: [],
        repoIndexPaths: [],
        snapshotArtifactPaths: [],
        spaceRootPath: deletedSpace.rootPath
      })
    );
    first.database.sqlite.prepare("DELETE FROM spaces WHERE id = ?").run(deletedSpace.id);

    const recreated = first.spaces.createSpace("Reusable Name");
    const markerPath = path.join(recreated.rootPath, "keep.txt");
    fs.writeFileSync(markerPath, "keep");
    assert.equal(recreated.slug, deletedSpace.slug);
    assert.notEqual(recreated.rootPath, deletedSpace.rootPath);
    first.database.sqlite.close();

    const restarted = createServices();
    try {
      assert.equal(fs.existsSync(deletedSpace.rootPath), false);
      assert.equal(fs.existsSync(markerPath), true);
      assert.equal(fs.existsSync(tombstonePath), false);
      assert.equal(restarted.spaces.getSpaceById(recreated.id).id, recreated.id);
    } finally {
      restarted.database.sqlite.close();
    }
  } finally {
    if (first.database.sqlite.open) first.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("a failed deletion transaction preserves files and removes its tombstone", async () => {
  const testRoot = createTestRoot("space-delete-rollback-");
  const services = createServices();

  try {
    const space = services.spaces.createSpace("Rollback Space");
    const markerPath = path.join(space.rootPath, "keep.txt");
    fs.writeFileSync(markerPath, "keep");
    services.database.sqlite.exec(`
      CREATE TRIGGER block_managed_space_delete
      BEFORE DELETE ON spaces
      BEGIN
        SELECT RAISE(ABORT, 'blocked deletion');
      END;
    `);

    await assert.rejects(() => services.spaces.deleteSpaceWithManagedData(space.id), /blocked deletion/);
    assert.equal(fs.existsSync(markerPath), true);
    assert.equal(services.spaces.getSpaceById(space.id).id, space.id);
    const tombstones = fs.readdirSync(path.join(services.config.tmpDir, "space-deletions"));
    assert.deepEqual(tombstones, []);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

function createSnapshotFixture(services: ReturnType<typeof createServices>, name: string) {
  const space = services.spaces.createSpace(name);
  const timestamp = nowIso();
  const githubRepositoryId = createId("ghr");
  insertRecord(services.database, "github_repositories", {
    id: githubRepositoryId,
    githubId: Date.now(),
    owner: "example",
    name: "delete-fixture",
    fullName: `example/delete-fixture-${githubRepositoryId}`,
    htmlUrl: "https://github.com/example/delete-fixture",
    cloneUrl: "https://github.com/example/delete-fixture.git",
    defaultBranch: "main",
    private: false,
    archived: false,
    fork: false,
    description: null,
    topicsJson: "[]",
    pushedAt: timestamp,
    lastSeenAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const repository = services.spaces.addRepositoryToSpace(space.id, githubRepositoryId) as {
    id: string;
    localPath: string;
  };
  fs.writeFileSync(path.join(repository.localPath, "source.ts"), "export const ready = true;\n");

  const snapshotId = createId("snp");
  const snapshotPath = path.join(services.config.snapshotIndexesDir, snapshotId);
  const sourcePath = path.join(snapshotPath, "sources", repository.id, "delete-fixture");
  fs.mkdirSync(sourcePath, { recursive: true });
  fs.writeFileSync(path.join(sourcePath, "source.ts"), "export const ready = true;\n");
  insertRecord(services.database, "space_snapshots", {
    id: snapshotId,
    spaceId: space.id,
    version: 1,
    status: "active",
    artifactPath: snapshotPath,
    manifestJson: JSON.stringify({
      snapshotId,
      version: 1,
      createdAt: timestamp,
      repositories: [{
        spaceRepositoryId: repository.id,
        githubRepositoryId,
        fullName: "example/delete-fixture",
        branch: "main",
        commit: "0123456789abcdef",
        projectName: "delete-fixture",
        localPath: sourcePath
      }]
    }),
    createdAt: timestamp,
    activatedAt: timestamp,
    error: null
  });
  updateRecord(
    services.database,
    "spaces",
    { activeSnapshotId: snapshotId, snapshotStatus: "active", snapshotStatusUpdatedAt: timestamp, updatedAt: timestamp },
    "id",
    space.id
  );
  return { space, repository, snapshotId, snapshotPath };
}

function createTestRoot(prefix: string): string {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, prefix));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";
  delete process.env.GH_TOKEN;
  return testRoot;
}

function cleanupTestRoot(testRoot: string): void {
  fs.rmSync(testRoot, { recursive: true, force: true });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
