import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/connection.js";
import { managedPathSize, removeManagedPath } from "../domain/files.js";
import { nowIso } from "../domain/time.js";
import { assertSnapshotArtifactPath, ensurePlainManagedDirectory } from "./snapshotService.js";

const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "skipped", "cancelled"] as const;

export class MaintenanceService {
  constructor(
    private readonly database: AppDatabase,
    private readonly config: AppConfig
  ) {}

  summary(jobRetentionDays = this.config.jobRetentionDaysDefault): MaintenanceSummary {
    return {
      defaults: {
        snapshotRetention: this.config.snapshotRetentionDefault,
        jobRetentionDays: this.config.jobRetentionDaysDefault
      },
      candidates: {
        oldRepoIndexRecords: this.oldRepoIndexRecordIds().length,
        removedRepositoryIndexes: this.removedRepositoryIndexTargets().length,
        orphanRepoIndexDirectories: this.orphanRepoIndexDirectories().length,
        orphanRevisionSources: this.orphanRevisionSourceTargets().length,
        failedSnapshots: this.failedSnapshotRows().length,
        oldJobs: this.oldJobIds(jobRetentionDays).length,
        removedClones: this.removedCloneRows().length
      },
      estimatedBytes: {
        failedSnapshots: this.failedSnapshotBytes(),
        removedRepositoryIndexes: sumBytes(this.removedRepositoryIndexTargets().map((row) => row.cachePath), this.config.memorepoHome),
        orphanRepoIndexDirectories: sumBytes(this.orphanRepoIndexDirectories().map((row) => row.path), this.config.memorepoHome),
        removedClones: sumBytes(this.removedCloneRows().map((row) => row.localPath), this.config.memorepoHome)
      }
    };
  }

  runGarbageCollection(jobRetentionDays = this.config.jobRetentionDaysDefault): MaintenanceResult {
    const deletedAt = nowIso();
    const failedSnapshots = this.deleteFailedSnapshots();
    const removedClones = this.cleanupRemovedClones();
    const removedRepositoryIndexes = this.deleteRemovedRepositoryIndexes();
    const orphanRepoIndexDirectories = this.deleteOrphanRepoIndexDirectories();
    const orphanRevisionSources = this.deleteOrphanRevisionSources();
    const oldRepoIndexRecords = this.deleteOldRepoIndexRecords();
    const oldJobs = this.deleteOldJobs(jobRetentionDays);

    return {
      deletedAt,
      jobRetentionDays,
      oldRepoIndexRecords,
      removedRepositoryIndexes,
      orphanRepoIndexDirectories,
      orphanRevisionSources,
      failedSnapshots,
      oldJobs,
      removedClones
    };
  }

  private deleteFailedSnapshots(): FileCleanupResult {
    const rows = this.failedSnapshotRows();
    const affectedSpaceIds = Array.from(new Set(rows.map((row) => row.spaceId)));
    const snapshotRoot = this.snapshotRoot();
    const removed = removePaths(
      rows.map((row) => assertSnapshotArtifactPath(snapshotRoot, row.id, row.artifactPath)),
      snapshotRoot
    );
    const transaction = this.database.sqlite.transaction(() => {
      for (const row of rows) {
        this.database.sqlite.prepare("DELETE FROM space_snapshots WHERE id = ?").run(row.id);
      }
      for (const spaceId of affectedSpaceIds) {
        const state = this.database.sqlite
          .prepare(
            `
            SELECT
              active_snapshot_id AS activeSnapshotId,
              (SELECT COUNT(*) FROM space_snapshots WHERE space_id = ?) AS snapshotCount
            FROM spaces
            WHERE id = ?
          `
          )
          .get(spaceId, spaceId) as { activeSnapshotId: string | null; snapshotCount: number } | undefined;
        if (state && !state.activeSnapshotId && state.snapshotCount === 0) {
          this.database.sqlite
            .prepare("UPDATE spaces SET snapshot_status = 'none', snapshot_status_updated_at = ?, updated_at = ? WHERE id = ?")
            .run(nowIso(), nowIso(), spaceId);
        }
      }
    });
    transaction();
    return { count: rows.length, bytes: removed.bytes };
  }

