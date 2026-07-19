import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { CbmService } from "../src/services/cbmService.js";
import { createCbmBenchmarkCorpus } from "./cbmBenchmarkCorpus.js";

test("CBM query/index stress preserves cache isolation, cancellation recovery, restart recovery, and no child orphans", {
  skip: process.env.MEMOREPO_RUN_CBM_STRESS !== "1",
  timeout: 120_000
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-cbm-stress-"));
  const corpusA = createCbmBenchmarkCorpus(root);
  const corpusB = createCbmBenchmarkCorpus(root);
  const domainB = path.join(corpusB.root, "alpha", "src", "domain.ts");
  fs.writeFileSync(domainB, fs.readFileSync(domainB, "utf8").replace("invalid order", "ISOLATED-B-991"));
  const managedHome = path.join(root, "managed");
  const cacheA = path.join(managedHome, "a");
  const cacheB = path.join(managedHome, "b");
  const previousHome = process.env.MEMOREPO_HOME;
  process.env.MEMOREPO_HOME = managedHome;
  const config = loadConfig();
  if (previousHome === undefined) delete process.env.MEMOREPO_HOME; else process.env.MEMOREPO_HOME = previousHome;
  let cbm = new CbmService(config);
  try {
    await cbm.indexRepository(corpusA.root, cacheA, "fast");
    const projectA = (await cbm.listProjects(cacheA)).projects?.[0]?.name;
    assert.ok(projectA);

    const indexB = cbm.indexRepository(corpusB.root, cacheB, "moderate");
    const concurrentQueries = Promise.all(Array.from({ length: 20 }, () =>
      cbm.tool<unknown>("search_graph", { project: projectA, query: "validateOrder", limit: 5 }, cacheA, 30_000)));
    await Promise.all([indexB, concurrentQueries]);
    const projectB = (await cbm.listProjects(cacheB)).projects?.[0]?.name;
    assert.ok(projectB);

    const aSentinel = await cbm.tool<unknown>("search_code", { project: projectA, pattern: "invalid order", limit: 5 }, cacheA);
    const bSentinel = await cbm.tool<unknown>("search_code", { project: projectB, pattern: "invalid order", limit: 5 }, cacheB);
    assert.ok(resultCount(aSentinel) > 0);
    assert.equal(resultCount(bSentinel), 0);

    const controller = new AbortController();
    controller.abort(new Error("stress cancellation"));
    await assert.rejects(() => cbm.indexRepository(corpusA.root, path.join(managedHome, "cancelled"), "full", undefined, controller.signal),
      /stress cancellation|interrupt|abort|cancel/u);

    await cbm.close();
    assertNoChildProcesses();
    cbm = new CbmService(config);
    const recovered = await cbm.tool<unknown>("search_graph", { project: projectA, query: "validateOrder", limit: 5 }, cacheA, 30_000);
    assert.match(JSON.stringify(recovered), /validateOrder/u);
  } finally {
    await cbm.close();
    assertNoChildProcesses();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function assertNoChildProcesses(): void {
  if (process.platform !== "linux") return;
  const childrenFile = `/proc/${process.pid}/task/${process.pid}/children`;
  if (fs.existsSync(childrenFile)) assert.equal(fs.readFileSync(childrenFile, "utf8").trim(), "");
}

function resultCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const result = value as Record<string, unknown>;
  if (typeof result.total_results === "number") return result.total_results;
  return Array.isArray(result.results) ? result.results.length : 0;
}
