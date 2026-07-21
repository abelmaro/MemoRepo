import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppConfig } from "../config.js";
import { ensureInsideDir } from "../domain/paths.js";
import { sanitizePublicMessage } from "../domain/publicSanitize.js";
import { redactSensitive } from "../domain/sanitize.js";
import { assertCbmV090Compatible, type CbmV090Capabilities } from "./cbmV090Capabilities.js";
import { createSafeProcessEnvironment, runProcess, type ProcessResult } from "./process.js";

const DEFAULT_INTERACTIVE_CBM_CONCURRENCY = 2;
const DEFAULT_INDEX_CBM_CONCURRENCY = 1;
const MAX_MCP_STDERR_CHARS = 64 * 1024;
const MAX_MCP_HEADER_BYTES = 16 * 1024;
const MAX_MCP_BODY_BYTES = 32 * 1024 * 1024;
const MAX_MCP_BUFFER_BYTES = MAX_MCP_HEADER_BYTES + 6 + MAX_MCP_BODY_BYTES;
const MAX_MCP_TOOL_PAGES = 16;
const MAX_MCP_TOOLS = 256;

type CbmMcpProcessFactory = (cacheDir: string) => ChildProcessWithoutNullStreams;

export interface CbmCommandOptions {
  cacheDir: string;
  timeoutMs?: number | undefined;
  onOutput?: ((line: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export type CbmIndexMode = "fast" | "moderate" | "full";
export type CbmIndexStatus = "indexed" | "degraded" | "error" | "skipped" | "unknown";
export type CbmIndexQuality = "clean" | "partial" | "degraded" | "failed";
export type CbmIndexVerificationStatus = "ready" | "degraded" | "error" | "skipped" | "unknown";
export type CbmIndexVerificationQuality = "complete" | "degraded" | "unknown";

export interface CbmIndexSkippedFile {
  path: string;
  reason: string;
  phase: string;
}

export interface CbmIndexSkippedSummary {
  files: CbmIndexSkippedFile[];
  count: number;
  truncated: boolean;
}

export interface CbmIndexExcludedSummary {
  dirs: string[];
  count: number;
  truncated: boolean;
}

export interface CbmIndexRepositoryResult {
  project?: string;
  status: CbmIndexStatus;
  reportedStatus?: string;
  quality: CbmIndexQuality;
  skippedCount: number;
  skipped?: CbmIndexSkippedSummary;
  excluded?: CbmIndexExcludedSummary;
  nodes?: number;
  edges?: number;
  expectedNodes?: number;
  expectedEdges?: number;
  hint?: string;
  adrPresent?: boolean;
  adrHint?: string;
  artifactPresent?: boolean;
  artifactHint?: string;
  logfile?: string;
  outcome?: string;
  repoPath?: string;
  indexStatus?: CbmIndexStatusResult;
}

export interface CbmIndexStatusGitMetadata {
  isGit?: boolean;
  isWorktree?: boolean;
  isDetached?: boolean;
  rootExists?: boolean;
  worktreeRoot?: string;
  gitDir?: string;
  gitCommonDir?: string;
  canonicalRoot?: string;
  branch?: string;
  branchSlug?: string;
  headSha?: string;
  baseSha?: string;
}

export interface CbmIndexStatusResult {
  project?: string;
  status: CbmIndexVerificationStatus;
  reportedStatus?: string;
  quality: CbmIndexVerificationQuality;
  nodes?: number;
  edges?: number;
  rootPath?: string;
  git?: CbmIndexStatusGitMetadata;
}

export interface CbmCrossRepoLinksResult {
  project?: string;
  status?: string;
  indexStatus: CbmIndexStatusResult;
}

export function createCbmEnvironment(
  cacheDir?: string,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment = createSafeProcessEnvironment(source);

  environment.CBM_LOG_LEVEL = "warn";
  if (cacheDir !== undefined) {
    environment.CBM_CACHE_DIR = cacheDir;
  }

  return environment;
}

export class CbmService {
  private readonly sessions = new Map<string, CbmMcpSession>();
  private readonly isolatedSessions = new Set<CbmMcpSession>();
  private readonly trackedSessions = new Map<CbmMcpSession, string>();
  private readonly turnSessions = new Map<string, Promise<TurnSessionEntry>>();
  private readonly isolatedPermits: AbortablePermitPool;
  private readonly indexPermits: AbortablePermitPool;
  private readonly immutableCacheConfiguration = new Map<string, Promise<void>>();
  private runtimeVersion: Promise<string> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly runCbmProcess: typeof runProcess = runProcess,
    private readonly createMcpProcess: CbmMcpProcessFactory = spawnCbmMcpProcess
  ) {
    this.isolatedPermits = new AbortablePermitPool(
      positiveConcurrency(config.cbmInteractiveConcurrency, DEFAULT_INTERACTIVE_CBM_CONCURRENCY)
    );
    this.indexPermits = new AbortablePermitPool(
      positiveConcurrency(config.cbmIndexConcurrency, DEFAULT_INDEX_CBM_CONCURRENCY)
    );
  }

  async version(): Promise<string> {
    this.runtimeVersion ??= this.readVersion().catch((error: unknown) => {
      this.runtimeVersion = null;
      throw error;
    });
    return this.runtimeVersion;
  }

  private async readVersion(): Promise<string> {
    const result = await this.runCbmProcess({
      command: "codebase-memory-mcp",
      args: ["--version"],
      env: createCbmEnvironment(),
      inheritEnv: false,
      timeoutMs: 30_000
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "codebase-memory-mcp --version failed");
    }
    return (result.stdout || result.stderr).trim();
  }

  async capabilities(cacheDir: string): Promise<CbmV090Capabilities> {
    const [version, descriptors] = await Promise.all([
      this.version(),
      this.listToolDescriptors(cacheDir)
    ]);
    return assertCbmV090Compatible(version, descriptors);
  }

  async indexRepository(
    repoPath: string,
    cacheDir: string,
    mode: CbmIndexMode = "fast",
    onOutput?: (line: string) => void,
    signal?: AbortSignal
  ): Promise<CbmIndexRepositoryResult> {
    const rawResult = await this.cli<unknown>(
      "index_repository",
      { repo_path: repoPath, mode, persistence: false },
      { cacheDir, timeoutMs: 30 * 60_000, onOutput, signal }
    );
    const result = normalizeCbmIndexRepositoryResult(rawResult);
    const project = await this.resolveProjectName(repoPath, cacheDir) ?? result.project;
    const indexStatus = project
      ? await this.indexStatus(project, cacheDir, signal)
      : normalizeCbmIndexStatusResult({});
    const quality = combineCbmIndexQuality(result.quality, indexStatus.quality);
    return {
      ...result,
      quality,
      indexStatus,
      ...(project ? { project } : {})
    };
  }

  async buildCrossRepoLinks(
    repoPath: string,
    cacheDir: string,
    onOutput?: (line: string) => void,
    signal?: AbortSignal
  ): Promise<CbmCrossRepoLinksResult> {
    const rawResult = await this.cli<unknown>(
      "index_repository",
      { repo_path: repoPath, mode: "cross-repo-intelligence", target_projects: ["*"] },
      { cacheDir, timeoutMs: 30 * 60_000, onOutput, signal }
    );
    const result = recordValue(rawResult) ?? {};
    const project = await this.resolveProjectName(repoPath, cacheDir) ?? normalizedString(result.project);
    const indexStatus = project
      ? await this.indexStatus(project, cacheDir, signal)
      : normalizeCbmIndexStatusResult({});
    return {
      ...(normalizedString(result.status) ? { status: normalizedString(result.status)! } : {}),
      ...(project ? { project } : {}),
      indexStatus
    };
  }

  async indexStatus(project: string, cacheDir: string, signal?: AbortSignal): Promise<CbmIndexStatusResult> {
    const rawResult = await this.cli<unknown>(
      "index_status",
      { project },
      { cacheDir, timeoutMs: 60_000, signal }
    );
    const result = normalizeCbmIndexStatusResult(rawResult);
    const projectMatches = result.project?.toLocaleLowerCase("en-US") === project.toLocaleLowerCase("en-US");
    const hasCounts = result.nodes !== undefined && result.edges !== undefined;
    const rootExists = result.git?.rootExists;
    if (!projectMatches || !hasCounts) {
      return { ...result, quality: "unknown" };
    }
    if (rootExists === false) {
      return { ...result, quality: "degraded" };
    }
    return result;
  }

  async listProjects(cacheDir: string) {
    return this.cli<{ projects?: Array<{ name: string; root_path: string; nodes: number; edges: number }> }>(
      "list_projects",
      {},
      { cacheDir, timeoutMs: 60_000 }
    );
  }

  private async resolveProjectName(repoPath: string, cacheDir: string): Promise<string | undefined> {
    const projects = await this.listProjects(cacheDir);
    const normalizedRepoPath = normalizePath(repoPath);
    const matched = projects.projects?.find((project) => normalizePath(project.root_path) === normalizedRepoPath);
    return matched?.name ?? (projects.projects?.length === 1 ? projects.projects[0]?.name : undefined);
  }

  async tool<T>(
    tool: string,
    input: Record<string, unknown>,
    cacheDir: string,
    timeoutMs = 10_000,
    signal?: AbortSignal,
    turnSessionId?: string
  ): Promise<T> {
    throwIfAborted(signal);
    const resolvedCacheDir = ensureInsideDir(this.config.memorepoHome, cacheDir);
    fs.mkdirSync(resolvedCacheDir, { recursive: true });
    await this.ensureImmutableCacheConfiguration(resolvedCacheDir);
    if (turnSessionId) {
      const entry = await this.turnSession(turnSessionId, resolvedCacheDir, signal);
      const operation = entry.session.callTool<T>(tool, input, timeoutMs);
      return signal
        ? abortableSessionCall(operation, signal, () => entry.session.close())
        : operation;
    }
    if (!signal) {
      return this.session(resolvedCacheDir).callTool<T>(tool, input, timeoutMs);
    }

    const release = await this.isolatedPermits.acquire(signal);
    let session: CbmMcpSession | null = null;
    try {
      throwIfAborted(signal);
      const isolated = this.isolatedSession(resolvedCacheDir);
      session = isolated;
      const operation = isolated.callTool<T>(tool, input, timeoutMs);
      return await abortableSessionCall(operation, signal, () => isolated.close());
    } finally {
      try {
        await session?.close();
      } finally {
        release();
      }
    }
  }

  async listTools(cacheDir: string): Promise<string[]> {
    const tools = await this.listToolDescriptors(cacheDir);
    return tools.map((tool) => tool.name);
  }

  async listToolDescriptors(cacheDir: string): Promise<McpToolDescriptor[]> {
    const resolvedCacheDir = ensureInsideDir(this.config.memorepoHome, cacheDir);
    fs.mkdirSync(resolvedCacheDir, { recursive: true });
    await this.ensureImmutableCacheConfiguration(resolvedCacheDir);
    return this.session(resolvedCacheDir).listToolDescriptors();
  }

  async closeSession(cacheDir: string): Promise<void> {
    const key = normalizePath(path.resolve(cacheDir));
    const sessions = Array.from(this.trackedSessions, ([session, sessionKey]) => sessionKey === key ? session : null)
      .filter((session): session is CbmMcpSession => session !== null);
    await Promise.all(sessions.map((session) => session.close()));
  }

  async closeTurnSession(turnSessionId: string): Promise<void> {
    const pending = this.turnSessions.get(turnSessionId);
    if (!pending) return;
    this.turnSessions.delete(turnSessionId);
    const entry = await pending.catch(() => null);
    await entry?.session.close();
  }

  async close(): Promise<void> {
    const sessions = new Set(this.trackedSessions.keys());
    this.sessions.clear();
    this.isolatedSessions.clear();
    this.turnSessions.clear();
    await Promise.all(Array.from(sessions, (session) => session.close()));
    this.trackedSessions.clear();
  }

  private session(cacheDir: string): CbmMcpSession {
    const key = normalizePath(cacheDir);
    const existing = this.sessions.get(key);
    if (existing && !existing.closed) {
      return existing;
    }

    const session = new CbmMcpSession(cacheDir, [], () => {
      this.trackedSessions.delete(session);
      if (this.sessions.get(key) === session) {
        this.sessions.delete(key);
      }
    }, this.createMcpProcess);
    this.sessions.set(key, session);
    this.trackedSessions.set(session, key);
    return session;
  }

  private isolatedSession(cacheDir: string, onClosed: () => void = () => {}): CbmMcpSession {
    const key = normalizePath(cacheDir);
    const session = new CbmMcpSession(cacheDir, [], () => {
      this.isolatedSessions.delete(session);
      this.trackedSessions.delete(session);
      onClosed();
    }, this.createMcpProcess);
    this.isolatedSessions.add(session);
    this.trackedSessions.set(session, key);
    return session;
  }

  private turnSession(turnSessionId: string, cacheDir: string, signal?: AbortSignal): Promise<TurnSessionEntry> {
    const cacheKey = normalizePath(cacheDir);
    const existing = this.turnSessions.get(turnSessionId);
    if (existing) {
      return existing.then((entry) => {
        if (entry.cacheKey !== cacheKey) throw new Error("Agent turn session changed snapshot cache");
        return entry;
      });
    }

    const permitSignal = signal ?? new AbortController().signal;
    let pending!: Promise<TurnSessionEntry>;
    pending = (async () => {
      const release = await this.isolatedPermits.acquire(permitSignal);
      let released = false;
      const releaseSession = () => {
        if (released) return;
        released = true;
        release();
        if (this.turnSessions.get(turnSessionId) === pending) this.turnSessions.delete(turnSessionId);
      };
      try {
        throwIfAborted(signal);
        const session = this.isolatedSession(cacheDir, releaseSession);
        return { cacheKey, session };
      } catch (error) {
        releaseSession();
        throw error;
      }
    })();
    this.turnSessions.set(turnSessionId, pending);
    void pending.catch(() => {
      if (this.turnSessions.get(turnSessionId) === pending) this.turnSessions.delete(turnSessionId);
    });
    return pending;
  }

  private async cli<T>(tool: string, input: Record<string, unknown>, options: CbmCommandOptions): Promise<T> {
    const cacheDir = ensureInsideDir(this.config.memorepoHome, options.cacheDir);
    fs.mkdirSync(cacheDir, { recursive: true });
    await this.ensureImmutableCacheConfiguration(cacheDir);

    const permitSignal = options.signal ?? new AbortController().signal;
    const release = tool === "index_repository" ? await this.indexPermits.acquire(permitSignal) : () => {};
    let result: ProcessResult;
    try {
      result = await this.runCbmProcess({
        command: "codebase-memory-mcp",
        args: ["cli", tool],
        stdin: JSON.stringify(input),
        env: createCbmEnvironment(cacheDir),
        inheritEnv: false,
        timeoutMs: options.timeoutMs,
        onOutput: options.onOutput,
        signal: options.signal
      });
    } finally {
      release();
    }

    if (result.exitCode !== 0) {
      const detail = sanitizePublicMessage(
        result.stderr || result.stdout || `codebase-memory-mcp ${tool} failed`,
        [this.config.memorepoHome]
      );
      const termination = result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode ?? "unknown"}`;
      throw new Error(`codebase-memory-mcp ${tool} failed (${termination}): ${detail}`);
    }

    const stdout = result.stdout.trim();
    if (!stdout) {
      return {} as T;
    }

    try {
      return JSON.parse(stdout) as T;
    } catch (error) {
      throw new Error(
        `Unable to parse codebase-memory-mcp output for ${tool}: ${sanitizePublicMessage(stdout, [this.config.memorepoHome])}`
      );
    }
  }

  private ensureImmutableCacheConfiguration(cacheDir: string): Promise<void> {
    const key = normalizePath(cacheDir);
    const existing = this.immutableCacheConfiguration.get(key);
    if (existing) return existing;
    const pending = this.configureImmutableCache(cacheDir).catch((error) => {
      this.immutableCacheConfiguration.delete(key);
      throw error;
    });
    this.immutableCacheConfiguration.set(key, pending);
    return pending;
  }

  private async configureImmutableCache(cacheDir: string): Promise<void> {
    const readSettings = async () => {
      const result = await this.runCbmProcess({
        command: "codebase-memory-mcp",
        args: ["config", "list"],
        env: createCbmEnvironment(cacheDir),
        inheritEnv: false,
        timeoutMs: 10_000
      });
      if (result.exitCode !== 0) throw new Error("Unable to verify snapshot query configuration");
      return cbmBooleanSettings(result.stdout || result.stderr);
    };

    const settings = await readSettings();
    for (const name of ["auto_index", "auto_watch"] as const) {
      if (!settings.has(name)) throw new Error("CBM does not support immutable snapshot query configuration");
      if (settings.get(name) === false) continue;
      const result = await this.runCbmProcess({
        command: "codebase-memory-mcp",
        args: ["config", "set", name, "false"],
        env: createCbmEnvironment(cacheDir),
        inheritEnv: false,
        timeoutMs: 10_000
      });
      if (result.exitCode !== 0) throw new Error("Unable to enforce immutable snapshot query configuration");
    }

    const verified = await readSettings();
    for (const name of ["auto_index", "auto_watch"] as const) {
      if (verified.get(name) !== false) {
        throw new Error("Immutable snapshot query configuration could not be verified");
      }
    }
  }
}

interface TurnSessionEntry {
  cacheKey: string;
  session: CbmMcpSession;
}

function positiveConcurrency(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function cbmBooleanSettings(output: string): Map<string, boolean> {
  const settings = new Map<string, boolean>();
  for (const match of output.matchAll(/^\s*([a-z_]+)\s*=\s*(true|false)\b/gim)) {
    const name = match[1];
    const value = match[2];
    if (name && value) settings.set(name.toLocaleLowerCase("en-US"), value.toLocaleLowerCase("en-US") === "true");
  }
  return settings;
}

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

export function normalizeCbmIndexRepositoryResult(value: unknown): CbmIndexRepositoryResult {
  const result = recordValue(value) ?? {};
  const reportedStatus = normalizedString(result.status);
  const status = normalizeCbmIndexStatus(reportedStatus);
  const skippedSource = recordValue(result.skipped);
  const skippedFiles = normalizeCbmIndexSkippedFiles(
    skippedSource?.files ?? result.skipped_files ?? result.skippedFiles ?? (Array.isArray(result.skipped) ? result.skipped : undefined)
  );
  const skippedCount = Math.max(
    normalizedNonNegativeInteger(result.skipped_count) ?? 0,
    normalizedNonNegativeInteger(result.skippedCount) ?? 0,
    normalizedNonNegativeInteger(skippedSource?.count) ?? 0,
    skippedFiles.length
  );
  const skipped = skippedCount > 0
    ? {
        files: skippedFiles,
        count: skippedCount,
        truncated: normalizedBoolean(skippedSource?.truncated) ?? skippedCount > skippedFiles.length
      }
    : undefined;
  const excludedSource = recordValue(result.excluded);
  const excludedDirs = normalizedStringArray(excludedSource?.dirs);
  const excludedCount = Math.max(
    normalizedNonNegativeInteger(excludedSource?.count) ?? 0,
    excludedDirs.length
  );
  const excluded = excludedCount > 0
    ? {
        dirs: excludedDirs,
        count: excludedCount,
        truncated: normalizedBoolean(excludedSource?.truncated) ?? excludedCount > excludedDirs.length
      }
    : undefined;
  const quality: CbmIndexQuality = status === "degraded"
    ? "degraded"
    : status !== "indexed"
      ? "failed"
      : skippedCount > 0
        ? "partial"
        : "clean";

  return {
    status,
    quality,
    skippedCount,
    ...(reportedStatus ? { reportedStatus } : {}),
    ...(normalizedString(result.project) ? { project: normalizedString(result.project)! } : {}),
    ...(skipped ? { skipped } : {}),
    ...(excluded ? { excluded } : {}),
    ...optionalNormalizedNumber("nodes", result.nodes),
    ...optionalNormalizedNumber("edges", result.edges),
    ...optionalNormalizedNumber("expectedNodes", result.expected_nodes ?? result.expectedNodes),
    ...optionalNormalizedNumber("expectedEdges", result.expected_edges ?? result.expectedEdges),
    ...optionalNormalizedString("hint", result.hint),
    ...optionalNormalizedBoolean("adrPresent", result.adr_present ?? result.adrPresent),
    ...optionalNormalizedString("adrHint", result.adr_hint ?? result.adrHint),
    ...optionalNormalizedBoolean("artifactPresent", result.artifact_present ?? result.artifactPresent),
    ...optionalNormalizedString("artifactHint", result.artifact_hint ?? result.artifactHint),
    ...optionalNormalizedString("logfile", result.logfile),
    ...optionalNormalizedString("outcome", result.outcome),
    ...optionalNormalizedString("repoPath", result.repo_path ?? result.repoPath)
  };
}

export function normalizeCbmIndexStatusResult(value: unknown): CbmIndexStatusResult {
  const result = recordValue(value) ?? {};
  const reportedStatus = normalizedString(result.status);
  const status = normalizeCbmIndexVerificationStatus(reportedStatus);
  const nodes = normalizedNonNegativeInteger(result.nodes);
  const edges = normalizedNonNegativeInteger(result.edges);
  const git = normalizeCbmIndexStatusGit(result.git);
  const quality: CbmIndexVerificationQuality = status === "ready"
    ? "complete"
    : status === "unknown"
      ? "unknown"
      : "degraded";

  return {
    status,
    quality,
    ...(reportedStatus ? { reportedStatus } : {}),
    ...optionalNormalizedString("project", result.project),
    ...(nodes === undefined ? {} : { nodes }),
    ...(edges === undefined ? {} : { edges }),
    ...optionalNormalizedString("rootPath", result.root_path ?? result.rootPath),
    ...(git ? { git } : {})
  };
}

function normalizeCbmIndexVerificationStatus(value: string | undefined): CbmIndexVerificationStatus {
  switch (value?.toLocaleLowerCase("en-US")) {
    case "ready":
    case "indexed":
    case "complete":
    case "completed":
    case "success":
    case "ok":
      return "ready";
    case "degraded":
      return "degraded";
    case "failed":
    case "error":
      return "error";
    case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}

function normalizeCbmIndexStatusGit(value: unknown): CbmIndexStatusGitMetadata | undefined {
  const git = recordValue(value);
  if (!git) return undefined;
  const normalized = {
    ...optionalNormalizedBoolean("isGit", git.is_git ?? git.isGit),
    ...optionalNormalizedBoolean("isWorktree", git.is_worktree ?? git.isWorktree),
    ...optionalNormalizedBoolean("isDetached", git.is_detached ?? git.isDetached),
    ...optionalNormalizedBoolean("rootExists", git.root_exists ?? git.rootExists),
    ...optionalNormalizedString("worktreeRoot", git.worktree_root ?? git.worktreeRoot),
    ...optionalNormalizedString("gitDir", git.git_dir ?? git.gitDir),
    ...optionalNormalizedString("gitCommonDir", git.git_common_dir ?? git.gitCommonDir),
    ...optionalNormalizedString("canonicalRoot", git.canonical_root ?? git.canonicalRoot),
    ...optionalNormalizedString("branch", git.branch),
    ...optionalNormalizedString("branchSlug", git.branch_slug ?? git.branchSlug),
    ...optionalNormalizedString("headSha", git.head_sha ?? git.headSha),
    ...optionalNormalizedString("baseSha", git.base_sha ?? git.baseSha)
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function combineCbmIndexQuality(
  primary: CbmIndexQuality,
  verification: CbmIndexVerificationQuality
): CbmIndexQuality {
  if (primary === "degraded" || primary === "failed" || verification === "degraded") return "degraded";
  if (primary === "partial") return "partial";
  return verification === "complete" ? "clean" : "failed";
}

function normalizeCbmIndexStatus(value: string | undefined): CbmIndexStatus {
  switch (value?.toLocaleLowerCase("en-US")) {
    case "indexed":
    case "complete":
    case "completed":
    case "success":
    case "ok":
      return "indexed";
    case "degraded":
      return "degraded";
    case "error":
      return "error";
    case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}

function normalizeCbmIndexSkippedFiles(value: unknown): CbmIndexSkippedFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const item = recordValue(candidate);
    if (!item) return [];
    return [{
      path: normalizedString(item.path) ?? "",
      reason: normalizedString(item.reason) ?? "",
      phase: normalizedString(item.phase) ?? ""
    }];
  });
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizedStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const normalized = normalizedString(item);
    return normalized ? [normalized] : [];
  }) : [];
}

function normalizedNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizedBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNormalizedString<Key extends string>(key: Key, value: unknown): Partial<Record<Key, string>> {
  const normalized = normalizedString(value);
  return normalized ? { [key]: normalized } as Record<Key, string> : {};
}

function optionalNormalizedNumber<Key extends string>(key: Key, value: unknown): Partial<Record<Key, number>> {
  const normalized = normalizedNonNegativeInteger(value);
  return normalized === undefined ? {} : { [key]: normalized } as Record<Key, number>;
}

function optionalNormalizedBoolean<Key extends string>(key: Key, value: unknown): Partial<Record<Key, boolean>> {
  const normalized = normalizedBoolean(value);
  return normalized === undefined ? {} : { [key]: normalized } as Record<Key, boolean>;
}

class CbmMcpSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly ready: Promise<void>;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private stderr = "";
  private toolDescriptors: Promise<McpToolDescriptor[]> | null = null;
  private closing: Promise<void> | null = null;
  closed = false;

  constructor(
    private readonly cacheDir: string,
    private readonly sensitiveValues: string[],
    private readonly onClose: () => void,
    createProcess: CbmMcpProcessFactory
  ) {
    this.child = createProcess(cacheDir);

    this.child.unref();
    unrefStream(this.child.stdin);
    unrefStream(this.child.stdout);
    unrefStream(this.child.stderr);

    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (this.closed || this.stderr.length >= MAX_MCP_STDERR_CHARS) return;
      const remaining = MAX_MCP_STDERR_CHARS - this.stderr.length;
      this.stderr += redactSensitive(chunk.toString("utf8"), this.sensitiveValues).slice(0, remaining);
    });
    this.child.stdin.on("error", () => this.fail(new Error("codebase-memory-mcp input stream failed")));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", () => this.fail(new Error(`codebase-memory-mcp server closed for ${this.cacheDir}: ${this.stderr.trim()}`)));

    this.ready = this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "memorepo-api", version: "0.1.8" }
    }, 30_000).then(() => {
      this.write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    });
  }

  async callTool<T>(tool: string, input: Record<string, unknown>, timeoutMs: number): Promise<T> {
    await this.ready;
    const response = await this.request<McpToolCallResult>("tools/call", { name: tool, arguments: input }, timeoutMs);
    return parseCbmToolResult<T>(tool, response);
  }

  async listTools(): Promise<string[]> {
    const tools = await this.listToolDescriptors();
    return tools.map((tool) => tool.name);
  }

  async listToolDescriptors(): Promise<McpToolDescriptor[]> {
    await this.ready;
    this.toolDescriptors ??= this.fetchToolDescriptors();
    return this.toolDescriptors;
  }

  private async fetchToolDescriptors(): Promise<McpToolDescriptor[]> {
    const tools = new Map<string, McpToolDescriptor>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let candidateCount = 0;

    for (let page = 0; page < MAX_MCP_TOOL_PAGES; page += 1) {
      const rawResponse = await this.request<unknown>(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        10_000
      );
      if (!rawResponse || typeof rawResponse !== "object" || Array.isArray(rawResponse)) {
        throw new Error("codebase-memory-mcp tools/list returned an invalid result");
      }
      const response = rawResponse as McpToolsListResult;
      if (response.tools !== undefined && !Array.isArray(response.tools)) {
        throw new Error("codebase-memory-mcp tools/list returned an invalid tools collection");
      }

      for (const candidate of response.tools ?? []) {
        candidateCount += 1;
        if (candidateCount > MAX_MCP_TOOLS) {
          throw new Error(`codebase-memory-mcp tools/list exceeded ${MAX_MCP_TOOLS} tools`);
        }
        const descriptor = normalizeMcpToolDescriptor(candidate);
        if (descriptor && !tools.has(descriptor.name)) tools.set(descriptor.name, descriptor);
      }

      if (response.nextCursor === undefined) {
        return Array.from(tools.values());
      }
      if (typeof response.nextCursor !== "string" || response.nextCursor.length === 0) {
        throw new Error("codebase-memory-mcp tools/list returned an invalid nextCursor");
      }
      if (seenCursors.has(response.nextCursor)) {
        throw new Error("codebase-memory-mcp tools/list returned a repeated nextCursor");
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }

    throw new Error(`codebase-memory-mcp tools/list exceeded ${MAX_MCP_TOOL_PAGES} pages`);
  }

  close(): Promise<void> {
    if (this.closing) {
      return this.closing;
    }
    return this.shutdown(new Error("codebase-memory-mcp server closed"));
  }

  private request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("codebase-memory-mcp server is closed"));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        void this.close().catch(() => undefined);
        reject(new Error(`codebase-memory-mcp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private write(message: Record<string, unknown>): void {
    const body = JSON.stringify(message);
    const frame = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
    try {
      this.child.stdin.write(frame, (error) => {
        if (error) {
          this.fail(new Error("codebase-memory-mcp input stream failed"));
        }
      });
    } catch {
      this.fail(new Error("codebase-memory-mcp input stream failed"));
    }
  }

  private onStdout(chunk: Buffer): void {
    if (this.closed) return;
    if (this.buffer.length + chunk.length > MAX_MCP_BUFFER_BYTES) {
      this.fail(new Error("codebase-memory-mcp response frame exceeded the maximum size"));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const header = findHeader(this.buffer);
      if (!header) {
        if (this.buffer.length > MAX_MCP_HEADER_BYTES) {
          this.fail(new Error("codebase-memory-mcp response header exceeded the maximum size"));
        }
        return;
      }
      if (header.start > MAX_MCP_HEADER_BYTES) {
        this.fail(new Error("codebase-memory-mcp response header exceeded the maximum size"));
        return;
      }

      const headerText = this.buffer.subarray(0, header.start).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        this.fail(new Error("Invalid codebase-memory-mcp response header"));
        return;
      }

      const bodyLength = Number(match[1]);
      if (!Number.isSafeInteger(bodyLength) || bodyLength < 0 || bodyLength > MAX_MCP_BODY_BYTES) {
        this.fail(new Error("codebase-memory-mcp response body exceeded the maximum size"));
        return;
      }
      const bodyStart = header.start + header.length;
      const bodyEnd = bodyStart + bodyLength;
      if (this.buffer.length < bodyEnd) {
        return;
      }

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = bodyEnd === this.buffer.length
        ? Buffer.alloc(0)
        : Buffer.from(this.buffer.subarray(bodyEnd));
      this.handleMessage(body);
      if (this.closed) return;
    }
  }

  private handleMessage(body: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(body) as JsonRpcMessage;
    } catch {
      this.fail(new Error("Invalid codebase-memory-mcp JSON response"));
      return;
    }

    if (typeof message.id !== "number") {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }

    pending.resolve(message.result);
  }

  private fail(error: Error): void {
    void this.shutdown(error).catch(() => undefined);
  }

  private shutdown(error: Error): Promise<void> {
    if (this.closing) {
      return this.closing;
    }

    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();

    let resolveClosing!: () => void;
    let rejectClosing!: (error: Error) => void;
    const closingPromise = new Promise<void>((resolve, reject) => {
      resolveClosing = resolve;
      rejectClosing = reject;
    });
    this.closing = closingPromise;

    let finished = false;
    let closeNotified = false;
    let forceKill: NodeJS.Timeout | undefined;
    let forceConfirmation: NodeJS.Timeout | undefined;
    const notifyClose = () => {
      if (closeNotified) return;
      closeNotified = true;
      this.onClose();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      if (forceKill) clearTimeout(forceKill);
      if (forceConfirmation) clearTimeout(forceConfirmation);
      notifyClose();
      resolveClosing();
    };
    const failToStop = () => {
      if (finished) return;
      finished = true;
      if (forceKill) clearTimeout(forceKill);
      if (forceConfirmation) clearTimeout(forceConfirmation);
      if (this.closing === closingPromise) {
        this.closing = null;
      }
      rejectClosing(new Error("codebase-memory-mcp process did not exit after forced termination"));
    };

    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      finish();
      return closingPromise;
    }

    this.child.once("close", finish);
    forceKill = setTimeout(() => {
      try {
        if (!this.child.kill("SIGKILL") && this.child.exitCode === null && this.child.signalCode === null) {
          failToStop();
          return;
        }
        if (finished) return;
        forceConfirmation = setTimeout(failToStop, 1_000);
      } catch {
        failToStop();
      }
    }, 1_000);

    try {
      if (!this.child.kill("SIGTERM") && this.child.exitCode === null && this.child.signalCode === null) {
        failToStop();
      }
    } catch {
      if (this.child.exitCode !== null || this.child.signalCode !== null) finish();
      else failToStop();
    }
    return closingPromise;
  }
}

