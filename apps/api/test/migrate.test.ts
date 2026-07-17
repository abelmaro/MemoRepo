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
    assert.ok(tableNames(sqlite).has("github_oauth_credentials"));
    assert.ok(tableNames(sqlite).has("agent_account_sessions"));
    assert.ok(tableNames(sqlite).has("agent_chats"));
    assert.ok(tableNames(sqlite).has("agent_messages"));
    assert.ok(tableNames(sqlite).has("agent_turns"));
    assert.equal(tableNames(sqlite).has("codex_conversations"), false);
    assert.ok(columnNames(sqlite, "github_oauth_credentials").has("token_ciphertext"));
    assert.ok(columnNames(sqlite, "jobs").has("deduplication_key"));
    assert.ok(indexNames(sqlite).has("jobs_active_deduplication_unique"));
    assert.ok(indexNames(sqlite).has("agent_chats_space_updated_idx"));
    assert.ok(indexNames(sqlite).has("agent_messages_chat_sequence_unique"));
    assert.ok(indexNames(sqlite).has("agent_turns_active_chat_unique"));
  } finally {
    sqlite.close();
  }
});

test("agent chat persistence keeps visible transcripts safe across snapshot and chat deletion", () => {
  const sqlite = new Database(":memory:");
  try {
    migrate(sqlite);
    sqlite.exec(`
      INSERT INTO spaces (
        id, name, slug, root_path, snapshot_status, snapshot_status_updated_at, created_at, updated_at
      ) VALUES ('space-1', 'Space', 'space', '/tmp/space', 'ready', '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO space_snapshots (
        id, space_id, version, status, artifact_path, manifest_json, created_at
      ) VALUES ('snapshot-1', 'space-1', 1, 'inactive', '/tmp/snapshot', '{}', '2026-01-01');
      INSERT INTO agent_account_sessions (
        id, provider_id, account_key, connected_at
      ) VALUES ('account-1', 'test-provider', 'test-account', '2026-01-01');
      INSERT INTO agent_chats (
        id, space_id, account_session_id, snapshot_id, snapshot_version, snapshot_meta_json,
        title, status, created_at, updated_at
      ) VALUES (
        'conversation-1', 'space-1', 'account-1', 'snapshot-1', 1, '{}',
        'Question', 'active', '2026-01-01', '2026-01-01'
      );
      INSERT INTO agent_messages (
        id, chat_id, sequence, role, status, content, created_at
      ) VALUES
        ('message-1', 'conversation-1', 1, 'user', 'completed', 'Question', '2026-01-01'),
        ('message-2', 'conversation-1', 2, 'assistant', 'completed', 'Answer', '2026-01-01');
      INSERT INTO agent_turns (
        id, chat_id, user_message_id, assistant_message_id, status, created_at, finished_at
      ) VALUES (
        'turn-1', 'conversation-1', 'message-1', 'message-2', 'completed', '2026-01-01', '2026-01-01'
      );
    `);

    sqlite.prepare("DELETE FROM space_snapshots WHERE id = 'snapshot-1'").run();
    assert.equal(
      sqlite.prepare("SELECT snapshot_id FROM agent_chats WHERE id = 'conversation-1'").pluck().get(),
      null,
    );

    sqlite.prepare("DELETE FROM agent_chats WHERE id = 'conversation-1'").run();
    assert.equal(sqlite.prepare("SELECT COUNT(*) FROM agent_messages").pluck().get(), 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) FROM agent_turns").pluck().get(), 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) FROM agent_account_sessions").pluck().get(), 1);
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

test("migrate repairs a version 5 database that is missing agent chat tables", () => {
  const sqlite = new Database(":memory:");
  try {
    migrate(sqlite);
    sqlite.exec(`
      DROP TABLE agent_turns;
      DROP TABLE agent_messages;
      DROP TABLE agent_chats;
      DROP TABLE agent_account_sessions;
    `);
    sqlite.pragma("user_version = 5");

    migrate(sqlite);

    assert.equal(schemaVersion(sqlite), CURRENT_SCHEMA_VERSION);
    assert.ok(tableNames(sqlite).has("agent_account_sessions"));
    assert.ok(tableNames(sqlite).has("agent_chats"));
    assert.ok(tableNames(sqlite).has("agent_messages"));
    assert.ok(tableNames(sqlite).has("agent_turns"));
    assert.ok(indexNames(sqlite).has("agent_turns_active_chat_unique"));
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
