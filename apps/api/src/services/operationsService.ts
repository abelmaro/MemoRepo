import path from "node:path";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/connection.js";
import { insertRecord, updateRecord } from "../db/sql.js";
import { createId } from "../domain/ids.js";
import { nowIso } from "../domain/time.js";
import type { CbmService } from "./cbmService.js";
import type { GitService } from "./gitService.js";
import type { GitHubService } from "./githubService.js";
import type { JobRunner } from "./jobRunner.js";
import type { SnapshotService } from "./snapshotService.js";
import type { SpaceService } from "./spaceService.js";

export class OperationsService {
  constructor(
    private readonly database: AppDatabase,
    private readonly config: AppConfig,
    private readonly spaces: SpaceService,
    private readonly github: GitHubService,
    private readonly git: GitService,
    private readonly cbm: CbmService,
    private readonly snapshots: SnapshotService,
    private readonly jobs: JobRunner
  ) {}

  registerJobHandlers(): void {
    this.jobs.register("sync_github_repositories", async (_payload, context) => {
      context.log("Syncing repositories visible to the connected GitHub account");
      const result = await this.github.syncRepositories();
      context.log(`Synced ${result.count} repositories`);
      for (const warning of result.warnings) {
        context.log(warning);
      }
    });

    this.jobs.register("refresh_branches", async (payload, context) => {
      const spaceRepositoryId = stringPayload(payload, "spaceRepositoryId");
      const record = this.spaces.getSpaceRepository(spaceRepositoryId);
      context.log(`Refreshing remote branches for ${record.full_name}`);
      const branches = await this.git.fetchBranches(record.local_path, { onOutput: context.log });
      this.updateBranches(spaceRepositoryId, branches);
      context.log(`Found ${branches.length} remote branches`);
    });

    this.jobs.register("clone_space_repository", async (payload, context) => {
      const spaceRepositoryId = stringPayload(payload, "spaceRepositoryId");
      const record = this.spaces.getSpaceRepository(spaceRepositoryId);
      const timestamp = nowIso();
      updateRecord(this.database, "space_repositories", { cloneStatus: "cloning", lastError: null, updatedAt: timestamp }, "id", spaceRepositoryId);

      try {
        context.log(`Cloning ${record.full_name}`);
        await this.git.cloneRepository(record.clone_url, record.local_path, { onOutput: context.log });
        const branches = await this.git.fetchBranches(record.local_path, { onOutput: context.log });
        updateRecord(
          this.database,
          "space_repositories",
          {
            cloneStatus: "cloned",
            branchesJson: JSON.stringify(branches),
            lastFetchedAt: nowIso(),
            lastError: null,
            updatedAt: nowIso()
          },
          "id",
          spaceRepositoryId
        );
      } catch (error) {
        this.failSpaceRepository(spaceRepositoryId, "cloneStatus", error);
        throw error;
      }
    });

    this.jobs.register("checkout_space_repository", async (payload, context) => {
      const spaceRepositoryId = stringPayload(payload, "spaceRepositoryId");
      const requestedBranch = optionalStringPayload(payload, "branch");
      const record = this.spaces.getSpaceRepository(spaceRepositoryId);
      const branch = requestedBranch ?? record.selected_branch ?? record.default_branch;
      context.log(`Checking out ${record.full_name} at origin/${branch}`);

      updateRecord(this.database, "space_repositories", { indexStatus: "stale", lastError: null, updatedAt: nowIso() }, "id", spaceRepositoryId);
      this.spaces.markSpaceStale(record.space_id);

      try {
        const branches = await this.git.fetchBranches(record.local_path, { onOutput: context.log });
        this.updateBranches(spaceRepositoryId, branches);
        if (!branches.includes(branch)) {
          throw new Error(`Remote branch not found: ${branch}`);
        }
        const commit = await this.git.checkoutRemoteBranch(record.local_path, branch, { onOutput: context.log });
        updateRecord(
          this.database,
          "space_repositories",
          {
            selectedBranch: branch,
            selectedCommit: commit,
            remoteRef: `refs/remotes/origin/${branch}`,
            cloneStatus: "cloned",
            indexStatus: "stale",
            lastError: null,
            updatedAt: nowIso()
          },
          "id",
          spaceRepositoryId
        );
        context.log(`Checked out ${commit.slice(0, 12)}`);
      } catch (error) {
        this.failSpaceRepository(spaceRepositoryId, "indexStatus", error);
        throw error;
      }
    });

    this.jobs.register("index_space_repository", async (payload, context) => {
      const spaceRepositoryId = stringPayload(payload, "spaceRepositoryId");
      await this.indexSpaceRepository(spaceRepositoryId, context.log);
    });

    this.jobs.register("rebuild_space_snapshot", async (payload, context) => {
      const spaceId = stringPayload(payload, "spaceId");
      context.log("Building immutable cross-repo snapshot");
      const snapshot = await this.snapshots.buildSpaceSnapshot(spaceId, context.log);
      context.log(`Activated snapshot v${snapshot.version.toString().padStart(6, "0")}`);
    });

    this.jobs.register("reindex_space", async (payload, context) => {
      const spaceId = stringPayload(payload, "spaceId");
      const repositories = this.spaces.listSpaceRepositories(spaceId) as Array<Record<string, unknown>>;
      if (repositories.length === 0) {
        throw new Error("Space has no repositories");
      }

      context.log(`Checking ${repositories.length} repositories for remote updates`);
      let updatedRepositories = 0;
      for (const repository of repositories) {
        const spaceRepositoryId = String(repository.id);
        const branch = String(repository.selected_branch ?? repository.default_branch);
        const fullName = String(repository.full_name);
        const localPath = String(repository.local_path);
        context.log(`Checking ${fullName} at origin/${branch}`);
        const remote = await this.git.fetchBranchState(localPath, branch, { onOutput: context.log });
        this.updateBranches(spaceRepositoryId, remote.branches);

        const selectedCommit = typeof repository.selected_commit === "string" ? repository.selected_commit : null;
        const indexStatus = String(repository.index_status);
        const commitChanged = selectedCommit !== remote.commit;
        const needsIndex = commitChanged || indexStatus !== "indexed";
        if (!needsIndex) {
          context.log(`${fullName} is up to date at ${remote.commit.slice(0, 12)}`);
          continue;
        }

        const reason = commitChanged
          ? `${selectedCommit?.slice(0, 12) ?? "no indexed commit"} -> ${remote.commit.slice(0, 12)}`
          : `index status is ${indexStatus}`;
        context.log(`Updating ${fullName}: ${reason}`);
        updateRecord(this.database, "space_repositories", { indexStatus: "stale", lastError: null, updatedAt: nowIso() }, "id", spaceRepositoryId);
        this.spaces.markSpaceStale(spaceId);

        const commit = await this.git.checkoutFetchedRemoteBranch(localPath, branch, { onOutput: context.log });
        updateRecord(
          this.database,
          "space_repositories",
          {
            selectedBranch: branch,
            selectedCommit: commit,
            remoteRef: `refs/remotes/origin/${branch}`,
            cloneStatus: "cloned",
            indexStatus: "stale",
            lastError: null,
            updatedAt: nowIso()
          },
          "id",
          spaceRepositoryId
        );
        await this.indexSpaceRepository(spaceRepositoryId, context.log);
        updatedRepositories += 1;
      }

      const space = this.spaces.getSpaceById(spaceId);
      const snapshotNeedsRebuild =
        updatedRepositories > 0 ||
        space.snapshotStatus !== "active" ||
        repositories.some((repository) => !Boolean(repository.snapshot_included));

      if (snapshotNeedsRebuild) {
        context.log("Building immutable cross-repo snapshot");
        const snapshot = await this.snapshots.buildSpaceSnapshot(spaceId, context.log);
        context.log(`Activated snapshot v${snapshot.version.toString().padStart(6, "0")}`);
      } else {
        context.log("Active snapshot is already up to date");
      }
      context.log(`Checked ${repositories.length} repositories; updated ${updatedRepositories}`);
    });
  }

