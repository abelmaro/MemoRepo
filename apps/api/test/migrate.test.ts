import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION, migrate } from "../src/db/migrate.js";

test("migrate creates and versions a new database", () => {
  const sqlite = new Database(":memory:");
  try {
    migrate(sqlite);

    assert.equal(schemaVersion(sqlite), CURRENT_SCHEMA_VERSION);
    assert.ok(tableNames(sqlite).has("spaces"));
    assert.ok(tableNames(sqlite).has("jobs"));
    assert.ok(columnNames(sqlite, "jobs").has("deduplication_key"));
    assert.ok(indexNames(sqlite).has("jobs_active_deduplication_unique"));
  } finally {
    sqlite.close();
  }
});

test("migrate upgrades unversioned 0.1.0 through 0.1.2 databases without losing data", () => {
  const sqlite = new Database(":memory:");
  try {
    createLegacySchema(sqlite, false);
    sqlite.prepare(`
      INSERT INTO jobs (id, type, status, payload_json, created_at)
      VALUES ('job-1', 'snapshot', 'pending', '{}', '2026-01-01T00:00:00.000Z')
    `).run();

    migrate(sqlite);

    assert.equal(schemaVersion(sqlite), CURRENT_SCHEMA_VERSION);
    assert.ok(columnNames(sqlite, "jobs").has("deduplication_key"));
    assert.equal(sqlite.prepare("SELECT type FROM jobs WHERE id = 'job-1'").pluck().get(), "snapshot");
  } finally {
    sqlite.close();
  }
});

test("migrate adopts unversioned 0.1.3 through 0.1.6 databases and runs pending data migrations", () => {
  const sqlite = new Database(":memory:");
  try {
    createLegacySchema(sqlite, true);
    sqlite.exec(`
      INSERT INTO spaces (
        id, name, slug, root_path, snapshot_status, snapshot_status_updated_at, created_at, updated_at
      ) VALUES (
        'space-1', 'Space', 'space', '/tmp/space', 'none', '2026-01-01', '2026-01-01', '2026-01-01'
      );
      INSERT INTO space_snapshots (
        id, space_id, version, status, artifact_path, manifest_json, created_at
      ) VALUES (
        'snapshot-1', 'space-1', 1, 'active', '/tmp/snapshot', '{}', '2026-01-01'
      );
    `);

    migrate(sqlite);

    assert.equal(schemaVersion(sqlite), CURRENT_SCHEMA_VERSION);
    assert.equal(
      sqlite.prepare("SELECT status FROM space_snapshots WHERE id = 'snapshot-1'").pluck().get(),
      "inactive",
    );
  } finally {
    sqlite.close();
  }
});

test("migrate is idempotent and rejects databases created by newer versions", () => {
  const sqlite = new Database(":memory:");
  try {
    migrate(sqlite);
    migrate(sqlite);
    sqlite.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);

    assert.throws(() => migrate(sqlite), /newer than supported/);
  } finally {
    sqlite.close();
  }
});

function createLegacySchema(sqlite: Database.Database, withDeduplication: boolean): void {
  sqlite.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      root_path TEXT NOT NULL,
      active_snapshot_id TEXT,
      snapshot_status TEXT NOT NULL DEFAULT 'none',
      snapshot_status_updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      space_id TEXT,
      space_repository_id TEXT,
      depends_on_job_id TEXT,
      payload_json TEXT NOT NULL,
      ${withDeduplication ? "deduplication_key TEXT," : ""}
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE space_snapshots (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id),
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      artifact_path TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      error TEXT
    );
  `);
}

function schemaVersion(sqlite: Database.Database): number {
  return sqlite.pragma("user_version", { simple: true }) as number;
}

function tableNames(sqlite: Database.Database): Set<string> {
  const rows = sqlite.pragma("table_list") as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function columnNames(sqlite: Database.Database, table: string): Set<string> {
  const rows = sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function indexNames(sqlite: Database.Database): Set<string> {
  const rows = sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'index'").all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
}
