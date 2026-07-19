import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/connection.js";
import { publicJobSelectColumns } from "../db/jobProjection.js";
import { insertRecord, type SqlValue, updateRecord } from "../db/sql.js";
import { NotFoundError } from "../domain/errors.js";
import { assertDeletableManagedPath, removeManagedPath, type ManagedPathRemoval } from "../domain/files.js";
import { createId, sha256 } from "../domain/ids.js";
import { assertInside, ensureInsideDir, repoPathName } from "../domain/paths.js";
import { slugify } from "../domain/slug.js";
import { nowIso } from "../domain/time.js";
import type { CbmService } from "./cbmService.js";

export class SpaceService {
  private readonly deletionStates = new Map<string, SpaceDeletionState>();
  private readonly deletionTombstonesDir: string;

  constructor(
    private readonly database: AppDatabase,
    private readonly config: AppConfig,
    private readonly cbm: CbmService
  ) {
    ensurePlainManagedDirectory(this.config.memorepoHome, this.config.spacesDir, "Managed spaces root");
    ensurePlainManagedDirectory(this.config.memorepoHome, this.config.repoIndexesDir, "Repository index root");
    ensurePlainManagedDirectory(this.config.memorepoHome, this.config.snapshotIndexesDir, "Snapshot index root");
    this.deletionTombstonesDir = ensurePlainManagedDirectory(
      this.config.memorepoHome,
      path.join(this.config.tmpDir, "space-deletions"),
      "Space deletion journal root"
    );
    this.recoverSpaceDeletionTombstones();
  }

  assertSpaceAcceptsWork(spaceId: string): void {
    if (this.deletionStates.get(spaceId)?.deleting) {
      throw spaceDeletionConflict();
    }
    this.getSpaceById(spaceId);
  }

