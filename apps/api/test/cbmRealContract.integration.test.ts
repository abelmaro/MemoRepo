import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { CbmService } from "../src/services/cbmService.js";
import { createCbmBenchmarkCorpus } from "./cbmBenchmarkCorpus.js";

const EXPECTED_GATEWAY_NATIVE_TOOLS = [
  "detect_changes",
  "get_architecture",
  "get_code_snippet",
  "get_graph_schema",
  "index_status",
  "list_projects",
  "query_graph",
  "search_code",
  "search_graph",
  "trace_path"
] as const;

test("pinned CBM v0.9 contract discovers every page and executes every gateway native tool", {
  skip: process.env.MEMOREPO_RUN_CBM_CONTRACT !== "1"
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-cbm-contract-"));
  const corpus = createCbmBenchmarkCorpus(root);
  const managedHome = path.join(root, "managed");
  const cacheDir = path.join(managedHome, "index");
  initializeRepository(corpus.root);

  const previousHome = process.env.MEMOREPO_HOME;
  process.env.MEMOREPO_HOME = managedHome;
  const config = loadConfig();
  if (previousHome === undefined) delete process.env.MEMOREPO_HOME; else process.env.MEMOREPO_HOME = previousHome;
  const cbm = new CbmService(config);

  try {
    assert.match(await cbm.version(), /\b0\.9\.0\b/u);
    await cbm.indexRepository(corpus.root, cacheDir, "fast");
    const descriptors = await cbm.listToolDescriptors(cacheDir);
    const names = descriptors.map((descriptor) => descriptor.name);

    assert.ok(names.length > 8, `Expected a paginated tool catalog, received ${names.length} tools`);
    assert.equal(new Set(names).size, names.length, "Tool descriptors must be deduplicated");
    for (const expected of EXPECTED_GATEWAY_NATIVE_TOOLS) {
      assert.ok(names.includes(expected), `Pinned CBM catalog is missing ${expected}`);
    }

    const projects = await cbm.listProjects(cacheDir);
    const project = projects.projects?.[0]?.name;
    assert.ok(project, "Indexed corpus must expose one project");

    const calls: Array<[string, Record<string, unknown>]> = [
      ["list_projects", {}],
      ["index_status", { project }],
      ["get_architecture", { project, aspects: ["overview"] }],
      ["get_graph_schema", { project }],
      ["search_graph", { project, query: "validateOrder", limit: 5 }],
      ["search_code", { project, pattern: "validateOrder", limit: 5 }],
      ["trace_path", { project, function_name: "validateOrder", direction: "both", depth: 1 }],
      ["get_code_snippet", { project, qualified_name: "validateOrder" }],
      ["detect_changes", { project }],
      ["query_graph", { project, query: "MATCH (n) RETURN n LIMIT 1", max_rows: 1 }]
    ];

    for (const [tool, input] of calls) {
      const result = await cbm.tool<unknown>(tool, input, cacheDir, 60_000);
      assert.notEqual(result, undefined, `${tool} returned undefined`);
    }
  } finally {
    await cbm.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function initializeRepository(repository: string): void {
  execFileSync("git", ["init", "--initial-branch=main", repository], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "config", "user.email", "tests@example.invalid"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "MemoRepo Tests"]);
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "commit", "-m", "benchmark fixture"], { stdio: "ignore" });
}
