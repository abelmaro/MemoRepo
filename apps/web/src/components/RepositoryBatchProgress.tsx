import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock3, Github, Loader2, RotateCcw, XCircle } from "lucide-react";
import { api, type RepositoryBatch, type RepositoryBatchSubmission } from "../lib/api";
import { QueryErrorState } from "./QueryErrorState";
import { StatusBadge } from "./StatusBadge";

export function RepositoryBatchProgress({ batchId, onJob }: { batchId: string; onJob: (jobId: string) => void }) {
  const queryClient = useQueryClient();
  const batchQuery = useQuery({
    queryKey: ["repository-batch", batchId],
    queryFn: () => api<{ batch: RepositoryBatch }>(`/api/repository-batches/${batchId}`),
    refetchInterval: (query) => {
      const batch = (query.state.data as { batch?: RepositoryBatch } | undefined)?.batch;
      return batch && ["succeeded", "failed", "cancelled"].includes(batch.status) ? false : 1_000;
    }
  });
  const cancelMutation = useMutation({
    mutationFn: () => api<{ batch: RepositoryBatch }>(`/api/repository-batches/${batchId}/cancel`, { method: "POST", body: "{}" }),
    onSuccess: ({ batch }) => refreshBatch(queryClient, batch)
  });
  const retryMutation = useMutation({
    mutationFn: () => api<RepositoryBatchSubmission>(`/api/repository-batches/${batchId}/retry`, { method: "POST", body: "{}" }),
    onSuccess: ({ batch }) => refreshBatch(queryClient, batch)
  });

  const batch = batchQuery.data?.batch;
  const active = batch && ["pending", "running"].includes(batch.status);
  const canRetry = batch && ["failed", "cancelled"].includes(batch.status);
  const progressValue = batch
    ? batch.phase === "preparing"
      ? batch.preparedCount
      : batch.repositoryCount + batch.indexedCount
    : 0;
  const progressMax = Math.max(1, (batch?.repositoryCount ?? 0) * 2);
  const mutationError = cancelMutation.error ?? retryMutation.error;

  return (
    <div className="batch-progress">
      {batchQuery.isError ? (
        <QueryErrorState title="Batch progress could not be loaded" error={batchQuery.error} onRetry={() => void batchQuery.refetch()} />
      ) : null}
      {!batch && !batchQuery.isError ? (
        <div className="batch-progress-loading"><Loader2 className="spin" size={22} /> Loading batch progress…</div>
      ) : null}
      {batch ? (
        <>
          <div className="batch-progress-summary">
            <div>
              <span className="eyebrow">{formatPhase(batch.phase)}</span>
              <h3>{batch.repositoryCount} {batch.repositoryCount === 1 ? "repository" : "repositories"}</h3>
              <p>{progressMessage(batch)}</p>
            </div>
            <StatusBadge status={batch.status} />
          </div>

          <div className="batch-progress-meter" role="progressbar" aria-valuemin={0} aria-valuemax={progressMax} aria-valuenow={progressValue}>
            <span style={{ width: `${Math.min(100, (progressValue / progressMax) * 100)}%` }} />
          </div>

          <div className="batch-progress-counts" aria-live="polite">
            <span>{batch.preparedCount}/{batch.repositoryCount} prepared</span>
            <span>{batch.indexedCount}/{batch.repositoryCount} indexed</span>
            {batch.failedCount > 0 ? <span className="batch-progress-failed">{batch.failedCount} failed</span> : null}
          </div>

          <div className="batch-progress-items">
            {batch.items.map((item) => (
              <div className="batch-progress-item" key={item.spaceRepositoryId}>
                <Github size={18} aria-hidden="true" />
                <div>
                  <strong>{item.fullName}</strong>
                  <span>{formatRepositoryStatus(item.status, batch.phase)}</span>
                </div>
                {item.status === "succeeded" ? <CheckCircle2 className="batch-progress-success" size={18} aria-label="Ready" /> : null}
                {["failed", "skipped", "cancelled"].includes(item.status) ? <XCircle className="batch-progress-failed" size={18} aria-label="Failed" /> : null}
                {item.status === "pending" ? <Clock3 size={18} aria-label="Queued" /> : null}
                {item.status === "running" ? <Loader2 className="spin" size={18} aria-label="Running" /> : null}
              </div>
            ))}
          </div>

          <div className="job-log-actions">
            <button className="secondary-button danger" type="button" disabled={!active || cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>
              {cancelMutation.isPending ? <Loader2 className="spin" size={18} /> : <XCircle size={18} />}
              <span>Cancel batch</span>
            </button>
            <button className="secondary-button" type="button" disabled={!canRetry || retryMutation.isPending} onClick={() => retryMutation.mutate()}>
              {retryMutation.isPending ? <Loader2 className="spin" size={18} /> : <RotateCcw size={18} />}
              <span>Retry failed work</span>
            </button>
            <button className="secondary-button" type="button" disabled={!batch.snapshotJobId} onClick={() => batch.snapshotJobId && onJob(batch.snapshotJobId)}>
              <span>Open snapshot log</span>
            </button>
          </div>
          {mutationError ? <div className="inline-alert error" role="alert">{mutationError instanceof Error ? mutationError.message : "Batch action failed."}</div> : null}
        </>
      ) : null}
    </div>
  );
}

function refreshBatch(queryClient: ReturnType<typeof useQueryClient>, batch: RepositoryBatch): void {
  queryClient.setQueryData(["repository-batch", batch.id], { batch });
  void queryClient.invalidateQueries({ queryKey: ["jobs"] });
  void queryClient.invalidateQueries({ queryKey: ["space", batch.spaceId] });
  void queryClient.invalidateQueries({ queryKey: ["spaces"] });
}

function formatPhase(phase: string): string {
  if (phase === "preparing") return "Preparing repositories";
  if (phase === "indexing") return "Building shared snapshot";
  if (phase === "complete") return "Batch complete";
  return phase.replaceAll("_", " ");
}

function progressMessage(batch: RepositoryBatch): string {
  if (batch.phase === "preparing") return `Cloning and checking out ${batch.preparedCount + 1} of ${batch.repositoryCount}.`;
  if (batch.phase === "indexing") return `Indexed ${batch.indexedCount} of ${batch.repositoryCount} into the shared snapshot.`;
  if (batch.status === "succeeded") return "All repositories are available in the active snapshot.";
  if (batch.status === "cancelled") return "The batch was cancelled. Completed repository data was kept for retry.";
  if (batch.status === "failed") return "The active snapshot was preserved. Retry to continue incomplete work.";
  return "Waiting for repository work to start.";
}

function formatRepositoryStatus(status: string, phase: string): string {
  if (status === "succeeded" && phase === "preparing") return "Ready for snapshot";
  if (status === "succeeded") return "Prepared";
  if (status === "pending") return "Queued";
  return status.replaceAll("_", " ");
}
