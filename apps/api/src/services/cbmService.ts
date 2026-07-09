import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppConfig } from "../config.js";
import { ensureInsideDir } from "../domain/paths.js";
import { redactSensitive } from "../domain/sanitize.js";
import { createSafeProcessEnvironment, runProcess } from "./process.js";

export interface CbmCommandOptions {
  cacheDir: string;
  timeoutMs?: number | undefined;
  onOutput?: ((line: string) => void) | undefined;
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

  constructor(private readonly config: AppConfig) {}

  async version(): Promise<string> {
    const result = await runProcess({
      command: "codebase-memory-mcp",
      args: ["--version"],
      env: createCbmEnvironment(),
      inheritEnv: false,
      timeoutMs: 30_000,
      sensitiveValues: [this.config.githubToken]
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || "codebase-memory-mcp --version failed");
    }
    return (result.stdout || result.stderr).trim();
  }

  async indexRepository(repoPath: string, cacheDir: string, mode: "fast" | "moderate" | "full" = "fast", onOutput?: (line: string) => void) {
    const result = await this.cli<{ project?: string; status?: string; nodes?: number; edges?: number }>(
      "index_repository",
      { repo_path: repoPath, mode, persistence: false },
      { cacheDir, timeoutMs: 30 * 60_000, onOutput }
    );
    const project = await this.resolveProjectName(repoPath, cacheDir);
    return { ...result, project: project ?? result.project };
  }

  async buildCrossRepoLinks(repoPath: string, cacheDir: string, onOutput?: (line: string) => void) {
    return this.cli(
      "index_repository",
      { repo_path: repoPath, mode: "cross-repo-intelligence", target_projects: ["*"] },
      { cacheDir, timeoutMs: 30 * 60_000, onOutput }
    );
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

  async tool<T>(tool: string, input: Record<string, unknown>, cacheDir: string, timeoutMs = 10_000): Promise<T> {
    const resolvedCacheDir = ensureInsideDir(this.config.memorepoHome, cacheDir);
    fs.mkdirSync(resolvedCacheDir, { recursive: true });
    return this.session(resolvedCacheDir).callTool<T>(tool, input, timeoutMs);
  }

  async closeSession(cacheDir: string): Promise<void> {
    const session = this.sessions.get(normalizePath(path.resolve(cacheDir)));
    if (session) {
      await session.close();
    }
  }

  async close(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  private session(cacheDir: string): CbmMcpSession {
    const key = normalizePath(cacheDir);
    const existing = this.sessions.get(key);
    if (existing && !existing.closed) {
      return existing;
    }

    const session = new CbmMcpSession(cacheDir, [this.config.githubToken], () => {
      if (this.sessions.get(key) === session) {
        this.sessions.delete(key);
      }
    });
    this.sessions.set(key, session);
    return session;
  }

  private async cli<T>(tool: string, input: Record<string, unknown>, options: CbmCommandOptions): Promise<T> {
    const cacheDir = ensureInsideDir(this.config.memorepoHome, options.cacheDir);
    fs.mkdirSync(cacheDir, { recursive: true });

    const result = await runProcess({
      command: "codebase-memory-mcp",
      args: ["cli", tool, JSON.stringify(input)],
      env: createCbmEnvironment(cacheDir),
      inheritEnv: false,
      timeoutMs: options.timeoutMs,
      sensitiveValues: [this.config.githubToken],
      onOutput: options.onOutput
    });

    if (result.exitCode !== 0) {
      const detail = result.stderr || result.stdout || `codebase-memory-mcp ${tool} failed`;
      throw new Error(`codebase-memory-mcp ${tool} failed for ${JSON.stringify(input)}: ${detail}`);
    }

    const stdout = result.stdout.trim();
    if (!stdout) {
      return {} as T;
    }

    try {
      return JSON.parse(stdout) as T;
    } catch (error) {
      throw new Error(`Unable to parse codebase-memory-mcp output for ${tool}: ${stdout}`);
    }
  }
}

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

class CbmMcpSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly ready: Promise<void>;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private stderr = "";
  closed = false;

  constructor(
    private readonly cacheDir: string,
    private readonly sensitiveValues: string[],
    private readonly onClose: () => void
  ) {
    this.child = spawn("codebase-memory-mcp", [], {
      env: createCbmEnvironment(cacheDir),
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.unref();
    unrefStream(this.child.stdin);
    unrefStream(this.child.stdout);
    unrefStream(this.child.stderr);

    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += redactSensitive(chunk.toString("utf8"), this.sensitiveValues);
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", () => this.fail(new Error(`codebase-memory-mcp server closed for ${this.cacheDir}: ${this.stderr.trim()}`)));

    this.ready = this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "memorepo-api", version: "0.1.2" }
    }, 30_000).then(() => {
      this.write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    });
  }

  async callTool<T>(tool: string, input: Record<string, unknown>, timeoutMs: number): Promise<T> {
    await this.ready;
    const response = await this.request<McpToolCallResult>("tools/call", { name: tool, arguments: input }, timeoutMs);
    const text = response.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
    if (!text) {
      return response as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Unable to parse codebase-memory-mcp output for ${tool}: ${text}`);
    }
  }

  close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    this.closed = true;
    this.onClose();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("codebase-memory-mcp server closed"));
    }
    this.pending.clear();
    return new Promise((resolve) => {
      const forceKill = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 1_000);

      this.child.once("close", () => {
        clearTimeout(forceKill);
        resolve();
      });
      this.child.kill("SIGTERM");
    });
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
        void this.close();
        reject(new Error(`codebase-memory-mcp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private write(message: Record<string, unknown>): void {
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const header = findHeader(this.buffer);
      if (!header) {
        return;
      }

      const headerText = this.buffer.subarray(0, header.start).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        this.fail(new Error(`Invalid codebase-memory-mcp response header: ${headerText}`));
        return;
      }

      const bodyLength = Number(match[1]);
      const bodyStart = header.start + header.length;
      const bodyEnd = bodyStart + bodyLength;
      if (this.buffer.length < bodyEnd) {
        return;
      }

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(body) as JsonRpcMessage;
    } catch {
      this.fail(new Error(`Invalid codebase-memory-mcp JSON response: ${body}`));
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
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClose();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
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

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface McpToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
}

interface JsonRpcMessage {
  id?: unknown;
  result?: unknown;
  error?: { message: string };
}
