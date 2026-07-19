import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotObservability } from "../src/services/snapshotService.js";

test("snapshot observability summarizes engine, mode, coverage, and skip reasons", () => {
  const summary = snapshotObservability(JSON.stringify({
    quality: "partial",
    repositories: [
      {
        sourceIntegrity: { fileCount: 40 },
        cbmIndex: {
          engineVersion: "0.9.0",
          mode: "fast",
          skippedCount: 2,
          skipped: {
            files: [
              { path: "src/a.ts", phase: "parse", reason: "syntax" },
              { path: "src/b.ts", phase: "parse", reason: "syntax" }
            ]
          },
          excluded: { count: 3 }
        }
      },
      {
        sourceIntegrity: { fileCount: 10 },
        cbmIndex: {
          engineVersion: "0.9.0",
          mode: "fast",
          skippedCount: 0
        }
      }
    ]
  }));

  assert.deepEqual(summary, {
    quality: "partial",
    engineVersions: ["0.9.0"],
    indexModes: ["fast"],
    sourceFileCount: 50,
    skippedCount: 2,
    excludedDirectoryCount: 3,
    coveragePercent: 96,
    skipReasons: [{ reason: "syntax", count: 2 }]
  });
});

test("snapshot observability fails closed for malformed legacy manifests", () => {
  assert.deepEqual(snapshotObservability("not-json"), {
    quality: "unknown",
    engineVersions: [],
    indexModes: [],
    sourceFileCount: 0,
    skippedCount: 0,
    excludedDirectoryCount: 0,
    coveragePercent: null,
    skipReasons: []
  });
});
