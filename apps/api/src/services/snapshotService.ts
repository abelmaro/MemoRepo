import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/connection.js";
import { insertRecord, updateRecord } from "../db/sql.js";
import { NotFoundError } from "../domain/errors.js";
import { assertDeletableManagedPath, managedPathSize, managedPathSizeAsync, removeManagedPath } from "../domain/files.js";
import { createId } from "../domain/ids.js";
import { assertInside, ensureInsideDir } from "../domain/paths.js";
import { sanitizePublicMessage } from "../domain/publicSanitize.js";
import { nowIso } from "../domain/time.js";
import type { CbmService } from "./cbmService.js";
import { createSafeProcessEnvironment, runProcess } from "./process.js";
import type { SpaceRepositoryRecord } from "./spaceService.js";

type SnapshotRepositoryMaterializer = (
  memorepoHome: string,
  repositoryPath: string,
  commit: string,
  targetPath: string,
  signal?: AbortSignal
) => Promise<void>;

export interface SnapshotManifestRepository {
  spaceRepositoryId: string;
  githubRepositoryId: string;
  fullName: string;
  branch: string;
  commit: string;
  projectName: string;
  localPath: string;
}

export interface SnapshotManifest {
  snapshotId: string;
  version: number;
  createdAt: string;
  repositories: SnapshotManifestRepository[];
}

export class SnapshotService {
  private readonly pruningSnapshotIds = new Set<string>();
  private readonly sourceMaterializations = new Map<string, Promise<string>>();
  private readonly snapshotSizeTasks = new Map<string, Promise<void>>();

  constructor(
    private readonly database: AppDatabase,
    private readonly config: AppConfig,
    private readonly cbm: CbmService,
    private readonly removeSnapshotArtifact: typeof removeManagedPath = removeManagedPath,
    private readonly materializeRepository: SnapshotRepositoryMaterializer = materializeGitRepository
  ) {
    this.reconcileInterruptedSnapshotBuilds();
    this.recoverInterruptedSnapshotPrunes();
    cleanupStaleSnapshotWorktrees(this.config.memorepoHome);
    cleanupStaleSnapshotIndexes(this.config.memorepoHome);
    ensurePlainManagedDirectory(this.config.memorepoHome, this.config.revisionSourcesDir, "Revision source root");
    cleanupOrphanedSnapshotArtifacts(this.database, this.config);
  }

