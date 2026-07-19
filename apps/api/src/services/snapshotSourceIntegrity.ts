import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SNAPSHOT_SOURCE_INTEGRITY_SCHEMA_VERSION = 1;
export const SNAPSHOT_SOURCE_INTEGRITY_ALGORITHM = "sha256" as const;
const MAX_INTEGRITY_MANIFEST_BYTES = 64 * 1024 * 1024;
const HASH_BUFFER_BYTES = 128 * 1024;

export interface SnapshotSourceIntegrityFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface SnapshotSourceIntegrityManifest {
  schemaVersion: typeof SNAPSHOT_SOURCE_INTEGRITY_SCHEMA_VERSION;
  algorithm: typeof SNAPSHOT_SOURCE_INTEGRITY_ALGORITHM;
  sourceDirectory: string;
  treeSha: string;
  rootDigest: string;
  fileCount: number;
  totalBytes: number;
  files: SnapshotSourceIntegrityFile[];
}

export type SnapshotSourceIntegritySummary = Omit<SnapshotSourceIntegrityManifest, "files">;

export interface SnapshotSourceIntegrityVerification {
  valid: boolean;
  reason?: string;
  manifest?: SnapshotSourceIntegrityManifest;
}

export function snapshotSourceIntegrityManifestPath(sourcePath: string): string {
  return path.join(path.dirname(sourcePath), `${path.basename(sourcePath)}.source-integrity.json`);
}

export async function createSnapshotSourceIntegrityManifest(
  sourcePath: string,
  treeSha: string,
  signal?: AbortSignal
): Promise<SnapshotSourceIntegrityManifest> {
  assertTreeSha(treeSha);
  const files = await snapshotSourceFiles(sourcePath, signal);
  const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  return {
    schemaVersion: SNAPSHOT_SOURCE_INTEGRITY_SCHEMA_VERSION,
    algorithm: SNAPSHOT_SOURCE_INTEGRITY_ALGORITHM,
    sourceDirectory: path.basename(sourcePath),
    treeSha: treeSha.toLocaleLowerCase("en-US"),
    rootDigest: snapshotSourceRootDigest(files),
    fileCount: files.length,
    totalBytes,
    files
  };
}

export async function writeSnapshotSourceIntegrityManifestAtomic(
  manifestPath: string,
  manifest: SnapshotSourceIntegrityManifest,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const parent = path.dirname(manifestPath);
  const parentStat = await fs.promises.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("Snapshot source integrity manifest parent is not a plain directory");
  }
  const temporaryPath = path.join(
    parent,
    `.${path.basename(manifestPath)}.${randomBytes(8).toString("hex")}.tmp`
  );
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    throwIfAborted(signal);
    await fs.promises.rename(temporaryPath, manifestPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function readSnapshotSourceIntegrityManifest(
  manifestPath: string
): Promise<SnapshotSourceIntegrityManifest> {
  const stat = await fs.promises.lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INTEGRITY_MANIFEST_BYTES) {
    throw new Error("Snapshot source integrity manifest is not a bounded regular file");
  }
  const parsed = JSON.parse(await fs.promises.readFile(manifestPath, "utf8")) as unknown;
  return validateSnapshotSourceIntegrityManifest(parsed);
}

export async function verifySnapshotSourceIntegrity(
  sourcePath: string,
  manifestPath: string,
  expectedTreeSha: string,
  signal?: AbortSignal
): Promise<SnapshotSourceIntegrityVerification> {
  try {
    throwIfAborted(signal);
    const manifest = await readSnapshotSourceIntegrityManifest(manifestPath);
    if (manifest.sourceDirectory !== path.basename(sourcePath)) {
      return { valid: false, reason: "source_directory_mismatch" };
    }
    if (manifest.treeSha !== expectedTreeSha.toLocaleLowerCase("en-US")) {
      return { valid: false, reason: "tree_sha_mismatch" };
    }
    const actual = await createSnapshotSourceIntegrityManifest(sourcePath, expectedTreeSha, signal);
    if (actual.rootDigest !== manifest.rootDigest) return { valid: false, reason: "root_digest_mismatch" };
    if (actual.fileCount !== manifest.fileCount) return { valid: false, reason: "file_count_mismatch" };
    if (actual.totalBytes !== manifest.totalBytes) return { valid: false, reason: "total_bytes_mismatch" };
    if (!sameIntegrityFiles(actual.files, manifest.files)) return { valid: false, reason: "file_manifest_mismatch" };
    return { valid: true, manifest };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { valid: false, reason: "manifest_unavailable_or_invalid" };
  }
}

export function snapshotSourceIntegritySummary(
  manifest: SnapshotSourceIntegrityManifest
): SnapshotSourceIntegritySummary {
  const { files: _files, ...summary } = manifest;
  return summary;
}

