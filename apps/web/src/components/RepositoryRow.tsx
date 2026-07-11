import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clipboard,
  ExternalLink,
  GitBranch,
  Github,
  Loader2,
  MoreVertical,
  RefreshCw,
  Search,
  Trash2
} from "lucide-react";
import { api, booleanValue, type Job, type SpaceRepository } from "../lib/api";
import type { SnapshotUiState } from "../lib/snapshotState";
import { Modal } from "./Modal";
import { StatusBadge } from "./StatusBadge";

interface RepositoryRowProps {
  repository: SpaceRepository;
  snapshotState: SnapshotUiState;
  onSnapshotJob?: (() => void) | undefined;
  onJob: (jobId: string) => void;
  onChanged: () => void;
}

export function RepositoryRow({ repository, snapshotState, onSnapshotJob, onJob, onChanged }: RepositoryRowProps) {
  const currentBranch = repository.selected_branch ?? repository.default_branch;
  const branches = useMemo(() => parseBranches(repository.branches_json, currentBranch), [repository.branches_json, currentBranch]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [branchCandidate, setBranchCandidate] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const status = repositoryStatus(repository, snapshotState);

  const checkoutMutation = useMutation({
    mutationFn: (branch: string) =>
      api<{ jobs: Job[] }>(`/api/space-repositories/${repository.id}/checkout`, {
        method: "POST",
        body: JSON.stringify({ branch })
      }),
    onSuccess: ({ jobs }) => {
      const firstJob = jobs[0];
      if (firstJob) {
        onJob(firstJob.id);
      }
      setBranchOpen(false);
      setBranchCandidate(null);
      setBranchQuery("");
      onChanged();
    }
  });

  const actionMutation = useMutation({
    mutationFn: (action: "reindex" | "refresh" | "remove") => {
      if (action === "remove") {
        return api<{ job?: Job }>(`/api/space-repositories/${repository.id}`, { method: "DELETE" });
      }
      return api<{ job?: Job; jobs?: Job[] }>(
        `/api/space-repositories/${repository.id}/${action === "refresh" ? "refresh-branches" : "reindex"}`,
        { method: "POST", body: "{}" }
      );
    },
    onSuccess: (data, action) => {
      const result = data as { job?: Job; jobs?: Job[] };
      const job = result.job ?? result.jobs?.[0];
      if (job) {
        onJob(job.id);
      }
      setMenuOpen(false);
      if (action === "remove") {
        setRemoveOpen(false);
      }
      onChanged();
    }
  });

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function closeOnOutsideClick(event: PointerEvent) {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  const branchResults = useMemo(() => {
    const normalizedQuery = branchQuery.trim().toLowerCase();
    if (normalizedQuery) {
      return branches.filter((branch) => branch.toLowerCase().includes(normalizedQuery)).slice(0, 40);
    }

    const preferred = [currentBranch, repository.default_branch, "main", "dev", ...branches];
    return Array.from(new Set(preferred.filter((branch) => branches.includes(branch)))).slice(0, 12);
  }, [branchQuery, branches, currentBranch, repository.default_branch]);

  async function copyText(value: string, label: string) {
    await navigator.clipboard.writeText(value);
    setCopyState(`${label} copied`);
    window.setTimeout(() => setCopyState(null), 2500);
    setMenuOpen(false);
  }

  function startAction(action: "reindex" | "refresh") {
    actionMutation.mutate(action);
    setMenuOpen(false);
  }

  const mutationError = checkoutMutation.error ?? actionMutation.error;

  return (
    <div className="repo-row" role="row">
      <div className="repo-main" role="cell">
        <div className="repo-icon" aria-hidden="true">
          <Github size={22} />
        </div>
        <div className="repo-identity">
          <strong className="repo-name">{repository.full_name.split("/").at(-1)}</strong>
          <a href={repository.html_url} target="_blank" rel="noreferrer">
            {repository.full_name}
          </a>
          <span className="repo-metadata">
            {booleanValue(repository.private) ? <span>Private</span> : <span>Public</span>}
            {booleanValue(repository.fork) ? <span>Fork</span> : null}
            {booleanValue(repository.archived) ? <span>Archived</span> : null}
          </span>
        </div>
      </div>

      <div className="repo-status-cell" role="cell" data-label="Status">
        <StatusBadge status={status.label} tone={status.tone} />
        <span>{status.description}</span>
      </div>

      <div className="repo-branch-cell" role="cell" data-label="Branch">
        <button className="branch-button" type="button" onClick={() => setBranchOpen(true)}>
          <GitBranch size={16} />
          <span>{currentBranch}</span>
          <small>Change</small>
        </button>
      </div>

      <div className="repo-indexed-cell" role="cell" data-label="Last indexed">
        <span title={repository.last_indexed_at ? new Date(repository.last_indexed_at).toLocaleString() : undefined}>
          {repository.last_indexed_at ? formatRelativeTime(repository.last_indexed_at) : "Not indexed yet"}
        </span>
        {repository.selected_commit ? <code title={repository.selected_commit}>{repository.selected_commit.slice(0, 7)}</code> : null}
      </div>

      <div className="repo-actions" role="cell" aria-busy={checkoutMutation.isPending || actionMutation.isPending}>
        {status.action === "reindex" ? (
          <button className="secondary-button compact-button" type="button" onClick={() => startAction("reindex")}>
            <RefreshCw size={16} />
            <span>Retry</span>
          </button>
        ) : status.action === "snapshot" && onSnapshotJob ? (
          <button className="secondary-button compact-button" type="button" onClick={onSnapshotJob}>
            <ExternalLink size={16} />
            <span>View error</span>
          </button>
        ) : null}
        <div className="action-menu" ref={menuRef}>
          <button
            ref={menuButtonRef}
            className="icon-button"
            type="button"
            aria-label={`Actions for ${repository.full_name}`}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            title="Repository actions"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreVertical size={18} />
          </button>
          {menuOpen ? (
            <div className="action-menu-popover" aria-label={`Actions for ${repository.full_name}`}>
              <a className="action-menu-item" href={repository.html_url} target="_blank" rel="noreferrer">
                <ExternalLink size={16} />
                <span>Open in GitHub</span>
              </a>
              <button className="action-menu-item" type="button" onClick={() => { setBranchOpen(true); setMenuOpen(false); }}>
                <GitBranch size={16} />
                <span>Change branch</span>
              </button>
              <button className="action-menu-item" type="button" onClick={() => startAction("refresh")}>
                <RefreshCw size={16} />
                <span>Refresh branches</span>
              </button>
              <button className="action-menu-item" type="button" onClick={() => startAction("reindex")}>
                <CheckCircle2 size={16} />
                <span>Reindex repository</span>
              </button>
              <button className="action-menu-item" type="button" onClick={() => void copyText(repository.full_name, "Repository name")}>
                <Clipboard size={16} />
                <span>Copy repository name</span>
              </button>
              <button
                className="action-menu-item"
                type="button"
                disabled={!repository.selected_commit}
                onClick={() => repository.selected_commit && void copyText(repository.selected_commit, "Commit SHA")}
              >
                <Clipboard size={16} />
                <span>Copy commit SHA</span>
              </button>
              <div className="action-menu-separator" role="separator" />
              <button className="action-menu-item danger" type="button" onClick={() => { setRemoveOpen(true); setMenuOpen(false); }}>
                <Trash2 size={16} />
                <span>Remove from Space</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {repository.last_error || mutationError ? (
        <div className="repo-error" role="alert">
          {repository.last_error ?? (mutationError instanceof Error ? mutationError.message : "Repository action failed")}
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite">{copyState}</div>

      {branchOpen ? (
        <Modal
          title={`Change branch · ${repository.full_name.split("/").at(-1)}`}
          onClose={() => {
            if (!checkoutMutation.isPending) {
              setBranchOpen(false);
              setBranchCandidate(null);
              setBranchQuery("");
            }
          }}
          wide
        >
          <div className="branch-picker-dialog">
            <p>Choose the branch MemoRepo should clone and expose to agents. The managed clone will be reset when you confirm.</p>
            <label className="branch-search">
              <span>Search {branches.length} available branches</span>
              <div>
                <Search size={18} />
                <input
                  autoFocus
                  data-modal-autofocus
                  value={branchQuery}
                  onChange={(event) => {
                    setBranchQuery(event.target.value);
                    setBranchCandidate(null);
                  }}
                  placeholder="Branch name"
                />
              </div>
            </label>
            <div className="branch-results" aria-label="Available branches">
              {branchResults.map((branch) => (
                <button
                  key={branch}
                  className={[
                    "branch-result",
                    branch === currentBranch ? "current" : "",
                    branch === branchCandidate ? "selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  type="button"
                  onClick={() => setBranchCandidate(branch)}
                  disabled={branch === currentBranch}
                  aria-current={branch === currentBranch ? "true" : undefined}
                  aria-pressed={branch !== currentBranch ? branch === branchCandidate : undefined}
                >
                  <GitBranch size={16} />
                  <span className="branch-result-label">
                    <span>{branch}</span>
                    {branch === currentBranch ? <small>Current</small> : null}
                    {branch === branchCandidate ? <small>Selected</small> : null}
                  </span>
                </button>
              ))}
              {branchResults.length === 0 ? <div className="empty-inline">No branches match “{branchQuery}”.</div> : null}
            </div>
            {branchQuery.trim() && branches.filter((branch) => branch.toLowerCase().includes(branchQuery.trim().toLowerCase())).length > 40 ? (
              <p className="branch-results-note">Showing the first 40 matches. Refine the search to narrow the list.</p>
            ) : null}
            {branchCandidate && branchCandidate !== currentBranch ? (
              <div className="branch-confirmation" role="status">
                <div>
                  <strong>Switch to {branchCandidate}?</strong>
                  <span>MemoRepo will reset the managed clone, then rebuild its index and the Space snapshot.</span>
                </div>
                <div className="dialog-actions">
                  <button className="secondary-button" type="button" onClick={() => setBranchCandidate(null)} disabled={checkoutMutation.isPending}>
                    Cancel
                  </button>
                  <button className="primary-button" type="button" onClick={() => checkoutMutation.mutate(branchCandidate)} disabled={checkoutMutation.isPending}>
                    {checkoutMutation.isPending ? <Loader2 className="spin" size={18} /> : <GitBranch size={18} />}
                    <span>Switch branch</span>
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {removeOpen ? (
        <Modal title="Remove repository" onClose={() => !actionMutation.isPending && setRemoveOpen(false)}>
          <div className="confirmation-dialog">
            <p>
              Remove <strong>{repository.full_name}</strong> from this Space? Existing snapshots remain available until lifecycle cleanup runs.
            </p>
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => setRemoveOpen(false)} disabled={actionMutation.isPending}>
                Cancel
              </button>
              <button className="secondary-button danger" type="button" onClick={() => actionMutation.mutate("remove")} disabled={actionMutation.isPending}>
                {actionMutation.isPending ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
                <span>Remove repository</span>
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function repositoryStatus(
  repository: SpaceRepository,
  snapshotState: SnapshotUiState
): { label: string; tone: "green" | "amber" | "red" | "gray"; description: string; action?: "reindex" | "snapshot" } {
  const cloneStatus = repository.clone_status.toLowerCase();
  const indexStatus = repository.index_status.toLowerCase();
  if (repository.last_error || [cloneStatus, indexStatus].some((status) => ["failed", "missing", "error"].includes(status))) {
    return { label: "Needs attention", tone: "red", description: "Review the latest error", action: "reindex" };
  }
  if ([cloneStatus, indexStatus].some((status) => ["pending", "running", "cloning", "indexing", "building"].includes(status))) {
    return { label: "Updating", tone: "amber", description: "Preparing agent context" };
  }
  if (cloneStatus === "cloned" && indexStatus === "indexed" && booleanValue(repository.snapshot_included)) {
    return { label: "Ready", tone: "green", description: "Available to agents" };
  }
  if (cloneStatus === "cloned" && indexStatus === "indexed") {
    if (snapshotState === "failed") {
      return { label: "Snapshot failed", tone: "red", description: "Open the failed snapshot job", action: "snapshot" };
    }
    if (snapshotState === "required") {
      return { label: "Snapshot required", tone: "amber", description: "Run Check for updates" };
    }
    if (snapshotState === "checking") {
      return { label: "Checking snapshot", tone: "gray", description: "Loading the latest operation" };
    }
    return { label: "Snapshot pending", tone: "amber", description: "Waiting for the active snapshot" };
  }
  return { label: "Preparing", tone: "gray", description: "Clone or index is incomplete" };
}

function parseBranches(value: string, fallback: string): string[] {
  try {
    const parsed = JSON.parse(value) as string[];
    const branches = parsed.length > 0 ? parsed : [fallback];
    return Array.from(new Set(branches.filter(Boolean))).sort((left, right) => left.localeCompare(right));
  } catch {
    return [fallback].filter(Boolean);
  }
}

function formatRelativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return "Unknown";
  }
  const differenceSeconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(differenceSeconds) < 60) {
    return formatter.format(differenceSeconds, "second");
  }
  const differenceMinutes = Math.round(differenceSeconds / 60);
  if (Math.abs(differenceMinutes) < 60) {
    return formatter.format(differenceMinutes, "minute");
  }
  const differenceHours = Math.round(differenceMinutes / 60);
  if (Math.abs(differenceHours) < 24) {
    return formatter.format(differenceHours, "hour");
  }
  return formatter.format(Math.round(differenceHours / 24), "day");
}