  async buildSpaceSnapshot(spaceId: string, onOutput?: (line: string) => void, signal?: AbortSignal) {
    const activeRepos = this.getActiveRepositories(spaceId);
    if (activeRepos.length === 0) {
      throw new Error("Cannot build a snapshot for an empty space");
    }

    for (const repo of activeRepos) {
      if (repo.clone_status !== "cloned") {
        throw new Error(`${repo.full_name} is not cloned`);
      }
      if (!repo.selected_branch || !repo.selected_commit) {
        throw new Error(`${repo.full_name} has no selected branch and commit`);
      }
    }

    const version = this.nextVersion(spaceId);
    const snapshotId = createId("snp");
    const createdAt = nowIso();
    const versionName = `v${version.toString().padStart(6, "0")}`;
    const snapshotRoot = ensurePlainManagedDirectory(
      this.config.memorepoHome,
      this.config.snapshotIndexesDir,
      "Snapshot index root"
    );
    const artifactPath = ensureInsideDir(snapshotRoot, path.join(snapshotRoot, snapshotId));

    insertRecord(this.database, "space_snapshots", {
      id: snapshotId,
      spaceId,
      version,
      status: "building",
      artifactPath,
      manifestJson: JSON.stringify({ snapshotId, version, createdAt, repositories: [] }),
      createdAt,
      activatedAt: null,
      error: null,
      sizeBytes: null
    });

    this.updateSpaceSnapshotStatus(spaceId, "building");

    try {
      const manifestRepositories: SnapshotManifestRepository[] = [];
      const materializedRepositories: Array<{ repository: SpaceRepositoryRecord; sourcePath: string }> = [];

      for (const repo of activeRepos) {
        throwIfAborted(signal);
        const materializeStartedAt = Date.now();
        onOutput?.(`Indexing ${repo.full_name} into snapshot ${versionName}`);
        const sourcePath = await this.materializeRevisionSource(repo, signal);
        onOutput?.(`Snapshot source prepared in ${formatDuration(Date.now() - materializeStartedAt)}`);
        const indexStartedAt = Date.now();
        const result = await this.cbm.indexRepository(sourcePath, artifactPath, "fast", onOutput, signal);
        onOutput?.(`Snapshot index for ${repo.full_name} completed in ${formatDuration(Date.now() - indexStartedAt)}`);
        const projectName = result.project ?? this.projectNameFromPath(sourcePath);
        materializedRepositories.push({ repository: repo, sourcePath });
        manifestRepositories.push({
          spaceRepositoryId: repo.id,
          githubRepositoryId: repo.github_repository_id,
          fullName: repo.full_name,
          branch: repo.selected_branch!,
          commit: repo.selected_commit!,
          projectName,
          localPath: sourcePath
        });
      }

      if (materializedRepositories.length > 1) {
        for (const { repository, sourcePath } of materializedRepositories) {
          onOutput?.(`Linking cross-repo intelligence for ${repository.full_name}`);
          await this.cbm.buildCrossRepoLinks(sourcePath, artifactPath, onOutput, signal);
        }
      }

      const manifest: SnapshotManifest = {
        snapshotId,
        version,
        createdAt,
        repositories: manifestRepositories
      };
      const sizeBytes = await managedPathSizeAsync(snapshotRoot, artifactPath, signal);
      const activatedAt = nowIso();

      this.database.sqlite.transaction(() => {
        const currentRepositories = this.getActiveRepositories(spaceId);
        if (!sameSnapshotInputs(activeRepos, currentRepositories)) {
          throw new Error("Space repositories changed while the snapshot was building");
        }

        this.database.sqlite
          .prepare("UPDATE space_snapshots SET status = 'inactive' WHERE space_id = ? AND id <> ? AND status = 'active'")
          .run(spaceId, snapshotId);

        updateRecord(
          this.database,
          "space_snapshots",
          {
            status: "active",
            manifestJson: JSON.stringify(manifest),
            activatedAt,
            error: null,
            sizeBytes
          },
          "id",
          snapshotId
        );

        updateRecord(
          this.database,
          "spaces",
          {
            activeSnapshotId: snapshotId,
            snapshotStatus: "active",
            snapshotStatusUpdatedAt: activatedAt,
            updatedAt: activatedAt
          },
          "id",
          spaceId
        );

        this.database.sqlite
          .prepare("UPDATE space_repositories SET snapshot_included = 0, updated_at = ? WHERE space_id = ?")
          .run(activatedAt, spaceId);

        for (const repo of activeRepos) {
          updateRecord(this.database, "space_repositories", { snapshotIncluded: true, updatedAt: activatedAt }, "id", repo.id);
        }
      })();

      return { snapshotId, version };
    } catch (error) {
      const message = sanitizePublicMessage(error, [this.config.memorepoHome]);
      const failedAt = nowIso();
      const currentSpace = this.database.sqlite
        .prepare("SELECT active_snapshot_id AS activeSnapshotId FROM spaces WHERE id = ?")
        .get(spaceId) as { activeSnapshotId: string | null } | undefined;

      this.database.sqlite.transaction(() => {
        updateRecord(this.database, "space_snapshots", { status: "failed", error: message }, "id", snapshotId);
        updateRecord(
          this.database,
          "spaces",
          {
            snapshotStatus: currentSpace?.activeSnapshotId ? "stale" : "failed",
            snapshotStatusUpdatedAt: failedAt,
            updatedAt: failedAt
          },
          "id",
          spaceId
        );
      })();

      throw new Error(message, { cause: error });
    }
  }

  getActiveSnapshot(spaceId: string) {
    const space = this.database.sqlite
      .prepare("SELECT active_snapshot_id AS activeSnapshotId FROM spaces WHERE id = ?")
      .get(spaceId) as { activeSnapshotId: string | null } | undefined;
    if (!space?.activeSnapshotId) {
      return null;
    }

    return this.database.sqlite.prepare("SELECT * FROM space_snapshots WHERE id = ?").get(space.activeSnapshotId) ?? null;
  }

