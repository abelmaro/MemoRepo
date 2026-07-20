import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { AppConfig } from "../src/config.js";
import type { GitHubCredentialProvider } from "../src/services/githubCredentialProvider.js";
import { GitService } from "../src/services/gitService.js";
import { createSafeProcessEnvironment, runProcess } from "../src/services/process.js";
import { materializeGitRepository } from "../src/services/snapshotService.js";

test("keeps an already clean checkout and repairs changed managed clones", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-git-service-"));
  const source = path.join(root, "source");
  const clone = path.join(root, "managed", "clone");
  const binDir = path.join(root, "bin");

  try {
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    await git(source, ["init", "-b", "main"]);
    await git(source, ["config", "user.email", "tests@example.invalid"]);
    await git(source, ["config", "user.name", "MemoRepo Tests"]);
    fs.writeFileSync(path.join(source, "tracked.txt"), "main\n");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "main"]);

    await git(source, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(source, "tracked.txt"), "feature\n");
    await git(source, ["commit", "-am", "feature"]);
    const featureCommit = (await git(source, ["rev-parse", "HEAD"])).stdout.trim();
    await git(source, ["checkout", "main"]);
    const mainCommit = (await git(source, ["rev-parse", "HEAD"])).stdout.trim();

    const credentials = { getAccessToken: () => "test-token" } as unknown as GitHubCredentialProvider;
    const service = new GitService({ memorepoHome: root, binDir } as AppConfig, credentials);
    await service.cloneRepository(source, clone);

    assert.equal(await service.checkoutFetchedRemoteBranch(clone, "main"), mainCommit);
    assert.equal(fs.readFileSync(path.join(clone, "tracked.txt"), "utf8").trim(), "main");

    fs.writeFileSync(path.join(clone, "tracked.txt"), "modified\n");
    fs.writeFileSync(path.join(clone, "untracked.txt"), "remove me\n");
    assert.equal(await service.checkoutFetchedRemoteBranch(clone, "main"), mainCommit);
    assert.equal(fs.readFileSync(path.join(clone, "tracked.txt"), "utf8").trim(), "main");
    assert.equal(fs.existsSync(path.join(clone, "untracked.txt")), false);

    assert.equal(await service.checkoutFetchedRemoteBranch(clone, "feature"), featureCommit);
    assert.equal(fs.readFileSync(path.join(clone, "tracked.txt"), "utf8").trim(), "feature");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("blobless clones retain exact snapshot materialization and avoid tags", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-git-partial-"));
  const source = path.join(root, "source");
  const clone = path.join(root, "managed", "clone");
  const snapshot = path.join(root, "snapshots", "current");
  const binDir = path.join(root, "bin");

  try {
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    await git(source, ["init", "-b", "main"]);
    await git(source, ["config", "user.email", "tests@example.invalid"]);
    await git(source, ["config", "user.name", "MemoRepo Tests"]);
    await git(source, ["config", "uploadpack.allowFilter", "true"]);
    fs.writeFileSync(path.join(source, "historical.bin"), "x".repeat(256 * 1024));
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "historical content"]);
    await git(source, ["tag", "historical-tag"]);
    fs.rmSync(path.join(source, "historical.bin"));
    fs.writeFileSync(path.join(source, "current.txt"), "current\n");
    await git(source, ["add", "-A"]);
    await git(source, ["commit", "-m", "current content"]);
    const currentCommit = (await git(source, ["rev-parse", "HEAD"])).stdout.trim();

    const credentials = { getAccessToken: () => "test-token" } as unknown as GitHubCredentialProvider;
    const service = new GitService({ memorepoHome: root, binDir } as AppConfig, credentials);
    await service.cloneRepository(pathToFileURL(source).href, clone);

    assert.equal((await git(clone, ["config", "--get", "remote.origin.partialclonefilter"])).stdout.trim(), "blob:none");
    assert.equal((await git(clone, ["config", "--get", "remote.origin.tagOpt"])).stdout.trim(), "--no-tags");
    assert.equal((await git(clone, ["tag", "--list"])).stdout.trim(), "");
    assert.equal(await service.checkoutFetchedRemoteBranch(clone, "main"), currentCommit);
    await materializeGitRepository(root, clone, currentCommit, snapshot);
    assert.equal(fs.readFileSync(path.join(snapshot, "current.txt"), "utf8"), "current\n");
    assert.equal(fs.existsSync(path.join(snapshot, ".git")), false);
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
