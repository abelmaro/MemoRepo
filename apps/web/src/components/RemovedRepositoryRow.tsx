import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { api, type SpaceRepository } from "../lib/api";
import { Modal } from "./Modal";
import { StatusBadge } from "./StatusBadge";

export function RemovedRepositoryRow({ repository, onChanged }: { repository: SpaceRepository; onChanged: () => void }) {
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const cleanupMutation = useMutation({
    mutationFn: () => api(`/api/space-repositories/${repository.id}/files`, { method: "DELETE" }),
    onSuccess: () => {
      setCleanupOpen(false);
      onChanged();
    }
  });

  function cleanupFiles() {
    cleanupMutation.mutate();
  }

  return (
    <>
      <article className="removed-row">
        <div>
          <strong>{repository.full_name}</strong>
          <span>Removed from this space{repository.removed_at ? ` at ${new Date(repository.removed_at).toLocaleString()}` : ""}</span>
        </div>
        <div className="repo-badges">
          <StatusBadge status={repository.clone_status} />
          <StatusBadge status={repository.index_status} />
        </div>
        <button className="icon-button danger" type="button" onClick={() => setCleanupOpen(true)} aria-label="Clean repository files">
          <Trash2 size={18} />
        </button>
      </article>

      {cleanupOpen ? (
        <Modal title="Delete managed clone files" onClose={() => !cleanupMutation.isPending && setCleanupOpen(false)}>
          <div className="confirmation-dialog">
            <p>
              Delete MemoRepo-managed clone files for <strong>{repository.full_name}</strong>? This does not delete the GitHub repository.
            </p>
            {cleanupMutation.error ? (
              <div className="inline-alert error" role="alert">
                {cleanupMutation.error instanceof Error ? cleanupMutation.error.message : "Repository files could not be deleted."}
              </div>
            ) : null}
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => setCleanupOpen(false)} disabled={cleanupMutation.isPending}>
                Cancel
              </button>
              <button className="secondary-button danger" type="button" onClick={cleanupFiles} disabled={cleanupMutation.isPending}>
                {cleanupMutation.isPending ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
                <span>Delete files</span>
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
