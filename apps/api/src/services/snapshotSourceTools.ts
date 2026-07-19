import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_READ_BYTES = 32 * 1024;
const MAX_READ_BYTES = 128 * 1024;
const DEFAULT_SEARCH_LIMIT = 25;
const MAX_SEARCH_LIMIT = 100;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_SCANNED_BYTES = 32 * 1024 * 1024;
const MAX_SEARCH_RESPONSE_BYTES = 45 * 1024;
const MAX_SEARCH_DURATION_MS = 10_000;

export interface SnapshotSourceRepository {
  projectName: string;
  fullName: string;
  localPath: string;
}

export interface ReadSnapshotFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
}

export interface SearchSnapshotTextInput {
  query: string;
  caseSensitive?: boolean;
  pathPrefix?: string;
  glob?: string;
  extensions?: string[];
  limit?: number;
  offset?: number;
}

export async function readSnapshotFile(
  repository: SnapshotSourceRepository,
  input: ReadSnapshotFileInput,
  signal?: AbortSignal
) {
  throwIfAborted(signal);
  const relativePath = normalizeRelativePath(input.path, "read_snapshot_file path");
  const startLine = boundedInteger(input.startLine ?? 1, "start_line", 1, 10_000_000);
  const endLine = boundedInteger(input.endLine ?? startLine + 199, "end_line", startLine, 10_000_000);
  const maxBytes = boundedInteger(input.maxBytes ?? DEFAULT_READ_BYTES, "max_bytes", 1, MAX_READ_BYTES);
  const safe = await openImmutableTextFile(repository.localPath, relativePath, MAX_READ_BYTES + 1, signal);
  try {
    const buffer = Buffer.alloc(Math.min(safe.size, MAX_READ_BYTES + 1));
    const { bytesRead } = await safe.handle.read(buffer, 0, buffer.length, 0);
    throwIfAborted(signal);
    const data = buffer.subarray(0, bytesRead);
    assertText(data, relativePath);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
    const lines = decoded.split(/\r?\n/);
    const selected = lines.slice(startLine - 1, endLine);
    const numbered: string[] = [];
    let outputBytes = 0;
    let truncated = safe.size > data.length || endLine < lines.length;
    for (let index = 0; index < selected.length; index += 1) {
      const line = `${startLine + index}: ${selected[index]}`;
      const bytes = Buffer.byteLength(line + "\n");
      if (outputBytes + bytes > maxBytes) {
        truncated = true;
        break;
      }
      numbered.push(line);
      outputBytes += bytes;
    }
    return {
      project: repository.projectName,
      repository: repository.fullName,
      path: relativePath,
      start_line: startLine,
      end_line: startLine + Math.max(0, numbered.length - 1),
      total_lines: safe.size > data.length ? undefined : lines.length,
      content: numbered.join("\n"),
      sha256: createHash("sha256").update(data).digest("hex"),
      digest_complete: safe.size === data.length,
      truncated,
      response_bytes: outputBytes
    };
  } finally {
    await safe.handle.close();
  }
}

export async function searchSnapshotText(
  repositories: SnapshotSourceRepository[],
  input: SearchSnapshotTextInput,
  signal?: AbortSignal
) {
  const query = requiredLiteral(input.query);
  const pathPrefix = input.pathPrefix ? normalizeRelativePath(input.pathPrefix, "path_prefix") : undefined;
  const glob = input.glob ? compileGlob(input.glob) : undefined;
  const extensions = normalizeExtensions(input.extensions);
  const limit = boundedInteger(input.limit ?? DEFAULT_SEARCH_LIMIT, "limit", 1, MAX_SEARCH_LIMIT);
  const offset = boundedInteger(input.offset ?? 0, "offset", 0, 1_000_000);
  const started = Date.now();
  const matches: Array<{ project: string; path: string; line: number; context: string }> = [];
  let matchingCount = 0;
  let searchedFiles = 0;
  let skippedBinary = 0;
  let skippedOversize = 0;
  let scannedBytes = 0;
  let responseBytes = 0;
  let complete = true;

  outer: for (const repository of repositories) {
    const files = await inventoryRegularFiles(repository.localPath, signal);
    for (const relativePath of files) {
      throwIfAborted(signal);
      if (Date.now() - started > MAX_SEARCH_DURATION_MS || scannedBytes >= MAX_SEARCH_SCANNED_BYTES) {
        complete = false;
        break outer;
      }
      if (pathPrefix && relativePath !== pathPrefix && !relativePath.startsWith(`${pathPrefix}/`)) continue;
      if (glob && !glob.test(relativePath)) continue;
      if (extensions && !extensions.has(path.extname(relativePath).toLowerCase())) continue;
      const safe = await openImmutableTextFile(repository.localPath, relativePath, MAX_SEARCH_FILE_BYTES + 1, signal);
      try {
        if (safe.size > MAX_SEARCH_FILE_BYTES) {
          skippedOversize += 1;
          continue;
        }
        const data = Buffer.alloc(safe.size);
        const { bytesRead } = await safe.handle.read(data, 0, data.length, 0);
        scannedBytes += bytesRead;
        const content = data.subarray(0, bytesRead);
        if (!isText(content)) {
          skippedBinary += 1;
          continue;
        }
        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
        } catch {
          skippedBinary += 1;
          continue;
        }
        searchedFiles += 1;
        const needle = input.caseSensitive ? query : query.toLocaleLowerCase("und");
        for (const [index, line] of decoded.split(/\r?\n/).entries()) {
          const haystack = input.caseSensitive ? line : line.toLocaleLowerCase("und");
          if (!haystack.includes(needle)) continue;
          if (matchingCount >= offset && matches.length < limit) {
            const context = compactContext(line, query, input.caseSensitive ?? false);
            const candidate = { project: repository.projectName, path: relativePath, line: index + 1, context };
            const bytes = Buffer.byteLength(JSON.stringify(candidate));
            if (responseBytes + bytes > MAX_SEARCH_RESPONSE_BYTES) {
              complete = false;
              break outer;
            }
            matches.push(candidate);
            responseBytes += bytes;
          }
          matchingCount += 1;
        }
      } finally {
        await safe.handle.close();
      }
    }
  }

  const hasMore = matchingCount > offset + matches.length;
  return {
    complete,
    searchedFiles,
    skippedBinary,
    skippedOversize,
    scannedBytes,
    truncated: !complete || hasMore,
    offset,
    effective_limit: limit,
    returned: matches.length,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + matches.length } : {}),
    matches
  };
}