  private failedSnapshotBytes(): number {
    const snapshotRoot = this.snapshotRoot();
    return sumBytes(
      this.failedSnapshotRows().map((row) => assertSnapshotArtifactPath(snapshotRoot, row.id, row.artifactPath)),
      snapshotRoot
    );
  }

  private snapshotRoot(): string {
    return ensurePlainManagedDirectory(
      this.config.memorepoHome,
      this.config.snapshotIndexesDir,
      "Snapshot index root"
    );
  }

  private deleteRemovedRepositoryIndexes(): FileCleanupResult {
    const targets = this.removedRepositoryIndexTargets();
    const removed = removePaths(targets.map((target) => target.cachePath), this.config.memorepoHome);
    const repositoryIds = Array.from(new Set(targets.map((target) => target.spaceRepositoryId)));
    const transaction = this.database.sqlite.transaction(() => {
      for (const repositoryId of repositoryIds) {
        this.database.sqlite.prepare("DELETE FROM repo_indexes WHERE space_repository_id = ?").run(repositoryId);
      }
    });
    transaction();
    return { count: repositoryIds.length, bytes: removed.bytes };
  }

  private deleteOrphanRepoIndexDirectories(): FileCleanupResult {
    const targets = this.orphanRepoIndexDirectories();
    const removed = removePaths(targets.map((target) => target.path), this.config.memorepoHome);
    return { count: targets.length, bytes: removed.bytes };
  }

