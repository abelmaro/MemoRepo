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
import { createSnapshotRebuildFingerprint } from "./snapshotRebuildFingerprint.js";
import { classifyProcessTermination, directorySizeBytes, readCgroupMemoryMetrics, recordCbmOperationMetric } from "./operationalMetrics.js";
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
      const result = await this.github.syncRepositories(context.signal);
      context.log(`Synced ${result.count} repositories`);
      for (const warning of result.warnings) {
        context.log(warning);
      }
    });

    this.jobs.register("refresh_branches", async (payload, context) => {
      const spaceRepositoryId = stringPayload(payload, "spaceRepositoryId");
      const record = this.spaces.getSpaceRepository(spaceRepositoryId);
      context.log(`Refreshing remote branches for ${record.full_name}`);
      const branches = await this.git.fetchBranches(record.local_path, { onOutput: context.log, signal: context.signal });
      this.updateBranches(spaceRepositoryId, branches);
      context.log(`Found ${branches.length} remote branches`);
    });

    this.jobs.register("clone_space_repository", async (payload, context) => {
      const spaceRepositoryId = stringPayload(payload, "spaceRepositoryId");
      const record = this.spaces.getSpaceRepository(spaceRepositoryId);
      const timestamp = nowIso();
      updateRecord(this.database, "space_repositories", { cloneStatus: "cloning", lastError: null, updatedAt: timestamp }, "id", spaceRepositoryId);

      try {
        const cloneStartedAt = Date.now();
        context.log(`Cloning ${record.full_name}`);
        await this.git.cloneRepository(record.clone_url, record.local_path, { onOutput: context.log, signal: context.signal });
        context.log(`Clone completed in ${formatDuration(Date.now() - cloneStartedAt)}`);
        const branches = await this.git.listBranches(record.local_path, { signal: context.signal });
        context.log(`Discovered ${branches.length} remote branches without a redundant network fetch`);
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
      const useExistingFetch = payload.useExistingFetch === true;
      const record = this.spaces.getSpaceRepository(spaceRepositoryId);
      const branch = requestedBranch ?? record.selected_branch ?? record.default_branch;
      context.log(`Checking out ${record.full_name} at origin/${branch}`);

      updateRecord(this.database, "space_repositories", { indexStatus: "stale", lastError: null, updatedAt: nowIso() }, "id", spaceRepositoryId);
      this.spaces.markSpaceStale(record.space_id);

      try {
        const branches = useExistingFetch
          ? await this.git.listBranches(record.local_path, { signal: context.signal })
          : await this.git.fetchBranches(record.local_path, { onOutput: context.log, signal: context.signal });
        this.updateBranches(spaceRepositoryId, branches);
        if (!branches.includes(branch)) {
          throw new Error(`Remote branch not found: ${branch}`);
        }
        const checkoutStartedAt = Date.now();
        const commit = await this.git.checkoutFetchedRemoteBranch(record.local_path, branch, {
          onOutput: context.log,
          signal: context.signal
        });
        context.log(`Checkout completed in ${formatDuration(Date.now() - checkoutStartedAt)}`);
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
      await this.indexSpaceRepository(spaceRepositoryId, context.log, context.signal);
    });

    this.jobs.register("rebuild_space_snapshot", async (payload, context) => {
      const spaceId = stringPayload(payload, "spaceId");
      context.log("Building immutable cross-repo snapshot");
      const snapshot = await this.snapshots.buildSpaceSnapshot(spaceId, context.log, context.signal);
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
        throwIfAborted(context.signal);
        const spaceRepositoryId = String(repository.id);
        const branch = String(repository.selected_branch ?? repository.default_branch);
        const fullName = String(repository.full_name);
        const localPath = String(repository.local_path);
        context.log(`Checking ${fullName} at origin/${branch}`);
        const remote = await this.git.fetchBranchState(localPath, branch, { onOutput: context.log, signal: context.signal });
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

        const commit = await this.git.checkoutFetchedRemoteBranch(localPath, branch, { onOutput: context.log, signal: context.signal });
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
        await this.indexSpaceRepository(spaceRepositoryId, context.log, context.signal);
        updatedRepositories += 1;
      }

      const space = this.spaces.getSpaceById(spaceId);
      const snapshotNeedsRebuild =
        updatedRepositories > 0 ||
        space.snapshotStatus !== "active" ||
        repositories.some((repository) => !Boolean(repository.snapshot_included));

      if (snapshotNeedsRebuild) {
        context.log("Building immutable cross-repo snapshot");
        const snapshot = await this.snapshots.buildSpaceSnapshot(spaceId, context.log, context.signal);
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
    return this.enqueueAddRepositories(spaceId, [githubRepositoryId], true);
  }

  enqueueAddRepositories(spaceId: string, githubRepositoryIds: string[], singleCompatibility = false) {
    this.spaces.assertSpaceAcceptsWork(spaceId);
    const uniqueIds = [...new Set(githubRepositoryIds)];
    if (uniqueIds.length === 0 || uniqueIds.length > 50 || uniqueIds.some((id) => !id)) {
      throw new Error("Repository batch must contain between 1 and 50 unique repository IDs");
    }
    const spaceRepositories = uniqueIds.map((repositoryId) => this.spaces.addRepositoryToSpace(spaceId, repositoryId));
    const repositoryJobs = spaceRepositories.map((spaceRepository) => {
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
        payload: { spaceRepositoryId: spaceRepository.id, useExistingFetch: true }
      });
      if (this.config.snapshotOnlyIndexing) return { spaceRepository, jobs: [cloneJob, checkoutJob], terminal: checkoutJob };
      const indexJob = this.jobs.enqueue({
        type: "index_space_repository",
        spaceId,
        spaceRepositoryId: spaceRepository.id,
        dependsOnJobId: checkoutJob.id,
        payload: { spaceRepositoryId: spaceRepository.id }
      });
      return { spaceRepository, jobs: [cloneJob, checkoutJob, indexJob], terminal: indexJob };
    });
    const snapshotJob = this.enqueueSnapshotRebuild(spaceId, repositoryJobs.map((entry) => entry.terminal.id));
    const jobs = [...repositoryJobs.flatMap((entry) => entry.jobs), snapshotJob];
    if (singleCompatibility) return { spaceRepository: spaceRepositories[0]!, jobs };
    return { spaceRepositories, jobs, snapshotJob };
  }

  enqueueCheckout(spaceRepositoryId: string, branch: string) {
    const record = this.spaces.getSpaceRepository(spaceRepositoryId);
    this.spaces.assertSpaceAcceptsWork(record.space_id);
    const checkoutJob = this.jobs.enqueue({
      type: "checkout_space_repository",
      spaceId: record.space_id,
      spaceRepositoryId,
      payload: { spaceRepositoryId, branch }
    });
    if (this.config.snapshotOnlyIndexing) {
      const snapshotJob = this.enqueueSnapshotRebuild(record.space_id, [checkoutJob.id]);
      return [checkoutJob, snapshotJob];
    }
    const indexJob = this.jobs.enqueue({
      type: "index_space_repository",
      spaceId: record.space_id,
      spaceRepositoryId,
      dependsOnJobId: checkoutJob.id,
      payload: { spaceRepositoryId }
    });
    const snapshotJob = this.enqueueSnapshotRebuild(record.space_id, [indexJob.id]);
    return [checkoutJob, indexJob, snapshotJob];
  }

  enqueueReindexRepository(spaceRepositoryId: string) {
    const record = this.spaces.getSpaceRepository(spaceRepositoryId);
    this.spaces.assertSpaceAcceptsWork(record.space_id);
    return this.enqueueCheckout(spaceRepositoryId, record.selected_branch ?? record.default_branch);
  }

  enqueueRefreshBranches(spaceRepositoryId: string) {
    const record = this.spaces.getSpaceRepository(spaceRepositoryId);
    this.spaces.assertSpaceAcceptsWork(record.space_id);
    return this.jobs.enqueue({
      type: "refresh_branches",
      spaceId: record.space_id,
      spaceRepositoryId,
      payload: { spaceRepositoryId }
    });
  }

  enqueueReindexSpace(spaceId: string) {
    this.spaces.assertSpaceAcceptsWork(spaceId);
    return this.jobs.enqueue({ type: "reindex_space", spaceId, payload: { spaceId } });
  }

  enqueueRemoveRepository(spaceRepositoryId: string) {
    const record = this.spaces.getSpaceRepository(spaceRepositoryId);
    this.spaces.assertSpaceAcceptsWork(record.space_id);
    const removal = this.spaces.softRemoveSpaceRepository(spaceRepositoryId);
    const remainingRepositories = this.spaces.listSpaceRepositories(record.space_id);
    const snapshotJob =
      removal.revokedSnapshotId && remainingRepositories.length > 0
        ? this.enqueueSnapshotRebuild(record.space_id)
        : null;

    return { ...removal, job: snapshotJob };
  }

  private enqueueSnapshotRebuild(spaceId: string, dependencyJobIds: string[] = []) {
    const repositories = (this.spaces.listSpaceRepositories(spaceId) as Array<Record<string, unknown>>).map((repository) => ({
      repositoryId: String(repository.id),
      commit: typeof repository.selected_commit === "string" ? repository.selected_commit : null
    }));
    const fingerprint = createSnapshotRebuildFingerprint({ spaceId, mode: this.config.cbmIndexMode, repositories });
    const activeRepositoryJobs = (this.database.sqlite.prepare(
      `SELECT id FROM jobs
       WHERE space_id = ?
         AND status IN ('pending', 'running')
         AND type IN ('clone_space_repository', 'checkout_space_repository', 'index_space_repository')
         AND NOT EXISTS (
           SELECT 1
           FROM job_dependencies jd
           JOIN jobs dependent ON dependent.id = jd.job_id
           WHERE jd.dependency_job_id = jobs.id
             AND dependent.space_id = jobs.space_id
             AND dependent.status IN ('pending', 'running')
             AND dependent.type IN ('clone_space_repository', 'checkout_space_repository', 'index_space_repository')
         )
       ORDER BY created_at ASC, id ASC`
    ).all(spaceId) as Array<{ id: string }>).map((job) => job.id);
    return this.jobs.enqueueCoalesced({
      type: "rebuild_space_snapshot",
      spaceId,
      fingerprint,
      dependsOnJobIds: [...new Set([...activeRepositoryJobs, ...dependencyJobIds])],
      payload: { spaceId, mode: this.config.cbmIndexMode }
    });
  }

  private async indexSpaceRepository(spaceRepositoryId: string, log: (message: string) => void, signal?: AbortSignal) {
    const record = this.spaces.getSpaceRepository(spaceRepositoryId);
    if (!record.selected_branch || !record.selected_commit) {
      throw new Error(`${record.full_name} must be checked out before indexing`);
    }

    updateRecord(this.database, "space_repositories", { indexStatus: "indexing", lastError: null, updatedAt: nowIso() }, "id", spaceRepositoryId);

    const metricStartedAt = Date.now();
    const memoryBefore = readCgroupMemoryMetrics();
    try {
      const cachePath = path.join(this.config.repoIndexesDir, spaceRepositoryId);
      const indexStartedAt = Date.now();
      log(`Indexing ${record.full_name}`);
      const result = await this.cbm.indexRepository(record.local_path, cachePath, this.config.cbmIndexMode, log, signal);
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
      const memoryAfter = readCgroupMemoryMetrics();
      recordCbmOperationMetric(this.database, {
        operation: "index_repository", status: result.status, durationMs: Date.now() - metricStartedAt,
        spaceId: record.space_id, spaceRepositoryId, projectName, indexMode: this.config.cbmIndexMode,
        ...(result.nodes !== undefined ? { nodes: result.nodes } : {}),
        ...(result.edges !== undefined ? { edges: result.edges } : {}),
        skippedCount: result.skippedCount,
        artifactBytes: directorySizeBytes(cachePath), terminationKind: "completed",
        cgroupPeakBytes: memoryAfter.peakBytes
      });
      log(`Indexed ${record.full_name}`);
      log(`Repository index completed in ${formatDuration(Date.now() - indexStartedAt)}`);
    } catch (error) {
      const memory = readCgroupMemoryMetrics();
      recordCbmOperationMetric(this.database, {
        operation: "index_repository", status: "error", durationMs: Date.now() - metricStartedAt,
        spaceId: record.space_id, spaceRepositoryId, indexMode: this.config.cbmIndexMode,
        terminationKind: classifyProcessTermination({ error, cgroupOomKills: Math.max(0, memory.oomKillEvents - memoryBefore.oomKillEvents) }),
        cgroupPeakBytes: memory.peakBytes
      });
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

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = signal.reason instanceof Error ? new Error(signal.reason.message) : new Error("Operation cancelled");
  error.name = "AbortError";
  throw error;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}
