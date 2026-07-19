import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/db/schema.js";
import { migrate } from "../src/db/migrate.js";
import { JobRunner } from "../src/services/jobRunner.js";
import { OperationsService } from "../src/services/operationsService.js";

export interface IngestionBenchmarkSample {
  flow: "legacy" | "snapshot-only-batch";
  repositories: number;
  jobCount: number;
  primaryIndexCount: number;
  snapshotRebuildCount: number;
  simulatedElapsedMs: number;
  realElapsedMs: number;
}

export interface IngestionBenchmarkReport {
  generatedAt: string;
  environment: { jobConcurrency: number; cloneMs: number; checkoutMs: number; primaryIndexMs: number; repetitions: number };
  comparisons: Array<{
    repositories: number;
    legacy: IngestionBenchmarkSample;
    batch: IngestionBenchmarkSample;
    ingestionReduction: number;
  }>;
  gates: { exactlyNPrimaryIndexes: boolean; exactlyOneRebuild: boolean; ingestionReductionAtLeast50Percent: boolean; passed: boolean };
}

export async function runIngestionBenchmark(options: {
  repositoryCounts?: number[]; repetitions?: number; jobConcurrency?: number;
  cloneMs?: number; checkoutMs?: number; primaryIndexMs?: number;
} = {}): Promise<IngestionBenchmarkReport> {
  const repositoryCounts = options.repositoryCounts ?? [1, 3, 5];
  const repetitions = options.repetitions ?? 3;
  const environment = {
    jobConcurrency: options.jobConcurrency ?? 2,
    cloneMs: options.cloneMs ?? 4,
    checkoutMs: options.checkoutMs ?? 3,
    primaryIndexMs: options.primaryIndexMs ?? 5,
    repetitions
  };
  const comparisons: IngestionBenchmarkReport["comparisons"] = [];
  for (const repositories of repositoryCounts) {
    const legacy = median(await repeat(repetitions, () => measure("legacy", repositories, environment)));
    const batch = median(await repeat(repetitions, () => measure("snapshot-only-batch", repositories, environment)));
    comparisons.push({ repositories, legacy, batch, ingestionReduction: (legacy.primaryIndexCount - batch.primaryIndexCount) / legacy.primaryIndexCount });
  }
  const exactlyNPrimaryIndexes = comparisons.every((value) => value.batch.primaryIndexCount === value.repositories);
  const exactlyOneRebuild = comparisons.every((value) => value.legacy.snapshotRebuildCount === 1 && value.batch.snapshotRebuildCount === 1);
  const ingestionReductionAtLeast50Percent = comparisons.every((value) => value.ingestionReduction >= 0.5);
  return {
    generatedAt: new Date().toISOString(), environment, comparisons,
    gates: {
      exactlyNPrimaryIndexes, exactlyOneRebuild, ingestionReductionAtLeast50Percent,
      passed: exactlyNPrimaryIndexes && exactlyOneRebuild && ingestionReductionAtLeast50Percent
    }
  };
}

async function measure(
  flow: IngestionBenchmarkSample["flow"],
  repositoryCount: number,
  environment: IngestionBenchmarkReport["environment"]
): Promise<IngestionBenchmarkSample> {
  const sqlite = new Database(":memory:");
  migrate(sqlite);
  const database = { sqlite, db: drizzle(sqlite, { schema }) };
  const jobs = new JobRunner(database, environment.jobConcurrency);
  const repositories: Array<Record<string, unknown>> = [];
  let sequence = 0;
  let primaryIndexCount = 0;
  let snapshotRebuildCount = 0;
  const spaces = {
    assertSpaceAcceptsWork: (_spaceId: string) => undefined,
    addRepositoryToSpace: (spaceId: string, repositoryId: string) => {
      const value = { id: `spr_${++sequence}`, space_id: spaceId, github_repository_id: repositoryId, selected_commit: null };
      repositories.push(value);
      return value;
    },
    listSpaceRepositories: (spaceId: string) => repositories.filter((value) => value.space_id === spaceId)
  };
  const operations = new OperationsService(
    database, { snapshotOnlyIndexing: flow === "snapshot-only-batch", cbmIndexMode: "fast" } as never,
    spaces as never, {} as never, {} as never, {} as never, {} as never, jobs
  );
  jobs.register("clone_space_repository", async () => delay(environment.cloneMs));
  jobs.register("checkout_space_repository", async () => delay(environment.checkoutMs));
  jobs.register("index_space_repository", async () => { primaryIndexCount += 1; await delay(environment.primaryIndexMs); });
  jobs.register("rebuild_space_snapshot", async () => {
    snapshotRebuildCount += 1;
    for (let index = 0; index < repositoryCount; index += 1) {
      primaryIndexCount += 1;
      await delay(environment.primaryIndexMs);
    }
  });
  try {
    const ids = Array.from({ length: repositoryCount }, (_, index) => `repo_${index + 1}`);
    const startedAt = performance.now();
    if (flow === "legacy") for (const id of ids) operations.enqueueAddRepository("spc_benchmark", id);
    else operations.enqueueAddRepositories("spc_benchmark", ids);
    await waitForTerminalJobs(sqlite);
    const realElapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const jobCount = (sqlite.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count;
    const simulatedElapsedMs = environment.cloneMs + environment.checkoutMs +
      (flow === "legacy" ? environment.primaryIndexMs : 0) + repositoryCount * environment.primaryIndexMs;
    return { flow, repositories: repositoryCount, jobCount, primaryIndexCount, snapshotRebuildCount, simulatedElapsedMs, realElapsedMs };
  } finally {
    jobs.stop();
    sqlite.close();
  }
}

async function waitForTerminalJobs(sqlite: Database.Database): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = sqlite.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('succeeded', 'failed', 'skipped', 'cancelled') THEN 1 ELSE 0 END) AS terminal FROM jobs"
    ).get() as { total: number; terminal: number };
    if (state.total > 0 && state.total === state.terminal) return;
    await delay(1);
  }
  throw new Error("Timed out waiting for ingestion benchmark jobs");
}

async function repeat<T>(count: number, operation: () => Promise<T>): Promise<T[]> {
  const values: T[] = [];
  for (let index = 0; index < count; index += 1) values.push(await operation());
  return values;
}

function median(samples: IngestionBenchmarkSample[]): IngestionBenchmarkSample {
  return [...samples].sort((left, right) => left.realElapsedMs - right.realElapsedMs)[Math.floor(samples.length / 2)]!;
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