function spawnCbmMcpProcess(cacheDir: string): ChildProcessWithoutNullStreams {
  return spawn("codebase-memory-mcp", [], {
    env: createCbmEnvironment(cacheDir),
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function findHeader(buffer: Buffer): { start: number; length: number } | null {
  const standard = buffer.indexOf("\r\n\r\n");
  const windowsTextMode = buffer.indexOf("\r\r\n\r\r\n");
  if (standard === -1 && windowsTextMode === -1) {
    return null;
  }
  if (windowsTextMode !== -1 && (standard === -1 || windowsTextMode < standard)) {
    return { start: windowsTextMode, length: 6 };
  }
  return { start: standard, length: 4 };
}

function unrefStream(stream: unknown): void {
  if (!stream || typeof stream !== "object" || !("unref" in stream)) {
    return;
  }
  const unref = (stream as { unref: unknown }).unref;
  if (typeof unref === "function") {
    unref.call(stream);
  }
}

class AbortablePermitPool {
  private active = 0;
  private readonly waiting: PermitWaiter[] = [];

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseToken());
    }

    return new Promise((resolve, reject) => {
      const waiter: PermitWaiter = { signal, resolve, reject, onAbort: () => {} };
      waiter.onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index === -1) return;
        this.waiting.splice(index, 1);
        reject(abortError());
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiting.push(waiter);
      if (signal.aborted) waiter.onAbort();
    });
  }

  private releaseToken(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    this.active -= 1;
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      if (!waiter) break;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortError());
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseToken());
      break;
    }
  }
}

