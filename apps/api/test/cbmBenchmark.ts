import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../src/config.js";
import { CbmService, type CbmIndexMode, type CbmIndexRepositoryResult } from "../src/services/cbmService.js";
import { createCbmBenchmarkCorpus, inventoryCorpus } from "./cbmBenchmarkCorpus.js";

const QUERIES = [
  { query: "validate an order before processing", expected: "validateOrder" },
  { query: "format an order identifier", expected: "formatOrder" },
  { query: "normalize a profile value", expected: "normalize" }
] as const;
const SNIPPETS = [
  { projectHint: "alpha", qualifiedName: "validateOrder", expected: "order.total < 0" },
  { projectHint: "alpha", qualifiedName: "formatOrder", expected: "return order.id" },
  { projectHint: "beta", qualifiedName: "normalize", expected: "toLowerCase" }
] as const;

export interface CbmBenchmarkConfig {
  outputPath: string;
  mode: CbmIndexMode;
  warmRepetitions: number;
  keepWorkdir: boolean;
}

export interface Distribution {
  count: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface RetrievalAggregate {
  queries: number;
  hitAt1: number;
  hitAt5: number;
}

export interface CbmBenchmarkReport {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  runtime: { version: string; mode: CbmIndexMode };
  index: {
    durationMs: number;
    artifactBytes: number;
    status: string;
    quality: string;
    nodes: number | null;
    edges: number | null;
    skipped: number;
  };
  coverage: { sourceFiles: number; indexedFiles: number; ratio: number };
  retrieval: RetrievalAggregate & {
    coldLatency: Distribution;
    warmLatency: Distribution;
    responseBytes: number;
  };
  semantic: (RetrievalAggregate & { available: true; latency: Distribution; responseBytes: number })
    | { available: false; reason: string };
  snippets: { attempted: number; exact: number; responseBytes: number; latency: Distribution };
  deterministicSet: { queryCount: number; snippetCount: number; warmRepetitions: number };
  workdir?: string;
}

export class CbmBenchmarkInputError extends Error {}

export function parseCbmBenchmarkArguments(args: string[], now = new Date()): CbmBenchmarkConfig {
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  const config: CbmBenchmarkConfig = {
    outputPath: path.join(os.tmpdir(), "memorepo-cbm", `benchmark-${stamp}.json`),
    mode: "fast",
    warmRepetitions: 5,
    keepWorkdir: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--keep-workdir") { config.keepWorkdir = true; continue; }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new CbmBenchmarkInputError(`${argument} requires a value`);
    if (argument === "--output") config.outputPath = path.resolve(value);
    else if (argument === "--mode") {
      if (!isIndexMode(value)) throw new CbmBenchmarkInputError("--mode must be fast, moderate, or full");
      config.mode = value;
    } else if (argument === "--warm-repetitions") {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1 || count > 20) throw new CbmBenchmarkInputError("--warm-repetitions must be between 1 and 20");
      config.warmRepetitions = count;
    } else throw new CbmBenchmarkInputError(`Unknown argument: ${argument}`);
    index += 1;
  }
  return config;
}

