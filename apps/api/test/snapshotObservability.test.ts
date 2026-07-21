import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { snapshotIndexingDetails, snapshotObservability } from "../src/services/snapshotService.js";

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

test("snapshot indexing details group safe relative paths by repository", () => {
  const managedRoot = path.resolve("managed-home");
  const unsafeAbsolutePath = path.join(managedRoot, "sources", "secret.ts");
  const details = snapshotIndexingDetails(JSON.stringify({
    repositories: [
      {
        fullName: "example/service",
        cbmIndex: {
          skippedCount: 2,
          skipped: {
            files: [
              { path: "src/broken.ts", reason: "syntax", phase: "parse" },
              { path: unsafeAbsolutePath, reason: `failed below ${managedRoot}`, phase: "read" }
            ],
            count: 2,
            truncated: false
          },
          excluded: { dirs: ["vendor", "../outside"], count: 2, truncated: false }
        }
      },
      {
        fullName: "example/clean",
        cbmIndex: { skippedCount: 0 }
      }
    ]
  }), managedRoot);

  assert.deepEqual(details, [{
    repository: "example/service",
    skippedFiles: [{ path: "src/broken.ts", reason: "syntax", phase: "parse" }],
    skippedCount: 2,
    skippedTruncated: true,
    excludedDirectories: ["vendor"],
    excludedDirectoryCount: 2,
    excludedDirectoriesTruncated: true
  }]);
  assert.equal(JSON.stringify(details).includes(managedRoot), false);
});

test("snapshot indexing details fail closed for malformed manifests", () => {
  assert.deepEqual(snapshotIndexingDetails("not-json", path.resolve("managed-home")), []);
});