  listSpaceSnapshots(spaceId: string) {
    const activeSnapshotId = this.activeSnapshotId(spaceId);
    const rows = this.snapshotRows(spaceId);
    const snapshotRoot = ensurePlainManagedDirectory(
      this.config.memorepoHome,
      this.config.snapshotIndexesDir,
      "Snapshot index root"
    );
    for (const row of rows) {
      const artifactPath = assertSnapshotArtifactPath(snapshotRoot, row.id, row.artifactPath);
      if (row.sizeBytes === null) {
        this.scheduleSnapshotSize(row.id, snapshotRoot, artifactPath);
      }
    }
    return {
      snapshots: rows.map((row) => toPublicSnapshot(
        row,
        activeSnapshotId,
        this.config.memorepoHome
      )),
      totalSizeBytes: rows.reduce((total, row) => total + (row.sizeBytes ?? 0), 0),
      defaultRetention: this.config.snapshotRetentionDefault
    };
  }

  async pruneSpaceSnapshots(spaceId: string, keepLatest = this.config.snapshotRetentionDefault) {
    this.assertNoActiveSpaceJobs(spaceId);
    const retention = boundedRetention(keepLatest);
    const activeSnapshotId = this.activeSnapshotId(spaceId);
    const rows = this.snapshotRows(spaceId);
    const retainedIds = new Set(rows.slice(0, retention).map((row) => row.id));
    if (activeSnapshotId) {
      retainedIds.add(activeSnapshotId);
    }

    const candidates = rows.filter((row) => !retainedIds.has(row.id));
    const candidateIds = candidates.map((row) => row.id);
    for (const snapshotId of candidateIds) {
      if (this.pruningSnapshotIds.has(snapshotId)) {
        throw Object.assign(new Error("Snapshot pruning is already in progress"), { statusCode: 409 });
      }
    }
    for (const snapshotId of candidateIds) this.pruningSnapshotIds.add(snapshotId);
    try {
      this.assertNoActiveAgentTurns(candidateIds);
      const snapshotRoot = ensurePlainManagedDirectory(
        this.config.memorepoHome,
        this.config.snapshotIndexesDir,
        "Snapshot index root"
      );
      const safeArtifactPaths = new Map(
        candidates.map((row) => [row.id, assertSnapshotArtifactPath(snapshotRoot, row.id, row.artifactPath)] as const)
      );

      let bytes = 0;
      let deletedCount = 0;
      let failure: string | null = null;
      for (const row of candidates) {
        try {
          const artifactPath = safeArtifactPaths.get(row.id)!;
          await this.cbm.closeSession(artifactPath);
          this.database.sqlite.transaction(() => {
            this.assertNoActiveAgentTurns([row.id]);
            const marked = this.database.sqlite
              .prepare("UPDATE space_snapshots SET status = 'pruning', error = NULL WHERE id = ? AND status = ?")
              .run(row.id, row.status);
            if (marked.changes !== 1) throw new Error("Snapshot changed during pruning");
          })();

          let removed;
          try {
            removed = this.removeSnapshotArtifact(snapshotRoot, artifactPath);
          } catch (error) {
            this.database.sqlite
              .prepare("UPDATE space_snapshots SET error = ? WHERE id = ? AND status = 'pruning'")
              .run(sanitizePublicMessage(error, [this.config.memorepoHome]), row.id);
            throw error;
          }

          this.database.sqlite.transaction(() => {
            const deleted = this.database.sqlite
              .prepare("DELETE FROM space_snapshots WHERE id = ? AND status = 'pruning'")
              .run(row.id);
            if (deleted.changes !== 1) throw new Error("Snapshot disappeared during pruning");
          })();
          bytes += removed.sizeBytes;
          deletedCount += 1;
        } catch (error) {
          if (deletedCount === 0) throw error;
          failure = sanitizePublicMessage(error, [this.config.memorepoHome]);
          break;
        }
      }

      return {
        prunedAt: nowIso(),
        keepLatest: retention,
        deletedCount,
        deletedBytes: bytes,
        retainedCount: rows.length - deletedCount,
        incomplete: failure !== null,
        remainingDeleteCount: candidates.length - deletedCount,
        error: failure
      };
    } finally {
      for (const snapshotId of candidateIds) this.pruningSnapshotIds.delete(snapshotId);
    }
  }

