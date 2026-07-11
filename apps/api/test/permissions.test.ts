import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensurePrivateDir, restrictPrivateFile } from "../src/domain/permissions.js";

test("managed directories and files are owner-only on POSIX", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-permissions-"));
  const managedDir = path.join(root, "managed");
  const privateFile = path.join(managedDir, "private.sqlite");

  try {
    ensurePrivateDir(managedDir);
    fs.writeFileSync(privateFile, "private", { mode: 0o666 });
    restrictPrivateFile(privateFile);

    assert.equal(fs.statSync(managedDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(privateFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
