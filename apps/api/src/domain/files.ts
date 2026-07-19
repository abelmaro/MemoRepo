import fs from "node:fs";
import path from "node:path";
import { assertInside } from "./paths.js";

export interface ManagedPathRemoval {
  path: string;
  existed: boolean;
  sizeBytes: number;
}

export function managedPathSize(root: string, target: string): number {
  const safePath = assertDeletableManagedPath(root, target);
  return pathSize(safePath);
}

export async function managedPathSizeAsync(root: string, target: string, signal?: AbortSignal): Promise<number> {
  const safePath = assertDeletableManagedPath(root, target);
  return pathSizeAsync(safePath, signal);
}

export function removeManagedPath(root: string, target: string): ManagedPathRemoval {
  const safePath = assertDeletableManagedPath(root, target);
  const existed = fs.existsSync(safePath);
  const sizeBytes = existed ? pathSize(safePath) : 0;
  if (existed) {
    fs.rmSync(safePath, { recursive: true, force: true });
  }
  return { path: safePath, existed, sizeBytes };
}

export function assertDeletableManagedPath(root: string, target: string): string {
  const safePath = assertInside(root, target);
  const relativePath = path.relative(path.resolve(root), safePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Refusing to delete MEMOREPO_HOME itself");
  }
  return safePath;
}

function pathSize(target: string): number {
  if (!fs.existsSync(target)) {
    return 0;
  }

  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    return stat.size;
  }
  if (!stat.isDirectory()) {
    return stat.size;
  }

  let total = stat.size;
  for (const entry of fs.readdirSync(target)) {
    total += pathSize(path.join(target, entry));
  }
  return total;
}

async function pathSizeAsync(target: string, signal?: AbortSignal): Promise<number> {
  throwIfAborted(signal);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(target);
  } catch (error) {
    if (isMissingPathError(error)) return 0;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return stat.size;

  let total = stat.size;
  const entries = await fs.promises.readdir(target);
  for (const entry of entries) {
    total += await pathSizeAsync(path.join(target, entry), signal);
  }
  return total;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? new Error(signal.reason.message) : new Error("Operation cancelled");
  error.name = "AbortError";
  throw error;
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}