  assertAgentTurnCanStart(snapshotId: string): void {
    const row = this.database.sqlite
      .prepare("SELECT status FROM space_snapshots WHERE id = ?")
      .get(snapshotId) as { status: string } | undefined;
    if (this.pruningSnapshotIds.has(snapshotId) || row?.status === "pruning") {
      throw Object.assign(new Error("This chat's snapshot is being pruned"), { statusCode: 409 });
    }
  }

  private reconcileInterruptedSnapshotBuilds(): void {
    const rows = this.database.sqlite
      .prepare("SELECT id, space_id AS spaceId FROM space_snapshots WHERE status = 'building'")
      .all() as Array<{ id: string; spaceId: string }>;
    if (rows.length === 0) return;

    const failedAt = nowIso();
    const message = "Snapshot build was interrupted by a previous shutdown";
    this.database.sqlite.transaction(() => {
      for (const row of rows) {
        this.database.sqlite
          .prepare("UPDATE space_snapshots SET status = 'failed', error = ? WHERE id = ? AND status = 'building'")
          .run(message, row.id);
      }
      for (const spaceId of new Set(rows.map((row) => row.spaceId))) {
        const space = this.database.sqlite
          .prepare("SELECT active_snapshot_id AS activeSnapshotId FROM spaces WHERE id = ?")
          .get(spaceId) as { activeSnapshotId: string | null } | undefined;
        if (!space) continue;
        this.database.sqlite
          .prepare(
            `UPDATE spaces
             SET snapshot_status = ?, snapshot_status_updated_at = ?, updated_at = ?
             WHERE id = ? AND snapshot_status = 'building'`
          )
          .run(space.activeSnapshotId ? "stale" : "failed", failedAt, failedAt, spaceId);
      }
    })();
  }

  private recoverInterruptedSnapshotPrunes(): void {
    const rows = this.database.sqlite
      .prepare("SELECT id, artifact_path AS artifactPath FROM space_snapshots WHERE status = 'pruning'")
      .all() as Array<{ id: string; artifactPath: string }>;
    if (rows.length === 0) return;

    const snapshotRoot = ensurePlainManagedDirectory(
      this.config.memorepoHome,
      this.config.snapshotIndexesDir,
      "Snapshot index root"
    );
    for (const row of rows) {
      try {
        const artifactPath = assertSnapshotArtifactPath(snapshotRoot, row.id, row.artifactPath);
        this.removeSnapshotArtifact(snapshotRoot, artifactPath);
        this.database.sqlite
          .prepare("DELETE FROM space_snapshots WHERE id = ? AND status = 'pruning'")
          .run(row.id);
      } catch (error) {
        this.database.sqlite
          .prepare("UPDATE space_snapshots SET error = ? WHERE id = ? AND status = 'pruning'")
          .run(sanitizePublicMessage(error, [this.config.memorepoHome]), row.id);
      }
    }
  }

  private assertNoActiveAgentTurns(snapshotIds: string[]): void {
    if (snapshotIds.length === 0) return;
    const placeholders = snapshotIds.map(() => "?").join(", ");
    const active = this.database.sqlite
      .prepare(
        `SELECT 1
         FROM agent_chats c
         JOIN agent_turns t ON t.chat_id = c.id
         WHERE c.snapshot_id IN (${placeholders})
           AND t.status IN ('queued', 'pending', 'running')
         LIMIT 1`
      )
      .get(...snapshotIds);
    if (active) {
      throw Object.assign(new Error("Wait for active agent answers before pruning their snapshots"), {
        statusCode: 409
      });
    }
  }

