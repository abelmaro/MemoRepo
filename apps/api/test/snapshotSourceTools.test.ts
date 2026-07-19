import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readSnapshotFile, searchSnapshotText, type SnapshotSourceRepository } from "../src/services/snapshotSourceTools.js";

async function fixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "memorepo-source-tools-"));
  const one = path.join(root, "one");
  const two = path.join(root, "two");
  await fs.promises.mkdir(path.join(one, "docs"), { recursive: true });
  await fs.promises.mkdir(two, { recursive: true });
  await fs.promises.writeFile(path.join(one, "docs", "guía.txt"), "alpha\nExact Café needle\nomega\n", "utf8");
  await fs.promises.writeFile(path.join(one, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await fs.promises.writeFile(path.join(one, "large.txt"), "x".repeat(1024 * 1024 + 1));
  await fs.promises.writeFile(path.join(two, "other.md"), "needle elsewhere\nneedle twice\n", "utf8");
  const repositories: SnapshotSourceRepository[] = [
    { projectName: "one", fullName: "org/one", localPath: one },
    { projectName: "two", fullName: "org/two", localPath: two }
  ];
  return { root, one, repositories, cleanup: () => fs.promises.rm(root, { recursive: true, force: true }) };
}

test("read_snapshot_file returns bounded numbered UTF-8 source and digest", async () => {
  const value = await fixture();
  try {
    const result = await readSnapshotFile(value.repositories[0]!, { path: "docs/guía.txt", startLine: 2, endLine: 3 });
    assert.equal(result.content, "2: Exact Café needle\n3: omega");
    assert.equal(result.digest_complete, true);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
  } finally { await value.cleanup(); }
});

test("read_snapshot_file rejects traversal, absolute, drive, UNC, NUL, binary, and directories", async () => {
  const value = await fixture();
  try {
    for (const unsafe of ["../x", "/etc/passwd", "C:\\Windows\\x", "\\\\host\\share\\x", "docs/../x", "docs\0x"]) {
      await assert.rejects(() => readSnapshotFile(value.repositories[0]!, { path: unsafe }));
    }
    await assert.rejects(() => readSnapshotFile(value.repositories[0]!, { path: "binary.bin" }), /binary/);
    await assert.rejects(() => readSnapshotFile(value.repositories[0]!, { path: "docs" }), /regular file/);
  } finally { await value.cleanup(); }
});

test("read_snapshot_file rejects an intermediate symbolic link", async (t) => {
  const value = await fixture();
  try {
    const link = path.join(value.one, "linked");
    try { await fs.promises.symlink(path.join(value.one, "docs"), link, "junction"); }
    catch { t.skip("symlink creation is unavailable"); return; }
    await assert.rejects(() => readSnapshotFile(value.repositories[0]!, { path: "linked/guía.txt" }), /symbolic link|reparse/);
  } finally { await value.cleanup(); }
});

test("search_snapshot_text fans out, preserves Unicode, paginates, and reports skips", async () => {
  const value = await fixture();
  try {
    const first = await searchSnapshotText(value.repositories, { query: "needle", limit: 2 });
    assert.equal(first.complete, true);
    assert.equal(first.skippedBinary, 1);
    assert.equal(first.skippedOversize, 1);
    assert.equal(first.returned, 2);
    assert.equal(first.has_more, true);
    const second = await searchSnapshotText(value.repositories, { query: "needle", limit: 2, offset: first.next_offset });
    assert.equal(second.returned, 1);
    assert.equal(second.has_more, false);
    const unicode = await searchSnapshotText(value.repositories, { query: "café", caseSensitive: false });
    assert.equal(unicode.matches[0]?.context.includes("Café"), true);
  } finally { await value.cleanup(); }
});

test("search_snapshot_text filters project inventory by prefix, glob, and extension", async () => {
  const value = await fixture();
  try {
    const result = await searchSnapshotText(value.repositories, {
      query: "needle", pathPrefix: "docs", glob: "docs/*.txt", extensions: ["txt"]
    });
    assert.deepEqual(result.matches.map((match) => match.project), ["one"]);
    assert.equal(result.complete, true);
    assert.equal(result.has_more, false);
  } finally { await value.cleanup(); }
});

test("source search honors cancellation", async () => {
  const value = await fixture();
  try {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await assert.rejects(() => searchSnapshotText(value.repositories, { query: "needle" }, controller.signal), { name: "AbortError" });
  } finally { await value.cleanup(); }
});
