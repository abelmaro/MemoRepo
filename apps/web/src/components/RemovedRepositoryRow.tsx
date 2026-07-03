import { useMutation } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { api, type SpaceRepository } from "../lib/api";
import { StatusBadge } from "./StatusBadge";

export function RemovedRepositoryRow({ repository, onChanged }: { repository: SpaceRepository; onChanged: () => void }) {
  const cleanupMutation = useMutation({
    mutationFn: () => api(`/api/space-repositories/${repository.id}/files`, { method: "DELETE" }),
    onSuccess: () => onChanged()
  });

  function cleanupFiles() {
    if (!window.confirm(`Delete managed clone files for ${repository.full_name}? This does not delete the GitHub repository.`)) {
      return;
    }
    cleanupMutation.mutate();
  }

  return (
    <article className="removed-row">
      <div>
        <strong>{repository.full_name}</strong>
        <span>Removed from this space{repository.removed_at ? ` at ${new Date(repository.removed_at).toLocaleString()}` : ""}</span>
      </div>
      <div className="repo-badges">
        <StatusBadge status={repository.clone_status} />
        <StatusBadge status={repository.index_status} />
      </div>
      <button className="icon-button danger" type="button" onClick={cleanupFiles} aria-label="Clean repository files" disabled={cleanupMutation.isPending}>
        {cleanupMutation.isPending ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
      </button>
    </article>
  );
}
