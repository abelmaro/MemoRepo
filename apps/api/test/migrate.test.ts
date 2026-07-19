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
    assert.ok(tableNames(sqlite).has("job_dependencies"));
    assert.ok(tableNames(sqlite).has("cbm_operation_metrics"));
    assert.ok(tableNames(sqlite).has("github_oauth_credentials"));
    assert.ok(tableNames(sqlite).has("agent_account_sessions"));
    assert.ok(tableNames(sqlite).has("agent_model_preferences"));
    assert.deepEqual(
      ["id", "provider_id", "model_id", "effort", "verbosity", "updated_at"].filter(
        (column) => !columnNames(sqlite, "agent_model_preferences").has(column)
      ),
      []
    );
    assert.equal(columnNames(sqlite, "agent_model_preferences").has("credential"), false);
    assert.equal(columnNames(sqlite, "agent_model_preferences").has("token"), false);
    assert.ok(tableNames(sqlite).has("agent_chats"));
    assert.ok(tableNames(sqlite).has("agent_messages"));
    assert.ok(tableNames(sqlite).has("agent_turns"));
    assert.equal(tableNames(sqlite).has("codex_conversations"), false);
    assert.ok(columnNames(sqlite, "github_oauth_credentials").has("token_ciphertext"));
    assert.ok(columnNames(sqlite, "jobs").has("deduplication_key"));
    assert.deepEqual(
      [
        "provider_id",
        "model_id",
        "mode",
        "execution_policy",
        "phase",
        "completion_reason",
        "answer_quality",
        "resumable",
        "attempt_count",
        "effort",
        "verbosity",
        "max_run_seconds",
        "max_tool_calls",
        "max_provider_rounds",
        "submission_sequence",
        "stop_reason",
        "provider_round_count",
        "length_stop_count",
        "tool_call_count",
        "input_tokens",
        "output_tokens",
        "reasoning_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "total_tokens"
      ].filter((column) => !columnNames(sqlite, "agent_turns").has(column)),
      []
    );
    assert.ok(indexNames(sqlite).has("jobs_active_deduplication_unique"));
    assert.ok(indexNames(sqlite).has("agent_chats_space_updated_idx"));
    assert.ok(indexNames(sqlite).has("agent_messages_chat_sequence_unique"));
    assert.ok(indexNames(sqlite).has("agent_turns_active_chat_unique"));
    assert.ok(indexNames(sqlite).has("agent_turns_queue_created_idx"));
    assert.ok(indexNames(sqlite).has("agent_turns_submission_sequence_unique"));
    assert.ok(tableNames(sqlite).has("agent_turn_attempts"));
    assert.deepEqual(
      [
        "failure_category",
        "failure_stage",
        "provider_code",
        "http_status",
        "provider_request_id",
        "provider_response_id",
        "transport",
        "retryable",
        "retry_after_ms",
        "diagnostic_summary",
        "time_to_first_provider_event_ms",
        "attempt_duration_ms"
      ].filter((column) => !columnNames(sqlite, "agent_turn_attempts").has(column)),
      []
    );
    assert.ok(tableNames(sqlite).has("agent_tool_cache"));
    assert.ok(tableNames(sqlite).has("agent_turn_tool_results"));
    assert.match(
      sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'agent_turns_active_chat_unique'").pluck().get() as string,
      /queued.*pending.*running/
    );
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

