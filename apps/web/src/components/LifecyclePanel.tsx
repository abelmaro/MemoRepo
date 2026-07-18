import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Loader2, RefreshCw, Trash2 } from "lucide-react";
import {
  api,
  type MaintenanceResult,
  type MaintenanceSummary,
  type SnapshotListResponse,
  type SnapshotPruneResult,
  type Space
} from "../lib/api";
import { Modal } from "./Modal";
import { StatusBadge } from "./StatusBadge";
import { QueryErrorState } from "./QueryErrorState";

export function LifecyclePanel({
  space,
  onChanged,
  onDeleted,
  operationsDisabled,
}: {
  space: Space;
  onChanged: () => void;
  onDeleted: () => void;
  operationsDisabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [snapshotRetention, setSnapshotRetention] = useState<number | null>(null);
  const [jobRetentionDays, setJobRetentionDays] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");

  const snapshotsQuery = useQuery({
    queryKey: ["space-snapshots", space.id],
    queryFn: () => api<SnapshotListResponse>(`/api/spaces/${space.id}/snapshots`)
  });
  const maintenanceQuery = useQuery({
    queryKey: ["maintenance-summary"],
    queryFn: () => api<MaintenanceSummary>("/api/maintenance/summary")
  });
  const effectiveSnapshotRetention = snapshotRetention ?? snapshotsQuery.data?.defaultRetention ?? 3;
  const effectiveJobRetentionDays = jobRetentionDays ?? maintenanceQuery.data?.defaults.jobRetentionDays ?? 30;

  const pruneMutation = useMutation({
    mutationFn: () =>
      api<SnapshotPruneResult>(`/api/spaces/${space.id}/snapshots/prune`, {
        method: "POST",
        body: JSON.stringify({ keepLatest: effectiveSnapshotRetention })
      }),
    onSuccess: (result) => {
      setFeedback({ tone: "success", message: `Deleted ${result.deletedCount} snapshots and freed ${formatBytes(result.deletedBytes)}.` });
      void queryClient.invalidateQueries({ queryKey: ["space-snapshots", space.id] });
      void queryClient.invalidateQueries({ queryKey: ["maintenance-summary"] });
      onChanged();
    },
    onError: (error) => setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Snapshots could not be pruned" })
  });

  const gcMutation = useMutation({
    mutationFn: () =>
      api<MaintenanceResult>("/api/maintenance/gc", {
        method: "POST",
        body: JSON.stringify({ jobRetentionDays: effectiveJobRetentionDays })
      }),
    onSuccess: (result) => {
      setFeedback({ tone: "success", message: `Garbage collection finished. Freed ${formatBytes(maintenanceResultBytes(result))}.` });
      void queryClient.invalidateQueries({ queryKey: ["maintenance-summary"] });
      void queryClient.invalidateQueries({ queryKey: ["space-snapshots", space.id] });
      onChanged();
    },
    onError: (error) => setFeedback({ tone: "error", message: error instanceof Error ? error.message : "Garbage collection failed" })
  });

  const deleteManagedMutation = useMutation({
    mutationFn: () => api(`/api/spaces/${space.id}/managed-data`, { method: "DELETE" }),
    onSuccess: () => onDeleted(),
    onError: () => undefined
  });

  const snapshots = snapshotsQuery.data?.snapshots ?? [];
  const maintenance = maintenanceQuery.data;
  const gcCandidateCount = maintenance ? maintenanceCandidateCount(maintenance) : 0;
  const gcBytes = maintenance ? maintenanceCandidateBytes(maintenance) : 0;

  function deleteManagedSpace() {
    deleteManagedMutation.mutate();
  }

  return (
    <>
      {snapshotsQuery.isError ? (
        <QueryErrorState title="Snapshots could not be loaded" error={snapshotsQuery.error} onRetry={() => void snapshotsQuery.refetch()} />
      ) : null}
      {maintenanceQuery.isError ? (
        <QueryErrorState title="Maintenance summary could not be loaded" error={maintenanceQuery.error} onRetry={() => void maintenanceQuery.refetch()} />
      ) : null}
      <section className="lifecycle-panel management-panel" aria-labelledby="lifecycle-title">
      <div className="panel-heading with-icon">
        <Database size={20} />
        <div>
          <h3 id="lifecycle-title">Data lifecycle</h3>
          <p>Manage snapshots, retained jobs, and MemoRepo-owned local data.</p>
        </div>
      </div>
      {feedback ? (
        <div className={`inline-alert lifecycle-feedback ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>
          {feedback.message}
        </div>
      ) : null}
      <div className="lifecycle-grid">
        <div className="lifecycle-card lifecycle-card-wide">
          <div className="lifecycle-card-header">
            <div>
              <h3>Snapshots</h3>
              <span>{snapshots.length} total · {formatBytes(snapshotsQuery.data?.totalSizeBytes ?? 0)}</span>
            </div>
            <div className="compact-controls">
              <label>
                <span>Keep</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={effectiveSnapshotRetention}
                  onChange={(event) => setSnapshotRetention(Number(event.target.value))}
                />
              </label>
              <button className="secondary-button" type="button" onClick={() => { setFeedback(null); pruneMutation.mutate(); }} disabled={pruneMutation.isPending || operationsDisabled}>
                {pruneMutation.isPending ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
                <span>Prune</span>
              </button>
            </div>
          </div>
          <div className="snapshot-list">
            {snapshots.map((snapshot) => (
              <article className="snapshot-row" key={snapshot.id}>
                <div>
                  <strong>v{snapshot.version.toString().padStart(6, "0")}</strong>
                  <span>{snapshot.repositoryCount} repos · {formatBytes(snapshot.sizeBytes)} · {formatSnapshotTime(snapshot.createdAt)}</span>
                  {snapshot.error ? <small>{snapshot.error}</small> : null}
                </div>
                <div className="repo-badges">
                  {snapshot.active ? <StatusBadge status="active" tone="green" /> : <StatusBadge status={snapshot.status} />}
                </div>
              </article>
            ))}
            {snapshots.length === 0 ? <div className="empty-inline">No snapshots yet.</div> : null}
          </div>
        </div>

        <div className="lifecycle-card garbage-collection-card">
          <div className="lifecycle-card-header">
            <div>
              <h3>Garbage collection</h3>
              <span>{gcCandidateCount} candidates · {formatBytes(gcBytes)}</span>
            </div>
          </div>
          <div className="maintenance-metrics">
            <span>Failed snapshots: {maintenance?.candidates.failedSnapshots ?? 0}</span>
            <span>Removed clones: {maintenance?.candidates.removedClones ?? 0}</span>
            <span>Old jobs: {maintenance?.candidates.oldJobs ?? 0}</span>
            <span>Repo indexes: {(maintenance?.candidates.oldRepoIndexRecords ?? 0) + (maintenance?.candidates.removedRepositoryIndexes ?? 0)}</span>
            <span>Revision sources: {maintenance?.candidates.orphanRevisionSources ?? 0}</span>
          </div>
          <div className="compact-controls lifecycle-actions">
            <label>
              <span>Job days</span>
              <input
                type="number"
                min={1}
                max={3650}
                value={effectiveJobRetentionDays}
                onChange={(event) => setJobRetentionDays(Number(event.target.value))}
              />
            </label>
            <button className="secondary-button" type="button" onClick={() => { setFeedback(null); gcMutation.mutate(); }} disabled={gcMutation.isPending || operationsDisabled}>
              {gcMutation.isPending ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
              <span>Run GC</span>
            </button>
          </div>
        </div>

        <div className="lifecycle-card danger-zone">
          <div className="lifecycle-card-header">
            <div>
              <h3>Delete space</h3>
              <span>Removes managed clones, indexes, snapshots, jobs, and local MCP connections.</span>
            </div>
          </div>
          <button className="secondary-button danger" type="button" onClick={() => { deleteManagedMutation.reset(); setDeleteConfirmation(""); setDeleteOpen(true); }} disabled={operationsDisabled}>
            <Trash2 size={18} />
            <span>Delete space</span>
          </button>
        </div>
      </div>
      </section>

      {deleteOpen ? (
        <Modal title="Delete space" onClose={() => !deleteManagedMutation.isPending && setDeleteOpen(false)}>
          <div className="confirmation-dialog">
            <p>
              Delete <strong>{space.name}</strong> and all MemoRepo-managed clones, indexes, snapshots, jobs, and local MCP connections?
            </p>
            <label className="form-stack">
              <span>Type <strong>DELETE {space.name}</strong> to confirm.</span>
              <input
                data-modal-autofocus
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
                disabled={deleteManagedMutation.isPending}
              />
            </label>
            {deleteManagedMutation.error ? (
              <div className="inline-alert error" role="alert">
                {deleteManagedMutation.error instanceof Error ? deleteManagedMutation.error.message : "Space could not be deleted."}
              </div>
            ) : null}
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => setDeleteOpen(false)} disabled={deleteManagedMutation.isPending}>
                Cancel
              </button>
              <button
                className="secondary-button danger"
                type="button"
                onClick={deleteManagedSpace}
                disabled={deleteConfirmation !== `DELETE ${space.name}` || deleteManagedMutation.isPending}
              >
                {deleteManagedMutation.isPending ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
                <span>Delete space</span>
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function formatSnapshotTime(value: string): string {
  return new Date(value).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function maintenanceCandidateCount(summary: MaintenanceSummary): number {
  return Object.values(summary.candidates).reduce((total, value) => total + value, 0);
}

function maintenanceCandidateBytes(summary: MaintenanceSummary): number {
  return Object.values(summary.estimatedBytes).reduce((total, value) => total + value, 0);
}

function maintenanceResultBytes(result: MaintenanceResult): number {
  return (
    result.removedRepositoryIndexes.bytes +
    result.orphanRepoIndexDirectories.bytes +
    result.orphanRevisionSources.bytes +
    result.failedSnapshots.bytes +
    result.removedClones.bytes
  );
}
