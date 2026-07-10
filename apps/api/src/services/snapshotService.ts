import path from "node:path";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/connection.js";
import { insertRecord, updateRecord } from "../db/sql.js";
import { NotFoundError } from "../domain/errors.js";
import { managedPathSize, removeManagedPath } from "../domain/files.js";
import { createId } from "../domain/ids.js";
import { ensureInsideDir } from "../domain/paths.js";
import { nowIso } from "../domain/time.js";
import type { CbmService } from "./cbmService.js";
import type { SpaceRepositoryRecord } from "./spaceService.js";

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
  constructor(
    private readonly database: AppDatabase,
    private readonly config: AppConfig,
    private readonly cbm: CbmService
  ) {}

  async buildSpaceSnapshot(spaceId: string, onOutput?: (line: string) => void) {
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

    const previousSnapshot = this.getActiveSnapshot(spaceId) as { artifact_path?: string } | null;
    const version = this.nextVersion(spaceId);
    const snapshotId = createId("snp");
    const createdAt = nowIso();
    const versionName = `v${version.toString().padStart(6, "0")}`;
    const artifactPath = ensureInsideDir(this.config.memorepoHome, path.join(this.config.snapshotIndexesDir, snapshotId));

    insertRecord(this.database, "space_snapshots", {
      id: snapshotId,
      spaceId,
      version,
      status: "building",
      artifactPath,
      manifestJson: JSON.stringify({ snapshotId, version, createdAt, repositories: [] }),
      createdAt,
      activatedAt: null,
      error: null
    });

    this.updateSpaceSnapshotStatus(spaceId, "building");

    try {
      const manifestRepositories: SnapshotManifestRepository[] = [];

      for (const repo of activeRepos) {
        onOutput?.(`Indexing ${repo.full_name} into snapshot ${versionName}`);
        const result = await this.cbm.indexRepository(repo.local_path, artifactPath, "fast", onOutput);
        const projectName = result.project ?? this.projectNameFromPath(repo.local_path);
        manifestRepositories.push({
          spaceRepositoryId: repo.id,
          githubRepositoryId: repo.github_repository_id,
          fullName: repo.full_name,
          branch: repo.selected_branch!,
          commit: repo.selected_commit!,
          projectName,
          localPath: repo.local_path
        });
      }

      if (activeRepos.length > 1) {
        for (const repo of activeRepos) {
          onOutput?.(`Linking cross-repo intelligence for ${repo.full_name}`);
          await this.cbm.buildCrossRepoLinks(repo.local_path, artifactPath, onOutput);
        }
      }

      const manifest: SnapshotManifest = {
        snapshotId,
        version,
        createdAt,
        repositories: manifestRepositories
      };
      const activatedAt = nowIso();

      this.database.sqlite.transaction(() => {
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
            error: null
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

      if (previousSnapshot?.artifact_path && previousSnapshot.artifact_path !== artifactPath) {
        await this.cbm.closeSession(previousSnapshot.artifact_path);
      }

      return { snapshotId, version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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

      throw error;
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
    return {
      snapshots: rows.map((row) => toPublicSnapshot(row, activeSnapshotId, this.config.memorepoHome)),
      totalSizeBytes: rows.reduce((total, row) => total + managedPathSize(this.config.memorepoHome, row.artifactPath), 0),
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
    let bytes = 0;
    for (const row of candidates) {
      await this.cbm.closeSession(row.artifactPath);
      bytes += removeManagedPath(this.config.memorepoHome, row.artifactPath).sizeBytes;
    }

    const transaction = this.database.sqlite.transaction(() => {
      for (const row of candidates) {
        this.database.sqlite.prepare("DELETE FROM space_snapshots WHERE id = ?").run(row.id);
      }
    });
    transaction();

    return {
      prunedAt: nowIso(),
      keepLatest: retention,
      deletedCount: candidates.length,
      deletedBytes: bytes,
      retainedCount: rows.length - candidates.length
    };
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
          error
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
}

function toPublicSnapshot(row: SnapshotRow, activeSnapshotId: string | null, memorepoHome: string): PublicSnapshot {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    active: row.id === activeSnapshotId,
    repositoryCount: snapshotRepositoryCount(row.manifestJson),
    sizeBytes: managedPathSize(memorepoHome, row.artifactPath),
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    error: row.error
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

interface SnapshotRow {
  id: string;
  version: number;
  status: string;
  artifactPath: string;
  manifestJson: string;
  createdAt: string;
  activatedAt: string | null;
  error: string | null;
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
