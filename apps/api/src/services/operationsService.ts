import path from "node:path";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/connection.js";
import { insertRecord, updateRecord } from "../db/sql.js";
import { createId } from "../domain/ids.js";
import { NotFoundError } from "../domain/errors.js";
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
        const needsMutableIndex = !this.config.snapshotOnlyIndexing && (commitChanged || indexStatus !== "indexed");
        if (!commitChanged && !needsMutableIndex) {
          context.log(`${fullName} is up to date at ${remote.commit.slice(0, 12)}`);
          continue;
        }

        const reason = commitChanged
          ? `${selectedCommit?.slice(0, 12) ?? "no indexed commit"} -> ${remote.commit.slice(0, 12)}`
          : `index status is ${indexStatus}`;
        context.log(`Updating ${fullName}: ${reason}`);
        updateRecord(this.database, "space_repositories", { indexStatus: "stale", lastError: null, updatedAt: nowIso() }, "id", spaceRepositoryId);
        this.spaces.markSpaceStale(spaceId);

        if (commitChanged) {
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
        }
        if (needsMutableIndex) {
          await this.indexSpaceRepository(spaceRepositoryId, context.log, context.signal);
        }
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
    return this.enqueueRepositorySet(spaceId, [githubRepositoryId], true, null);
  }

  enqueueAddRepositories(spaceId: string, githubRepositoryIds: string[], requestId = createId("req")) {
    return this.enqueueRepositorySet(spaceId, githubRepositoryIds, false, requestId);
  }

  private enqueueRepositorySet(
    spaceId: string,
    githubRepositoryIds: string[],
    singleCompatibility: boolean,
    requestId: string | null
  ) {
    const uniqueIds = [...new Set(githubRepositoryIds)];
    if (uniqueIds.length === 0 || uniqueIds.length > 50 || uniqueIds.some((id) => !id)) {
      throw new Error("Repository batch must contain between 1 and 50 unique repository IDs");
    }
    const canonicalRepositoryIds = [...uniqueIds].sort((left, right) => left.localeCompare(right));

    if (requestId) {
      const existing = this.findRepositoryBatch(spaceId, requestId);
      if (existing) {
        if (existing.repository_ids_json !== JSON.stringify(canonicalRepositoryIds)) {
          throw Object.assign(new Error("Repository batch request ID was already used with different repositories"), { statusCode: 409 });
        }
        return this.repositoryBatchSubmission(existing.id);
      }
    }

    return this.jobs.runAtomically(() => {
      if (requestId) {
        const existing = this.findRepositoryBatch(spaceId, requestId);
        if (existing) return this.repositoryBatchSubmission(existing.id);
        this.spaces.assertNoActiveSpaceJobs(spaceId);
      }
      this.spaces.assertRepositoriesCanBeAdded(spaceId, uniqueIds);

      const timestamp = nowIso();
      const batchId = requestId ? createId("bat") : null;
      if (batchId && requestId) {
        insertRecord(this.database, "repository_batches", {
          id: batchId,
          spaceId,
          requestId,
          repositoryIdsJson: JSON.stringify(canonicalRepositoryIds),
          snapshotJobId: null,
          createdAt: timestamp,
          updatedAt: timestamp
        });
      }

      const spaceRepositories = uniqueIds.map((repositoryId) => this.spaces.addRepositoryToSpace(spaceId, repositoryId));
      const repositoryJobs = spaceRepositories.map((spaceRepository) =>
        this.enqueueRepositoryPreparation(spaceId, spaceRepository, batchId)
      );
      const snapshotJob = this.enqueueSnapshotRebuild(spaceId, repositoryJobs.map((entry) => entry.terminal.id));
      if (batchId) {
        this.recordRepositoryBatchJob(batchId, snapshotJob.id, "snapshot", null);
        updateRecord(this.database, "repository_batches", { snapshotJobId: snapshotJob.id, updatedAt: timestamp }, "id", batchId);
      }
      const jobs = [...repositoryJobs.flatMap((entry) => entry.jobs), snapshotJob];
      if (singleCompatibility) return { spaceRepository: spaceRepositories[0]!, jobs };
      return { spaceRepositories, jobs, snapshotJob, batch: this.getRepositoryBatch(batchId!) };
    });
  }

  getRepositoryBatch(batchId: string) {
    const batch = this.requireRepositoryBatch(batchId);
    const repositoryIds = JSON.parse(batch.repository_ids_json) as string[];
    const repositories = (this.spaces.listSpaceRepositories(batch.space_id) as Array<Record<string, unknown>>)
      .filter((repository) => repositoryIds.includes(String(repository.github_repository_id)));
    const links = this.repositoryBatchJobLinks(batchId);
    const jobs = links.map((link) => ({
      stage: link.stage,
      spaceRepositoryId: link.space_repository_id,
      job: this.jobs.getJob(link.job_id)
    }));
    const latestByRepositoryStage = new Map<string, { status: string }>();
    for (const entry of jobs) {
      if (!entry.spaceRepositoryId || !entry.job) continue;
      latestByRepositoryStage.set(
        `${entry.spaceRepositoryId}:${entry.stage}`,
        entry.job as { status: string }
      );
    }
    const terminalStage = this.config.snapshotOnlyIndexing ? "checkout" : "index";
    const items = repositories.map((repository) => {
      const id = String(repository.id);
      const latest = latestByRepositoryStage.get(`${id}:${terminalStage}`);
      const status = latest?.status ?? (this.repositoryReadyForSnapshot(repository) ? "succeeded" : "pending");
      return {
        spaceRepositoryId: id,
        githubRepositoryId: String(repository.github_repository_id),
        fullName: String(repository.full_name),
        cloneStatus: String(repository.clone_status),
        indexStatus: String(repository.index_status),
        status
      };
    });
    const snapshotJob = batch.snapshot_job_id ? this.jobs.getJob(batch.snapshot_job_id) as { status: string } | undefined : undefined;
    const active = jobs.some((entry) => entry.job && ["pending", "running"].includes((entry.job as { status: string }).status));
    const preparedCount = items.filter((item) => item.status === "succeeded").length;
    const failedCount = items.filter((item) => ["failed", "skipped", "cancelled"].includes(item.status)).length;
    const indexedCount = snapshotJob?.status === "succeeded"
      ? items.length
      : this.buildingSnapshotRepositoryCount(batch.space_id, new Set(items.map((item) => item.spaceRepositoryId)));
    const status = active
      ? "running"
      : snapshotJob?.status === "succeeded"
        ? "succeeded"
        : snapshotJob?.status === "cancelled"
          ? "cancelled"
          : snapshotJob && ["failed", "skipped"].includes(snapshotJob.status)
            ? "failed"
            : "pending";
    const phase = ["failed", "cancelled"].includes(status)
      ? status
      : preparedCount < items.length
        ? "preparing"
        : snapshotJob?.status === "running"
          ? "indexing"
          : snapshotJob?.status === "succeeded"
            ? "complete"
            : status;

    return {
      id: batch.id,
      spaceId: batch.space_id,
      requestId: batch.request_id,
      status,
      phase,
      repositoryCount: items.length,
      preparedCount,
      indexedCount,
      failedCount,
      snapshotJobId: batch.snapshot_job_id,
      items,
      jobs,
      createdAt: batch.created_at,
      updatedAt: batch.updated_at
    };
  }

  cancelRepositoryBatch(batchId: string) {
    this.requireRepositoryBatch(batchId);
    const cancellationOrder: Record<RepositoryBatchJobLink["stage"], number> = {
      snapshot: 0,
      index: 1,
      checkout: 2,
      clone: 3
    };
    const links = this.repositoryBatchJobLinks(batchId)
      .sort((left, right) => cancellationOrder[left.stage] - cancellationOrder[right.stage]);
    for (const link of links) {
      const job = this.jobs.getJob(link.job_id) as { status: string } | undefined;
      if (job && ["pending", "running"].includes(job.status)) this.jobs.cancelJob(link.job_id);
    }
    updateRecord(this.database, "repository_batches", { updatedAt: nowIso() }, "id", batchId);
    return this.getRepositoryBatch(batchId);
  }

  retryRepositoryBatch(batchId: string) {
    const batch = this.requireRepositoryBatch(batchId);
    const active = this.repositoryBatchJobLinks(batchId).some((link) => {
      const job = this.jobs.getJob(link.job_id) as { status: string } | undefined;
      return job && ["pending", "running"].includes(job.status);
    });
    if (active) return this.repositoryBatchSubmission(batchId);

    return this.jobs.runAtomically(() => {
      this.spaces.assertNoActiveSpaceJobs(batch.space_id);
      const repositoryIds = JSON.parse(batch.repository_ids_json) as string[];
      const repositories = (this.spaces.listSpaceRepositories(batch.space_id) as Array<Record<string, unknown>>)
        .filter((repository) => repositoryIds.includes(String(repository.github_repository_id)));
      if (repositories.length !== repositoryIds.length) {
        throw Object.assign(new Error("Repository batch can no longer be retried because its membership changed"), { statusCode: 409 });
      }
      const terminalJobIds: string[] = [];
      for (const repository of repositories) {
        const preparation = this.enqueueRepositoryRecovery(batch.space_id, repository, batchId);
        if (preparation) terminalJobIds.push(preparation.id);
      }
      const snapshotJob = this.enqueueSnapshotRebuild(batch.space_id, terminalJobIds);
      this.recordRepositoryBatchJob(batchId, snapshotJob.id, "snapshot", null);
      updateRecord(this.database, "repository_batches", { snapshotJobId: snapshotJob.id, updatedAt: nowIso() }, "id", batchId);
      return this.repositoryBatchSubmission(batchId);
    });
  }

  private enqueueRepositoryPreparation(
    spaceId: string,
    spaceRepository: { id: string },
    batchId: string | null
  ) {
    const cloneJob = this.jobs.enqueue({
      type: "clone_space_repository",
      spaceId,
      spaceRepositoryId: spaceRepository.id,
      payload: { spaceRepositoryId: spaceRepository.id }
    });
    if (batchId) this.recordRepositoryBatchJob(batchId, cloneJob.id, "clone", spaceRepository.id);
    const checkoutJob = this.jobs.enqueue({
      type: "checkout_space_repository",
      spaceId,
      spaceRepositoryId: spaceRepository.id,
      dependsOnJobId: cloneJob.id,
      payload: { spaceRepositoryId: spaceRepository.id, useExistingFetch: true }
    });
    if (batchId) this.recordRepositoryBatchJob(batchId, checkoutJob.id, "checkout", spaceRepository.id);
    if (this.config.snapshotOnlyIndexing) {
      return { spaceRepository, jobs: [cloneJob, checkoutJob], terminal: checkoutJob };
    }
    const indexJob = this.jobs.enqueue({
      type: "index_space_repository",
      spaceId,
      spaceRepositoryId: spaceRepository.id,
      dependsOnJobId: checkoutJob.id,
      payload: { spaceRepositoryId: spaceRepository.id }
    });
    if (batchId) this.recordRepositoryBatchJob(batchId, indexJob.id, "index", spaceRepository.id);
    return { spaceRepository, jobs: [cloneJob, checkoutJob, indexJob], terminal: indexJob };
  }

  private enqueueRepositoryRecovery(
    spaceId: string,
    repository: Record<string, unknown>,
    batchId: string
  ) {
    const spaceRepositoryId = String(repository.id);
    let dependencyJobId: string | null = null;
    if (String(repository.clone_status) !== "cloned") {
      const cloneJob = this.jobs.enqueue({
        type: "clone_space_repository",
        spaceId,
        spaceRepositoryId,
        payload: { spaceRepositoryId }
      });
      this.recordRepositoryBatchJob(batchId, cloneJob.id, "clone", spaceRepositoryId);
      dependencyJobId = cloneJob.id;
    }

    if (dependencyJobId || typeof repository.selected_commit !== "string" || repository.selected_commit.length === 0) {
      const checkoutJob = this.jobs.enqueue({
        type: "checkout_space_repository",
        spaceId,
        spaceRepositoryId,
        ...(dependencyJobId ? { dependsOnJobId: dependencyJobId } : {}),
        payload: { spaceRepositoryId, useExistingFetch: Boolean(dependencyJobId) }
      });
      this.recordRepositoryBatchJob(batchId, checkoutJob.id, "checkout", spaceRepositoryId);
      dependencyJobId = checkoutJob.id;
    }

    if (!this.config.snapshotOnlyIndexing && (dependencyJobId || String(repository.index_status) !== "indexed")) {
      const indexJob = this.jobs.enqueue({
        type: "index_space_repository",
        spaceId,
        spaceRepositoryId,
        ...(dependencyJobId ? { dependsOnJobId: dependencyJobId } : {}),
        payload: { spaceRepositoryId }
      });
      this.recordRepositoryBatchJob(batchId, indexJob.id, "index", spaceRepositoryId);
      dependencyJobId = indexJob.id;
    }
    return dependencyJobId ? this.jobs.getJob(dependencyJobId) as { id: string } : null;
  }

  private repositoryBatchSubmission(batchId: string) {
    const batch = this.getRepositoryBatch(batchId);
    const jobs = batch.jobs.map((entry) => entry.job).filter((job): job is NonNullable<typeof job> => Boolean(job));
    const snapshotJob = batch.snapshotJobId ? this.jobs.getJob(batch.snapshotJobId) : null;
    const spaceRepositories = batch.items.map((item) => this.spaces.getSpaceRepository(item.spaceRepositoryId));
    return { batch, spaceRepositories, jobs, snapshotJob };
  }

  private recordRepositoryBatchJob(
    batchId: string,
    jobId: string,
    stage: "clone" | "checkout" | "index" | "snapshot",
    spaceRepositoryId: string | null
  ): void {
    this.database.sqlite.prepare(
      `INSERT OR IGNORE INTO repository_batch_jobs (batch_id, job_id, stage, space_repository_id)
       VALUES (?, ?, ?, ?)`
    ).run(batchId, jobId, stage, spaceRepositoryId);
  }

  private repositoryBatchJobLinks(batchId: string): RepositoryBatchJobLink[] {
    return this.database.sqlite.prepare(
      `SELECT rbj.job_id, rbj.stage, rbj.space_repository_id
       FROM repository_batch_jobs rbj
       JOIN jobs j ON j.id = rbj.job_id
       WHERE rbj.batch_id = ?
       ORDER BY j.created_at ASC, j.id ASC`
    ).all(batchId) as RepositoryBatchJobLink[];
  }

  private findRepositoryBatch(spaceId: string, requestId: string): RepositoryBatchRow | null {
    return (this.database.sqlite.prepare(
      "SELECT * FROM repository_batches WHERE space_id = ? AND request_id = ?"
    ).get(spaceId, requestId) as RepositoryBatchRow | undefined) ?? null;
  }

  private requireRepositoryBatch(batchId: string): RepositoryBatchRow {
    const batch = this.database.sqlite.prepare("SELECT * FROM repository_batches WHERE id = ?").get(batchId) as
      | RepositoryBatchRow
      | undefined;
    if (!batch) throw new NotFoundError("Repository batch not found");
    return batch;
  }

  private repositoryReadyForSnapshot(repository: Record<string, unknown>): boolean {
    return String(repository.clone_status) === "cloned"
      && typeof repository.selected_commit === "string"
      && repository.selected_commit.length > 0
      && (this.config.snapshotOnlyIndexing || String(repository.index_status) === "indexed");
  }

  private buildingSnapshotRepositoryCount(spaceId: string, batchRepositoryIds: Set<string>): number {
    const row = this.database.sqlite.prepare(
      "SELECT manifest_json FROM space_snapshots WHERE space_id = ? AND status = 'building' ORDER BY created_at DESC LIMIT 1"
    ).get(spaceId) as { manifest_json: string } | undefined;
    if (!row) return 0;
    try {
      const manifest = JSON.parse(row.manifest_json) as { repositories?: Array<{ spaceRepositoryId?: unknown }> };
      return Array.isArray(manifest.repositories)
        ? manifest.repositories.filter((repository) => batchRepositoryIds.has(String(repository.spaceRepositoryId))).length
        : 0;
    } catch {
      return 0;
    }
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

interface RepositoryBatchRow {
  id: string;
  space_id: string;
  request_id: string;
  repository_ids_json: string;
  snapshot_job_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RepositoryBatchJobLink {
  job_id: string;
  stage: "clone" | "checkout" | "index" | "snapshot";
  space_repository_id: string | null;
}
