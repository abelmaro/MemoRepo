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
import type {
  CbmIndexExcludedSummary,
  CbmIndexMode,
  CbmIndexQuality,
  CbmIndexRepositoryResult,
  CbmIndexSkippedSummary,
  CbmIndexStatusResult,
  CbmIndexStatus,
  CbmService
} from "./cbmService.js";
import { createSafeProcessEnvironment, runProcess } from "./process.js";
import type { SpaceRepositoryRecord } from "./spaceService.js";
import { classifyProcessTermination, directorySizeBytes, readCgroupMemoryMetrics, recordCbmOperationMetric } from "./operationalMetrics.js";
import {
  createSnapshotSourceIntegrityManifest,
  snapshotSourceIntegrityManifestPath,
  snapshotSourceIntegritySummary,
  verifySnapshotSourceIntegrity,
  writeSnapshotSourceIntegrityManifestAtomic,
  type SnapshotSourceIntegritySummary
} from "./snapshotSourceIntegrity.js";

type SnapshotRepositoryMaterializer = (
  memorepoHome: string,
  repositoryPath: string,
  commit: string,
  targetPath: string,
  signal?: AbortSignal
) => Promise<void>;

interface MaterializedRevisionSource {
  sourcePath: string;
  sourceIntegrity: SnapshotSourceIntegritySummary;
}

export const SNAPSHOT_MANIFEST_SCHEMA_VERSION = 2;
export type SnapshotQuality = "complete" | "partial" | "degraded" | "unknown";

export interface SnapshotManifestRepositoryStatusChecks {
  afterPrimary: CbmIndexStatusResult;
  afterLinking?: CbmIndexStatusResult;
}

export interface SnapshotManifestRepositoryCbmIndex {
  engineVersion: string;
  mode: CbmIndexMode;
  status: CbmIndexStatus;
  reportedStatus?: string;
  quality: CbmIndexQuality;
  skippedCount: number;
  skipped?: CbmIndexSkippedSummary;
  excluded?: CbmIndexExcludedSummary;
  nodes?: number;
  edges?: number;
  expectedNodes?: number;
  expectedEdges?: number;
  snapshotQuality?: SnapshotQuality;
  statusChecks?: SnapshotManifestRepositoryStatusChecks;
}

export interface SnapshotManifestRepository {
  spaceRepositoryId: string;
  githubRepositoryId: string;
  fullName: string;
  branch: string;
  commit: string;
  projectName: string;
  localPath: string;
  sourceIntegrity?: SnapshotSourceIntegritySummary;
  cbmIndex?: SnapshotManifestRepositoryCbmIndex;
}

export interface SnapshotManifest {
  schemaVersion?: number;
  quality?: SnapshotQuality;
  snapshotId: string;
  version: number;
  createdAt: string;
  repositories: SnapshotManifestRepository[];
}

