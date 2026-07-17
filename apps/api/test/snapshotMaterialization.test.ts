import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSafeProcessEnvironment, runProcess } from "../src/services/process.js";
import { materializeGitRepository } from "../src/services/snapshotService.js";

test("materializes the selected commit directly without mutable or Git metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-materialize-"));
  const repository = path.join(root, "repositories", "source");
  const target = path.join(root, "snapshots", "one", "sources", "source");

  try {
    fs.mkdirSync(repository, { recursive: true });
    await git(repository, ["init"]);
    await git(repository, ["config", "user.email", "tests@example.invalid"]);
    await git(repository, ["config", "user.name", "MemoRepo Tests"]);
    fs.writeFileSync(path.join(repository, "tracked.txt"), "version one\n");
    fs.mkdirSync(path.join(repository, "nested"));
    fs.writeFileSync(path.join(repository, "nested", "entry.txt"), "nested content\n");
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-m", "initial"]);
    const commit = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();

    fs.writeFileSync(path.join(repository, "tracked.txt"), "working tree change\n");
    fs.writeFileSync(path.join(repository, "untracked.txt"), "must not be copied\n");

    await materializeGitRepository(root, repository, commit, target);

    assert.equal(fs.readFileSync(path.join(target, "tracked.txt"), "utf8"), "version one\n");
    assert.equal(fs.readFileSync(path.join(target, "nested", "entry.txt"), "utf8"), "nested content\n");
    assert.equal(fs.existsSync(path.join(target, "untracked.txt")), false);
    assert.equal(fs.existsSync(path.join(target, ".git")), false);

    fs.rmSync(repository, { recursive: true, force: true });
    assert.equal(fs.readFileSync(path.join(target, "tracked.txt"), "utf8"), "version one\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects symbolic links before materializing a snapshot source", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-materialize-link-"));
  const repository = path.join(root, "repositories", "source");
  const target = path.join(root, "snapshots", "one", "sources", "source");

  try {
    fs.mkdirSync(repository, { recursive: true });
    await git(repository, ["init"]);
    await git(repository, ["config", "user.email", "tests@example.invalid"]);
    await git(repository, ["config", "user.name", "MemoRepo Tests"]);
    const payloadPath = path.join(repository, "link-payload.txt");
    fs.writeFileSync(payloadPath, "outside-target\n");
    const object = (await git(repository, ["hash-object", "-w", "link-payload.txt"])).stdout.trim();
    await git(repository, ["update-index", "--add", "--cacheinfo", `120000,${object},unsafe-link`]);
    await git(repository, ["commit", "-m", "symbolic link entry"]);
    const commit = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();

    await assert.rejects(
      () => materializeGitRepository(root, repository, commit, target),
      (error: unknown) =>
        error instanceof Error
        && error.cause instanceof Error
        && /Snapshot source contains a symbolic link/.test(error.cause.message)
    );
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function git(repository: string, args: string[]) {
  const result = await runProcess({
    command: "git",
    args: ["-C", repository, ...args],
    env: createSafeProcessEnvironment(),
    inheritEnv: false,
    timeoutMs: 30_000
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result;
}
