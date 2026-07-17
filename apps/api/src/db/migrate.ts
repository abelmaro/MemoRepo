import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 7;

interface Migration {
  version: number;
  up: (sqlite: Database.Database) => void;
}

const migrations: Migration[] = [
  { version: 1, up: createInitialSchema },
  { version: 2, up: addJobDeduplication },
  { version: 3, up: normalizeSnapshotStatuses },
  { version: 4, up: addGitHubOAuthCredentials },
  { version: 5, up: addAgentChats },
  { version: 6, up: addAgentChats },
  { version: 7, up: addAgentTurnMetrics },
];

export function migrate(sqlite: Database.Database): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");

  const currentVersion = readSchemaVersion(sqlite);
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  const startingVersion = currentVersion === 0 ? detectLegacySchemaVersion(sqlite) : currentVersion;
  if (currentVersion === 0 && startingVersion > 0) {
    setSchemaVersion(sqlite, startingVersion);
  }

  for (const migration of migrations) {
    if (migration.version <= startingVersion) continue;

    const applyMigration = sqlite.transaction(() => {
      migration.up(sqlite);
      setSchemaVersion(sqlite, migration.version);
    });
    applyMigration.immediate();
  }

  const reconcileDataInvariants = sqlite.transaction(() => normalizeSnapshotStatuses(sqlite));
  reconcileDataInvariants.immediate();
}

function createInitialSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS spaces (
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

    CREATE TABLE IF NOT EXISTS github_repositories (
      id TEXT PRIMARY KEY,
      github_id INTEGER NOT NULL UNIQUE,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL UNIQUE,
      html_url TEXT NOT NULL,
      clone_url TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      private INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      fork INTEGER NOT NULL,
      description TEXT,
      topics_json TEXT NOT NULL,
      pushed_at TEXT,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS space_repositories (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id),
      github_repository_id TEXT NOT NULL REFERENCES github_repositories(id),
      local_path TEXT NOT NULL,
      selected_branch TEXT,
      selected_commit TEXT,
      remote_ref TEXT,
      clone_status TEXT NOT NULL DEFAULT 'not_cloned',
      index_status TEXT NOT NULL DEFAULT 'not_indexed',
      snapshot_included INTEGER NOT NULL DEFAULT 0,
      branches_json TEXT NOT NULL DEFAULT '[]',
      last_fetched_at TEXT,
      last_indexed_at TEXT,
      last_error TEXT,
      removed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS space_repositories_active_unique
      ON space_repositories(space_id, github_repository_id)
      WHERE removed_at IS NULL;

    CREATE TABLE IF NOT EXISTS repo_indexes (
      id TEXT PRIMARY KEY,
      space_repository_id TEXT NOT NULL REFERENCES space_repositories(id),
      project_name TEXT NOT NULL,
      cache_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      status TEXT NOT NULL,
      indexed_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS space_snapshots (
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

    CREATE UNIQUE INDEX IF NOT EXISTS space_snapshots_space_version_unique
      ON space_snapshots(space_id, version);

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      space_id TEXT,
      space_repository_id TEXT,
      depends_on_job_id TEXT,
      payload_json TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS jobs_space_repository_idx ON jobs(space_repository_id, status);

    CREATE TABLE IF NOT EXISTS job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS job_events_job_created_idx ON job_events(job_id, created_at);

    CREATE TABLE IF NOT EXISTS mcp_connections (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id),
      name TEXT NOT NULL,
      client TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS mcp_connections_space_idx ON mcp_connections(space_id, revoked_at);
    CREATE INDEX IF NOT EXISTS mcp_connections_token_hash_idx ON mcp_connections(token_hash);

    CREATE TABLE IF NOT EXISTS mcp_tool_stats (
      space_id TEXT NOT NULL REFERENCES spaces(id),
      tool_name TEXT NOT NULL,
      call_count INTEGER NOT NULL DEFAULT 0,
      total_response_bytes INTEGER NOT NULL DEFAULT 0,
      max_response_bytes INTEGER NOT NULL DEFAULT 0,
      last_called_at TEXT NOT NULL,
      PRIMARY KEY (space_id, tool_name)
    );
  `);
}

function addJobDeduplication(sqlite: Database.Database): void {
  sqlite.exec(`
    ALTER TABLE jobs ADD COLUMN deduplication_key TEXT;

    CREATE UNIQUE INDEX jobs_active_deduplication_unique
      ON jobs(deduplication_key)
      WHERE deduplication_key IS NOT NULL
        AND status IN ('pending', 'running');
  `);
}

function normalizeSnapshotStatuses(sqlite: Database.Database): void {
  sqlite.exec(`
    UPDATE space_snapshots
    SET status = 'inactive'
    WHERE status = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM spaces
        WHERE spaces.active_snapshot_id = space_snapshots.id
      );
  `);
}

function addGitHubOAuthCredentials(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS github_oauth_credentials (
      id TEXT PRIMARY KEY,
      github_user_id INTEGER NOT NULL,
      login TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT NOT NULL,
      token_ciphertext TEXT NOT NULL,
      token_type TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      last_validated_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

function addAgentChats(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_account_sessions (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      account_key TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      disconnected_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_chats (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      account_session_id TEXT NOT NULL REFERENCES agent_account_sessions(id),
      snapshot_id TEXT REFERENCES space_snapshots(id) ON DELETE SET NULL,
      snapshot_version INTEGER NOT NULL,
      snapshot_meta_json TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE INDEX IF NOT EXISTS agent_chats_space_updated_idx
      ON agent_chats(space_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES agent_chats(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      content TEXT NOT NULL,
      sources_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS agent_messages_chat_sequence_unique
      ON agent_messages(chat_id, sequence);

    CREATE TABLE IF NOT EXISTS agent_turns (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES agent_chats(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
      assistant_message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS agent_turns_chat_created_idx
      ON agent_turns(chat_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS agent_turns_active_chat_unique
      ON agent_turns(chat_id)
      WHERE status IN ('pending', 'running');
  `);
}

function addAgentTurnMetrics(sqlite: Database.Database): void {
  sqlite.exec(`
    ALTER TABLE agent_turns ADD COLUMN provider_id TEXT;
    ALTER TABLE agent_turns ADD COLUMN model_id TEXT;
    ALTER TABLE agent_turns ADD COLUMN effort TEXT;
    ALTER TABLE agent_turns ADD COLUMN verbosity TEXT;
    ALTER TABLE agent_turns ADD COLUMN stop_reason TEXT;
    ALTER TABLE agent_turns ADD COLUMN provider_round_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_turns ADD COLUMN length_stop_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_turns ADD COLUMN tool_call_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_turns ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_turns ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_turns ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_turns ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_turns ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_turns ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
  `);
}

function detectLegacySchemaVersion(sqlite: Database.Database): number {
  const tables = sqlite.pragma("table_list") as Array<{ name: string }>;
  if (!tables.some((table) => table.name === "spaces")) return 0;

  const jobColumns = sqlite.pragma("table_info(jobs)") as Array<{ name: string }>;
  if (jobColumns.length === 0) {
    throw new Error("Cannot migrate unversioned database: expected jobs table is missing");
  }

  return jobColumns.some((column) => column.name === "deduplication_key") ? 2 : 1;
}

function readSchemaVersion(sqlite: Database.Database): number {
  return sqlite.pragma("user_version", { simple: true }) as number;
}

function setSchemaVersion(sqlite: Database.Database, version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("Invalid schema version");
  sqlite.pragma(`user_version = ${version}`);
}
