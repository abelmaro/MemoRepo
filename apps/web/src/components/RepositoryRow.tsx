import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Clipboard, ExternalLink, Github, MoreVertical, RefreshCw, Trash2 } from "lucide-react";
import { api, booleanValue, type Job, type SpaceRepository } from "../lib/api";
import { StatusBadge } from "./StatusBadge";

export function RepositoryRow({ repository, onJob, onChanged }: { repository: SpaceRepository; onJob: (jobId: string) => void; onChanged: () => void }) {
  const branches = parseBranches(repository.branches_json, repository.selected_branch ?? repository.default_branch);
  const checkoutMutation = useMutation({
    mutationFn: (branch: string) =>
      api<{ jobs: Job[] }>(`/api/space-repositories/${repository.id}/checkout`, {
        method: "POST",
        body: JSON.stringify({ branch })
      }),
    onSuccess: ({ jobs }) => {
      onJob(jobs[0]!.id);
      onChanged();
    }
  });
  const actionMutation = useMutation({
    mutationFn: (action: "reindex" | "refresh" | "remove") => {
      if (action === "remove") {
        return api(`/api/space-repositories/${repository.id}`, { method: "DELETE" });
      }
      return api<{ job?: Job; jobs?: Job[] }>(`/api/space-repositories/${repository.id}/${action === "refresh" ? "refresh-branches" : "reindex"}`, {
        method: "POST",
        body: "{}"
      });
    },
    onSuccess: (data) => {
      const result = data as { job?: Job; jobs?: Job[] };
      const job = result.job ?? result.jobs?.[0];
      if (job) {
        onJob(job.id);
      }
      onChanged();
    }
  });

  function selectBranch(branch: string) {
    if (branch === repository.selected_branch) {
      return;
    }
    if (!window.confirm(`Checkout origin/${branch}? MemoRepo will reset and clean this managed clone.`)) {
      return;
    }
    checkoutMutation.mutate(branch);
  }

  function removeRepository() {
    if (window.confirm(`Remove ${repository.full_name} from this space?`)) {
      actionMutation.mutate("remove");
    }
  }

  function copyText(value: string) {
    void navigator.clipboard.writeText(value);
  }

  return (
    <article className="repo-row">
      <div className="repo-main">
        <div className="repo-icon">
          <Github size={26} />
        </div>
        <div>
          <h2>{repository.full_name.split("/").at(-1)}</h2>
          <a href={repository.html_url} target="_blank" rel="noreferrer">
            {repository.full_name}
          </a>
        </div>
      </div>

      <div className="repo-badges">
        <StatusBadge status={repository.clone_status} />
        <StatusBadge status={repository.index_status} />
        <StatusBadge status={booleanValue(repository.snapshot_included) ? "active" : "stale"} />
        {booleanValue(repository.private) ? <StatusBadge status="private" tone="gray" /> : null}
        {booleanValue(repository.archived) ? <StatusBadge status="archived" tone="amber" /> : null}
        {booleanValue(repository.fork) ? <StatusBadge status="fork" tone="blue" /> : null}
      </div>

      <label className="branch-select">
        <span>branch</span>
        <select value={repository.selected_branch ?? repository.default_branch} onChange={(event) => selectBranch(event.target.value)}>
          {branches.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))}
        </select>
      </label>

      <div className="repo-actions">
        <button className="icon-button" type="button" onClick={() => actionMutation.mutate("refresh")} aria-label="Refresh branches">
          <RefreshCw size={18} />
        </button>
        <button className="icon-button" type="button" onClick={() => actionMutation.mutate("reindex")} aria-label="Reindex repository">
          <CheckCircle2 size={18} />
        </button>
        <button className="icon-button danger" type="button" onClick={removeRepository} aria-label="Remove repository">
          <Trash2 size={18} />
        </button>
        <details className="repo-menu">
          <summary className="icon-button" aria-label="More actions">
            <MoreVertical size={18} />
          </summary>
          <div className="repo-menu-popover">
            <a className="repo-menu-item" href={repository.html_url} target="_blank" rel="noreferrer">
              <ExternalLink size={16} />
              <span>Open GitHub</span>
            </a>
            <button className="repo-menu-item" type="button" onClick={() => copyText(repository.full_name)}>
              <Clipboard size={16} />
              <span>Copy repo name</span>
            </button>
            <button
              className="repo-menu-item"
              type="button"
              onClick={() => repository.selected_commit && copyText(repository.selected_commit)}
              disabled={!repository.selected_commit}
            >
              <Clipboard size={16} />
              <span>Copy commit</span>
            </button>
          </div>
        </details>
      </div>
      {repository.last_error ? <div className="repo-error">{repository.last_error}</div> : null}
    </article>
  );
}

function parseBranches(value: string, fallback: string): string[] {
  try {
    const parsed = JSON.parse(value) as string[];
    const branches = parsed.length > 0 ? parsed : [fallback];
    return Array.from(new Set(branches.filter(Boolean)));
  } catch {
    return [fallback].filter(Boolean);
  }
}
