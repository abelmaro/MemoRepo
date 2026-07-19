import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { backupBeforeSchemaUpgrade } from "../src/db/connection.js";
import { CURRENT_SCHEMA_VERSION } from "../src/db/migrate.js";

test("database startup creates one compatible backup before a schema upgrade", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-db-backup-"));
  const databasePath = path.join(root, "memorepo.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('preserved');");
  legacy.pragma("user_version = 1");
  try {
    assert.equal(backupBeforeSchemaUpgrade(legacy, databasePath), `${databasePath}.pre-v${CURRENT_SCHEMA_VERSION}.sqlite`);
    const backupPath = `${databasePath}.pre-v${CURRENT_SCHEMA_VERSION}.sqlite`;
    assert.equal(fs.existsSync(backupPath), true);
    const backup = new Database(backupPath, { readonly: true });
    try {
      assert.equal(backup.prepare("SELECT value FROM marker").pluck().get(), "preserved");
      assert.equal(backup.pragma("user_version", { simple: true }), 1);
    } finally { backup.close(); }
    const originalMtime = fs.statSync(backupPath).mtimeMs;
    assert.equal(backupBeforeSchemaUpgrade(legacy, databasePath), backupPath);
    assert.equal(fs.statSync(backupPath).mtimeMs, originalMtime);
  } finally {
    legacy.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
