import { useQuery } from "@tanstack/react-query";
import { Activity, AlertCircle, CheckCircle2, GitBranch, Github, Loader2, Plus } from "lucide-react";
import { api, type McpConnection, type Space, type SpaceRepository } from "../lib/api";
import type { SnapshotStateSummary } from "../lib/snapshotState";
import { QueryErrorState } from "./QueryErrorState";

interface SystemState {
  github: {
    authenticationMode: "token" | "oauth";
    connected: boolean;
    viewer?: { login: string };
    error?: string;
  };
  codebaseMemory: { installed: boolean; version?: string; error?: string };
  jobConcurrency: number;
}

interface StatusStripProps {
  space: Space;
  repositories: SpaceRepository[];
  loading: boolean;
  snapshotSummary: SnapshotStateSummary;
  onConnectAgent: () => void;
  onAddRepository: () => void;
  onSignInGitHub: () => void;
  onOpenSnapshotJob: (jobId: string) => void;
  operationsDisabled: boolean;
}

export function StatusStrip({
  space,
  repositories,
  loading,
  snapshotSummary,
  onConnectAgent,
  onAddRepository,
  onSignInGitHub,
  onOpenSnapshotJob,
  operationsDisabled,
}: StatusStripProps) {
  const systemQuery = useQuery({
    queryKey: ["system"],
    queryFn: () => api<SystemState>("/api/system")
  });
  const connectionsQuery = useQuery({
    queryKey: ["mcp-connections", space.id],
    queryFn: () => api<{ connections: McpConnection[] }>(`/api/spaces/${space.id}/mcp-connections`)
  });
  const snapshotJobId = snapshotSummary.latestSnapshotJob?.id;

  const activeConnections = (connectionsQuery.data?.connections ?? []).filter((connection) => !connection.revoked_at).length;
  const issueCount = repositories.filter((repository) => repository.last_error || [repository.clone_status, repository.index_status].some((status) => ["failed", "missing", "error"].includes(status.toLowerCase()))).length;
  const updatingRepositoryCount = repositories.filter((repository) =>
    [repository.clone_status, repository.index_status].some((status) => ["pending", "running", "cloning", "indexing", "building"].includes(status.toLowerCase()))
  ).length;
  const githubDisconnected = systemQuery.data?.github.connected === false;
  const githubUsesEnvironmentToken = systemQuery.data?.github.authenticationMode === "token";
  const systemProblems = [
    githubDisconnected
      ? githubUsesEnvironmentToken
        ? systemQuery.data?.github.error ?? "GitHub access through GH_TOKEN could not be validated."
        : "GitHub isn't connected. Sign in to sync repositories."
      : null,
    systemQuery.data && !systemQuery.data.codebaseMemory.installed ? systemQuery.data.codebaseMemory.error ?? "codebase-memory-mcp is unavailable." : null
  ].filter(Boolean) as string[];

  let tone: "success" | "warning" | "danger" | "neutral" = "success";
  let title = "Agent access is ready";
  let description = `${repositories.length} ${repositories.length === 1 ? "repository is" : "repositories are"} available through ${activeConnections} active ${activeConnections === 1 ? "connection" : "connections"}.`;
  let action: "add" | "connect" | "manage" | "activity" | null = "manage";
  let statusLoading = false;
  let busy = false;

  if (loading) {
    tone = "neutral";
    title = "Loading Space status";
    description = "Checking repositories, snapshots, and agent access…";
    action = null;
    statusLoading = true;
    busy = true;
  } else if (repositories.length === 0) {
    tone = "neutral";
    title = "Add your first repository";
    description = "Choose the code you want agents to search together in this isolated Space.";
    action = "add";
  } else if (issueCount > 0) {
    tone = "danger";
    title = `${issueCount} ${issueCount === 1 ? "repository needs" : "repositories need"} attention`;
    description = "Review the affected repository and retry its index before relying on this Space.";
    action = null;
  } else if (snapshotSummary.state === "failed") {
    tone = "danger";
    title = "Snapshot build failed";
    description = `${snapshotSummary.excludedRepositoryCount} indexed ${snapshotSummary.excludedRepositoryCount === 1 ? "repository is" : "repositories are"} not available to agents. Open the failed operation to inspect the error and retry.`;
    action = snapshotJobId ? "activity" : null;
  } else if (snapshotSummary.state === "required") {
    tone = "warning";
    title = "Snapshot rebuild required";
    description = `${snapshotSummary.excludedRepositoryCount} indexed ${snapshotSummary.excludedRepositoryCount === 1 ? "repository is" : "repositories are"} not in the active snapshot. Run Check for updates to rebuild it.`;
    action = null;
  } else if (snapshotSummary.state === "checking") {
    tone = "neutral";
    title = "Checking snapshot status";
    description = "Loading the latest snapshot operation…";
    action = null;
    statusLoading = true;
    busy = true;
  } else if (updatingRepositoryCount > 0 || snapshotSummary.state === "updating") {
    tone = "warning";
    title = "Preparing repository context";
    description = "Repositories are still being cloned, indexed, or added to the active snapshot.";
    action = null;
    busy = true;
  } else if (connectionsQuery.isError) {
    tone = "danger";
    title = "Agent access status is unavailable";
    description = "Repository context is ready, but active connections could not be checked.";
    action = null;
  } else if (connectionsQuery.isPending) {
    tone = "neutral";
    title = "Checking agent access";
    description = "Repositories are ready. Loading active connection details…";
    action = null;
    statusLoading = true;
  } else if (activeConnections === 0) {
    tone = "success";
    title = "Ready to connect an agent";
    description = `${repositories.length} ${repositories.length === 1 ? "repository is" : "repositories are"} indexed and ready for read-only search.`;
    action = "connect";
  }

  return (
    <section className="space-status" aria-labelledby="space-status-title">
      <div className={`space-status-callout space-status-${tone}`} role="status">
        <div className="space-status-icon" aria-hidden="true">
          {tone === "danger" || (tone === "warning" && !busy) ? <AlertCircle size={24} /> : busy || statusLoading ? <Loader2 className="spin" size={24} /> : <CheckCircle2 size={24} />}
        </div>
        <div>
          <h2 id="space-status-title">{title}</h2>
          <p>{description}</p>
        </div>
        {action === "activity" && snapshotJobId ? (
          <button className="secondary-button" type="button" onClick={() => onOpenSnapshotJob(snapshotJobId)}>
            <Activity size={18} />
            <span>View error</span>
          </button>
        ) : action === "add" ? (
          <button className="primary-button" type="button" onClick={onAddRepository} disabled={operationsDisabled}>
            <Plus size={18} />
            <span>Add repository</span>
          </button>
        ) : action === "connect" || action === "manage" ? (
          <button className={action === "connect" ? "primary-button" : "secondary-button"} type="button" onClick={onConnectAgent}>
            <GitBranch size={18} />
            <span>{action === "connect" ? "Connect agent" : `Manage ${activeConnections} ${activeConnections === 1 ? "connection" : "connections"}`}</span>
          </button>
        ) : null}
      </div>
      {connectionsQuery.isError ? (
        <QueryErrorState title="Agent connections could not be loaded" error={connectionsQuery.error} onRetry={() => void connectionsQuery.refetch()} />
      ) : null}
      {systemQuery.isError ? (
        <QueryErrorState title="System status could not be loaded" error={systemQuery.error} onRetry={() => void systemQuery.refetch()} />
      ) : null}
      {systemProblems.length > 0 ? (
        <div className="system-alert" role="alert">
          <AlertCircle size={18} />
          <div className="system-alert-copy">
            <strong>System setup needs attention</strong>
            <span>{systemProblems.join(" ")}</span>
          </div>
          {githubDisconnected && !githubUsesEnvironmentToken ? (
            <button className="primary-button compact-button" type="button" onClick={onSignInGitHub}>
              <Github size={16} />
              <span>Sign in with GitHub</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
