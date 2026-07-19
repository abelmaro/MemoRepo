import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSnapshotSourceIntegrityManifest,
  readSnapshotSourceIntegrityManifest,
  snapshotSourceIntegrityManifestPath,
  verifySnapshotSourceIntegrity,
  writeSnapshotSourceIntegrityManifestAtomic
} from "../src/services/snapshotSourceIntegrity.js";

const TREE_SHA = "a".repeat(40);

test("source integrity records deterministic hashes for nested Unicode paths outside the indexed tree", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-source-integrity-unicode-"));
  const source = path.join(root, "captured-source");
  try {
    fs.mkdirSync(path.join(source, "código", "日本語"), { recursive: true });
    fs.writeFileSync(path.join(source, "README.md"), "hello\n", "utf8");
    fs.writeFileSync(path.join(source, "código", "árbol.ts"), "export const árbol = true;\n", "utf8");
    fs.writeFileSync(path.join(source, "código", "日本語", "値.ts"), "export const value = 1;\n", "utf8");

    const manifest = await createSnapshotSourceIntegrityManifest(source, TREE_SHA);
    const manifestPath = snapshotSourceIntegrityManifestPath(source);
    await writeSnapshotSourceIntegrityManifestAtomic(manifestPath, manifest);

    assert.equal(path.dirname(manifestPath), path.dirname(source));
    assert.equal(path.resolve(manifestPath).startsWith(`${path.resolve(source)}${path.sep}`), false);
    assert.deepEqual(manifest.files.map((file) => file.path), [
      "README.md",
      "código/árbol.ts",
      "código/日本語/値.ts"
    ]);
    assert.equal(manifest.fileCount, 3);
    assert.match(manifest.rootDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(await readSnapshotSourceIntegrityManifest(manifestPath), manifest);
    assert.deepEqual(await verifySnapshotSourceIntegrity(source, manifestPath, TREE_SHA), {
      valid: true,
      manifest
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source reuse detects byte changes even when size and mtime are preserved", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-source-integrity-bytes-"));
  const source = path.join(root, "captured-source");
  const file = path.join(source, "same-metadata.txt");
  try {
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(file, "alpha\n", "utf8");
    const manifest = await createSnapshotSourceIntegrityManifest(source, TREE_SHA);
    const manifestPath = snapshotSourceIntegrityManifestPath(source);
    await writeSnapshotSourceIntegrityManifestAtomic(manifestPath, manifest);
    const original = fs.statSync(file);

    fs.writeFileSync(file, "omega\n", "utf8");
    fs.utimesSync(file, original.atime, original.mtime);
    assert.equal(fs.statSync(file).size, original.size);

    const verification = await verifySnapshotSourceIntegrity(source, manifestPath, TREE_SHA);
    assert.equal(verification.valid, false);
    assert.equal(verification.reason, "root_digest_mismatch");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("source integrity rejects symlinks instead of hashing their targets", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-source-integrity-link-"));
  const source = path.join(root, "captured-source");
  const external = path.join(root, "external");
  try {
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, "secret.txt"), "outside\n", "utf8");
    try {
      fs.symlinkSync(external, path.join(source, "unsafe"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("creating a junction is not permitted on this Windows host");
        return;
      }
      throw error;
    }

    await assert.rejects(
      () => createSnapshotSourceIntegrityManifest(source, TREE_SHA),
      /rejects symbolic links/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancelled atomic manifest writes leave the previous manifest intact and no temporary file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-source-integrity-cancel-"));
  const source = path.join(root, "captured-source");
  try {
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "one.txt"), "one\n", "utf8");
    const manifest = await createSnapshotSourceIntegrityManifest(source, TREE_SHA);
    const manifestPath = snapshotSourceIntegrityManifestPath(source);
    await writeSnapshotSourceIntegrityManifestAtomic(manifestPath, manifest);
    const before = fs.readFileSync(manifestPath, "utf8");
    const controller = new AbortController();
    controller.abort(new Error("cancel integrity write"));

    await assert.rejects(
      () => writeSnapshotSourceIntegrityManifestAtomic(manifestPath, manifest, controller.signal),
      (error: unknown) => error instanceof Error && error.name === "AbortError"
    );
    assert.equal(fs.readFileSync(manifestPath, "utf8"), before);
    assert.deepEqual(
      fs.readdirSync(root).filter((entry) => entry.endsWith(".tmp")),
      []
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tampered manifests and tree SHA mismatches fail closed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-source-integrity-tamper-"));
  const source = path.join(root, "captured-source");
  try {
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "one.txt"), "one\n", "utf8");
    const manifest = await createSnapshotSourceIntegrityManifest(source, TREE_SHA);
    const manifestPath = snapshotSourceIntegrityManifestPath(source);
    await writeSnapshotSourceIntegrityManifestAtomic(manifestPath, manifest);

    assert.deepEqual(await verifySnapshotSourceIntegrity(source, manifestPath, "b".repeat(40)), {
      valid: false,
      reason: "tree_sha_mismatch"
    });
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, rootDigest: "0".repeat(64) }), "utf8");
    assert.deepEqual(await verifySnapshotSourceIntegrity(source, manifestPath, TREE_SHA), {
      valid: false,
      reason: "manifest_unavailable_or_invalid"
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
