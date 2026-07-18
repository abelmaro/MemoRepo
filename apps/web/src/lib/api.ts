const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8787";
const CONTROL_TOKEN_STORAGE_KEY = "memorepo.control-token";
const CONTROL_UNAUTHORIZED_EVENT = "memorepo:control-unauthorized";
const CSRF_HEADER = "x-memorepo-csrf";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_EVENT_STREAM_RETRY_MS = 1_000;
const MIN_EVENT_STREAM_RETRY_MS = 1_000;
const MAX_EVENT_STREAM_RETRY_MS = 60_000;
let inMemoryControlToken: string | null = null;

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

export interface GitHubConnectionStatus {
  authenticationMode: "token" | "oauth";
  connected: boolean;
  viewer?: GitHubOAuthViewer;
  scopes?: string[];
  connectedAt?: string;
  lastValidatedAt?: string | null;
  manageAuthorizationUrl?: string;
}

export interface GitHubOAuthViewer {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
}

export interface GitHubDeviceAuthorizationStart {
  attemptId: string;
  userCode: string;
  verificationUri: "https://github.com/login/device";
  expiresAt: string;
  intervalSeconds: number;
}

export type GitHubDeviceAuthorizationStatus =
  | { status: "pending"; expiresAt: string; nextPollAt: string }
  | { status: "connected"; viewer: GitHubOAuthViewer; scopes: string[] }
  | { status: "denied" | "expired" | "failed"; error: string };

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
    orphanRevisionSources: number;
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
  orphanRevisionSources: { count: number; bytes: number };
  failedSnapshots: { count: number; bytes: number };
  oldJobs: { count: number };
  removedClones: { count: number; bytes: number; skipped: number };
}

export interface AgentStatus {
  configured: boolean;
  available: boolean;
  connected: boolean;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  authSource: string | null;
  version: string | null;
  message: string | null;
  capacity?: {
    active: number;
    maxActive: number;
    queued: number;
    maxQueued: number;
  };
}

export interface AgentModelCatalog {
  providers: Array<{
    id: string;
    name: string;
    models: Array<{
      id: string;
      name: string;
      capabilities: {
        effort?: { options: AgentEffort[]; default: AgentEffort };
        verbosity?: { options: AgentVerbosity[]; default: AgentVerbosity };
      };
    }>;
  }>;
  selected: {
    providerId: string;
    modelId: string;
    settings: AgentRunSettings;
  };
}

export type AgentEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentVerbosity = "low" | "medium" | "high";

export interface AgentRunSettings {
  effort?: AgentEffort;
  verbosity?: AgentVerbosity;
}

export type AgentRunMode = "quick" | "standard" | "deep";

export interface AgentRunMetrics {
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | null;
  providerRoundCount: number;
  lengthStopCount: number;
  toolCallCount: number;
  usage: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly requestId: string | null,
    readonly status: number
  ) {
    super(code ? `${message} (${code})` : message);
    this.name = "ApiError";
  }
}

export interface AgentLogin {
  loginId: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  verificationUrl: string | null;
  userCode: string | null;
  instructions: string | null;
  error: string | null;
}

export interface AgentSource {
  tool: string;
  repository?: string;
  project?: string;
  path?: string;
  symbol?: string;
  commit?: string;
}

export interface AgentSnapshotContext {
  id: string | null;
  version: number;
  createdAt?: string;
  activatedAt?: string | null;
  repositories?: Array<{
    fullName: string;
    branch: string;
    commit: string;
    projectName: string;
  }>;
}

