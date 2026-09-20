import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { CbmService, createCbmEnvironment } from "../src/services/cbmService.js";
import { runProcess } from "../src/services/process.js";
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

test("pinned CBM v0.11 contract discovers every page and executes every gateway native tool", {
  skip: process.env.MEMOREPO_RUN_CBM_CONTRACT !== "1"
}, async (context) => {
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
    assert.match(await cbm.version(), /\b0\.11\.0\b/u);
    const indexed = await cbm.indexRepository(corpus.root, cacheDir, "fast");
    assert.equal(indexed.quality, "clean");
    assert.equal(indexed.indexStatus?.quality, "complete");
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

    if (process.platform === "win32") {
      const started = Date.now();
      const shell = await runProcess({ command: "powershell.exe", args: ["-Command", "Write-Output 'CBM shell ready'"],
        env: createCbmEnvironment(cacheDir), inheritEnv: false, timeoutMs: 60_000 });
      context.diagnostic(`Native text-search shell: exit=${shell.exitCode}, duration=${Date.now() - started}ms`);
      assert.equal(shell.exitCode, 0, shell.stderr);
    }

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
      let result: unknown;
      try {
        result = await cbm.tool<unknown>(tool, input, cacheDir, 60_000);
      } catch (error) {
        if (process.platform === "win32" && tool === "search_code") {
          const direct = await runProcess({ command: "codebase-memory-mcp", args: ["cli", "--quiet", "--json", tool],
            stdin: JSON.stringify({ ...input, format: "json" }), env: createCbmEnvironment(cacheDir), inheritEnv: false, timeoutMs: 60_000 });
          context.diagnostic(`Native CLI text-search comparison: ${direct.exitCode}: ${direct.stdout} ${direct.stderr}`);
        }
        throw error;
      }
      assert.notEqual(result, undefined, `${tool} returned undefined`);
    }

    const graph = await cbm.tool<{ results: Array<{ qualified_name: string; file_path: string }> }>(
      "search_graph", { project, query: "validateOrder", limit: 5 }, cacheDir, 60_000);
    assert.ok(graph.results.some((row) => row.qualified_name.endsWith(".validateOrder") && row.file_path.endsWith("domain.ts")));
    const trace = await cbm.tool<{ callers: unknown[] }>("trace_path",
      { project, function_name: "validateOrder", direction: "both" }, cacheDir, 60_000);
    assert.ok(trace.callers.length > 0);

    const second = createCbmBenchmarkCorpus(root);
    const secondSource = path.join(second.root, "alpha", "src", "domain.ts");
    fs.writeFileSync(secondSource, fs.readFileSync(secondSource, "utf8").replace("order.total < 0", "order.total < -100"));
    initializeRepository(second.root);
    const secondCache = path.join(managedHome, "second-index");
    const rebuilding = cbm.indexRepository(second.root, secondCache, "fast");
    const snippetInput = { project, qualified_name: "validateOrder" };
    const firstWhileBuilding = await cbm.tool<{ source: string }>("get_code_snippet", snippetInput, cacheDir, 60_000);
    assert.match(firstWhileBuilding.source, /order.total < 0/u);
    const secondIndexed = await rebuilding;
    assert.equal(secondIndexed.indexStatus?.quality, "complete");
    const secondProject = (await cbm.listProjects(secondCache)).projects?.[0]?.name;
    assert.ok(secondProject);
    const [firstSnippet, secondSnippet] = await Promise.all([
      cbm.tool<{ source: string }>("get_code_snippet", snippetInput, cacheDir, 60_000),
      cbm.tool<{ source: string }>("get_code_snippet", { ...snippetInput, project: secondProject }, secondCache, 60_000)
    ]);
    assert.match(firstSnippet.source, /order.total < 0/u);
    assert.match(secondSnippet.source, /order.total < -100/u);
    await cbm.closeSession(secondCache);
    assert.match((await cbm.tool<{ source: string }>("get_code_snippet", snippetInput, cacheDir, 60_000)).source, /order.total < 0/u);
    assert.match((await cbm.tool<{ source: string }>("get_code_snippet", { ...snippetInput, project: secondProject }, secondCache, 60_000)).source, /order.total < -100/u);
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
