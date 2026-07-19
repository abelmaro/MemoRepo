import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AppConfig } from "../src/config.js";
import {
  CbmService,
  normalizeCbmIndexRepositoryResult,
  normalizeCbmIndexStatusResult
} from "../src/services/cbmService.js";
import type { ProcessResult, RunProcessOptions } from "../src/services/process.js";

test("CBM index results normalize the complete v0.9 quality metadata", () => {
  assert.deepEqual(
    normalizeCbmIndexRepositoryResult({
      project: "sample-project",
      status: "indexed",
      skipped_count: 2,
      skipped: {
        files: [{ path: "src/broken.ts", reason: "parser failed", phase: "parse" }],
        count: 2,
        truncated: true
      },
      excluded: { dirs: ["vendor"], count: 3, truncated: true },
      nodes: 101,
      edges: 202,
      expected_nodes: 105,
      expected_edges: 210,
      hint: "retry",
      adr_present: false,
      adr_hint: "create one",
      artifact_present: true,
      artifact_hint: "artifact ready",
      logfile: "logs/sample.log",
      outcome: "clean",
      repo_path: "/source/sample"
    }),
    {
      project: "sample-project",
      status: "indexed",
      reportedStatus: "indexed",
      quality: "partial",
      skippedCount: 2,
      skipped: {
        files: [{ path: "src/broken.ts", reason: "parser failed", phase: "parse" }],
        count: 2,
        truncated: true
      },
      excluded: { dirs: ["vendor"], count: 3, truncated: true },
      nodes: 101,
      edges: 202,
      expectedNodes: 105,
      expectedEdges: 210,
      hint: "retry",
      adrPresent: false,
      adrHint: "create one",
      artifactPresent: true,
      artifactHint: "artifact ready",
      logfile: "logs/sample.log",
      outcome: "clean",
      repoPath: "/source/sample"
    }
  );
});

test("CBM index results reconcile legacy skipped arrays and counts conservatively", () => {
  const result = normalizeCbmIndexRepositoryResult({
    status: "INDEXED",
    skippedCount: 3,
    skippedFiles: [
      { path: "one.ts", reason: "read failed", phase: "discover" },
      { path: "two.ts", reason: "parse failed", phase: "parse" }
    ]
  });

  assert.equal(result.status, "indexed");
  assert.equal(result.quality, "partial");
  assert.equal(result.skippedCount, 3);
  assert.deepEqual(result.skipped, {
    files: [
      { path: "one.ts", reason: "read failed", phase: "discover" },
      { path: "two.ts", reason: "parse failed", phase: "parse" }
    ],
    count: 3,
    truncated: true
  });
});

test("CBM index results fail closed for degraded and unknown statuses", () => {
  assert.deepEqual(
    normalizeCbmIndexRepositoryResult({ status: "degraded", skipped_count: 0 }),
    {
      status: "degraded",
      reportedStatus: "degraded",
      quality: "degraded",
      skippedCount: 0
    }
  );
  assert.deepEqual(
    normalizeCbmIndexRepositoryResult({ status: "future-partial", skipped_count: 0 }),
    {
      status: "unknown",
      reportedStatus: "future-partial",
      quality: "failed",
      skippedCount: 0
    }
  );
});

for (const successfulStatus of ["indexed", "complete", "completed", "success", "ok"] as const) {
  test(`CBM index status ${successfulStatus} normalizes to a clean successful result`, () => {
    assert.deepEqual(
      normalizeCbmIndexRepositoryResult({ status: successfulStatus, skipped_count: 0 }),
      {
        status: "indexed",
        reportedStatus: successfulStatus,
        quality: "clean",
        skippedCount: 0
      }
    );
  });
}

test("CBM index status skipped remains explicitly non-activatable", () => {
  assert.deepEqual(
    normalizeCbmIndexRepositoryResult({ status: "skipped", skipped_count: 0 }),
    {
      status: "skipped",
      reportedStatus: "skipped",
      quality: "failed",
      skippedCount: 0
    }
  );
});