  enqueueGitHubSync() {
    return this.jobs.enqueue({ type: "sync_github_repositories" });
  }

  enqueueAddRepository(spaceId: string, githubRepositoryId: string) {
    const spaceRepository = this.spaces.addRepositoryToSpace(spaceId, githubRepositoryId);
    const cloneJob = this.jobs.enqueue({
      type: "clone_space_repository",
      spaceId,
      spaceRepositoryId: spaceRepository.id,
      payload: { spaceRepositoryId: spaceRepository.id }
    });
    const checkoutJob = this.jobs.enqueue({
      type: "checkout_space_repository",
      spaceId,
      spaceRepositoryId: spaceRepository.id,
      dependsOnJobId: cloneJob.id,
      payload: { spaceRepositoryId: spaceRepository.id }
    });
    const indexJob = this.jobs.enqueue({
      type: "index_space_repository",
      spaceId,
      spaceRepositoryId: spaceRepository.id,
      dependsOnJobId: checkoutJob.id,
      payload: { spaceRepositoryId: spaceRepository.id }
    });
    const snapshotJob = this.jobs.enqueue({
      type: "rebuild_space_snapshot",
      spaceId,
      dependsOnJobId: indexJob.id,
      payload: { spaceId }
    });

    return { spaceRepository, jobs: [cloneJob, checkoutJob, indexJob, snapshotJob] };
  }