async function openImmutableTextFile(root: string, relativePath: string, maxStatSize: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  const realRoot = await fs.promises.realpath(root);
  const segments = relativePath.split("/");
  let current = realRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Snapshot source path contains a symbolic link or reparse point");
  }
  const resolved = path.resolve(realRoot, ...segments);
  if (!isInside(realRoot, resolved)) throw new Error("Snapshot source path escapes its repository");
  const realTarget = await fs.promises.realpath(resolved);
  if (!isInside(realRoot, realTarget)) throw new Error("Snapshot source path escapes its repository");
  const before = await fs.promises.lstat(realTarget);
  if (!before.isFile()) throw new Error("Snapshot source path must be a regular file");
  if (before.size > maxStatSize) return { handle: await fs.promises.open(realTarget, "r"), size: before.size };
  const handle = await fs.promises.open(realTarget, "r");
  const after = await handle.stat();
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
    await handle.close();
    throw new Error("Snapshot source file changed while it was being opened");
  }
  return { handle, size: after.size };
}

async function inventoryRegularFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const realRoot = await fs.promises.realpath(root);
  const output: string[] = [];
  const pending = [""];
  while (pending.length > 0) {
    throwIfAborted(signal);
    const relativeDirectory = pending.pop()!;
    const absoluteDirectory = path.join(realRoot, relativeDirectory);
    for (const entry of await fs.promises.readdir(absoluteDirectory, { withFileTypes: true })) {
      const relative = path.posix.join(relativeDirectory.replaceAll("\\", "/"), entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile()) output.push(relative);
    }
  }
  return output.sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeRelativePath(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty relative path`);
  if (value.includes("\0") || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^[/\\]{2}/.test(value)) {
    throw new Error(`${label} must be a safe relative path`);
  }
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  return segments.join("/");
}

function requiredLiteral(value: unknown): string {
  if (typeof value !== "string" || !value.length) throw new Error("query must be a non-empty literal string");
  if (value.includes("\0") || Buffer.byteLength(value) > 1024) throw new Error("query is invalid or too large");
  return value;
}

function compileGlob(value: string): RegExp {
  const normalized = normalizeRelativePath(value, "glob");
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("\0", ".*").replaceAll("?", "[^/]");
  return new RegExp(`^${escaped}$`, "u");
}

function normalizeExtensions(values: string[] | undefined): Set<string> | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length > 32) throw new Error("extensions must be an array with at most 32 entries");
  return new Set(values.map((value) => {
    if (typeof value !== "string" || !/^\.?[A-Za-z0-9_-]{1,16}$/.test(value)) throw new Error("extensions contains an invalid extension");
    return (value.startsWith(".") ? value : `.${value}`).toLowerCase();
  }));
}

function compactContext(line: string, query: string, caseSensitive: boolean): string {
  const haystack = caseSensitive ? line : line.toLocaleLowerCase("und");
  const needle = caseSensitive ? query : query.toLocaleLowerCase("und");
  const index = haystack.indexOf(needle);
  const start = Math.max(0, index - 100);
  const end = Math.min(line.length, index + query.length + 100);
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

function isText(buffer: Buffer): boolean {
  return !buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

function assertText(buffer: Buffer, relativePath: string): void {
  if (!isText(buffer)) throw new Error(`Snapshot source file is binary: ${relativePath}`);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error(signal.reason instanceof Error ? signal.reason.message : "Operation cancelled");
  error.name = "AbortError";
  throw error;
}