  private getActiveRepositories(spaceId: string): SpaceRepositoryRecord[] {
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
          AND sr.removed_at IS NULL
        ORDER BY gr.full_name ASC
      `
      )
      .all(spaceId) as SpaceRepositoryRecord[];
  }

  private nextVersion(spaceId: string): number {
    const row = this.database.sqlite
      .prepare("SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM space_snapshots WHERE space_id = ?")
      .get(spaceId) as { next_version: number };
    return row.next_version;
  }

  private updateSpaceSnapshotStatus(spaceId: string, status: string): void {
    const timestamp = nowIso();
    updateRecord(this.database, "spaces", { snapshotStatus: status, snapshotStatusUpdatedAt: timestamp, updatedAt: timestamp }, "id", spaceId);
  }

  private projectNameFromPath(repoPath: string): string {
    return repoPath.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  private activeSnapshotId(spaceId: string): string | null {
    const space = this.database.sqlite
      .prepare("SELECT active_snapshot_id AS activeSnapshotId FROM spaces WHERE id = ?")
      .get(spaceId) as { activeSnapshotId: string | null } | undefined;
    if (!space) {
      throw new NotFoundError("Space not found");
    }
    return space.activeSnapshotId;
  }

  private snapshotRows(spaceId: string): SnapshotRow[] {
    return this.database.sqlite
      .prepare(
        `
        SELECT
          id,
          version,
          status,
          artifact_path AS artifactPath,
          manifest_json AS manifestJson,
          created_at AS createdAt,
          activated_at AS activatedAt,
          error,
          size_bytes AS sizeBytes
        FROM space_snapshots
        WHERE space_id = ?
        ORDER BY version DESC
      `
      )
      .all(spaceId) as SnapshotRow[];
  }

  private assertNoActiveSpaceJobs(spaceId: string): void {
    const row = this.database.sqlite
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM jobs
        WHERE space_id = ?
          AND status IN ('pending', 'running')
      `
      )
      .get(spaceId) as { count: number };
    if (row.count > 0) {
      throw new Error("Space has pending or running jobs");
    }
  }

  private scheduleSnapshotSize(snapshotId: string, snapshotRoot: string, artifactPath: string): void {
    if (this.snapshotSizeTasks.has(snapshotId)) return;
    const task = (async () => {
      const sizeBytes = await managedPathSizeAsync(snapshotRoot, artifactPath);
      this.database.sqlite
        .prepare("UPDATE space_snapshots SET size_bytes = ? WHERE id = ? AND size_bytes IS NULL")
        .run(sizeBytes, snapshotId);
    })();
    this.snapshotSizeTasks.set(snapshotId, task);
    void task.catch(() => undefined).finally(() => {
      if (this.snapshotSizeTasks.get(snapshotId) === task) this.snapshotSizeTasks.delete(snapshotId);
    });
  }

  private materializeRevisionSource(repo: SpaceRepositoryRecord, signal?: AbortSignal): Promise<string> {
    const sourceRoot = ensurePlainManagedDirectory(
      this.config.memorepoHome,
      this.config.revisionSourcesDir,
      "Revision source root"
    );
    const repositoryRoot = ensureInsideDir(sourceRoot, path.join(sourceRoot, safePathSegment(repo.github_repository_id)));
    const commitRoot = assertInside(repositoryRoot, path.join(repositoryRoot, safePathSegment(repo.selected_commit!)));
    const targetPath = assertInside(commitRoot, path.join(commitRoot, safePathSegment(path.basename(repo.local_path))));
    const key = path.normalize(targetPath).toLowerCase();

    const existing = this.sourceMaterializations.get(key);
    if (existing) return waitForSharedMaterialization(existing, signal);

    const materialization = this.createRevisionSource(repo, sourceRoot, commitRoot, targetPath, signal);
    this.sourceMaterializations.set(key, materialization);
    void materialization.finally(() => {
      if (this.sourceMaterializations.get(key) === materialization) this.sourceMaterializations.delete(key);
    }).catch(() => undefined);
    return waitForSharedMaterialization(materialization, signal);
  }

  private async createRevisionSource(
    repo: SpaceRepositoryRecord,
    sourceRoot: string,
    commitRoot: string,
    targetPath: string,
    signal?: AbortSignal
  ): Promise<string> {
    if (isPlainDirectoryInside(sourceRoot, targetPath)) return targetPath;
    if (fs.existsSync(commitRoot)) {
      await fs.promises.rm(assertDeletableManagedPath(sourceRoot, commitRoot), { recursive: true, force: true });
    }

    ensureInsideDir(sourceRoot, path.dirname(commitRoot));
    const temporaryRoot = assertInside(
      sourceRoot,
      path.join(path.dirname(commitRoot), `.tmp-${path.basename(commitRoot)}-${createId("src").slice(-8)}`)
    );
    const temporaryTarget = assertInside(temporaryRoot, path.join(temporaryRoot, path.basename(targetPath)));
    try {
      await this.materializeRepository(
        this.config.memorepoHome,
        repo.local_path,
        repo.selected_commit!,
        temporaryTarget,
        signal
      );
      throwIfAborted(signal);
      await fs.promises.rename(temporaryRoot, commitRoot);
      return targetPath;
    } catch (error) {
      if (isPlainDirectoryInside(sourceRoot, targetPath)) return targetPath;
      throw error;
    } finally {
      await fs.promises.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function toPublicSnapshot(
  row: SnapshotRow,
  activeSnapshotId: string | null,
  memorepoHome: string
): PublicSnapshot {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    active: row.id === activeSnapshotId,
    repositoryCount: snapshotRepositoryCount(row.manifestJson),
    sizeBytes: row.sizeBytes ?? 0,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    error: row.error ? sanitizePublicMessage(row.error, [memorepoHome]) : null
  };
}

function snapshotRepositoryCount(manifestJson: string): number {
  try {
    const manifest = JSON.parse(manifestJson) as { repositories?: unknown };
    return Array.isArray(manifest.repositories) ? manifest.repositories.length : 0;
  } catch {
    return 0;
  }
}

function boundedRetention(value: number): number {
  if (!Number.isInteger(value)) {
    throw new Error("keepLatest must be an integer");
  }
  if (value < 1 || value > 100) {
    throw new Error("keepLatest must be between 1 and 100");
  }
  return value;
}

function sameSnapshotInputs(
  captured: SpaceRepositoryRecord[],
  current: SpaceRepositoryRecord[]
): boolean {
  if (captured.length !== current.length) return false;
  return captured.every((repository, index) => {
    const latest = current[index];
    return Boolean(
      latest
      && latest.id === repository.id
      && latest.selected_branch === repository.selected_branch
      && latest.selected_commit === repository.selected_commit
      && latest.clone_status === repository.clone_status
      && latest.removed_at === repository.removed_at
    );
  });
}

export function assertSnapshotArtifactPath(snapshotRoot: string, snapshotId: string, artifactPath: string): string {
  const safeArtifactPath = assertDeletableManagedPath(snapshotRoot, artifactPath);
  const expectedPath = assertDeletableManagedPath(snapshotRoot, path.join(snapshotRoot, snapshotId));
  if (!samePath(safeArtifactPath, expectedPath)) {
    throw new Error("Snapshot artifact path does not match its snapshot ID");
  }

  const realSnapshotRoot = fs.realpathSync(snapshotRoot);
  try {
    const stat = fs.lstatSync(safeArtifactPath);
    if (!stat.isSymbolicLink() && !isStrictlyInsidePath(realSnapshotRoot, fs.realpathSync(safeArtifactPath))) {
      throw new Error("Snapshot artifact escapes the managed snapshot root");
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  return safeArtifactPath;
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function safePathSegment(value: string): string {
  const segment = value
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return segment || "repository";
}

export async function materializeGitRepository(
  memorepoHome: string,
  repositoryPath: string,
  commit: string,
  targetPath: string,
  signal?: AbortSignal
): Promise<void> {
  const repository = assertInside(memorepoHome, repositoryPath);
  const target = assertDeletableManagedPath(memorepoHome, targetPath);
  ensureInsideDir(memorepoHome, path.dirname(target));
  if (fs.existsSync(target)) throw new Error("Snapshot source target already exists");

  const indexRoot = snapshotIndexRoot(memorepoHome);
  const temporaryIndex = assertDeletableManagedPath(
    indexRoot,
    path.join(indexRoot, `i-${createId("tmp").slice(-16)}`)
  );
  let materialized = false;

  try {
    throwIfAborted(signal);
    await assertGitTreeCanBeMaterialized(repository, commit, signal);

    const indexEnvironment = { GIT_INDEX_FILE: temporaryIndex };
    const readTree = await runGit(repository, ["read-tree", commit], signal, indexEnvironment);
    if (readTree.exitCode !== 0) throw new Error("Git could not read the selected snapshot commit");

    const checkout = await runGit(
      repository,
      ["checkout-index", "--all", "--force", `--prefix=${gitPath(target)}/`],
      signal,
      indexEnvironment
    );
    if (checkout.exitCode !== 0) throw new Error("Git could not materialize the selected snapshot commit");
    throwIfAborted(signal);
    if (!fs.existsSync(target)) throw new Error("Git did not create the snapshot source target");
    materialized = true;
  } catch (error) {
    await fs.promises.rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw new Error("Could not materialize the selected repository commit for the snapshot", { cause: error });
  } finally {
    await fs.promises.rm(temporaryIndex, { force: true }).catch(() => undefined);
  }

  if (!materialized) throw new Error("Snapshot source materialization did not complete");
}

function isPlainDirectoryInside(root: string, target: string): boolean {
  try {
    const safeTarget = assertDeletableManagedPath(root, target);
    const stat = fs.lstatSync(safeTarget);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const realRoot = fs.realpathSync(root);
    return isStrictlyInsidePath(realRoot, fs.realpathSync(safeTarget));
  } catch {
    return false;
  }
}

async function waitForSharedMaterialization(materialization: Promise<string>, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  if (!signal) return materialization;

  return await new Promise<string>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    materialization.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function abortError(signal: AbortSignal): Error {
  const error = signal.reason instanceof Error ? new Error(signal.reason.message) : new Error("Operation cancelled");
  error.name = "AbortError";
  return error;
}

async function assertGitTreeCanBeMaterialized(
  repositoryPath: string,
  commit: string,
  signal?: AbortSignal
): Promise<void> {
  const tree = await runGit(
    repositoryPath,
    ["ls-tree", "-r", "--full-tree", commit],
    signal,
    undefined,
    64 * 1024 * 1024
  );
  if (tree.exitCode !== 0 || tree.stdoutTruncated) {
    throw new Error("Git could not safely inspect the selected snapshot commit");
  }
  if (tree.stdout.split(/\r?\n/).some((entry) => entry.startsWith("120000 "))) {
    throw new Error("Snapshot source contains a symbolic link");
  }
}

function cleanupStaleSnapshotWorktrees(memorepoHome: string): void {
  const stagingParent = snapshotWorktreeRoot(memorepoHome);
  for (const entry of fs.readdirSync(stagingParent)) {
    if (!/^w-[0-9a-f]{8}$/i.test(entry)) continue;
    const staging = path.join(stagingParent, entry);
    const registration = staleWorktreeRegistration(memorepoHome, staging);
    if (registration) removeManagedPath(memorepoHome, registration);
    removeManagedPath(memorepoHome, staging);
  }
}

function snapshotWorktreeRoot(memorepoHome: string): string {
  return ensurePlainManagedDirectory(memorepoHome, path.join(memorepoHome, "tmp", "snapshot-worktrees"), "Snapshot worktree root");
}

function snapshotIndexRoot(memorepoHome: string): string {
  return ensurePlainManagedDirectory(memorepoHome, path.join(memorepoHome, "tmp", "snapshot-indexes"), "Snapshot index root");
}

function cleanupStaleSnapshotIndexes(memorepoHome: string): void {
  const indexRoot = snapshotIndexRoot(memorepoHome);
  for (const entry of fs.readdirSync(indexRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^i-[0-9a-f]{16}$/i.test(entry.name)) continue;
    fs.rmSync(assertDeletableManagedPath(indexRoot, path.join(indexRoot, entry.name)), { force: true });
  }
}

function cleanupOrphanedSnapshotArtifacts(database: AppDatabase, config: AppConfig): void {
  const snapshotsRoot = ensurePlainManagedDirectory(config.memorepoHome, config.snapshotIndexesDir, "Snapshot index root");
  const realSnapshotsRoot = fs.realpathSync(snapshotsRoot);
  for (const entry of fs.readdirSync(snapshotsRoot)) {
    if (!/^snp_[0-9a-f]{32}$/i.test(entry)) continue;
    const artifactPath = assertDeletableManagedPath(snapshotsRoot, path.join(snapshotsRoot, entry));
    const row = database.sqlite
      .prepare("SELECT artifact_path AS artifactPath FROM space_snapshots WHERE id = ?")
      .get(entry) as { artifactPath: string } | undefined;
    if (row && samePath(row.artifactPath, artifactPath)) continue;

    const stat = fs.lstatSync(artifactPath);
    if (!stat.isSymbolicLink()) {
      const realArtifactPath = fs.realpathSync(artifactPath);
      if (!isStrictlyInsidePath(realSnapshotsRoot, realArtifactPath)) {
        throw new Error("Orphaned snapshot artifact escapes the managed snapshot root");
      }
    }
    removeManagedPath(config.memorepoHome, artifactPath);
  }
}

function staleWorktreeRegistration(memorepoHome: string, staging: string): string | null {
  try {
    const gitPointer = path.join(staging, ".git");
    const pointerStat = fs.lstatSync(gitPointer);
    if (!pointerStat.isFile() || pointerStat.isSymbolicLink()) return null;
    const match = /^gitdir:\s*(.+)\s*$/i.exec(fs.readFileSync(gitPointer, "utf8").trim());
    if (!match?.[1]) return null;

    const registration = assertDeletableManagedPath(memorepoHome, path.resolve(staging, match[1]));
    const worktreesRoot = path.dirname(registration);
    const repositoryGitRoot = path.dirname(worktreesRoot);
    if (path.basename(worktreesRoot).toLowerCase() !== "worktrees" || path.basename(repositoryGitRoot).toLowerCase() !== ".git") {
      return null;
    }
    const registrationStat = fs.lstatSync(registration);
    if (!registrationStat.isDirectory() || registrationStat.isSymbolicLink()) return null;
    const realHome = fs.realpathSync(memorepoHome);
    if (!isStrictlyInsidePath(realHome, fs.realpathSync(registration))) return null;

    const backReference = path.join(registration, "gitdir");
    const backReferenceStat = fs.lstatSync(backReference);
    if (!backReferenceStat.isFile() || backReferenceStat.isSymbolicLink()) return null;
    const registeredPointer = path.resolve(registration, fs.readFileSync(backReference, "utf8").trim());
    return samePath(registeredPointer, gitPointer) ? registration : null;
  } catch {
    return null;
  }
}

export function ensurePlainManagedDirectory(memorepoHome: string, target: string, label: string): string {
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

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function gitPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isStrictlyInsidePath(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function runGit(
  repositoryPath: string,
  args: string[],
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
  maxCaptureBytes = 64 * 1024
) {
  return runProcess({
    command: "git",
    args: ["-C", repositoryPath, "-c", "core.autocrlf=false", ...args],
    env: { ...createSafeProcessEnvironment(), ...environment },
    inheritEnv: false,
    timeoutMs: 120_000,
    maxCaptureBytes,
    maxLineBytes: 4 * 1024,
    signal
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? new Error(signal.reason.message) : new Error("Operation cancelled");
  error.name = "AbortError";
  throw error;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

interface SnapshotRow {
  id: string;
  version: number;
  status: string;
  artifactPath: string;
  manifestJson: string;
  createdAt: string;
  activatedAt: string | null;
  error: string | null;
  sizeBytes: number | null;
}

interface PublicSnapshot {
  id: string;
  version: number;
  status: string;
  active: boolean;
  repositoryCount: number;
  sizeBytes: number;
  createdAt: string;
  activatedAt: string | null;
  error: string | null;
}
