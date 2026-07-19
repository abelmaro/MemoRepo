import fs from "node:fs";
import path from "node:path";
import type { AppDatabase } from "../db/connection.js";
import { insertRecord } from "../db/sql.js";
import { createId } from "../domain/ids.js";
import { nowIso } from "../domain/time.js";

export type TerminationKind = "completed" | "failed" | "timeout" | "cancelled" | "signal" | "possible_oom";

export interface ProcessDiagnosticInput {
  exitCode?: number | null;
  signal?: string | null;
  error?: unknown;
  cgroupOomKills?: number;
}

export interface CgroupMemoryMetrics {
  currentBytes: number | null;
  peakBytes: number | null;
  limitBytes: number | null;
  oomEvents: number;
  oomKillEvents: number;
}

export interface CbmOperationMetric {
  operation: string;
  status: string;
  durationMs: number;
  spaceId?: string;
  snapshotId?: string;
  spaceRepositoryId?: string;
  projectName?: string;
  engineVersion?: string;
  indexMode?: string;
  exitCode?: number | null;
  terminationKind?: TerminationKind;
  nodes?: number;
  edges?: number;
  skippedCount?: number;
  artifactBytes?: number;
  responseBytes?: number;
  cacheHit?: boolean;
  truncated?: boolean;
  cgroupPeakBytes?: number | null;
}

export function classifyProcessTermination(input: ProcessDiagnosticInput): TerminationKind {
  const name = input.error instanceof Error ? input.error.name : "";
  const message = input.error instanceof Error ? input.error.message : String(input.error ?? "");
  if (name === "AbortError" || /cancelled|canceled|aborted/u.test(message.toLowerCase())) return "cancelled";
  if (/timed out|timeout/u.test(message.toLowerCase())) return "timeout";
  if (input.exitCode === 137 || input.signal === "SIGKILL" || /exit code 137/u.test(message.toLowerCase())
    || /signal sigkill/u.test(message.toLowerCase()) || (input.cgroupOomKills ?? 0) > 0) return "possible_oom";
  if (input.signal) return "signal";
  if (input.exitCode === 0 && !input.error) return "completed";
  return "failed";
}

export function readCgroupMemoryMetrics(root = "/sys/fs/cgroup"): CgroupMemoryMetrics {
  const events = parseKeyValueFile(path.join(root, "memory.events"));
  return {
    currentBytes: readCgroupNumber(path.join(root, "memory.current")),
    peakBytes: readCgroupNumber(path.join(root, "memory.peak")) ?? readCgroupNumber(path.join(root, "memory.max_usage_in_bytes")),
    limitBytes: readCgroupNumber(path.join(root, "memory.max")) ?? readCgroupNumber(path.join(root, "memory.limit_in_bytes")),
    oomEvents: events.oom ?? 0,
    oomKillEvents: events.oom_kill ?? 0
  };
}

export function recordCbmOperationMetric(database: AppDatabase, metric: CbmOperationMetric): void {
  insertRecord(database, "cbm_operation_metrics", {
    id: createId("cbm"), operation: metric.operation, spaceId: metric.spaceId ?? null,
    snapshotId: metric.snapshotId ?? null, spaceRepositoryId: metric.spaceRepositoryId ?? null,
    projectName: metric.projectName ?? null, engineVersion: metric.engineVersion ?? null,
    indexMode: metric.indexMode ?? null, status: metric.status, durationMs: boundedInteger(metric.durationMs),
    exitCode: metric.exitCode ?? null, terminationKind: metric.terminationKind ?? null,
    nodes: metric.nodes ?? null, edges: metric.edges ?? null, skippedCount: metric.skippedCount ?? null,
    artifactBytes: metric.artifactBytes ?? null, responseBytes: metric.responseBytes ?? null,
    cacheHit: metric.cacheHit ? 1 : 0, truncated: metric.truncated ? 1 : 0,
    cgroupPeakBytes: metric.cgroupPeakBytes ?? null, createdAt: nowIso()
  });
}

export function directorySizeBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) total += fs.statSync(target).size;
    }
  }
  return total;
}

function readCgroupNumber(filePath: string): number | null {
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    if (!value || value === "max") return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  } catch { return null; }
}

function parseKeyValueFile(filePath: string): Record<string, number> {
  try {
    return Object.fromEntries(fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/u).flatMap((line) => {
      const [key, raw] = line.trim().split(/\s+/, 2);
      const value = Number(raw);
      return key && Number.isSafeInteger(value) && value >= 0 ? [[key, value]] : [];
    }));
  } catch { return {}; }
}

function boundedInteger(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(value)) : 0;
}