  enqueueCheckout(spaceRepositoryId: string, branch: string) {
    const record = this.spaces.getSpaceRepository(spaceRepositoryId);
    const checkoutJob = this.jobs.enqueue({
      type: "checkout_space_repository",
      spaceId: record.space_id,
      spaceRepositoryId,
      payload: { spaceRepositoryId, branch }
    });
    const indexJob = this.jobs.enqueue({
      type: "index_space_repository",
      spaceId: record.space_id,
      spaceRepositoryId,
      dependsOnJobId: checkoutJob.id,
      payload: { spaceRepositoryId }
    });
    const snapshotJob = this.jobs.enqueue({
      type: "rebuild_space_snapshot",
      spaceId: record.space_id,
      dependsOnJobId: indexJob.id,
      payload: { spaceId: record.space_id }
    });
    return [checkoutJob, indexJob, snapshotJob];
  }

  enqueueReindexRepository(spaceRepositoryId: string) {
    const record = this.spaces.getSpaceRepository(spaceRepositoryId);
    return this.enqueueCheckout(spaceRepositoryId, record.selected_branch ?? record.default_branch);
  }

  enqueueRefreshBranches(spaceRepositoryId: string) {
    const record = this.spaces.getSpaceRepository(spaceRepositoryId);
    return this.jobs.enqueue({
      type: "refresh_branches",
      spaceId: record.space_id,
      spaceRepositoryId,
      payload: { spaceRepositoryId }
    });
  }

  enqueueReindexSpace(spaceId: string) {
    return this.jobs.enqueue({ type: "reindex_space", spaceId, payload: { spaceId } });
  }

  enqueueRemoveRepository(spaceRepositoryId: string) {
    const record = this.spaces.getSpaceRepository(spaceRepositoryId);
    const removal = this.spaces.softRemoveSpaceRepository(spaceRepositoryId);
    const remainingRepositories = this.spaces.listSpaceRepositories(record.space_id);
    const snapshotJob =
      removal.revokedSnapshotId && remainingRepositories.length > 0
        ? this.jobs.enqueue({
            type: "rebuild_space_snapshot",
            spaceId: record.space_id,
            payload: { spaceId: record.space_id }
          })
        : null;

    return { ...removal, job: snapshotJob };
  }

  private async indexSpaceRepository(spaceRepositoryId: string, log: (message: string) => void) {
    const record = this.spaces.getSpaceRepository(spaceRepositoryId);
    if (!record.selected_branch || !record.selected_commit) {
      throw new Error(`${record.full_name} must be checked out before indexing`);
    }

    updateRecord(this.database, "space_repositories", { indexStatus: "indexing", lastError: null, updatedAt: nowIso() }, "id", spaceRepositoryId);

    try {
      const cachePath = path.join(this.config.repoIndexesDir, spaceRepositoryId);
      log(`Indexing ${record.full_name}`);
      const result = await this.cbm.indexRepository(record.local_path, cachePath, "fast", log);
      const projectName = result.project ?? record.local_path.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const timestamp = nowIso();
      insertRecord(this.database, "repo_indexes", {
        id: createId("idx"),
        spaceRepositoryId,
        projectName,
        cachePath,
        branch: record.selected_branch,
        commitSha: record.selected_commit,
        status: String(result.status ?? "indexed"),
        indexedAt: timestamp,
        error: null,
        createdAt: timestamp
      });
      updateRecord(
        this.database,
        "space_repositories",
        {
          indexStatus: "indexed",
          lastIndexedAt: timestamp,
          lastError: null,
          updatedAt: timestamp
        },
        "id",
        spaceRepositoryId
      );
      log(`Indexed ${record.full_name}`);
    } catch (error) {
      this.failSpaceRepository(spaceRepositoryId, "indexStatus", error);
      throw error;
    }
  }

  private updateBranches(spaceRepositoryId: string, branches: string[]): void {
    updateRecord(
      this.database,
      "space_repositories",
      { branchesJson: JSON.stringify(branches), lastFetchedAt: nowIso(), updatedAt: nowIso() },
      "id",
      spaceRepositoryId
    );
  }

  private failSpaceRepository(spaceRepositoryId: string, statusColumn: "cloneStatus" | "indexStatus", error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const values =
      statusColumn === "cloneStatus"
        ? { cloneStatus: "failed", lastError: message, updatedAt: nowIso() }
        : { indexStatus: "failed", lastError: message, updatedAt: nowIso() };

    updateRecord(this.database, "space_repositories", values, "id", spaceRepositoryId);
  }
}

function stringPayload(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing payload field: ${key}`);
  }
  return value;
}

function optionalStringPayload(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