export function snapshotSourceRootDigest(files: SnapshotSourceIntegrityFile[]): string {
  const hash = createHash("sha256");
  hash.update("memorepo-snapshot-source-integrity-v1\0", "utf8");
  for (const file of [...files].sort(compareIntegrityFiles)) {
    const pathBytes = Buffer.from(file.path, "utf8");
    hash.update(String(pathBytes.byteLength), "ascii");
    hash.update(":", "ascii");
    hash.update(pathBytes);
    hash.update("\0", "utf8");
    hash.update(String(file.sizeBytes), "ascii");
    hash.update("\0", "utf8");
    hash.update(file.sha256, "ascii");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

async function snapshotSourceFiles(
  sourcePath: string,
  signal?: AbortSignal
): Promise<SnapshotSourceIntegrityFile[]> {
  throwIfAborted(signal);
  const sourceStat = await fs.promises.lstat(sourcePath);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Snapshot source is not a plain directory");
  }
  const realSource = await fs.promises.realpath(sourcePath);
  const files: SnapshotSourceIntegrityFile[] = [];
  await walkSnapshotSource(sourcePath, realSource, [], files, signal);
  files.sort(compareIntegrityFiles);
  return files;
}

async function walkSnapshotSource(
  currentPath: string,
  realSource: string,
  relativeSegments: string[],
  files: SnapshotSourceIntegrityFile[],
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    throwIfAborted(signal);
    const absolutePath = path.join(currentPath, entry.name);
    const stat = await fs.promises.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new Error("Snapshot source integrity rejects symbolic links");
    const realPath = await fs.promises.realpath(absolutePath);
    assertStrictlyInside(realSource, realPath);
    const nextSegments = [...relativeSegments, entry.name];
    if (stat.isDirectory()) {
      await walkSnapshotSource(absolutePath, realSource, nextSegments, files, signal);
      continue;
    }
    if (!stat.isFile()) throw new Error("Snapshot source integrity rejects non-regular files");
    const hashed = await hashSnapshotSourceFile(absolutePath, signal);
    files.push({
      path: nextSegments.join("/"),
      sizeBytes: hashed.sizeBytes,
      sha256: hashed.sha256
    });
  }
}

async function hashSnapshotSourceFile(
  filePath: string,
  signal?: AbortSignal
): Promise<{ sizeBytes: number; sha256: string }> {
  const noFollow = "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Snapshot source integrity rejects non-regular files");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0;
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || offset !== after.size) {
      throw new Error("Snapshot source changed while its integrity was being computed");
    }
    return { sizeBytes: offset, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

function validateSnapshotSourceIntegrityManifest(value: unknown): SnapshotSourceIntegrityManifest {
  if (!isRecord(value)) throw new Error("Snapshot source integrity manifest must be an object");
  if (value.schemaVersion !== SNAPSHOT_SOURCE_INTEGRITY_SCHEMA_VERSION) {
    throw new Error("Snapshot source integrity manifest schema is unsupported");
  }
  if (value.algorithm !== SNAPSHOT_SOURCE_INTEGRITY_ALGORITHM) {
    throw new Error("Snapshot source integrity manifest algorithm is unsupported");
  }
  if (typeof value.sourceDirectory !== "string" || !value.sourceDirectory || path.basename(value.sourceDirectory) !== value.sourceDirectory) {
    throw new Error("Snapshot source integrity manifest source directory is invalid");
  }
  assertTreeSha(value.treeSha);
  assertDigest(value.rootDigest, "root digest");
  if (!isNonNegativeInteger(value.fileCount) || !isNonNegativeInteger(value.totalBytes) || !Array.isArray(value.files)) {
    throw new Error("Snapshot source integrity manifest totals are invalid");
  }
  const files = value.files.map(validateIntegrityFile);
  if (files.length !== value.fileCount || files.reduce((total, file) => total + file.sizeBytes, 0) !== value.totalBytes) {
    throw new Error("Snapshot source integrity manifest totals do not match its files");
  }
  const sorted = [...files].sort(compareIntegrityFiles);
  if (!sameIntegrityFiles(files, sorted) || new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("Snapshot source integrity manifest paths are not unique and sorted");
  }
  if (snapshotSourceRootDigest(files) !== value.rootDigest) {
    throw new Error("Snapshot source integrity manifest root digest is invalid");
  }
  return {
    schemaVersion: SNAPSHOT_SOURCE_INTEGRITY_SCHEMA_VERSION,
    algorithm: SNAPSHOT_SOURCE_INTEGRITY_ALGORITHM,
    sourceDirectory: value.sourceDirectory,
    treeSha: value.treeSha.toLocaleLowerCase("en-US"),
    rootDigest: value.rootDigest.toLocaleLowerCase("en-US"),
    fileCount: value.fileCount,
    totalBytes: value.totalBytes,
    files
  };
}

function validateIntegrityFile(value: unknown): SnapshotSourceIntegrityFile {
  if (!isRecord(value) || typeof value.path !== "string" || !isSafeRelativePath(value.path)) {
    throw new Error("Snapshot source integrity manifest file path is invalid");
  }
  if (!isNonNegativeInteger(value.sizeBytes)) {
    throw new Error("Snapshot source integrity manifest file size is invalid");
  }
  assertDigest(value.sha256, "file digest");
  return {
    path: value.path,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256.toLocaleLowerCase("en-US")
  };
}

function sameIntegrityFiles(
  left: SnapshotSourceIntegrityFile[],
  right: SnapshotSourceIntegrityFile[]
): boolean {
  return left.length === right.length && left.every((file, index) => {
    const candidate = right[index];
    return candidate?.path === file.path
      && candidate.sizeBytes === file.sizeBytes
      && candidate.sha256 === file.sha256;
  });
}

function compareIntegrityFiles(left: SnapshotSourceIntegrityFile, right: SnapshotSourceIntegrityFile): number {
  return compareUtf8(left.path, right.path);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function assertStrictlyInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Snapshot source entry escapes its source root");
  }
}

function assertTreeSha(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value)) {
    throw new Error("Snapshot source integrity tree SHA is invalid");
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`Snapshot source integrity ${label} is invalid`);
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? new Error(signal.reason.message) : new Error("Operation cancelled");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