  async withSpaceReader<T>(spaceId: string, operation: () => Promise<T> | T): Promise<T> {
    const release = this.acquireSpaceReader(spaceId);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async withSpaceReaderBySlug<T>(slug: string, operation: () => Promise<T> | T): Promise<T> {
    const space = this.getSpaceBySlug(slug);
    return this.withSpaceReader(space.id, operation);
  }

  listSpaces() {
    return this.database.sqlite
      .prepare(
        `
        SELECT
          s.*,
          COUNT(sr.id) AS repository_count
        FROM spaces s
        LEFT JOIN space_repositories sr
          ON sr.space_id = s.id
         AND sr.removed_at IS NULL
        GROUP BY s.id
        ORDER BY s.created_at ASC
      `
      )
      .all();
  }

  createSpace(name: string) {
    const timestamp = nowIso();
    const id = createId("spc");
    const slug = this.createUniqueSlug(name);
    const rootName = `${slug}__${sha256(id).slice(0, 32)}`;
    const rootPath = ensureInsideDir(this.config.memorepoHome, path.join(this.config.spacesDir, rootName));

    const record = {
      id,
      name: name.trim(),
      slug,
      rootPath,
      activeSnapshotId: null,
      snapshotStatus: "none",
      snapshotStatusUpdatedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    insertRecord(this.database, "spaces", record);
    return record;
  }

  renameSpace(id: string, name: string) {
    this.assertSpaceAcceptsWork(id);
    const timestamp = nowIso();
    updateRecord(this.database, "spaces", { name: name.trim(), updatedAt: timestamp }, "id", id);
    return this.getSpaceById(id);
  }

  deleteSpace(id: string) {
    this.assertSpaceAcceptsWork(id);
    const space = this.getSpaceById(id);
    this.assertNoActiveAgentTurns(id);
    const counts = this.database.sqlite
      .prepare(
        `
        SELECT
          (SELECT COUNT(*) FROM space_repositories WHERE space_id = ?) AS repositoryCount,
          (SELECT COUNT(*) FROM space_snapshots WHERE space_id = ?) AS snapshotCount,
          (SELECT COUNT(*) FROM jobs WHERE space_id = ?) AS jobCount
      `
      )
      .get(id, id, id) as DeleteSpaceCounts;

    if (counts.repositoryCount > 0 || counts.snapshotCount > 0 || counts.jobCount > 0) {
      throw new Error("Space must not have repositories, snapshots, or jobs before it can be deleted");
    }

    const safeRootPath = assertInside(this.config.memorepoHome, space.rootPath);
    const relativePath = path.relative(path.resolve(this.config.memorepoHome), safeRootPath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error("Refusing to delete MEMOREPO_HOME itself");
    }

    const deletedAt = nowIso();
    let connectionsDeleted = 0;
    let toolStatsDeleted = 0;
    this.database.sqlite.transaction(() => {
      toolStatsDeleted = this.database.sqlite.prepare("DELETE FROM mcp_tool_stats WHERE space_id = ?").run(id).changes;
      connectionsDeleted = this.database.sqlite.prepare("DELETE FROM mcp_connections WHERE space_id = ?").run(id).changes;
      this.database.sqlite.prepare("DELETE FROM spaces WHERE id = ?").run(id);
      this.database.sqlite
        .prepare(
          `DELETE FROM agent_account_sessions
           WHERE NOT EXISTS (
             SELECT 1 FROM agent_chats c WHERE c.account_session_id = agent_account_sessions.id
           )`
        )
        .run();
    })();

    const filesExisted = fs.existsSync(safeRootPath);
    if (filesExisted) {
      fs.rmSync(safeRootPath, { recursive: true, force: true });
    }

    return { deletedAt, spaceId: id, connectionsDeleted, toolStatsDeleted, filesExisted };
  }

  async deleteSpaceWithManagedData(id: string) {
    const releaseDeletion = this.beginSpaceDeletion(id);
    try {
      const space = this.getSpaceById(id);
      this.assertNoActiveSpaceJobs(id);
      this.assertNoActiveAgentTurns(id);

      const repositories = this.database.sqlite
        .prepare("SELECT id, local_path AS localPath FROM space_repositories WHERE space_id = ?")
        .all(id) as Array<{ id: string; localPath: string }>;
      const snapshots = this.database.sqlite
        .prepare("SELECT artifact_path AS artifactPath FROM space_snapshots WHERE space_id = ?")
        .all(id) as Array<{ artifactPath: string }>;
      const repoIndexes = this.database.sqlite
        .prepare(
          `
          SELECT DISTINCT ri.cache_path AS cachePath
          FROM repo_indexes ri
          JOIN space_repositories sr ON sr.id = ri.space_repository_id
          WHERE sr.space_id = ?
        `
        )
        .all(id) as Array<{ cachePath: string }>;

      await this.waitForSpaceReaders(id);
      for (const snapshot of snapshots) {
        await this.cbm.closeSession(snapshot.artifactPath);
      }

      const deletedAt = nowIso();
      const tombstone = this.createSpaceDeletionTombstone(id, deletedAt, {
        clonePaths: repositories.map((repository) => repository.localPath),
        repoIndexPaths: repoIndexes.map((row) => row.cachePath),
        snapshotArtifactPaths: snapshots.map((row) => row.artifactPath),
        spaceRootPath: space.rootPath
      });
      const tombstonePath = this.writeSpaceDeletionTombstone(tombstone);

      let connectionsDeleted = 0;
      let jobsDeleted = 0;
      let toolStatsDeleted = 0;
      try {
        // Nothing asynchronous or filesystem-related may be inserted between these checks and the transaction.
        this.assertNoActiveSpaceJobs(id);
        this.assertNoActiveAgentTurns(id);
        this.database.sqlite.transaction(() => {
          // Repeat under SQLite's transaction lock so another process cannot win the final check/delete race.
          this.assertNoActiveSpaceJobs(id);
          this.assertNoActiveAgentTurns(id);
          this.database.sqlite
            .prepare(
              `DELETE FROM job_events
               WHERE job_id IN (
                 SELECT j.id
                 FROM jobs j
                 LEFT JOIN space_repositories sr ON sr.id = j.space_repository_id
                 WHERE j.space_id = ? OR sr.space_id = ?
               )`
            )
            .run(id, id);
          jobsDeleted = this.database.sqlite
            .prepare(
              `DELETE FROM jobs
               WHERE space_id = ?
                  OR space_repository_id IN (
                    SELECT id FROM space_repositories WHERE space_id = ?
                  )`
            )
            .run(id, id).changes;
          toolStatsDeleted = this.database.sqlite.prepare("DELETE FROM mcp_tool_stats WHERE space_id = ?").run(id).changes;
          connectionsDeleted = this.database.sqlite.prepare("DELETE FROM mcp_connections WHERE space_id = ?").run(id).changes;
          this.database.sqlite
            .prepare(
              `DELETE FROM repo_indexes
               WHERE space_repository_id IN (
                 SELECT id FROM space_repositories WHERE space_id = ?
               )`
            )
            .run(id);
          this.database.sqlite.prepare("DELETE FROM space_snapshots WHERE space_id = ?").run(id);
          this.database.sqlite.prepare("DELETE FROM space_repositories WHERE space_id = ?").run(id);
          this.database.sqlite.prepare("DELETE FROM spaces WHERE id = ?").run(id);
          this.database.sqlite
            .prepare(
              `DELETE FROM agent_account_sessions
               WHERE NOT EXISTS (
                 SELECT 1 FROM agent_chats c WHERE c.account_session_id = agent_account_sessions.id
               )`
            )
            .run();
        })();
      } catch (error) {
        removeFileIfPresent(tombstonePath);
        throw error;
      }

      let cleanup: SpaceDeletionCleanup = { removedPaths: [], pending: true };
      try {
        cleanup = this.retrySpaceDeletionCleanup(tombstonePath, tombstone);
      } catch {
        // The database deletion already committed; the durable journal preserves cleanup for startup recovery.
      }
      return {
        deletedAt,
        spaceId: id,
        deletedBytes: cleanup.removedPaths.reduce((total, item) => total + item.sizeBytes, 0),
        filesDeleted: cleanup.removedPaths.filter((item) => item.existed).length,
        cleanupPending: cleanup.pending,
        repositoriesDeleted: repositories.length,
        snapshotsDeleted: snapshots.length,
        repoIndexPathsDeleted: uniqueManagedPaths(repoIndexes.map((row) => row.cachePath)).length,
        jobsDeleted,
        connectionsDeleted,
        toolStatsDeleted
      };
    } finally {
      releaseDeletion();
    }
  }

  private assertNoActiveSpaceJobs(spaceId: string): void {
    const activeJob = this.spaceJobRows(spaceId).find((job) => job.status === "pending" || job.status === "running");
    if (activeJob) {
      throw Object.assign(new Error("Space has pending or running jobs"), { statusCode: 409 });
    }
  }

  private acquireSpaceReader(spaceId: string): () => void {
    const state = this.spaceDeletionState(spaceId);
    if (state.deleting) {
      throw spaceDeletionConflict();
    }
    state.activeReaders += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.activeReaders -= 1;
      if (state.activeReaders === 0) {
        for (const resolve of state.readerDrainWaiters) resolve();
        state.readerDrainWaiters.clear();
        if (!state.deleting) this.deletionStates.delete(spaceId);
      }
    };
  }

  private beginSpaceDeletion(spaceId: string): () => void {
    const state = this.spaceDeletionState(spaceId);
    if (state.deleting) {
      throw spaceDeletionConflict();
    }
    state.deleting = true;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.deleting = false;
      if (state.activeReaders === 0) this.deletionStates.delete(spaceId);
    };
  }