export interface AgentChat {
  id: string;
  spaceId: string;
  title: string;
  status: "active" | "archived";
  snapshot: AgentSnapshotContext;
  activeSnapshot: { id: string | null; version: number } | null;
  usesLatestSnapshot: boolean;
  continuable: boolean;
  continuationReason: string | null;
  messageCount: number;
  activeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface AgentMessage {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  status: "pending" | "running" | "completed" | "interrupted" | "failed";
  content: string;
  sources: AgentSource[];
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AgentTurn {
  id: string;
  chatId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: "queued" | "pending" | "running" | "completed" | "interrupted" | "failed";
  error: string | null;
  providerId: string | null;
  modelId: string | null;
  mode: AgentRunMode;
  queuePosition: number | null;
  settings: AgentRunSettings;
  limits: {
    maxRunSeconds: number;
    maxToolCalls: number;
    maxProviderRounds: number;
  };
  metrics: AgentRunMetrics;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type AgentTurnEvent =
  | { type: "state"; turn: AgentTurn; assistantMessage: AgentMessage }
  | { type: "turn.started"; turnId: string; turn: AgentTurn }
  | { type: "assistant.delta"; turnId: string; messageId: string; offset: number; delta: string }
  | { type: "tool.started"; turnId: string; tool: string }
  | { type: "tool.completed"; turnId: string; tool: string; success: boolean; sources: AgentSource[] }
  | {
      type: "turn.completed";
      turnId: string;
      status: "completed" | "interrupted" | "failed";
      error: string | null;
      metrics: AgentRunMetrics;
    };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const controlToken = getControlToken();
  if (!controlToken) {
    notifyControlUnauthorized();
    throw new Error("MemoRepo control authentication is required");
  }

  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${controlToken}`);
  if (init?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!SAFE_METHODS.has((init?.method ?? "GET").toUpperCase())) {
    headers.set(CSRF_HEADER, "1");
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers
  });

  if (response.status === 401) {
    clearControlToken();
    notifyControlUnauthorized();
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown; requestId?: unknown };
    throw new ApiError(
      typeof body.error === "string" ? body.error : `Request failed: ${response.status}`,
      typeof body.code === "string" ? body.code : null,
      typeof body.requestId === "string" ? body.requestId : null,
      response.status
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export function getControlToken(): string | null {
  try {
    const storedToken = window.sessionStorage.getItem(CONTROL_TOKEN_STORAGE_KEY);
    if (storedToken !== null) {
      inMemoryControlToken = storedToken;
    }
    return storedToken ?? inMemoryControlToken;
  } catch {
    return inMemoryControlToken;
  }
}

export function setControlToken(token: string): void {
  inMemoryControlToken = token;
  try {
    window.sessionStorage.setItem(CONTROL_TOKEN_STORAGE_KEY, token);
  } catch {
    // The in-memory copy keeps the current tab usable when storage is unavailable.
  }
}

export function clearControlToken(): void {
  inMemoryControlToken = null;
  try {
    window.sessionStorage.removeItem(CONTROL_TOKEN_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in hardened browser modes.
  }
}

export async function validateControlToken(token: string): Promise<boolean> {
  const response = await fetch(`${API_URL}/api/auth/status`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (response.status === 401) {
    return false;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === "string" ? body.error : `Authentication check failed: ${response.status}`);
  }
  return true;
}

export function onControlUnauthorized(listener: () => void): () => void {
  window.addEventListener(CONTROL_UNAUTHORIZED_EVENT, listener);
  return () => window.removeEventListener(CONTROL_UNAUTHORIZED_EVENT, listener);
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

export function subscribeToJobEvents(path: string, onEvent: (event: JobEvent) => void, onError?: (error: Error) => void): () => void {
  const controller = new AbortController();
  void streamJobEvents(path, onEvent, onError, controller.signal);
  return () => controller.abort();
}

export function subscribeToAgentTurnEvents(
  turnId: string,
  onEvent: (event: AgentTurnEvent) => void,
  onError?: (error: Error) => void
): () => void {
  const controller = new AbortController();
  void streamAgentTurnEvents(`/api/agent/turns/${encodeURIComponent(turnId)}/events`, onEvent, onError, controller.signal);
  return () => controller.abort();
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

async function streamJobEvents(
  path: string,
  onEvent: (event: JobEvent) => void,
  onError: ((error: Error) => void) | undefined,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    let retryDelayMs = DEFAULT_EVENT_STREAM_RETRY_MS;

    try {
      const controlToken = getControlToken();
      if (!controlToken) {
        notifyControlUnauthorized();
        return;
      }

      const response = await fetch(`${API_URL}${path}`, {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${controlToken}`
        },
        signal
      });

      if (response.status === 401) {
        clearControlToken();
        notifyControlUnauthorized();
        return;
      }
      if (response.status === 429) {
        retryDelayMs = retryAfterDelayMs(response.headers.get("retry-after"));
        throw new Error(`Job event stream rate limited; retrying in ${Math.ceil(retryDelayMs / 1_000)} seconds`);
      }
      if (!response.ok || !response.body) {
        throw new Error(`Job event stream failed: ${response.status}`);
      }

      await consumeEventStream<JobEvent>(response.body, onEvent, signal);
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }

    await waitForRetry(retryDelayMs, signal);
  }
}

