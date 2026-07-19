import fs from "node:fs";
import path from "node:path";
import { runIngestionBenchmark } from "./ingestionBenchmark.js";

const report = await runIngestionBenchmark();
const outputPath = process.argv[2]?.trim();
if (outputPath) {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.gates.passed) process.exitCode = 1;
