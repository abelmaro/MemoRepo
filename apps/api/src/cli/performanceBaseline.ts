import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { BaselineInputError, parseBaselineArguments, runPerformanceBaseline, writeBaselineReport } from "../performanceBaseline.js";

loadNearestEnvironmentFile();

try {
  const config = parseBaselineArguments(process.argv.slice(2));
  process.stdout.write("Running the performance baseline against the local API.\n");
  const report = await runPerformanceBaseline(config);
  await writeBaselineReport(report, config.outputPath);
  process.stdout.write(`Performance baseline completed. Report: ${config.outputPath}\n`);
  process.stdout.write(
    `Ingestion ${report.ingestion.durationMs} ms; snapshots ${report.ingestion.snapshotJobCount}; ` +
      `agent turns ${report.agents.totals.completed}/${report.scenario.agentConcurrencyRequested}; ` +
      `HTTP requests ${report.http.requestCount}.\n`
  );
} catch (error) {
  const message = error instanceof BaselineInputError ? error.message : "The performance baseline did not complete";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function loadNearestEnvironmentFile(): void {
  let current = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(current, ".env");
    if (fs.existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