export class SnapshotService {
  private readonly pruningSnapshotIds = new Set<string>();
  private readonly sourceMaterializations = new Map<string, Promise<MaterializedRevisionSource>>();
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
    const manifestRepositories: SnapshotManifestRepository[] = [];
    let manifestQuality: SnapshotQuality = "unknown";
    let linkingVerificationRequired = false;
    const currentManifest = (): SnapshotManifest => ({
      schemaVersion: SNAPSHOT_MANIFEST_SCHEMA_VERSION,
      quality: manifestQuality,
      snapshotId,
      version,
      createdAt,
      repositories: manifestRepositories
    });
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
      manifestJson: JSON.stringify(currentManifest()),
      createdAt,
      activatedAt: null,
      error: null,
      sizeBytes: null
    });

    this.updateSpaceSnapshotStatus(spaceId, "building");

    try {
      const materializedRepositories: Array<{ repository: SpaceRepositoryRecord; sourcePath: string }> = [];
      const engineVersion = await this.cbm.version();

      for (const repo of activeRepos) {
        throwIfAborted(signal);
        const materializeStartedAt = Date.now();
        onOutput?.(`Indexing ${repo.full_name} into snapshot ${versionName}`);
        const materializedSource = await this.materializeRevisionSource(repo, signal);
        const sourcePath = materializedSource.sourcePath;
        onOutput?.(`Snapshot source prepared in ${formatDuration(Date.now() - materializeStartedAt)}`);
        const indexStartedAt = Date.now();
        const mode = this.config.cbmIndexMode;
        const memoryBefore = readCgroupMemoryMetrics();
        let result: CbmIndexRepositoryResult;
        try {
          result = await this.cbm.indexRepository(sourcePath, artifactPath, mode, onOutput, signal);
        } catch (error) {
          const memory = readCgroupMemoryMetrics();
          recordCbmOperationMetric(this.database, {
            operation: "snapshot_index_repository", status: "error", durationMs: Date.now() - indexStartedAt,
            spaceId, snapshotId, spaceRepositoryId: repo.id, engineVersion, indexMode: mode,
            terminationKind: classifyProcessTermination({ error, cgroupOomKills: Math.max(0, memory.oomKillEvents - memoryBefore.oomKillEvents) }),
            cgroupPeakBytes: memory.peakBytes
          });
          throw error;
        }
        const projectName = result.project ?? this.projectNameFromPath(sourcePath);
        materializedRepositories.push({ repository: repo, sourcePath });
        const manifestRepository: SnapshotManifestRepository = {
          spaceRepositoryId: repo.id,
          githubRepositoryId: repo.github_repository_id,
          fullName: repo.full_name,
          branch: repo.selected_branch!,
          commit: repo.selected_commit!,
          projectName,
          localPath: sourcePath,
          sourceIntegrity: materializedSource.sourceIntegrity,
          cbmIndex: snapshotManifestRepositoryCbmIndex(engineVersion, mode, result)
        };
        manifestRepositories.push(manifestRepository);
        manifestQuality = aggregateSnapshotQuality(manifestRepositories, activeRepos.length, false);
        this.persistBuildingManifest(snapshotId, currentManifest());
        if (this.config.enforceSnapshotQuality !== false) {
          assertSnapshotIndexCanActivate(repo.full_name, manifestRepository.cbmIndex!);
        }
        recordCbmOperationMetric(this.database, {
          operation: "snapshot_index_repository", status: result.status, durationMs: Date.now() - indexStartedAt,
          spaceId, snapshotId, spaceRepositoryId: repo.id, projectName, engineVersion, indexMode: mode,
          ...(result.nodes !== undefined ? { nodes: result.nodes } : {}),
          ...(result.edges !== undefined ? { edges: result.edges } : {}),
          skippedCount: result.skippedCount,
          artifactBytes: directorySizeBytes(artifactPath), terminationKind: "completed",
          cgroupPeakBytes: readCgroupMemoryMetrics().peakBytes
        });
        onOutput?.(`Snapshot index for ${repo.full_name} completed in ${formatDuration(Date.now() - indexStartedAt)}`);
      }

      if (materializedRepositories.length > 1) {
        linkingVerificationRequired = true;
        for (const repository of manifestRepositories) {
          if (repository.cbmIndex) repository.cbmIndex.snapshotQuality = "unknown";
        }
        manifestQuality = aggregateSnapshotQuality(manifestRepositories, activeRepos.length, true);
        this.persistBuildingManifest(snapshotId, currentManifest());
        for (const { repository, sourcePath } of materializedRepositories) {
          onOutput?.(`Linking cross-repo intelligence for ${repository.full_name}`);
          const result = await this.cbm.buildCrossRepoLinks(sourcePath, artifactPath, onOutput, signal);
          const manifestRepository = manifestRepositories.find((candidate) => candidate.spaceRepositoryId === repository.id);
          if (!manifestRepository?.cbmIndex) throw new Error("Snapshot repository index metadata is missing");
          manifestRepository.cbmIndex.statusChecks = {
            ...(manifestRepository.cbmIndex.statusChecks ?? { afterPrimary: normalizeMissingIndexStatus() }),
            afterLinking: result.indexStatus
          };
          manifestRepository.cbmIndex.snapshotQuality = snapshotRepositoryIndexQuality(manifestRepository.cbmIndex, true);
          manifestQuality = aggregateSnapshotQuality(manifestRepositories, activeRepos.length, true);
          this.persistBuildingManifest(snapshotId, currentManifest());
          if (this.config.enforceSnapshotQuality !== false) {
            assertSnapshotIndexCanActivate(repository.full_name, manifestRepository.cbmIndex);
          }
        }
      }

      manifestQuality = aggregateSnapshotQuality(
        manifestRepositories,
        activeRepos.length,
        linkingVerificationRequired
      );
      if (this.config.enforceSnapshotQuality !== false && manifestQuality !== "complete") {
        throw new Error(`Snapshot index quality is ${manifestQuality}; activation requires complete quality`);
      }
      const manifest = currentManifest();
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
      manifestQuality = aggregateSnapshotQuality(
        manifestRepositories,
        activeRepos.length,
        linkingVerificationRequired
      );
      const message = sanitizePublicMessage(error, [this.config.memorepoHome]);
      const failedAt = nowIso();
      const currentSpace = this.database.sqlite
        .prepare("SELECT active_snapshot_id AS activeSnapshotId FROM spaces WHERE id = ?")
        .get(spaceId) as { activeSnapshotId: string | null } | undefined;

      this.database.sqlite.transaction(() => {
        updateRecord(
          this.database,
          "space_snapshots",
          { status: "failed", manifestJson: JSON.stringify(currentManifest()), error: message },
          "id",
          snapshotId
        );
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
    const durationRows = this.database.sqlite
      .prepare(`
        SELECT snapshot_id AS snapshotId, SUM(duration_ms) AS durationMs
        FROM cbm_operation_metrics
        WHERE space_id = ? AND snapshot_id IS NOT NULL AND operation = 'snapshot_index_repository'
        GROUP BY snapshot_id
      `)
      .all(spaceId) as Array<{ snapshotId: string; durationMs: number }>;
    const durationBySnapshot = new Map(durationRows.map((row) => [row.snapshotId, row.durationMs]));
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
        this.config.memorepoHome,
        durationBySnapshot.get(row.id) ?? null
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
      .prepare("SELECT status, manifest_json AS manifestJson FROM space_snapshots WHERE id = ?")
      .get(snapshotId) as { status: string; manifestJson: string } | undefined;
    if (this.pruningSnapshotIds.has(snapshotId) || row?.status === "pruning") {
      throw Object.assign(new Error("This chat's snapshot is being pruned"), { statusCode: 409 });
    }
    const quality = row ? declaredSnapshotQuality(row.manifestJson) : undefined;
    if (this.config.enforceSnapshotQuality !== false && quality && quality !== "complete") {
      throw Object.assign(
        new Error(`This chat's snapshot has ${quality} index quality and cannot start new agent turns`),
        { statusCode: 409 }
      );
    }
  }

  private reconcileInterruptedSnapshotBuilds(): void {
    const rows = this.database.sqlite
      .prepare("SELECT id, space_id AS spaceId, manifest_json AS manifestJson FROM space_snapshots WHERE status = 'building'")
      .all() as Array<{ id: string; spaceId: string; manifestJson: string }>;
    if (rows.length === 0) return;

    const failedAt = nowIso();
    const message = "Snapshot build was interrupted by a previous shutdown";
    this.database.sqlite.transaction(() => {
      for (const row of rows) {
        this.database.sqlite
          .prepare(
            "UPDATE space_snapshots SET status = 'failed', manifest_json = ?, error = ? WHERE id = ? AND status = 'building'"
          )
          .run(snapshotManifestJsonWithQuality(row.manifestJson, "unknown"), message, row.id);
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

  private persistBuildingManifest(snapshotId: string, manifest: SnapshotManifest): void {
    const updated = this.database.sqlite
      .prepare("UPDATE space_snapshots SET manifest_json = ? WHERE id = ? AND status = 'building'")
      .run(JSON.stringify(manifest), snapshotId);
    if (updated.changes !== 1) {
      throw new Error("Snapshot changed while index quality was being recorded");
    }
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

  private materializeRevisionSource(
    repo: SpaceRepositoryRecord,
    signal?: AbortSignal
  ): Promise<MaterializedRevisionSource> {
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
    return materialization;
  }

  private async createRevisionSource(
    repo: SpaceRepositoryRecord,
    sourceRoot: string,
    commitRoot: string,
    targetPath: string,
    signal?: AbortSignal
  ): Promise<MaterializedRevisionSource> {
    const treeSha = await selectedGitTreeSha(repo.local_path, repo.selected_commit!, signal);
    const existing = await reusableRevisionSource(sourceRoot, targetPath, treeSha, signal);
    if (existing) return existing;

    ensureInsideDir(sourceRoot, path.dirname(commitRoot));
    const temporaryRoot = assertInside(
      sourceRoot,
      path.join(path.dirname(commitRoot), `.tmp-${path.basename(commitRoot)}-${createId("src").slice(-8)}`)
    );
    const temporaryTarget = assertInside(temporaryRoot, path.join(temporaryRoot, path.basename(targetPath)));
    const temporaryManifestPath = snapshotSourceIntegrityManifestPath(temporaryTarget);
    const staleRoot = assertInside(
      sourceRoot,
      path.join(path.dirname(commitRoot), `.stale-${path.basename(commitRoot)}-${createId("src").slice(-8)}`)
    );
    let movedExisting = false;
    try {
      await this.materializeRepository(
        this.config.memorepoHome,
        repo.local_path,
        repo.selected_commit!,
        temporaryTarget,
        signal
      );
      throwIfAborted(signal);
      const integrity = await createSnapshotSourceIntegrityManifest(temporaryTarget, treeSha, signal);
      await writeSnapshotSourceIntegrityManifestAtomic(temporaryManifestPath, integrity, signal);
      const temporaryVerification = await verifySnapshotSourceIntegrity(
        temporaryTarget,
        temporaryManifestPath,
        treeSha,
        signal
      );
      if (!temporaryVerification.valid) {
        throw new Error(`Snapshot source integrity verification failed: ${temporaryVerification.reason ?? "unknown"}`);
      }
      throwIfAborted(signal);
      if (fs.existsSync(commitRoot)) {
        await fs.promises.rename(commitRoot, staleRoot);
        movedExisting = true;
      }
      await fs.promises.rename(temporaryRoot, commitRoot);
      if (movedExisting) {
        await fs.promises.rm(assertDeletableManagedPath(sourceRoot, staleRoot), { recursive: true, force: true });
        movedExisting = false;
      }
      return {
        sourcePath: targetPath,
        sourceIntegrity: snapshotSourceIntegritySummary(integrity)
      };
    } catch (error) {
      if (movedExisting && !fs.existsSync(commitRoot) && fs.existsSync(staleRoot)) {
        await fs.promises.rename(staleRoot, commitRoot).catch(() => undefined);
        movedExisting = false;
      }
      throwIfAborted(signal);
      const concurrentlyCreated = await reusableRevisionSource(sourceRoot, targetPath, treeSha, signal);
      if (concurrentlyCreated) return concurrentlyCreated;
      throw error;
    } finally {
      await fs.promises.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      if (movedExisting && fs.existsSync(staleRoot)) {
        await fs.promises.rename(staleRoot, commitRoot).catch(() => undefined);
      }
    }
  }
}

function toPublicSnapshot(
  row: SnapshotRow,
  activeSnapshotId: string | null,
  memorepoHome: string,
  indexDurationMs: number | null
): PublicSnapshot {
  const observability = snapshotObservability(row.manifestJson);
  const indexingDetails = snapshotIndexingDetails(row.manifestJson, memorepoHome);
  const error = row.error ? sanitizePublicMessage(row.error, [memorepoHome]) : null;
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    active: row.id === activeSnapshotId,
    repositoryCount: snapshotRepositoryCount(row.manifestJson),
    ...observability,
    indexingDetails,
    indexDurationMs,
    sizeBytes: row.sizeBytes ?? 0,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    error,
    reason: error ?? qualityReason(observability.quality, observability.skippedCount)
  };
}

export function snapshotObservability(manifestJson: string): SnapshotObservability {
  try {
    const manifest = JSON.parse(manifestJson) as SnapshotManifest;
    const repositories = Array.isArray(manifest.repositories) ? manifest.repositories : [];
    const indexes = repositories.flatMap((repository) => repository.cbmIndex ? [repository.cbmIndex] : []);
    const sourceFileCount = repositories.reduce(
      (total, repository) => total + (repository.sourceIntegrity?.fileCount ?? 0),
      0
    );
    const skippedCount = indexes.reduce((total, index) => total + Math.max(0, index.skippedCount ?? 0), 0);
    const excludedDirectoryCount = indexes.reduce(
      (total, index) => total + Math.max(0, index.excluded?.count ?? 0),
      0
    );
    const reasons = new Map<string, number>();
    for (const index of indexes) {
      for (const skipped of index.skipped?.files ?? []) {
        const reason = skipped.reason.trim() || "unspecified";
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }
    const quality = normalizeSnapshotQuality(manifest.quality) ?? "unknown";
    return {
      quality,
      engineVersions: uniqueStrings(indexes.map((index) => index.engineVersion)),
      indexModes: uniqueStrings(indexes.map((index) => index.mode)),
      sourceFileCount,
      skippedCount,
      excludedDirectoryCount,
      coveragePercent: sourceFileCount > 0
        ? Math.max(0, Math.min(100, Math.round(((sourceFileCount - skippedCount) / sourceFileCount) * 1_000) / 10))
        : null,
      skipReasons: Array.from(reasons, ([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
    };
  } catch {
    return {
      quality: "unknown",
      engineVersions: [],
      indexModes: [],
      sourceFileCount: 0,
      skippedCount: 0,
      excludedDirectoryCount: 0,
      coveragePercent: null,
      skipReasons: []
    };
  }
}

export function snapshotIndexingDetails(
  manifestJson: string,
  memorepoHome: string
): SnapshotRepositoryIndexingDetails[] {
  try {
    const manifest = JSON.parse(manifestJson) as SnapshotManifest;
    const repositories = Array.isArray(manifest.repositories) ? manifest.repositories : [];
    return repositories.flatMap((repository) => {
      const index = repository?.cbmIndex;
      if (!index) return [];

      const rawSkippedFiles = Array.isArray(index.skipped?.files) ? index.skipped.files : [];
      const skippedFiles = rawSkippedFiles.flatMap((candidate) => {
        const file = candidate && typeof candidate === "object"
          ? candidate as { path?: unknown; reason?: unknown; phase?: unknown }
          : null;
        const safePath = safeSnapshotDetailPath(file?.path);
        if (!safePath) return [];
        return [{
          path: safePath,
          reason: publicSnapshotDetailText(file?.reason, "unspecified", memorepoHome),
          phase: publicSnapshotDetailText(file?.phase, "unknown", memorepoHome)
        }];
      });
      const skippedCount = Math.max(0, index.skippedCount ?? 0, index.skipped?.count ?? 0, rawSkippedFiles.length);

      const rawExcludedDirectories = Array.isArray(index.excluded?.dirs) ? index.excluded.dirs : [];
      const excludedDirectories = rawExcludedDirectories.flatMap((candidate) => {
        const safePath = safeSnapshotDetailPath(candidate);
        return safePath ? [safePath] : [];
      });
      const excludedDirectoryCount = Math.max(0, index.excluded?.count ?? 0, rawExcludedDirectories.length);

      if (skippedCount === 0 && excludedDirectoryCount === 0) return [];
      const repositoryName = typeof repository.fullName === "string" && repository.fullName.trim()
        ? repository.fullName.trim()
        : "Unknown repository";

      return [{
        repository: repositoryName,
        skippedFiles,
        skippedCount,
        skippedTruncated: Boolean(index.skipped?.truncated)
          || skippedFiles.length < skippedCount
          || skippedFiles.length < rawSkippedFiles.length,
        excludedDirectories,
        excludedDirectoryCount,
        excludedDirectoriesTruncated: Boolean(index.excluded?.truncated)
          || excludedDirectories.length < excludedDirectoryCount
          || excludedDirectories.length < rawExcludedDirectories.length
      }];
    }).sort((left, right) => left.repository.localeCompare(right.repository));
  } catch {
    return [];
  }
}

function safeSnapshotDetailPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    return null;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  const relative = segments.filter((segment) => segment && segment !== ".").join("/");
  return relative || (normalized === "." ? "." : null);
}

function publicSnapshotDetailText(value: unknown, fallback: string, memorepoHome: string): string {
  const text = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return sanitizePublicMessage(text, [memorepoHome]);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort();
}

function qualityReason(quality: SnapshotQuality, skippedCount: number): string | null {
  if (quality === "complete") return null;
  if (skippedCount > 0) return `${skippedCount} source file${skippedCount === 1 ? " was" : "s were"} skipped during indexing`;
  return `Snapshot index quality is ${quality}`;
}

function snapshotRepositoryCount(manifestJson: string): number {
  try {
    const manifest = JSON.parse(manifestJson) as { repositories?: unknown };
    return Array.isArray(manifest.repositories) ? manifest.repositories.length : 0;
  } catch {
    return 0;
  }
}

function assertSnapshotIndexCanActivate(
  repositoryName: string,
  result: SnapshotManifestRepositoryCbmIndex
): void {
  const quality = normalizeSnapshotQuality(result.snapshotQuality);
  if (quality === "degraded") {
    throw new Error(`CBM index for ${repositoryName} reported degraded quality`);
  }
  if (quality === "partial" && result.skippedCount > 0) {
    const noun = result.skippedCount === 1 ? "file" : "files";
    throw new Error(`CBM index for ${repositoryName} skipped ${result.skippedCount} ${noun} due to indexing errors`);
  }
  if (quality === "partial") {
    throw new Error(`CBM index for ${repositoryName} reported partial quality`);
  }
  if (quality === "unknown") {
    throw new Error(`CBM index for ${repositoryName} could not be verified as complete`);
  }
}

function snapshotManifestRepositoryCbmIndex(
  engineVersion: string,
  mode: CbmIndexMode,
  result: CbmIndexRepositoryResult
): SnapshotManifestRepositoryCbmIndex {
  const index: SnapshotManifestRepositoryCbmIndex = {
    engineVersion,
    mode,
    status: result.status,
    quality: result.quality,
    skippedCount: result.skippedCount,
    ...(result.reportedStatus ? { reportedStatus: result.reportedStatus } : {}),
    ...(result.skipped ? { skipped: result.skipped } : {}),
    ...(result.excluded ? { excluded: result.excluded } : {}),
    ...(result.nodes === undefined ? {} : { nodes: result.nodes }),
    ...(result.edges === undefined ? {} : { edges: result.edges }),
    ...(result.expectedNodes === undefined ? {} : { expectedNodes: result.expectedNodes }),
    ...(result.expectedEdges === undefined ? {} : { expectedEdges: result.expectedEdges }),
    statusChecks: {
      afterPrimary: result.indexStatus ?? normalizeMissingIndexStatus()
    }
  };
  index.snapshotQuality = snapshotRepositoryIndexQuality(index, false);
  return index;
}

function normalizeMissingIndexStatus(): CbmIndexStatusResult {
  return { status: "unknown", quality: "unknown" };
}

function snapshotRepositoryIndexQuality(
  index: SnapshotManifestRepositoryCbmIndex,
  requireLinkingVerification: boolean
): SnapshotQuality {
  const afterPrimary = index.statusChecks?.afterPrimary;
  const afterLinking = index.statusChecks?.afterLinking;
  const checks = requireLinkingVerification ? [afterPrimary, afterLinking] : [afterPrimary];

  if (
    index.status === "degraded"
    || index.status === "error"
    || index.status === "skipped"
    || index.quality === "degraded"
    || checks.some((check) => check?.quality === "degraded")
  ) {
    return "degraded";
  }
  if (index.skippedCount > 0 || index.quality === "partial") return "partial";
  if (index.status !== "indexed" || index.quality !== "clean") return "unknown";
  if (checks.some((check) => check?.status !== "ready" || check.quality !== "complete")) return "unknown";
  return "complete";
}

function aggregateSnapshotQuality(
  repositories: SnapshotManifestRepository[],
  expectedRepositoryCount: number,
  requireLinkingVerification: boolean
): SnapshotQuality {
  const qualities = repositories.map((repository) => repository.cbmIndex
    ? snapshotRepositoryIndexQuality(repository.cbmIndex, requireLinkingVerification)
    : "unknown");
  if (qualities.includes("degraded")) return "degraded";
  if (qualities.includes("partial")) return "partial";
  if (repositories.length !== expectedRepositoryCount || qualities.includes("unknown")) return "unknown";
  return "complete";
}

export function normalizeSnapshotQuality(value: unknown): SnapshotQuality {
  return value === "complete" || value === "partial" || value === "degraded" ? value : "unknown";
}

function declaredSnapshotQuality(manifestJson: string): SnapshotQuality | undefined {
  try {
    const value = (JSON.parse(manifestJson) as { quality?: unknown }).quality;
    return value === "complete" || value === "partial" || value === "degraded" || value === "unknown"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function snapshotQuality(manifestJson: string): SnapshotQuality {
  return declaredSnapshotQuality(manifestJson) ?? "unknown";
}

function snapshotManifestJsonWithQuality(manifestJson: string, quality: SnapshotQuality): string {
  try {
    const manifest = JSON.parse(manifestJson) as unknown;
    const record = manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? manifest as Record<string, unknown>
      : {};
    return JSON.stringify({ ...record, quality });
  } catch {
    return JSON.stringify({ quality });
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

async function reusableRevisionSource(
  sourceRoot: string,
  targetPath: string,
  treeSha: string,
  signal?: AbortSignal
): Promise<MaterializedRevisionSource | null> {
  if (!isPlainDirectoryInside(sourceRoot, targetPath)) return null;
  const verification = await verifySnapshotSourceIntegrity(
    targetPath,
    snapshotSourceIntegrityManifestPath(targetPath),
    treeSha,
    signal
  );
  if (!verification.valid || !verification.manifest) return null;
  return {
    sourcePath: targetPath,
    sourceIntegrity: snapshotSourceIntegritySummary(verification.manifest)
  };
}

async function selectedGitTreeSha(
  repositoryPath: string,
  commit: string,
  signal?: AbortSignal
): Promise<string> {
  const result = await runGit(
    repositoryPath,
    ["rev-parse", "--verify", `${commit}^{tree}`],
    signal,
    undefined,
    1024
  );
  const treeSha = result.stdout.trim();
  if (result.exitCode !== 0 || result.stdoutTruncated || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(treeSha)) {
    throw new Error("Git could not resolve the selected snapshot tree");
  }
  return treeSha.toLocaleLowerCase("en-US");
}

async function waitForSharedMaterialization<T>(materialization: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return materialization;

  return await new Promise<T>((resolve, reject) => {
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
  quality: SnapshotQuality;
  repositoryCount: number;
  engineVersions: string[];
  indexModes: string[];
  sourceFileCount: number;
  skippedCount: number;
  excludedDirectoryCount: number;
  coveragePercent: number | null;
  skipReasons: Array<{ reason: string; count: number }>;
  indexingDetails: SnapshotRepositoryIndexingDetails[];
  indexDurationMs: number | null;
  sizeBytes: number;
  createdAt: string;
  activatedAt: string | null;
  error: string | null;
  reason: string | null;
}

export interface SnapshotObservability {
  quality: SnapshotQuality;
  engineVersions: string[];
  indexModes: string[];
  sourceFileCount: number;
  skippedCount: number;
  excludedDirectoryCount: number;
  coveragePercent: number | null;
  skipReasons: Array<{ reason: string; count: number }>;
}

export interface SnapshotRepositoryIndexingDetails {
  repository: string;
  skippedFiles: Array<{ path: string; reason: string; phase: string }>;
  skippedCount: number;
  skippedTruncated: boolean;
  excludedDirectories: string[];
  excludedDirectoryCount: number;
  excludedDirectoriesTruncated: boolean;
}