  private waitForSpaceReaders(spaceId: string): Promise<void> {
    const state = this.deletionStates.get(spaceId);
    if (!state || state.activeReaders === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => state.readerDrainWaiters.add(resolve));
  }

  private spaceDeletionState(spaceId: string): SpaceDeletionState {
    const current = this.deletionStates.get(spaceId);
    if (current) return current;
    const created: SpaceDeletionState = {
      deleting: false,
      activeReaders: 0,
      readerDrainWaiters: new Set()
    };
    this.deletionStates.set(spaceId, created);
    return created;
  }

  private createSpaceDeletionTombstone(
    spaceId: string,
    createdAt: string,
    paths: Omit<SpaceDeletionTombstone, "version" | "spaceId" | "createdAt">
  ): SpaceDeletionTombstone {
    return {
      version: 1,
      spaceId,
      createdAt,
      clonePaths: validateManagedDeletionPaths(paths.clonePaths, this.config.spacesDir),
      repoIndexPaths: validateManagedDeletionPaths(paths.repoIndexPaths, this.config.repoIndexesDir),
      snapshotArtifactPaths: validateManagedDeletionPaths(paths.snapshotArtifactPaths, this.config.snapshotIndexesDir),
      spaceRootPath: assertDeletableManagedPath(this.config.spacesDir, paths.spaceRootPath)
    };
  }

  private writeSpaceDeletionTombstone(tombstone: SpaceDeletionTombstone): string {
    const targetPath = path.join(this.deletionTombstonesDir, `${sha256(tombstone.spaceId)}.json`);
    writeDurableJson(targetPath, tombstone);
    return targetPath;
  }

