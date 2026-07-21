import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Loader2, RefreshCw, Trash2 } from "lucide-react";
import {
  api,
  type MaintenanceResult,
  type MaintenanceSummary,
  type SnapshotListResponse,
  type SnapshotPruneResult,
  type Space,
  type SpaceSnapshot
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
  const [detailsSnapshot, setDetailsSnapshot] = useState<SpaceSnapshot | null>(null);

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
            {snapshots.map((snapshot) => {
              const versionLabel = snapshotVersionLabel(snapshot.version);
              const hasIndexingDetails = snapshot.skippedCount > 0 || snapshot.excludedDirectoryCount > 0;
              return (
                <article className="snapshot-row" key={snapshot.id}>
                  <div>
                    <strong>{versionLabel}</strong>
                    <span>{snapshot.repositoryCount} repos · {formatBytes(snapshot.sizeBytes)} · {formatSnapshotTime(snapshot.createdAt)}</span>
                    <span>
                      CBM {snapshot.engineVersions?.join(", ") || "unknown"} · {snapshot.indexModes?.join(", ") || "unknown"} mode
                      {snapshot.coveragePercent === null ? "" : ` · ${snapshot.coveragePercent}% source coverage`}
                      {snapshot.indexDurationMs === null ? "" : ` · ${formatDuration(snapshot.indexDurationMs)}`}
                    </span>
                    <span>
                      {snapshot.sourceFileCount ?? 0} source files · {snapshot.skippedCount ?? 0} skipped · {snapshot.excludedDirectoryCount ?? 0} excluded directories
                    </span>
                    {snapshot.reason ? <small className={snapshot.error ? "snapshot-error" : undefined}>{snapshot.reason}</small> : null}
                    {hasIndexingDetails ? (
                      <button
                        className="text-button snapshot-details-trigger"
                        type="button"
                        aria-label={`View indexing details for snapshot ${versionLabel}`}
                        aria-haspopup="dialog"
                        aria-expanded={detailsSnapshot === snapshot}
                        onClick={() => setDetailsSnapshot(snapshot)}
                      >
                        View indexing details
                      </button>
                    ) : null}
                  </div>
                  <div className="repo-badges">
                    {snapshot.active ? <StatusBadge status="active" tone="green" /> : <StatusBadge status={snapshot.status} />}
                    <StatusBadge status={snapshot.quality} />
                  </div>
                </article>
              );
            })}
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

      {detailsSnapshot ? (
        <SnapshotIndexingDetailsDialog snapshot={detailsSnapshot} onClose={() => setDetailsSnapshot(null)} />
      ) : null}

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

function SnapshotIndexingDetailsDialog({ snapshot, onClose }: { snapshot: SpaceSnapshot; onClose: () => void }) {
  const details = snapshot.indexingDetails ?? [];
  const versionLabel = snapshotVersionLabel(snapshot.version);
  return (
    <Modal title={`${versionLabel} indexing details`} onClose={onClose} wide>
      <div className="snapshot-details-dialog">
        <p className="snapshot-details-summary">
          {snapshot.skippedCount} skipped {snapshot.skippedCount === 1 ? "file" : "files"} and {snapshot.excludedDirectoryCount} excluded {snapshot.excludedDirectoryCount === 1 ? "directory" : "directories"}, grouped by repository.
        </p>
        {details.length === 0 ? (
          <div className="empty-inline">Detailed paths were not reported for this snapshot.</div>
        ) : (
          <div className="snapshot-details-repositories">
            {details.map((detail) => (
              <section className="snapshot-detail-repository" key={detail.repository}>
                <h3>{detail.repository}</h3>
                <div className="snapshot-detail-grid">
                  {detail.skippedCount > 0 ? (
                    <section className="snapshot-detail-section">
                      <div className="snapshot-detail-heading">
                        <h4>Skipped files</h4>
                        <span>{detail.skippedCount}</span>
                      </div>
                      {detail.skippedFiles.length > 0 ? (
                        <ul className="snapshot-path-list">
                          {detail.skippedFiles.map((file) => (
                            <li key={`${file.path}:${file.phase}:${file.reason}`}>
                              <code>{file.path}</code>
                              <span>{file.reason} · {file.phase}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="snapshot-detail-note">No file paths were reported.</p>
                      )}
                      {detail.skippedTruncated ? (
                        <p className="snapshot-detail-note">Showing {detail.skippedFiles.length} of {detail.skippedCount} reported files.</p>
                      ) : null}
                    </section>
                  ) : null}

                  {detail.excludedDirectoryCount > 0 ? (
                    <section className="snapshot-detail-section">
                      <div className="snapshot-detail-heading">
                        <h4>Excluded directories</h4>
                        <span>{detail.excludedDirectoryCount}</span>
                      </div>
                      {detail.excludedDirectories.length > 0 ? (
                        <ul className="snapshot-path-list directories">
                          {detail.excludedDirectories.map((directory) => <li key={directory}><code>{directory}</code></li>)}
                        </ul>
                      ) : (
                        <p className="snapshot-detail-note">No directory paths were reported.</p>
                      )}
                      {detail.excludedDirectoriesTruncated ? (
                        <p className="snapshot-detail-note">Showing {detail.excludedDirectories.length} of {detail.excludedDirectoryCount} reported directories.</p>
                      ) : null}
                    </section>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function snapshotVersionLabel(version: number): string {
  return `v${version.toString().padStart(6, "0")}`;
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

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "unknown duration";
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  return `${(durationMs / 60_000).toFixed(1)} min`;
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
