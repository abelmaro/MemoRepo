import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseCbmBenchmarkArguments, runCbmBenchmark, writeCbmBenchmarkReport, type CbmBenchmarkReport } from "./cbmBenchmark.js";

const output = path.resolve(process.argv[2] ?? path.join(process.env.TMPDIR ?? "/tmp", "memorepo-cbm-matrix.json"));
const repetitions = Number(process.argv[3] ?? 3);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error("Matrix repetitions must be between 1 and 10");
const reports: CbmBenchmarkReport[] = [];
for (const mode of ["fast", "moderate", "full"] as const) {
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    process.stdout.write(`Running ${mode} repetition ${repetition}/${repetitions}\n`);
    reports.push(await runCbmBenchmark(parseCbmBenchmarkArguments(["--mode", mode, "--warm-repetitions", "5"])));
  }
}
const aggregate = evaluateMatrix(reports, repetitions);
await fs.promises.mkdir(path.dirname(output), { recursive: true });
await fs.promises.writeFile(output, `${JSON.stringify(aggregate, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`Matrix complete: ${output}\nSemantic decision: ${aggregate.semanticDecision.enable ? "enable" : "keep disabled"}\n`);

export function evaluateMatrix(reports: CbmBenchmarkReport[], expectedRepetitions: number) {
  const byMode = Object.fromEntries(["fast", "moderate", "full"].map((mode) => {
    const values = reports.filter((report) => report.runtime.mode === mode);
    if (values.length !== expectedRepetitions) throw new Error(`${mode} requires ${expectedRepetitions} reports`);
    return [mode, {
      repetitions: values.length,
      indexMedianMs: median(values.map((report) => report.index.durationMs)),
      artifactMedianBytes: median(values.map((report) => report.index.artifactBytes)),
      coverageMin: Math.min(...values.map((report) => report.coverage.ratio)),
      lexicalHitAt5: ratio(values, (report) => report.retrieval.hitAt5, (report) => report.retrieval.queries),
      snippetsExact: ratio(values, (report) => report.snippets.exact, (report) => report.snippets.attempted),
      semanticHitAt5: semanticRatio(values),
      semanticP95Ms: Math.max(...values.map((report) => report.semantic.available ? report.semantic.latency.p95Ms : Number.POSITIVE_INFINITY))
    }];
  })) as Record<"fast" | "moderate" | "full", ModeAggregate>;
  const candidates = (["moderate", "full"] as const).map((mode) => {
    const value = byMode[mode];
    const improvement = value.semanticHitAt5 === null ? null : value.semanticHitAt5 - byMode.fast.lexicalHitAt5;
    const gates = {
      quality: value.semanticHitAt5 !== null && (value.semanticHitAt5 >= 0.85 || (improvement ?? 0) >= 0.15),
      indexTime: value.indexMedianMs <= byMode.fast.indexMedianMs * 3,
      artifactSize: value.artifactMedianBytes <= byMode.fast.artifactMedianBytes * 4,
      queryLatency: Number.isFinite(value.semanticP95Ms) && value.semanticP95Ms <= 500,
      noLexicalRegression: value.lexicalHitAt5 >= 0.95,
      snippets: value.snippetsExact === 1
    };
    return { mode, improvement, gates, passes: Object.values(gates).every(Boolean) };
  });
  const winner = candidates.find((candidate) => candidate.passes);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    modes: byMode,
    semanticDecision: { enable: Boolean(winner), mode: winner?.mode ?? null, candidates },
    reports
  };
}

interface ModeAggregate {
  repetitions: number; indexMedianMs: number; artifactMedianBytes: number; coverageMin: number;
  lexicalHitAt5: number; snippetsExact: number; semanticHitAt5: number | null; semanticP95Ms: number;
}
function median(values: number[]): number { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0 }
function ratio(values: CbmBenchmarkReport[], numerator: (value: CbmBenchmarkReport) => number,
  denominator: (value: CbmBenchmarkReport) => number): number {
  return values.reduce((sum, value) => sum + numerator(value), 0) / values.reduce((sum, value) => sum + denominator(value), 0);
}
function semanticRatio(values: CbmBenchmarkReport[]): number | null {
  const available = values.filter((value) => value.semantic.available);
  return available.length === values.length ? ratio(available, (value) => value.semantic.available ? value.semantic.hitAt5 : 0,
    (value) => value.semantic.available ? value.semantic.queries : 0) : null;
}