  private retrySpaceDeletionCleanup(tombstonePath: string, tombstone: SpaceDeletionTombstone): SpaceDeletionCleanup {
    const safeTombstone = this.createSpaceDeletionTombstone(tombstone.spaceId, tombstone.createdAt, tombstone);
    this.assertNoLiveManagedPathOverlap(safeTombstone);
    const targets = [
      ...safeTombstone.repoIndexPaths.map((targetPath) => ({ root: this.config.repoIndexesDir, targetPath })),
      ...safeTombstone.snapshotArtifactPaths.map((targetPath) => ({ root: this.config.snapshotIndexesDir, targetPath })),
      ...safeTombstone.clonePaths.map((targetPath) => ({ root: this.config.spacesDir, targetPath })),
      { root: this.config.spacesDir, targetPath: safeTombstone.spaceRootPath }
    ];
    const removedPaths: ManagedPathRemoval[] = [];
    let cleanupFailed = false;
    for (const target of targets) {
      try {
        removedPaths.push(removeManagedDeletionPath(this.config.memorepoHome, target.root, target.targetPath));
      } catch {
        // The durable tombstone keeps failed paths available for the next startup retry.
        cleanupFailed = true;
      }
    }

    const managedPathPending = cleanupFailed
      || targets.some((target) => managedPathExists(target.root, target.targetPath));
    const tombstoneRemoved = managedPathPending ? false : removeFileIfPresent(tombstonePath);
    return { removedPaths, pending: managedPathPending || !tombstoneRemoved };
  }

  private assertNoLiveManagedPathOverlap(tombstone: SpaceDeletionTombstone): void {
    const livePaths = this.database.sqlite
      .prepare(
        `SELECT root_path AS targetPath FROM spaces
         UNION ALL SELECT local_path AS targetPath FROM space_repositories
         UNION ALL SELECT cache_path AS targetPath FROM repo_indexes
         UNION ALL SELECT artifact_path AS targetPath FROM space_snapshots`
      )
      .all() as Array<{ targetPath: string }>;
    const deletionTargets = uniqueManagedPaths([
      ...tombstone.clonePaths,
      ...tombstone.repoIndexPaths,
      ...tombstone.snapshotArtifactPaths,
      tombstone.spaceRootPath
    ]);

    for (const deletionTarget of deletionTargets) {
      for (const live of livePaths) {
        if (managedPathsOverlap(deletionTarget, live.targetPath)) {
          throw new Error("Space deletion journal overlaps live managed data");
        }
      }
    }
  }

