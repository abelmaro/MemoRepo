import process from "node:process";
import { CbmBenchmarkInputError, parseCbmBenchmarkArguments, runCbmBenchmark, writeCbmBenchmarkReport } from "./cbmBenchmark.js";

try {
  const config = parseCbmBenchmarkArguments(process.argv.slice(2));
  process.stdout.write(`Running deterministic CBM benchmark in ${config.mode} mode.\n`);
  const report = await runCbmBenchmark(config);
  await writeCbmBenchmarkReport(report, config.outputPath);
  process.stdout.write(`CBM benchmark completed. Report: ${config.outputPath}\n`);
  process.stdout.write(`Index ${report.index.durationMs} ms; coverage ${report.coverage.indexedFiles}/${report.coverage.sourceFiles}; `
    + `retrieval hit@1 ${report.retrieval.hitAt1}/${report.retrieval.queries}; hit@5 ${report.retrieval.hitAt5}/${report.retrieval.queries}.\n`);
} catch (error) {
  const message = error instanceof CbmBenchmarkInputError ? error.message : error instanceof Error ? error.message : "CBM benchmark failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
