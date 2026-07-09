import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/connection.js";
import { publicJobSelectColumns } from "../db/jobProjection.js";
import { insertRecord, type SqlValue, updateRecord } from "../db/sql.js";
import { NotFoundError } from "../domain/errors.js";
import { removeManagedPath } from "../domain/files.js";
import { createId } from "../domain/ids.js";
import { assertInside, ensureInsideDir, repoPathName } from "../domain/paths.js";
import { slugify } from "../domain/slug.js";
import { nowIso } from "../domain/time.js";
import type { CbmService } from "./cbmService.js";

export class SpaceService {
  constructor(
    private readonly database: AppDatabase,
    private readonly config: AppConfig,
    private readonly cbm: CbmService
  ) {}

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
    const rootPath = ensureInsideDir(this.config.memorepoHome, path.join(this.config.spacesDir, slug));

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
    const timestamp = nowIso();
    updateRecord(this.database, "spaces", { name: name.trim(), updatedAt: timestamp }, "id", id);
    return this.getSpaceById(id);
  }

  deleteSpace(id: string) {
    const space = this.getSpaceById(id);
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
    })();

    const filesExisted = fs.existsSync(safeRootPath);
    if (filesExisted) {
      fs.rmSync(safeRootPath, { recursive: true, force: true });
    }

    return { deletedAt, spaceId: id, connectionsDeleted, toolStatsDeleted, filesExisted };
  }

  async deleteSpaceWithManagedData(id: string) {
    const space = this.getSpaceById(id);
    const jobs = this.spaceJobRows(id);
    const activeJob = jobs.find((job) => job.status === "pending" || job.status === "running");
    if (activeJob) {
      throw new Error("Space has pending or running jobs");
    }

    const repositoryIds = this.database.sqlite
      .prepare("SELECT id FROM space_repositories WHERE space_id = ?")
      .all(id) as Array<{ id: string }>;
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

    for (const snapshot of snapshots) {
      await this.cbm.closeSession(snapshot.artifactPath);
    }

    const deletedAt = nowIso();

    const jobIds = jobs.map((job) => job.id);
    let connectionsDeleted = 0;
    let toolStatsDeleted = 0;
    const transaction = this.database.sqlite.transaction(() => {
      for (const jobId of jobIds) {
        this.database.sqlite.prepare("DELETE FROM job_events WHERE job_id = ?").run(jobId);
      }
      for (const jobId of jobIds) {
        this.database.sqlite.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
      }
      toolStatsDeleted = this.database.sqlite.prepare("DELETE FROM mcp_tool_stats WHERE space_id = ?").run(id).changes;
      connectionsDeleted = this.database.sqlite.prepare("DELETE FROM mcp_connections WHERE space_id = ?").run(id).changes;
      this.database.sqlite
        .prepare(
          `
          DELETE FROM repo_indexes
          WHERE space_repository_id IN (
            SELECT id FROM space_repositories WHERE space_id = ?
          )
        `
        )
        .run(id);
      this.database.sqlite.prepare("DELETE FROM space_snapshots WHERE space_id = ?").run(id);
      this.database.sqlite.prepare("DELETE FROM space_repositories WHERE space_id = ?").run(id);
      this.database.sqlite.prepare("DELETE FROM spaces WHERE id = ?").run(id);
    });
    transaction();

    const removedPaths = [
      ...removeUniqueManagedPaths(repoIndexes.map((row) => row.cachePath), this.config.memorepoHome),
      ...removeUniqueManagedPaths(snapshots.map((row) => row.artifactPath), this.config.memorepoHome),
      removeManagedPath(this.config.memorepoHome, space.rootPath)
    ];
    const deletedBytes = removedPaths.reduce((total, item) => total + item.sizeBytes, 0);

    return {
      deletedAt,
      spaceId: id,
      deletedBytes,
      filesDeleted: removedPaths.filter((item) => item.existed).length,
      repositoriesDeleted: repositoryIds.length,
      snapshotsDeleted: snapshots.length,
      repoIndexPathsDeleted: new Set(repoIndexes.map((row) => row.cachePath)).size,
      jobsDeleted: jobIds.length,
      connectionsDeleted,
      toolStatsDeleted
    };
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
    return this.listSpaceRepositoriesByRemovalState(spaceId, true);
  }

  private listSpaceRepositoriesByRemovalState(spaceId: string, removed: boolean) {
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
    this.markSpaceStale(record.space_id);
    return { removedAt: timestamp };
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

function removeUniqueManagedPaths(paths: string[], memorepoHome: string) {
  return Array.from(new Set(paths)).map((targetPath) => removeManagedPath(memorepoHome, targetPath));
}