  private deleteOrphanRevisionSources(): FileCleanupResult {
    const targets = this.orphanRevisionSourceTargets();
    const removed = removePaths(targets.map((target) => target.path), this.config.revisionSourcesDir);
    for (const entry of fs.readdirSync(this.config.revisionSourcesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const repositoryPath = path.join(this.config.revisionSourcesDir, entry.name);
      try {
        fs.rmdirSync(repositoryPath);
      } catch {
        // Referenced commits or concurrent filesystem activity keep the repository directory alive.
      }
    }
    return removed;
  }

  private deleteOldRepoIndexRecords(): CountCleanupResult {
    const ids = this.oldRepoIndexRecordIds();
    const transaction = this.database.sqlite.transaction(() => {
      for (const id of ids) {
        this.database.sqlite.prepare("DELETE FROM repo_indexes WHERE id = ?").run(id);
      }
    });
    transaction();
    return { count: ids.length };
  }

  private cleanupRemovedClones(): FileCleanupResult & { skipped: number } {
    const rows = this.removedCloneRows();
    let skipped = 0;
    let bytes = 0;
    let cleaned = 0;

    const transaction = this.database.sqlite.transaction((cleanedIds: string[]) => {
      const timestamp = nowIso();
      for (const id of cleanedIds) {
        this.database.sqlite
          .prepare(
            `
            UPDATE space_repositories
            SET clone_status = 'cleaned',
                index_status = 'not_indexed',
                snapshot_included = 0,
                last_error = NULL,
                updated_at = ?
            WHERE id = ?
          `
          )
          .run(timestamp, id);
      }
    });

    const cleanedIds: string[] = [];
    for (const row of rows) {
      if (this.hasActiveRepositoryJobs(row.id)) {
        skipped += 1;
        continue;
      }
      const removed = removeManagedPath(this.config.memorepoHome, row.localPath);
      bytes += removed.sizeBytes;
      cleaned += 1;
      cleanedIds.push(row.id);
    }

    transaction(cleanedIds);
    return { count: cleaned, bytes, skipped };
  }

  private deleteOldJobs(jobRetentionDays: number): CountCleanupResult {
    const ids = this.oldJobIds(jobRetentionDays);
    const transaction = this.database.sqlite.transaction(() => {
      for (const id of ids) {
        this.database.sqlite.prepare("DELETE FROM job_events WHERE job_id = ?").run(id);
      }
      for (const id of ids) {
        this.database.sqlite.prepare("DELETE FROM jobs WHERE id = ?").run(id);
      }
    });
    transaction();
    return { count: ids.length };
  }

  private failedSnapshotRows(): SnapshotCleanupRow[] {
    return this.database.sqlite
      .prepare(
        `
        SELECT
          ss.id,
          ss.space_id AS spaceId,
          ss.artifact_path AS artifactPath
        FROM space_snapshots ss
        LEFT JOIN spaces s ON s.active_snapshot_id = ss.id
        WHERE ss.status = 'failed'
          AND s.id IS NULL
      `
      )
      .all() as SnapshotCleanupRow[];
  }

  private oldRepoIndexRecordIds(): string[] {
    const rows = this.database.sqlite
      .prepare(
        `
        SELECT
          id,
          space_repository_id AS spaceRepositoryId,
          COALESCE(indexed_at, created_at) AS sortedAt
        FROM repo_indexes
        ORDER BY space_repository_id ASC, sortedAt DESC, created_at DESC
      `
      )
      .all() as RepoIndexRow[];
    const seen = new Set<string>();
    const old: string[] = [];
    for (const row of rows) {
      if (seen.has(row.spaceRepositoryId)) {
        old.push(row.id);
      } else {
        seen.add(row.spaceRepositoryId);
      }
    }
    return old;
  }

  private removedRepositoryIndexTargets(): RepoIndexTarget[] {
    return this.database.sqlite
      .prepare(
        `
        SELECT DISTINCT
          sr.id AS spaceRepositoryId,
          ri.cache_path AS cachePath
        FROM space_repositories sr
        JOIN repo_indexes ri ON ri.space_repository_id = sr.id
        WHERE sr.removed_at IS NOT NULL
          AND sr.clone_status = 'cleaned'
      `
      )
      .all() as RepoIndexTarget[];
  }

  private orphanRepoIndexDirectories(): PathTarget[] {
    if (!fs.existsSync(this.config.repoIndexesDir)) {
      return [];
    }
    const repositoryIds = new Set(
      (this.database.sqlite.prepare("SELECT id FROM space_repositories").all() as Array<{ id: string }>).map((row) => row.id)
    );
    return fs
      .readdirSync(this.config.repoIndexesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !repositoryIds.has(entry.name))
      .map((entry) => ({ path: path.join(this.config.repoIndexesDir, entry.name) }));
  }

  private orphanRevisionSourceTargets(): PathTarget[] {
    if (this.hasActiveSnapshotBuilds() || !fs.existsSync(this.config.revisionSourcesDir)) return [];
    const revisionRoot = path.resolve(this.config.revisionSourcesDir);
    const referenced = new Set<string>();
    const manifests = this.database.sqlite
      .prepare("SELECT manifest_json AS manifestJson FROM space_snapshots")
      .all() as Array<{ manifestJson: string }>;
    for (const row of manifests) {
      try {
        const manifest = JSON.parse(row.manifestJson) as { repositories?: Array<{ localPath?: unknown }> };
        for (const repository of manifest.repositories ?? []) {
          if (typeof repository.localPath !== "string") continue;
          const sourcePath = path.resolve(repository.localPath);
          if (!isStrictlyInside(revisionRoot, sourcePath)) continue;
          const relative = path.relative(revisionRoot, sourcePath);
          const [repositorySegment, commitSegment] = relative.split(path.sep);
          if (!repositorySegment || !commitSegment) continue;
          referenced.add(normalizePath(path.join(revisionRoot, repositorySegment, commitSegment)));
        }
      } catch {
        // Invalid manifests are handled by the snapshot gateway; they cannot retain shared sources.
      }
    }

    const targets: PathTarget[] = [];
    for (const repositoryEntry of fs.readdirSync(revisionRoot, { withFileTypes: true })) {
      const repositoryPath = path.join(revisionRoot, repositoryEntry.name);
      if (!repositoryEntry.isDirectory()) {
        targets.push({ path: repositoryPath });
        continue;
      }
      for (const commitEntry of fs.readdirSync(repositoryPath, { withFileTypes: true })) {
        const commitPath = path.join(repositoryPath, commitEntry.name);
        if (!referenced.has(normalizePath(commitPath))) targets.push({ path: commitPath });
      }
    }
    return targets;
  }

  private removedCloneRows(): RemovedCloneRow[] {
    return this.database.sqlite
      .prepare(
        `
        SELECT
          id,
          local_path AS localPath
        FROM space_repositories
        WHERE removed_at IS NOT NULL
          AND clone_status != 'cleaned'
      `
      )
      .all() as RemovedCloneRow[];
  }

  private oldJobIds(jobRetentionDays: number): string[] {
    const days = Math.max(1, Math.floor(jobRetentionDays));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const placeholders = TERMINAL_JOB_STATUSES.map(() => "?").join(", ");
    return (
      this.database.sqlite
        .prepare(
          `
          SELECT id
          FROM jobs
          WHERE status IN (${placeholders})
            AND COALESCE(finished_at, started_at, created_at) < ?
        `
        )
        .all(...TERMINAL_JOB_STATUSES, cutoff) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  private hasActiveRepositoryJobs(spaceRepositoryId: string): boolean {
    const row = this.database.sqlite
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM jobs
        WHERE space_repository_id = ?
          AND status IN ('pending', 'running')
      `
      )
      .get(spaceRepositoryId) as { count: number };
    return row.count > 0;
  }

  private hasActiveSnapshotBuilds(): boolean {
    const row = this.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM space_snapshots WHERE status = 'building'")
      .get() as { count: number };
    return row.count > 0;
  }
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isStrictlyInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function removePaths(paths: string[], memorepoHome: string): FileCleanupResult {
  let bytes = 0;
  const uniquePaths = Array.from(new Set(paths));
  for (const targetPath of uniquePaths) {
    bytes += removeManagedPath(memorepoHome, targetPath).sizeBytes;
  }
  return { count: uniquePaths.length, bytes };
}

function sumBytes(paths: string[], memorepoHome: string): number {
  let total = 0;
  for (const targetPath of Array.from(new Set(paths))) {
    total += managedPathSize(memorepoHome, targetPath);
  }
  return total;
}

interface SnapshotCleanupRow {
  id: string;
  spaceId: string;
  artifactPath: string;
}

interface RepoIndexRow {
  id: string;
  spaceRepositoryId: string;
}

interface RepoIndexTarget {
  spaceRepositoryId: string;
  cachePath: string;
}

interface PathTarget {
  path: string;
}

interface RemovedCloneRow {
  id: string;
  localPath: string;
}

interface CountCleanupResult {
  count: number;
}

interface FileCleanupResult extends CountCleanupResult {
  bytes: number;
}

export interface MaintenanceSummary {
  defaults: {
    snapshotRetention: number;
    jobRetentionDays: number;
  };
  candidates: {
    oldRepoIndexRecords: number;
    removedRepositoryIndexes: number;
    orphanRepoIndexDirectories: number;
    orphanRevisionSources: number;
    failedSnapshots: number;
    oldJobs: number;
    removedClones: number;
  };
  estimatedBytes: {
    failedSnapshots: number;
    removedRepositoryIndexes: number;
    orphanRepoIndexDirectories: number;
    removedClones: number;
  };
}

export interface MaintenanceResult {
  deletedAt: string;
  jobRetentionDays: number;
  oldRepoIndexRecords: CountCleanupResult;
  removedRepositoryIndexes: FileCleanupResult;
  orphanRepoIndexDirectories: FileCleanupResult;
  orphanRevisionSources: FileCleanupResult;
  failedSnapshots: FileCleanupResult;
  oldJobs: CountCleanupResult;
  removedClones: FileCleanupResult & { skipped: number };
}