test("migrate repairs a version 9 queue schema missing submission order", () => {
  const sqlite = new Database(":memory:");
  try {
    migrate(sqlite);
    sqlite.exec(`
      DROP INDEX agent_turns_queue_created_idx;
      DROP INDEX agent_turns_submission_sequence_unique;
      ALTER TABLE agent_turns DROP COLUMN submission_sequence;

      INSERT INTO spaces (
        id, name, slug, root_path, snapshot_status, snapshot_status_updated_at, created_at, updated_at
      ) VALUES ('space-queue', 'Queue', 'queue', '/tmp/queue', 'ready', '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO space_snapshots (
        id, space_id, version, status, artifact_path, manifest_json, created_at
      ) VALUES ('snapshot-queue', 'space-queue', 1, 'active', '/tmp/snapshot-queue', '{}', '2026-01-01');
      INSERT INTO agent_account_sessions (
        id, provider_id, account_key, connected_at
      ) VALUES ('account-queue', 'test-provider', 'test-account', '2026-01-01');
      INSERT INTO agent_chats (
        id, space_id, account_session_id, snapshot_id, snapshot_version, snapshot_meta_json,
        title, status, created_at, updated_at
      ) VALUES (
        'chat-queue', 'space-queue', 'account-queue', 'snapshot-queue', 1, '{}',
        'Queue', 'active', '2026-01-01', '2026-01-01'
      );
      INSERT INTO agent_messages (
        id, chat_id, sequence, role, status, content, created_at
      ) VALUES
        ('message-a-user', 'chat-queue', 1, 'user', 'completed', 'A', '2026-01-01'),
        ('message-a-assistant', 'chat-queue', 2, 'assistant', 'completed', 'A', '2026-01-01'),
        ('message-b-user', 'chat-queue', 3, 'user', 'completed', 'B', '2026-01-01'),
        ('message-b-assistant', 'chat-queue', 4, 'assistant', 'completed', 'B', '2026-01-01');
      INSERT INTO agent_turns (
        id, chat_id, user_message_id, assistant_message_id, status, created_at, finished_at
      ) VALUES
        ('turn-b', 'chat-queue', 'message-b-user', 'message-b-assistant', 'completed', '2026-01-01', '2026-01-01'),
        ('turn-a', 'chat-queue', 'message-a-user', 'message-a-assistant', 'completed', '2026-01-01', '2026-01-01');
    `);
    sqlite.pragma("user_version = 9");

    migrate(sqlite);

    assert.deepEqual(
      sqlite.prepare("SELECT id, submission_sequence AS sequence FROM agent_turns ORDER BY submission_sequence").all(),
      [{ id: "turn-a", sequence: 1 }, { id: "turn-b", sequence: 2 }]
    );
    assert.deepEqual(
      sqlite.prepare("SELECT DISTINCT mode, max_run_seconds, max_tool_calls, max_provider_rounds FROM agent_turns").get(),
      { mode: "standard", max_run_seconds: 360, max_tool_calls: 32, max_provider_rounds: 6 }
    );
  } finally {
    sqlite.close();
  }
});