  private recoverSpaceDeletionTombstones(): void {
    for (const entry of fs.readdirSync(this.deletionTombstonesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const tombstonePath = path.join(this.deletionTombstonesDir, entry.name);
      const tombstone = readSpaceDeletionTombstone(tombstonePath);
      if (!tombstone) continue;
      if (entry.name !== `${sha256(tombstone.spaceId)}.json`) continue;

      const spaceStillExists = Boolean(this.database.sqlite.prepare("SELECT 1 FROM spaces WHERE id = ?").get(tombstone.spaceId));
      if (spaceStillExists) {
        removeFileIfPresent(tombstonePath);
        continue;
      }
      try {
        this.retrySpaceDeletionCleanup(tombstonePath, tombstone);
      } catch {
        // Invalid or unsafe journals remain untouched for explicit operator review.
      }
    }
  }

  private assertNoActiveAgentTurns(spaceId: string): void {
    const active = this.database.sqlite
      .prepare(
        `SELECT 1
         FROM agent_turns t
         JOIN agent_chats c ON c.id = t.chat_id
         WHERE c.space_id = ? AND t.status IN ('queued', 'pending', 'running')
         LIMIT 1`
      )
      .get(spaceId);
    if (active) {
      throw Object.assign(new Error("Wait for active agent answers before deleting this Space"), {
        statusCode: 409
      });
    }
  }

  getSpaceById(id: string) {
    const record = this.database.sqlite.prepare(INTERNAL_SPACE_SELECT + " WHERE id = ?").get(id) as SpaceRecord | undefined;
    if (!record) {
      throw new NotFoundError("Space not found");
    }
    return record;
  }

  getSpaceBySlug(slug: string) {
    const record = this.database.sqlite.prepare(INTERNAL_SPACE_SELECT + " WHERE slug = ?").get(slug) as SpaceRecord | undefined;
    if (!record) {
      throw new NotFoundError("Space not found");
    }
    return record;
  }

  reconcileSpaceFilesystem(spaceId: string) {
    this.getSpaceById(spaceId);
    const rows = this.database.sqlite
      .prepare(
        `
        SELECT
          id,
          local_path,
          clone_status,
          snapshot_included,
          removed_at
        FROM space_repositories
        WHERE space_id = ?
      `
      )
      .all(spaceId) as ReconcileSpaceRepositoryRow[];

    const reconciledAt = nowIso();
    let changed = 0;
    let shouldMarkStale = false;

    for (const row of rows) {
      const safePath = assertInside(this.config.memorepoHome, row.local_path);
      const pathExists = fs.existsSync(safePath);
      const hasGitClone = fs.existsSync(path.join(safePath, ".git"));
      const updates: Record<string, SqlValue> = {};

      if (!hasGitClone) {
        if (row.removed_at && !pathExists && row.clone_status !== "cleaned") {
          updates.cloneStatus = "cleaned";
          updates.indexStatus = "not_indexed";
          updates.snapshotIncluded = false;
        }

        if (!row.removed_at && row.clone_status !== "not_cloned") {
          updates.cloneStatus = "not_cloned";
          updates.indexStatus = "not_indexed";
          updates.snapshotIncluded = false;
          updates.selectedCommit = null;
          updates.remoteRef = null;
          updates.lastError = pathExists ? "Local repository path is not a Git clone" : "Local repository path is missing";
        }
      }

      if (Object.keys(updates).length > 0) {
        updates.updatedAt = reconciledAt;
        updateRecord(this.database, "space_repositories", updates, "id", row.id);
        changed += 1;
        shouldMarkStale ||= !row.removed_at && row.snapshot_included === 1;
      }
    }

    if (shouldMarkStale) {
      this.markSpaceStale(spaceId);
    }

    return { reconciledAt, checked: rows.length, changed };
  }

  listGitHubRepositories(query?: string, kind: RepositoryKindFilter = "all") {
    const trimmed = query?.trim();
    const clauses: string[] = [];
    const params: string[] = [];

    if (trimmed) {
      const pattern = `%${trimmed.replace(/[\\%_]/g, "\\$&")}%`;
      clauses.push("(full_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }

    if (kind === "forks") {
      clauses.push("fork = 1");
    }
    if (kind === "archived") {
      clauses.push("archived = 1");
    }
    if (kind === "private") {
      clauses.push("private = 1");
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database.sqlite.prepare(`SELECT * FROM github_repositories ${where} ORDER BY full_name ASC LIMIT 100`).all(...params);
  }

  addRepositoryToSpace(spaceId: string, githubRepositoryId: string) {
    const space = this.getSpaceById(spaceId);
    const repository = this.database.sqlite
      .prepare("SELECT * FROM github_repositories WHERE id = ?")
      .get(githubRepositoryId) as { owner: string; name: string } | undefined;

    if (!repository) {
      throw new NotFoundError("GitHub repository not found");
    }

    const existing = this.database.sqlite
      .prepare(
        `
        SELECT id
        FROM space_repositories
        WHERE space_id = ?
          AND github_repository_id = ?
          AND removed_at IS NULL
      `
      )
      .get(spaceId, githubRepositoryId);

    if (existing) {
      throw new Error("Repository is already in this space");
    }

    const timestamp = nowIso();
    const id = createId("spr");
    const basePath = path.join(space.rootPath, repoPathName(repository.owner, repository.name));
    const localPath = fs.existsSync(basePath)
      ? path.join(space.rootPath, repoPathName(repository.owner, repository.name, id.slice(-6)))
      : basePath;

    const record = {
      id,
      spaceId,
      githubRepositoryId,
      localPath: ensureInsideDir(this.config.memorepoHome, localPath),
      selectedBranch: null,
      selectedCommit: null,
      remoteRef: null,
      cloneStatus: "not_cloned",
      indexStatus: "not_indexed",
      snapshotIncluded: false,
      branchesJson: "[]",
      lastFetchedAt: null,
      lastIndexedAt: null,
      lastError: null,
      removedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    insertRecord(this.database, "space_repositories", record);
    this.markSpaceStale(spaceId);
    return record;
  }

  listSpaceRepositories(spaceId: string) {
    return this.listSpaceRepositoriesByRemovalState(spaceId, false);
  }

  listRemovedSpaceRepositories(spaceId: string) {
    return this.listSpaceRepositoriesByRemovalState(spaceId, true, { pendingCleanupOnly: true });
  }

  private listSpaceRepositoriesByRemovalState(
    spaceId: string,
    removed: boolean,
    options: { pendingCleanupOnly?: boolean } = {}
  ) {
    const pendingCleanupClause = options.pendingCleanupOnly
      ? "AND NOT (sr.clone_status = 'cleaned' AND sr.index_status = 'not_indexed')"
      : "";
    return this.database.sqlite
      .prepare(
        `
        SELECT
          sr.*,
          gr.owner,
          gr.name,
          gr.full_name,
          gr.html_url,
          gr.clone_url,
          gr.default_branch,
          gr.private,
          gr.archived,
          gr.fork,
          gr.description,
          gr.topics_json,
          gr.pushed_at
        FROM space_repositories sr
        JOIN github_repositories gr ON gr.id = sr.github_repository_id
        WHERE sr.space_id = ?
          AND sr.removed_at IS ${removed ? "NOT NULL" : "NULL"}
          ${pendingCleanupClause}
        ORDER BY ${removed ? "sr.removed_at DESC" : "gr.full_name ASC"}
      `
      )
      .all(spaceId);
  }

  getSpaceRepository(spaceRepositoryId: string) {
    const record = this.database.sqlite
      .prepare(
        `
        SELECT
          sr.*,
          gr.owner,
          gr.name,
          gr.full_name,
          gr.html_url,
          gr.clone_url,
          gr.default_branch,
          gr.private,
          gr.archived,
          gr.fork,
          gr.description,
          gr.topics_json,
          gr.pushed_at
        FROM space_repositories sr
        JOIN github_repositories gr ON gr.id = sr.github_repository_id
        WHERE sr.id = ?
      `
      )
      .get(spaceRepositoryId);

    if (!record) {
      throw new NotFoundError("Space repository not found");
    }

    return record as SpaceRepositoryRecord;
  }

  softRemoveSpaceRepository(spaceRepositoryId: string) {
    const record = this.getSpaceRepository(spaceRepositoryId);
    const timestamp = nowIso();
    const space = this.getSpaceById(record.space_id);
    const revokedSnapshotId = record.snapshot_included === 1 ? space.activeSnapshotId : null;

    this.database.sqlite.transaction(() => {
      updateRecord(
        this.database,
        "space_repositories",
        {
          removedAt: timestamp,
          snapshotIncluded: false,
          updatedAt: timestamp
        },
        "id",
        spaceRepositoryId
      );

      if (revokedSnapshotId) {
        updateRecord(this.database, "space_snapshots", { status: "inactive" }, "id", revokedSnapshotId);
        updateRecord(
          this.database,
          "spaces",
          {
            activeSnapshotId: null,
            snapshotStatus: "revoked",
            snapshotStatusUpdatedAt: timestamp,
            updatedAt: timestamp
          },
          "id",
          record.space_id
        );
      } else {
        this.markSpaceStale(record.space_id);
      }
    })();

    return { removedAt: timestamp, revokedSnapshotId };
  }

  cleanupSpaceRepositoryFiles(spaceRepositoryId: string) {
    const record = this.getSpaceRepository(spaceRepositoryId);
    if (!record.removed_at) {
      throw new Error("Repository must be removed from the space before files can be cleaned");
    }

    const activeJobs = this.database.sqlite
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM jobs
        WHERE space_repository_id = ?
          AND status IN ('pending', 'running')
      `
      )
      .get(spaceRepositoryId) as { count: number };

    if (activeJobs.count > 0) {
      throw new Error("Repository has pending or running jobs");
    }

    const safePath = assertInside(this.config.memorepoHome, record.local_path);
    const relativePath = path.relative(path.resolve(this.config.memorepoHome), safePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error("Refusing to clean MEMOREPO_HOME itself");
    }

    const existed = fs.existsSync(safePath);
    if (existed) {
      fs.rmSync(safePath, { recursive: true, force: true });
    }

    const cleanedAt = nowIso();
    updateRecord(
      this.database,
      "space_repositories",
      {
        cloneStatus: "cleaned",
        indexStatus: "not_indexed",
        snapshotIncluded: false,
        lastError: null,
        updatedAt: cleanedAt
      },
      "id",
      spaceRepositoryId
    );

    return { cleanedAt, existed };
  }

  markSpaceStale(spaceId: string) {
    const space = this.getSpaceById(spaceId);
    const timestamp = nowIso();
    updateRecord(
      this.database,
      "spaces",
      {
        snapshotStatus: space.activeSnapshotId ? "stale" : "none",
        snapshotStatusUpdatedAt: timestamp,
        updatedAt: timestamp
      },
      "id",
      spaceId
    );
  }

  latestJobs(limit = 25) {
    return this.database.sqlite
      .prepare(
        `
        SELECT
          ${publicJobSelectColumns("j")},
          d.status AS dependency_status,
          d.type AS dependency_type
        FROM jobs j
        LEFT JOIN jobs d ON d.id = j.depends_on_job_id
        ORDER BY j.created_at DESC
        LIMIT ?
      `
      )
      .all(limit);
  }

  private spaceJobRows(spaceId: string): SpaceJobRow[] {
    return this.database.sqlite
      .prepare(
        `
        SELECT DISTINCT
          j.id,
          j.status
        FROM jobs j
        LEFT JOIN space_repositories sr ON sr.id = j.space_repository_id
        WHERE j.space_id = ?
           OR sr.space_id = ?
      `
      )
      .all(spaceId, spaceId) as SpaceJobRow[];
  }

  private createUniqueSlug(name: string): string {
    const base = slugify(name);
    for (let index = 0; index < 100; index += 1) {
      const candidate = index === 0 ? base : `${base}-${index + 1}`;
      const existing = this.database.sqlite.prepare("SELECT id FROM spaces WHERE slug = ?").get(candidate);
      if (!existing) {
        return candidate;
      }
    }
    return `${base}-${Date.now()}`;
  }
}

export type RepositoryKindFilter = "all" | "forks" | "archived" | "private";

const INTERNAL_SPACE_SELECT = `
  SELECT
    id,
    name,
    slug,
    root_path AS rootPath,
    active_snapshot_id AS activeSnapshotId,
    snapshot_status AS snapshotStatus,
    snapshot_status_updated_at AS snapshotStatusUpdatedAt,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM spaces
`;

export interface SpaceRecord {
  id: string;
  name: string;
  slug: string;
  rootPath: string;
  activeSnapshotId: string | null;
  snapshotStatus: string;
  snapshotStatusUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

interface ReconcileSpaceRepositoryRow {
  id: string;
  local_path: string;
  clone_status: string;
  snapshot_included: number;
  removed_at: string | null;
}

interface DeleteSpaceCounts {
  repositoryCount: number;
  snapshotCount: number;
  jobCount: number;
}

interface SpaceJobRow {
  id: string;
  status: string;
}

interface SpaceDeletionState {
  deleting: boolean;
  activeReaders: number;
  readerDrainWaiters: Set<() => void>;
}

interface SpaceDeletionTombstone {
  version: 1;
  spaceId: string;
  createdAt: string;
  clonePaths: string[];
  repoIndexPaths: string[];
  snapshotArtifactPaths: string[];
  spaceRootPath: string;
}

interface SpaceDeletionCleanup {
  removedPaths: ManagedPathRemoval[];
  pending: boolean;
}

export interface SpaceRepositoryRecord {
  id: string;
  space_id: string;
  github_repository_id: string;
  local_path: string;
  selected_branch: string | null;
  selected_commit: string | null;
  remote_ref: string | null;
  clone_status: string;
  index_status: string;
  snapshot_included: number;
  branches_json: string;
  last_fetched_at: string | null;
  last_indexed_at: string | null;
  last_error: string | null;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
  owner: string;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  default_branch: string;
  private: number;
  archived: number;
  fork: number;
  description: string | null;
  topics_json: string;
  pushed_at: string | null;
}

function spaceDeletionConflict(): Error {
  return Object.assign(new Error("Space deletion is in progress"), { statusCode: 409 });
}

function validateManagedDeletionPaths(paths: string[], allowedRoot: string): string[] {
  return uniqueManagedPaths(paths).map((targetPath) => assertDeletableManagedPath(allowedRoot, targetPath));
}

function uniqueManagedPaths(paths: string[]): string[] {
  const unique = new Map<string, string>();
  for (const targetPath of paths) {
    const resolved = path.resolve(targetPath);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!unique.has(key)) unique.set(key, resolved);
  }
  return [...unique.values()];
}

function managedPathExists(allowedRoot: string, targetPath: string): boolean {
  try {
    fs.lstatSync(assertDeletableManagedPath(allowedRoot, targetPath));
    return true;
  } catch (error) {
    return !isMissingPathError(error);
  }
}

function removeManagedDeletionPath(
  memorepoHome: string,
  allowedRoot: string,
  targetPath: string
): ManagedPathRemoval {
  const safeRoot = assertDeletableManagedPath(memorepoHome, allowedRoot);
  const safeTarget = assertDeletableManagedPath(safeRoot, targetPath);
  const realHome = fs.realpathSync(memorepoHome);
  const realRoot = assertPlainManagedDirectory(memorepoHome, safeRoot, "Managed deletion root");
  if (!isStrictlyInsidePath(realHome, realRoot)) {
    throw new Error("Managed deletion root escapes MEMOREPO_HOME");
  }

  let targetStat;
  try {
    targetStat = fs.lstatSync(safeTarget);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    assertNearestExistingParentInside(safeRoot, realRoot, path.dirname(safeTarget));
    return { path: safeTarget, existed: false, sizeBytes: 0 };
  }

  const realParent = fs.realpathSync(path.dirname(safeTarget));
  if (!isInsideOrEqualPath(realRoot, realParent)) {
    throw new Error("Managed deletion target parent escapes its configured root");
  }
  if (!targetStat.isSymbolicLink()) {
    const realTarget = fs.realpathSync(safeTarget);
    if (!isStrictlyInsidePath(realRoot, realTarget)) {
      throw new Error("Managed deletion target escapes its configured root");
    }
    return removeManagedPath(safeRoot, safeTarget);
  }

  fs.rmSync(safeTarget, { recursive: true, force: true });
  return { path: safeTarget, existed: true, sizeBytes: targetStat.size };
}

function ensurePlainManagedDirectory(memorepoHome: string, target: string, label: string): string {
  const safeTarget = assertInside(memorepoHome, target);
  const relative = path.relative(path.resolve(memorepoHome), safeTarget);
  let current = path.resolve(memorepoHome);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = ensureInsideDir(memorepoHome, path.join(current, segment));
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} must be a managed directory`);
    }
  }
  return safeTarget;
}

function assertPlainManagedDirectory(memorepoHome: string, target: string, label: string): string {
  const safeTarget = assertInside(memorepoHome, target);
  const relative = path.relative(path.resolve(memorepoHome), safeTarget);
  let current = path.resolve(memorepoHome);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = assertInside(memorepoHome, path.join(current, segment));
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} must be a managed directory`);
    }
  }
  return fs.realpathSync(safeTarget);
}

function assertNearestExistingParentInside(allowedRoot: string, realRoot: string, start: string): void {
  let current = assertInside(allowedRoot, start);
  while (true) {
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Managed deletion target parent must be a plain directory");
      }
      if (!isInsideOrEqualPath(realRoot, fs.realpathSync(current))) {
        throw new Error("Managed deletion target parent escapes its configured root");
      }
      return;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    if (samePath(current, allowedRoot)) {
      throw new Error("Managed deletion root is missing");
    }
    current = path.dirname(current);
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32"
    ? path.resolve(value).toLowerCase()
    : path.resolve(value);
  return normalize(left) === normalize(right);
}

function isInsideOrEqualPath(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isStrictlyInsidePath(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function managedPathsOverlap(left: string, right: string): boolean {
  return isInsideOrEqualPath(left, right) || isInsideOrEqualPath(right, left);
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function writeDurableJson(targetPath: string, value: unknown): void {
  const temporaryPath = `${targetPath}.${process.pid}.${createId("tmp")}`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, targetPath);
    syncDirectoryBestEffort(path.dirname(targetPath));
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    removeFileIfPresent(temporaryPath);
    throw error;
  }
}

function syncDirectoryBestEffort(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Directory fsync is not available on every supported platform.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function removeFileIfPresent(targetPath: string): boolean {
  try {
    fs.rmSync(targetPath, { force: true });
    return !fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function readSpaceDeletionTombstone(tombstonePath: string): SpaceDeletionTombstone | null {
  try {
    const value = JSON.parse(fs.readFileSync(tombstonePath, "utf8")) as unknown;
    if (!isRecord(value)
      || value.version !== 1
      || typeof value.spaceId !== "string"
      || typeof value.createdAt !== "string"
      || typeof value.spaceRootPath !== "string"
      || !isStringArray(value.clonePaths)
      || !isStringArray(value.repoIndexPaths)
      || !isStringArray(value.snapshotArtifactPaths)) {
      return null;
    }
    return value as unknown as SpaceDeletionTombstone;
  } catch {
    return null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
