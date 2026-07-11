import type { Job, SpaceRepository } from "./api";

export type SnapshotUiState = "ready" | "updating" | "failed" | "required" | "checking";

const SNAPSHOT_PIPELINE_JOB_TYPES = new Set([
  "clone_space_repository",
  "checkout_space_repository",
  "index_space_repository",
  "rebuild_space_snapshot",
  "reindex_space"
]);

const SNAPSHOT_BUILD_JOB_TYPES = new Set(["rebuild_space_snapshot", "reindex_space"]);

export interface SnapshotStateSummary {
  state: SnapshotUiState;
  excludedRepositoryCount: number;
  latestSnapshotJob: Job | null;
}

export function snapshotStateSummary(
  spaceId: string,
  snapshotStatus: string,
  repositories: SpaceRepository[],
  jobs: Job[] | undefined
): SnapshotStateSummary {
  const excludedRepositoryCount = repositories.filter((repository) => !snapshotIncluded(repository.snapshot_included)).length;
  if (excludedRepositoryCount === 0 && snapshotStatus === "active") {
    return { state: "ready", excludedRepositoryCount, latestSnapshotJob: null };
  }
  if (!jobs) {
    return { state: "checking", excludedRepositoryCount, latestSnapshotJob: null };
  }

  const spaceJobs = jobs.filter((job) => job.space_id === spaceId);
  const hasActivePipelineJob = spaceJobs.some(
    (job) => SNAPSHOT_PIPELINE_JOB_TYPES.has(job.type) && (job.status === "pending" || job.status === "running")
  );
  const latestSnapshotJob = spaceJobs.find((job) => SNAPSHOT_BUILD_JOB_TYPES.has(job.type)) ?? null;

  if (hasActivePipelineJob) {
    return { state: "updating", excludedRepositoryCount, latestSnapshotJob };
  }
  if (latestSnapshotJob?.status === "failed") {
    return { state: "failed", excludedRepositoryCount, latestSnapshotJob };
  }
  if (snapshotStatus === "failed") {
    return { state: "failed", excludedRepositoryCount, latestSnapshotJob };
  }
  return { state: "required", excludedRepositoryCount, latestSnapshotJob };
}

function snapshotIncluded(value: boolean | number): boolean {
  return value === true || value === 1;
}