test("migrate adds bounded provider diagnostics without changing existing attempts", () => {
  const sqlite = new Database(":memory:");
  try {
    migrate(sqlite);
    sqlite.exec(`
      DROP TABLE agent_turn_attempts;
      CREATE TABLE agent_turn_attempts (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        assistant_content TEXT NOT NULL DEFAULT '',
        sources_json TEXT NOT NULL DEFAULT '[]',
        stop_reason TEXT,
        provider_round_count INTEGER NOT NULL DEFAULT 0,
        length_stop_count INTEGER NOT NULL DEFAULT 0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(turn_id, attempt_number)
      );
      CREATE INDEX agent_turn_attempts_turn_idx
        ON agent_turn_attempts(turn_id, attempt_number DESC);

      INSERT INTO spaces (
        id, name, slug, root_path, snapshot_status, snapshot_status_updated_at, created_at, updated_at
      ) VALUES ('space-diagnostics', 'Diagnostics', 'diagnostics', '/tmp/diagnostics', 'ready', '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO space_snapshots (
        id, space_id, version, status, artifact_path, manifest_json, created_at
      ) VALUES ('snapshot-diagnostics', 'space-diagnostics', 1, 'active', '/tmp/snapshot-diagnostics', '{}', '2026-01-01');
      INSERT INTO agent_account_sessions (
        id, provider_id, account_key, connected_at
      ) VALUES ('account-diagnostics', 'test-provider', 'test-account', '2026-01-01');
      INSERT INTO agent_chats (
        id, space_id, account_session_id, snapshot_id, snapshot_version, snapshot_meta_json,
        title, status, created_at, updated_at
      ) VALUES (
        'chat-diagnostics', 'space-diagnostics', 'account-diagnostics', 'snapshot-diagnostics', 1, '{}',
        'Diagnostics', 'active', '2026-01-01', '2026-01-01'
      );
      INSERT INTO agent_messages (
        id, chat_id, sequence, role, status, content, created_at
      ) VALUES
        ('message-diagnostics-user', 'chat-diagnostics', 1, 'user', 'completed', 'Question', '2026-01-01'),
        ('message-diagnostics-assistant', 'chat-diagnostics', 2, 'assistant', 'failed', '', '2026-01-01');
      INSERT INTO agent_turns (
        id, chat_id, user_message_id, assistant_message_id, status, created_at, finished_at
      ) VALUES (
        'turn-diagnostics', 'chat-diagnostics', 'message-diagnostics-user',
        'message-diagnostics-assistant', 'failed', '2026-01-01', '2026-01-01'
      );
      INSERT INTO agent_turn_attempts (
        id, turn_id, attempt_number, status, error, started_at, finished_at
      ) VALUES (
        'attempt-diagnostics', 'turn-diagnostics', 1, 'failed', 'Agent run failed',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
      );
    `);
    sqlite.pragma("user_version = 14");

    migrate(sqlite);

    assert.equal(schemaVersion(sqlite), CURRENT_SCHEMA_VERSION);
    assert.deepEqual(
      sqlite.prepare(`
        SELECT status, error, assistant_content AS assistantContent,
          failure_category AS failureCategory, diagnostic_summary AS diagnosticSummary
        FROM agent_turn_attempts WHERE id = 'attempt-diagnostics'
      `).get(),
      {
        status: "failed",
        error: "Agent run failed",
        assistantContent: "",
        failureCategory: null,
        diagnosticSummary: null
      }
    );

    sqlite.prepare(`
      UPDATE agent_turn_attempts SET
        failure_category = 'timeout',
        failure_stage = 'streaming',
        provider_code = 'stream_timeout',
        http_status = 504,
        provider_request_id = 'request-safe-id',
        provider_response_id = 'response-safe-id',
        transport = 'websocket',
        retryable = 1,
        retry_after_ms = 2500,
        diagnostic_summary = 'Provider stream timed out before the first event.',
        time_to_first_provider_event_ms = 32000,
        attempt_duration_ms = 32150
      WHERE id = 'attempt-diagnostics'
    `).run();

    assert.deepEqual(
      sqlite.prepare(`
        SELECT failure_category AS failureCategory, failure_stage AS failureStage,
          provider_code AS providerCode, http_status AS httpStatus,
          provider_request_id AS providerRequestId, provider_response_id AS providerResponseId,
          transport, retryable, retry_after_ms AS retryAfterMs, diagnostic_summary AS diagnosticSummary,
          time_to_first_provider_event_ms AS timeToFirstProviderEventMs,
          attempt_duration_ms AS attemptDurationMs
        FROM agent_turn_attempts WHERE id = 'attempt-diagnostics'
      `).get(),
      {
        failureCategory: "timeout",
        failureStage: "streaming",
        providerCode: "stream_timeout",
        httpStatus: 504,
        providerRequestId: "request-safe-id",
        providerResponseId: "response-safe-id",
        transport: "websocket",
        retryable: 1,
        retryAfterMs: 2500,
        diagnosticSummary: "Provider stream timed out before the first event.",
        timeToFirstProviderEventMs: 32000,
        attemptDurationMs: 32150
      }
    );

    assert.throws(
      () => sqlite.prepare(`
        UPDATE agent_turn_attempts SET diagnostic_summary = ? WHERE id = 'attempt-diagnostics'
      `).run("x".repeat(1025)),
      /CHECK constraint failed/
    );
    assert.throws(
      () => sqlite.prepare(`
        UPDATE agent_turn_attempts SET retryable = 2 WHERE id = 'attempt-diagnostics'
      `).run(),
      /CHECK constraint failed/
    );
    assert.throws(
      () => sqlite.prepare(`
        UPDATE agent_turn_attempts SET retry_after_ms = 86400001 WHERE id = 'attempt-diagnostics'
      `).run(),
      /CHECK constraint failed/
    );
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
