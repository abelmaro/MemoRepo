import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, GitBranch, Loader2, Plus } from "lucide-react";
import { api, booleanValue, type McpConnection, type Space, type SpaceRepository } from "../lib/api";

interface SystemState {
  github: { connected: boolean; viewer?: { login: string }; error?: string };
  codebaseMemory: { installed: boolean; version?: string; error?: string };
  memorepoHome: string;
  jobConcurrency: number;
}

interface StatusStripProps {
  space: Space;
  repositories: SpaceRepository[];
  loading: boolean;
  onConnectAgent: () => void;
  onAddRepository: () => void;
}

export function StatusStrip({ space, repositories, loading, onConnectAgent, onAddRepository }: StatusStripProps) {
  const systemQuery = useQuery({
    queryKey: ["system"],
    queryFn: () => api<SystemState>("/api/system"),
    refetchInterval: 30000
  });
  const connectionsQuery = useQuery({
    queryKey: ["mcp-connections", space.id],
    queryFn: () => api<{ connections: McpConnection[] }>(`/api/spaces/${space.id}/mcp-connections`),
    refetchInterval: 10000
  });

  const activeConnections = (connectionsQuery.data?.connections ?? []).filter((connection) => !connection.revoked_at).length;
  const issueCount = repositories.filter((repository) => repository.last_error || [repository.clone_status, repository.index_status].some((status) => ["failed", "missing", "error"].includes(status.toLowerCase()))).length;
  const updatingCount = repositories.filter((repository) =>
    [repository.clone_status, repository.index_status].some((status) => ["pending", "running", "cloning", "indexing", "building"].includes(status.toLowerCase())) ||
    !booleanValue(repository.snapshot_included)
  ).length;
  const systemProblems = [
    systemQuery.data && !systemQuery.data.github.connected ? systemQuery.data.github.error ?? "GitHub is not connected." : null,
    systemQuery.data && !systemQuery.data.codebaseMemory.installed ? systemQuery.data.codebaseMemory.error ?? "codebase-memory-mcp is unavailable." : null
  ].filter(Boolean) as string[];

  let tone: "success" | "warning" | "danger" | "neutral" = "success";
  let title = "Agent access is ready";
  let description = `${repositories.length} ${repositories.length === 1 ? "repository is" : "repositories are"} available through ${activeConnections} active ${activeConnections === 1 ? "connection" : "connections"}.`;
  let action: "add" | "connect" | "manage" | null = "manage";
  let statusLoading = false;

  if (loading) {
    tone = "neutral";
    title = "Loading Space status";
    description = "Checking repositories, snapshots, and agent access…";
    action = null;
    statusLoading = true;
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
  } else if (updatingCount > 0) {
    tone = "warning";
    title = "Preparing repository context";
    description = `${updatingCount} ${updatingCount === 1 ? "repository is" : "repositories are"} still being cloned, indexed, or added to the active snapshot.`;
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
          {tone === "danger" ? <AlertCircle size={24} /> : tone === "warning" || statusLoading ? <Loader2 className="spin" size={24} /> : <CheckCircle2 size={24} />}
        </div>
        <div>
          <h2 id="space-status-title">{title}</h2>
          <p>{description}</p>
        </div>
        {action === "add" ? (
          <button className="primary-button" type="button" onClick={onAddRepository}>
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
      {systemProblems.length > 0 ? (
        <div className="system-alert" role="alert">
          <AlertCircle size={18} />
          <div>
            <strong>System setup needs attention</strong>
            <span>{systemProblems.join(" ")}</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