function abortableSessionCall<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  close: () => Promise<void>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancelling = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      if (settled || cancelling) return;
      cancelling = true;
      cleanup();
      void close().then(
        () => finish(() => reject(abortError())),
        () => finish(() => reject(abortError()))
      );
    };

    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (!cancelling) finish(() => resolve(value));
      },
      (error: unknown) => {
        if (!cancelling) finish(() => reject(error));
      }
    );
    if (signal.aborted) onAbort();
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("codebase-memory-mcp request was interrupted");
  error.name = "AbortError";
  return error;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PermitWaiter {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}

export interface McpToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

export interface McpToolDescriptor {
  name: string;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
}

interface McpToolsListResult {
  tools?: unknown;
  nextCursor?: unknown;
}

interface JsonRpcMessage {
  id?: unknown;
  result?: unknown;
  error?: { message: string };
}

export class CbmToolExecutionError extends Error {
  constructor(readonly tool: string, message: string) {
    super(message);
    this.name = "CbmToolExecutionError";
  }
}

function normalizeMcpToolDescriptor(candidate: unknown): McpToolDescriptor | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (typeof value.name !== "string" || value.name.length === 0) return null;

  const descriptor: McpToolDescriptor = { name: value.name };
  if (typeof value.description === "string") descriptor.description = value.description;
  if (value.inputSchema && typeof value.inputSchema === "object" && !Array.isArray(value.inputSchema)) {
    descriptor.inputSchema = value.inputSchema as Record<string, unknown>;
  }
  return descriptor;
}

export function parseCbmToolResult<T>(tool: string, response: McpToolCallResult): T {
  const text = response.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
  if (!text) {
    if (response.isError) {
      throw new CbmToolExecutionError(tool, "codebase-memory-mcp reported an error without details");
    }
    return response as T;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    if (response.isError) {
      throw new CbmToolExecutionError(tool, text);
    }
    throw new Error(`Unable to parse codebase-memory-mcp output for ${tool}: ${text}`);
  }

  const embeddedError = recordErrorMessage(parsed);
  if (response.isError || embeddedError) {
    throw new CbmToolExecutionError(tool, embeddedError ?? text);
  }
  return parsed as T;
}

function recordErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const error = (value as Record<string, unknown>).error;
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    return typeof message === "string" && message.trim() ? message : undefined;
  }
  return undefined;
}
