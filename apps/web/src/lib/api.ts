const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8787";

export interface Space {
  id: string;
  name: string;
  slug: string;
  active_snapshot_id: string | null;
  snapshot_status: string;
  repository_count?: number;
}

export interface GitHubRepository {
  id: string;
  githubId?: number;
  github_id?: number;
  owner: string;
  name: string;
  fullName?: string;
  full_name?: string;
  htmlUrl?: string;
  html_url?: string;
  cloneUrl?: string;
  clone_url?: string;
  defaultBranch?: string;
  default_branch?: string;
  private: boolean | number;
  archived: boolean | number;
  fork: boolean | number;
  description: string | null;
  topicsJson?: string;
  topics_json?: string;
}

export interface GitHubDiagnostics {
  connected: boolean;
  viewer?: {
    login: string;
    name: string | null;
  };
  tokenScopes?: string[];
  acceptedScopes?: string[];
  visibleRepositoryCount?: number;
  userRepositoryCount?: number;
  visibleOrganizationCount?: number;
  organizations?: GitHubOrganizationAccess[];
  warnings?: string[];
  error?: string;
}

export interface GitHubOrganizationAccess {
  login: string;
  status: "visible" | "inaccessible";
  repositoryCount: number | null;
  error?: string;
}

export interface SpaceRepository {
  id: string;
  space_id: string;
  github_repository_id: string;
  selected_branch: string | null;
  selected_commit: string | null;
  clone_status: string;
  index_status: string;
  snapshot_included: boolean | number;
  branches_json: string;
  last_fetched_at: string | null;
  last_indexed_at: string | null;
  last_error: string | null;
  removed_at: string | null;
  full_name: string;
  html_url: string;
  default_branch: string;
  private: boolean | number;
  archived: boolean | number;
  fork: boolean | number;
  description: string | null;
}

export interface Job {
  id: string;
  type: string;
  status: string;
  space_id: string | null;
  space_repository_id: string | null;
  depends_on_job_id: string | null;
  dependency_status?: string | null;
  dependency_type?: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobEvent {
  id: string;
  job_id: string;
  event_type: string;
  message: string;
  created_at: string;
}

export interface McpConnection {
  id: string;
  space_id: string;
  name: string;
  client: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface SpaceSnapshot {
  id: string;
  version: number;
  status: string;
  active: boolean;
  repositoryCount: number;
  sizeBytes: number;
  createdAt: string;
  activatedAt: string | null;
  error: string | null;
}

export interface SnapshotListResponse {
  snapshots: SpaceSnapshot[];
  totalSizeBytes: number;
  defaultRetention: number;
}

export interface SnapshotPruneResult {
  prunedAt: string;
  keepLatest: number;
  deletedCount: number;
  deletedBytes: number;
  retainedCount: number;
}

export interface MaintenanceSummary {
  defaults: {
    snapshotRetention: number;
    jobRetentionDays: number;
  };
  candidates: {
    oldRepoIndexRecords: number;
    removedRepositoryIndexes: number;
    orphanRepoIndexDirectories: number;
    failedSnapshots: number;
    oldJobs: number;
    removedClones: number;
  };
  estimatedBytes: {
    failedSnapshots: number;
    removedRepositoryIndexes: number;
    orphanRepoIndexDirectories: number;
    removedClones: number;
  };
}

export interface MaintenanceResult {
  deletedAt: string;
  jobRetentionDays: number;
  oldRepoIndexRecords: { count: number };
  removedRepositoryIndexes: { count: number; bytes: number };
  orphanRepoIndexDirectories: { count: number; bytes: number };
  failedSnapshots: { count: number; bytes: number };
  oldJobs: { count: number };
  removedClones: { count: number; bytes: number; skipped: number };
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function mcpJsonRpc<T>(spaceSlug: string, token: string, body: Record<string, unknown>): Promise<McpJsonRpcResponse<T>> {
  const response = await fetch(`${API_URL}/mcp/${spaceSlug}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(typeof payload.error === "string" ? payload.error : `MCP request failed: ${response.status}`);
  }

  const payload = (await response.json()) as McpJsonRpcResponse<T>;
  if (payload.error) {
    throw new Error(payload.error.message);
  }

  return payload;
}

export function eventSourceUrl(path: string): string {
  return `${API_URL}${path}`;
}

export function fullName(repository: GitHubRepository): string {
  return repository.full_name ?? repository.fullName ?? `${repository.owner}/${repository.name}`;
}

export function booleanValue(value: boolean | number): boolean {
  return value === true || value === 1;
}

export interface McpJsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

export interface McpToolsListResult {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}
