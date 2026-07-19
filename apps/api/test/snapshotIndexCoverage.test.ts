import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SnapshotManifest, SnapshotManifestRepository } from "../src/services/snapshotService.js";
import {
  snapshotIndexCoverage,
  snapshotIndexCoverageMcpView
} from "../src/services/snapshotIndexCoverage.js";
import {
  createSnapshotSourceIntegrityManifest,
  snapshotSourceIntegrityManifestPath,
  snapshotSourceIntegritySummary,
  writeSnapshotSourceIntegrityManifestAtomic
} from "../src/services/snapshotSourceIntegrity.js";

test("snapshot index coverage is exhaustive when integrity, skips, and exclusions are fully accounted for", async () => {
  const fixture = await coverageFixture({
    "src/main.ts": "export const main = true;\n",
    "src/view.ts": "export const view = true;\n",
    "vendor/runtime.js": "vendor();\n",
    "README": "notes\n"
  });
  try {
    const repository = fixture.repository({
      excluded: { dirs: ["vendor"], count: 1, truncated: false }
    });
    const result = await snapshotIndexCoverage(snapshotManifest("complete", [repository]));

    assert.equal(result.exhaustive, true);
    assert.deepEqual(result.exhaustivenessReasons, []);
    assert.deepEqual(result.totals, {
      extension: "all",
      sourceFiles: 4,
      sourceBytes: result.totals.sourceBytes,
      excludedFiles: 1,
      skippedFiles: 0,
      candidateFiles: 3,
      candidateBytes: result.totals.candidateBytes,
      coverageRatio: 0.75
    });
    assert.deepEqual(
      result.extensions.map((row) => ({
        extension: row.extension,
        sourceFiles: row.sourceFiles,
        excludedFiles: row.excludedFiles,
        candidateFiles: row.candidateFiles
      })),
      [
        { extension: ".js", sourceFiles: 1, excludedFiles: 1, candidateFiles: 0 },
        { extension: ".ts", sourceFiles: 2, excludedFiles: 0, candidateFiles: 2 },
        { extension: "[none]", sourceFiles: 1, excludedFiles: 0, candidateFiles: 1 }
      ]
    );
    assert.equal(result.projects[0]?.integrity.verified, true);
    assert.equal(result.indexedFileMembershipProven, false);
  } finally {
    fixture.cleanup();
  }
});

test("snapshot index coverage reports partial quality and skip distribution by extension and phase", async () => {
  const fixture = await coverageFixture({
    "src/good.ts": "export const good = true;\n",
    "src/broken.ts": "broken();\n"
  });
  try {
    const repository = fixture.repository({
      quality: "partial",
      snapshotQuality: "partial",
      skippedCount: 1,
      skipped: {
        files: [{ path: "src/broken.ts", reason: "parse failed", phase: "parse" }],
        count: 1,
        truncated: false
      }
    });
    const result = await snapshotIndexCoverage(snapshotManifest("partial", [repository]));
    const project = result.projects[0]!;

    assert.equal(result.quality, "partial");
    assert.equal(result.exhaustive, false);
    assert.deepEqual(project.exhaustivenessReasons, ["project_quality_partial", "snapshot_quality_partial"]);
    assert.equal(project.totals.sourceFiles, 2);
    assert.equal(project.totals.skippedFiles, 1);
    assert.equal(project.totals.candidateFiles, 1);
    assert.equal(project.totals.coverageRatio, 0.5);
    assert.deepEqual(project.skips.byExtension, [{ extension: ".ts", count: 1 }]);
    assert.deepEqual(project.skips.byPhase, [{ phase: "parse", count: 1 }]);
    assert.deepEqual(project.skips.samplePaths, ["src/broken.ts"]);
  } finally {
    fixture.cleanup();
  }
});

test("snapshot index coverage fails closed for legacy or subsequently modified sources", async () => {
  const fixture = await coverageFixture({ "src/main.ts": "export const main = true;\n" });
  try {
    const modern = fixture.repository();
    const legacy = { ...modern, sourceIntegrity: undefined };
    const legacyResult = await snapshotIndexCoverage(snapshotManifest("unknown", [legacy]));
    assert.equal(legacyResult.exhaustive, false);
    assert.deepEqual(legacyResult.exhaustivenessReasons, [
      "project_quality_complete",
      "snapshot_quality_unknown",
      "source_integrity_manifest_unavailable"
    ].filter((reason) => reason !== "project_quality_complete"));
    assert.equal(legacyResult.totals.sourceFiles, 0);

    fs.writeFileSync(path.join(fixture.sourcePath, "src", "main.ts"), "export const main = false;\n", "utf8");
    const modified = await snapshotIndexCoverage(snapshotManifest("complete", [modern]));
    assert.equal(modified.exhaustive, false);
    assert.equal(modified.projects[0]?.integrity.verified, false);
    assert.ok(modified.exhaustivenessReasons.includes("root_digest_mismatch"));
  } finally {
    fixture.cleanup();
  }
});

test("snapshot index coverage filters projects and exposes snake_case MCP fields", async () => {
  const fixture = await coverageFixture({ "main.ts": "main();\n" });
  try {
    const repository = fixture.repository();
    const manifest = snapshotManifest("complete", [repository]);
    const result = await snapshotIndexCoverage(manifest, { project: repository.fullName });
    const view = snapshotIndexCoverageMcpView(result);

    assert.equal((view as { coverage_basis?: string }).coverage_basis, "source_inventory_minus_reported_exclusions_and_skips");
    assert.equal((view as { indexed_file_membership_proven?: boolean }).indexed_file_membership_proven, false);
    assert.deepEqual(
      ((view.projects as Array<Record<string, unknown>>)[0]?.integrity as Record<string, unknown>).tree_sha,
      repository.sourceIntegrity?.treeSha
    );
    await assert.rejects(
      () => snapshotIndexCoverage(manifest, { project: "outside/project" }),
      /outside this space snapshot/
    );
  } finally {
    fixture.cleanup();
  }
});

async function coverageFixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-index-coverage-"));
  const sourcePath = path.join(root, "source");
  fs.mkdirSync(sourcePath, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(sourcePath, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  }
  const integrity = await createSnapshotSourceIntegrityManifest(sourcePath, "a".repeat(40));
  await writeSnapshotSourceIntegrityManifestAtomic(snapshotSourceIntegrityManifestPath(sourcePath), integrity);
  return {
    sourcePath,
    repository(overrides: Record<string, unknown> = {}): SnapshotManifestRepository {
      const { snapshotQuality = "complete", ...indexOverrides } = overrides;
      return {
        spaceRepositoryId: "spr_one",
        githubRepositoryId: "ghr_one",
        fullName: "example/source",
        branch: "main",
        commit: "b".repeat(40),
        projectName: "example__source",
        localPath: sourcePath,
        sourceIntegrity: snapshotSourceIntegritySummary(integrity),
        cbmIndex: {
          engineVersion: "codebase-memory-mcp 0.9.0",
          mode: "fast",
          status: "indexed",
          quality: "clean",
          skippedCount: 0,
          snapshotQuality: snapshotQuality as "complete" | "partial" | "degraded" | "unknown",
          statusChecks: {
            afterPrimary: {
              project: "example__source",
              status: "ready",
              quality: "complete",
              nodes: 1,
              edges: 0
            }
          },
          ...indexOverrides
        }
      };
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function snapshotManifest(
  quality: "complete" | "partial" | "degraded" | "unknown",
  repositories: SnapshotManifestRepository[]
): SnapshotManifest {
  return {
    schemaVersion: 2,
    quality,
    snapshotId: "snp_coverage",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    repositories
  };
}