export function summarizeDurations(samples: readonly number[]): Distribution {
  if (samples.length === 0) return { count: 0, minMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    minMs: round(sorted[0] ?? 0),
    medianMs: round(percentileNearestRank(sorted, 0.5)),
    p95Ms: round(percentileNearestRank(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0)
  };
}

export function aggregateRetrievalRankings(rankings: readonly unknown[], expected: readonly string[]): RetrievalAggregate {
  if (rankings.length !== expected.length) throw new Error("Each ranking requires one expected symbol");
  let hitAt1 = 0;
  let hitAt5 = 0;
  rankings.forEach((ranking, index) => {
    const items = rankedItems(ranking);
    const needle = expected[index]?.toLowerCase() ?? "";
    if (items.slice(0, 1).some((item) => JSON.stringify(item).toLowerCase().includes(needle))) hitAt1 += 1;
    if (items.slice(0, 5).some((item) => JSON.stringify(item).toLowerCase().includes(needle))) hitAt5 += 1;
  });
  return { queries: rankings.length, hitAt1, hitAt5 };
}

export async function runCbmBenchmark(config: CbmBenchmarkConfig): Promise<CbmBenchmarkReport> {
  const startedAt = new Date();
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-cbm-run-"));
  const corpus = createCbmBenchmarkCorpus(runRoot);
  const managedHome = path.join(runRoot, "managed");
  const cacheDir = path.join(managedHome, "index");
  const previousHome = process.env.MEMOREPO_HOME;
  process.env.MEMOREPO_HOME = managedHome;
  const appConfig = loadConfig();
  if (previousHome === undefined) delete process.env.MEMOREPO_HOME; else process.env.MEMOREPO_HOME = previousHome;
  const cbm = new CbmService(appConfig);
  try {
    const version = await cbm.version();
    if (!/0\.9\./u.test(version)) throw new Error(`perf:cbm requires codebase-memory-mcp v0.9.x; detected: ${version || "unknown"}`);
    const indexStarted = performance.now();
    const indexResult = await cbm.indexRepository(corpus.root, cacheDir, config.mode);
    const indexDurationMs = round(performance.now() - indexStarted);
    const projects = await cbm.listProjects(cacheDir);
    const projectNames = projects.projects?.map((project) => project.name) ?? [];

    const coldLatencies: number[] = [];
    const warmLatencies: number[] = [];
    const rankings: unknown[] = [];
    let retrievalBytes = 0;
    const benchmarkProject = projectNames[0];
    if (!benchmarkProject) throw new Error("Indexed benchmark corpus did not expose a CBM project");
    for (const query of QUERIES) {
      const cold = await timedTool(cbm, "search_graph", { project: benchmarkProject, query: query.query, limit: 5 }, cacheDir);
      coldLatencies.push(cold.durationMs);
      retrievalBytes += cold.bytes;
      rankings.push(cold.value);
      for (let repetition = 0; repetition < config.warmRepetitions; repetition += 1) {
        const warm = await timedTool(cbm, "search_graph", { project: benchmarkProject, query: query.query, limit: 5 }, cacheDir);
        warmLatencies.push(warm.durationMs);
        retrievalBytes += warm.bytes;
      }
    }

    const snippetLatencies: number[] = [];
    let snippetBytes = 0;
    let exactSnippets = 0;
    for (const probe of SNIPPETS) {
      const project = projectNames.find((name) => name.toLowerCase().includes(probe.projectHint)) ?? projectNames[0];
      const input: Record<string, unknown> = { qualified_name: probe.qualifiedName };
      if (project) input.project = project;
      const snippet = await timedTool(cbm, "get_code_snippet", input, cacheDir);
      snippetLatencies.push(snippet.durationMs);
      snippetBytes += snippet.bytes;
      if (JSON.stringify(snippet.value).includes(probe.expected)) exactSnippets += 1;
    }

    const indexedFiles = await countIndexedFiles(cbm, cacheDir, benchmarkProject);
    const sourceFiles = inventoryCorpus(corpus.root).length;
    const retrieval = aggregateRetrievalRankings(rankings, QUERIES.map((query) => query.expected));
    const semantic = await measureSemanticRetrieval(cbm, cacheDir, benchmarkProject, config.mode);
    return {
      schemaVersion: 1,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      runtime: { version, mode: config.mode },
      index: indexMetrics(indexResult, indexDurationMs, directoryBytes(cacheDir)),
      coverage: { sourceFiles, indexedFiles, ratio: sourceFiles === 0 ? 1 : round(indexedFiles / sourceFiles, 4) },
      retrieval: { ...retrieval, coldLatency: summarizeDurations(coldLatencies), warmLatency: summarizeDurations(warmLatencies), responseBytes: retrievalBytes },
      semantic,
      snippets: { attempted: SNIPPETS.length, exact: exactSnippets, responseBytes: snippetBytes, latency: summarizeDurations(snippetLatencies) },
      deterministicSet: { queryCount: QUERIES.length, snippetCount: SNIPPETS.length, warmRepetitions: config.warmRepetitions },
      ...(config.keepWorkdir ? { workdir: runRoot } : {})
    };
  } finally {
    await cbm.close();
    if (!config.keepWorkdir) fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

async function measureSemanticRetrieval(
  cbm: CbmService,
  cacheDir: string,
  project: string,
  mode: CbmIndexMode
): Promise<CbmBenchmarkReport["semantic"]> {
  if (mode === "fast") return { available: false, reason: "fast mode intentionally disables semantic retrieval" };
  const rankings: unknown[] = [];
  const latencies: number[] = [];
  let responseBytes = 0;
  try {
    for (const query of QUERIES) {
      const response = await timedTool(cbm, "search_graph", { project, semantic_query: [query.query], limit: 5 }, cacheDir);
      rankings.push(response.value);
      latencies.push(response.durationMs);
      responseBytes += response.bytes;
    }
    return {
      available: true,
      ...aggregateRetrievalRankings(rankings, QUERIES.map((query) => query.expected)),
      latency: summarizeDurations(latencies),
      responseBytes
    };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : "semantic retrieval failed" };
  }
}

export async function writeCbmBenchmarkReport(report: CbmBenchmarkReport, outputPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(temporary, outputPath);
}

function indexMetrics(result: CbmIndexRepositoryResult, durationMs: number, artifactBytes: number): CbmBenchmarkReport["index"] {
  return { durationMs, artifactBytes, status: result.status, quality: result.quality, nodes: result.nodes ?? null,
    edges: result.edges ?? null, skipped: result.skippedCount };
}

async function timedTool(cbm: CbmService, tool: string, input: Record<string, unknown>, cacheDir: string) {
  const started = performance.now();
  const value = await cbm.tool<unknown>(tool, input, cacheDir, 60_000);
  return { value, durationMs: performance.now() - started, bytes: Buffer.byteLength(JSON.stringify(value), "utf8") };
}

async function countIndexedFiles(cbm: CbmService, cacheDir: string, project: string): Promise<number> {
  const response = await cbm.tool<unknown>("search_graph", {
    project,
    label: "File",
    limit: 250
  }, cacheDir, 60_000);
  const paths = new Set<string>();
  collectPathValues(response, paths);
  return paths.size > 0 ? paths.size : rankedItems(response).length;
}

function collectPathValues(value: unknown, paths: Set<string>): void {
  if (Array.isArray(value)) { value.forEach((entry) => collectPathValues(entry, paths)); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "path" || key === "file_path") && typeof entry === "string") paths.add(entry.replaceAll("\\", "/"));
    else collectPathValues(entry, paths);
  }
}

function rankedItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["semantic_results", "results", "items", "nodes", "matches"]) {
    const candidate = (value as Record<string, unknown>)[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function directoryBytes(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target); else if (entry.isFile()) bytes += fs.statSync(target).size;
    }
  }
  return bytes;
}

function percentileNearestRank(sorted: readonly number[], percentile: number): number {
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? 0;
}
function round(value: number, decimals = 2): number { const scale = 10 ** decimals; return Math.round(value * scale) / scale }
function isIndexMode(value: string): value is CbmIndexMode { return value === "fast" || value === "moderate" || value === "full" }