async function streamAgentTurnEvents(
  path: string,
  onEvent: (event: AgentTurnEvent) => void,
  onError: ((error: Error) => void) | undefined,
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    let retryDelayMs = DEFAULT_EVENT_STREAM_RETRY_MS;
    try {
      const controlToken = getControlToken();
      if (!controlToken) {
        notifyControlUnauthorized();
        return;
      }
      const response = await fetch(`${API_URL}${path}`, {
        headers: { accept: "text/event-stream", authorization: `Bearer ${controlToken}` },
        signal
      });
      if (response.status === 401) {
        clearControlToken();
        notifyControlUnauthorized();
        return;
      }
      if (response.status === 429) {
        retryDelayMs = retryAfterDelayMs(response.headers.get("retry-after"));
        throw new Error(`Agent event stream rate limited; retrying in ${Math.ceil(retryDelayMs / 1_000)} seconds`);
      }
      if (!response.ok || !response.body) throw new Error(`Agent event stream failed: ${response.status}`);
      const completed = await consumeEventStream<AgentTurnEvent>(
        response.body,
        (event) => {
          onEvent(event);
          return event.type === "turn.completed";
        },
        signal
      );
      if (completed) return;
    } catch (error) {
      if (signal.aborted) return;
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
    await waitForRetry(retryDelayMs, signal);
  }
}

function retryAfterDelayMs(value: string | null, nowMs = Date.now()): number {
  const retryAfter = value?.trim();
  let delayMs = DEFAULT_EVENT_STREAM_RETRY_MS;

  if (retryAfter && /^\d+$/.test(retryAfter)) {
    const seconds = Number(retryAfter);
    delayMs = Number.isFinite(seconds) ? seconds * 1_000 : MAX_EVENT_STREAM_RETRY_MS;
  } else if (retryAfter) {
    const retryAtMs = Date.parse(retryAfter);
    if (Number.isFinite(retryAtMs)) {
      delayMs = retryAtMs - nowMs;
    }
  }

  return Math.min(MAX_EVENT_STREAM_RETRY_MS, Math.max(MIN_EVENT_STREAM_RETRY_MS, Math.ceil(delayMs)));
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timeoutId = window.setTimeout(finish, delayMs);
    const onAbort = () => {
      window.clearTimeout(timeoutId);
      finish();
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function consumeEventStream<T>(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: T) => boolean | void,
  signal: AbortSignal
): Promise<boolean> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        return false;
      }
      buffer += decoder.decode(chunk.value, { stream: true });

      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) {
          if (onEvent(JSON.parse(data) as T) === true) return true;
        }
        separator = /\r?\n\r?\n/.exec(buffer);
      }
    }
    return false;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function notifyControlUnauthorized(): void {
  window.dispatchEvent(new Event(CONTROL_UNAUTHORIZED_EVENT));
}