test("CBM index_status normalizes the complete v0.9 ready response", () => {
  assert.deepEqual(
    normalizeCbmIndexStatusResult({
      project: "sample-project",
      nodes: 2249,
      edges: 6363,
      status: "ready",
      root_path: "G:/source/sample",
      git: {
        is_git: true,
        is_worktree: false,
        is_detached: false,
        root_exists: true,
        worktree_root: "G:/source/sample",
        git_dir: ".git",
        git_common_dir: ".git",
        canonical_root: "G:/source/sample",
        branch: "main",
        branch_slug: "main",
        head_sha: "abc123",
        base_sha: ""
      }
    }),
    {
      project: "sample-project",
      status: "ready",
      reportedStatus: "ready",
      quality: "complete",
      nodes: 2249,
      edges: 6363,
      rootPath: "G:/source/sample",
      git: {
        isGit: true,
        isWorktree: false,
        isDetached: false,
        rootExists: true,
        worktreeRoot: "G:/source/sample",
        gitDir: ".git",
        gitCommonDir: ".git",
        canonicalRoot: "G:/source/sample",
        branch: "main",
        branchSlug: "main",
        headSha: "abc123"
      }
    }
  );
});

for (const successfulStatus of ["ready", "indexed", "complete", "completed", "success", "ok"] as const) {
  test(`CBM index_status ${successfulStatus} verifies as complete`, () => {
    const result = normalizeCbmIndexStatusResult({
      project: "sample-project",
      status: successfulStatus,
      nodes: 1,
      edges: 0
    });
    assert.equal(result.status, "ready");
    assert.equal(result.quality, "complete");
  });
}

test("CBM index_status fails closed for missing and unhealthy statuses", () => {
  assert.equal(normalizeCbmIndexStatusResult({ status: "future-state" }).quality, "unknown");
  assert.equal(normalizeCbmIndexStatusResult({ status: "error" }).quality, "degraded");
  assert.equal(normalizeCbmIndexStatusResult({ status: "degraded" }).quality, "degraded");
});

test("CBM verifies index_status after both primary indexing and cross-repository linking", async () => {
  const memorepoHome = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-cbm-status-"));
  const repoPath = path.join(memorepoHome, "sample");
  const cacheDir = path.join(memorepoHome, "indexes", "snapshot");
  fs.mkdirSync(repoPath, { recursive: true });
  const cliCalls: string[] = [];
  const runner = async (options: RunProcessOptions): Promise<ProcessResult> => {
    if (options.args[0] === "config") {
      return processResult("auto_index = false\nauto_watch = false\n");
    }
    const tool = options.args[1]!;
    cliCalls.push(tool);
    if (tool === "index_repository") {
      const input = JSON.parse(options.args[2]!) as { mode?: string };
      return processResult(JSON.stringify({
        project: "sample-project",
        status: input.mode === "cross-repo-intelligence" ? "linked" : "indexed",
        skipped_count: 0,
        nodes: 3,
        edges: 2
      }));
    }
    if (tool === "list_projects") {
      return processResult(JSON.stringify({
        projects: [{ name: "sample-project", root_path: repoPath, nodes: 3, edges: 2 }]
      }));
    }
    if (tool === "index_status") {
      return processResult(JSON.stringify({
        project: "sample-project",
        status: "ready",
        nodes: 3,
        edges: 2,
        git: { root_exists: true }
      }));
    }
    throw new Error(`Unexpected tool ${tool}`);
  };
  const cbm = new CbmService({
    memorepoHome,
    cbmInteractiveConcurrency: 2,
    cbmIndexConcurrency: 1
  } as AppConfig, runner);

  try {
    const indexed = await cbm.indexRepository(repoPath, cacheDir);
    assert.equal(indexed.quality, "clean");
    assert.equal(indexed.indexStatus?.quality, "complete");
    assert.deepEqual(cliCalls, ["index_repository", "list_projects", "index_status"]);

    cliCalls.length = 0;
    const linked = await cbm.buildCrossRepoLinks(repoPath, cacheDir);
    assert.equal(linked.indexStatus.quality, "complete");
    assert.deepEqual(cliCalls, ["index_repository", "list_projects", "index_status"]);
  } finally {
    fs.rmSync(memorepoHome, { recursive: true, force: true });
  }
});

function processResult(stdout: string): ProcessResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false
  };
}
