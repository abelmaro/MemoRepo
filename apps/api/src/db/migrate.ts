import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 16;

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
  { version: 8, up: addSnapshotSizes },
  { version: 9, up: addAgentQueueAndModes },
  { version: 10, up: addAgentSubmissionSequence },
  { version: 11, up: addAdaptiveAgentRuns },
  { version: 12, up: addAgentModelPreferences },
  { version: 13, up: addJobDependencies },
  { version: 14, up: addOperationalMetrics },
  { version: 15, up: addAgentAttemptDiagnostics },
  { version: 16, up: addRepositoryBatches },
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

function addJobDependencies(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS job_dependencies (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      dependency_job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (job_id, dependency_job_id),
      CHECK (job_id <> dependency_job_id)
    );
    CREATE INDEX IF NOT EXISTS job_dependencies_dependency_idx
      ON job_dependencies(dependency_job_id, job_id);
    INSERT OR IGNORE INTO job_dependencies (job_id, dependency_job_id, created_at)
      SELECT id, depends_on_job_id, created_at
      FROM jobs
      WHERE depends_on_job_id IS NOT NULL;
  `);
}

function addOperationalMetrics(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS mcp_tool_stats (
      space_id TEXT NOT NULL REFERENCES spaces(id), tool_name TEXT NOT NULL,
      call_count INTEGER NOT NULL DEFAULT 0, total_response_bytes INTEGER NOT NULL DEFAULT 0,
      max_response_bytes INTEGER NOT NULL DEFAULT 0, total_duration_ms INTEGER NOT NULL DEFAULT 0,
      max_duration_ms INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0,
      cache_hit_count INTEGER NOT NULL DEFAULT 0, truncated_count INTEGER NOT NULL DEFAULT 0,
      last_called_at TEXT NOT NULL, PRIMARY KEY (space_id, tool_name)
    );
    CREATE TABLE IF NOT EXISTS cbm_operation_metrics (
      id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      space_id TEXT,
      snapshot_id TEXT,
      space_repository_id TEXT,
      project_name TEXT,
      engine_version TEXT,
      index_mode TEXT,
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      exit_code INTEGER,
      termination_kind TEXT,
      nodes INTEGER,
      edges INTEGER,
      skipped_count INTEGER,
      artifact_bytes INTEGER,
      response_bytes INTEGER,
      cache_hit INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      cgroup_peak_bytes INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cbm_operation_metrics_created_idx ON cbm_operation_metrics(created_at);
    CREATE INDEX IF NOT EXISTS cbm_operation_metrics_space_created_idx ON cbm_operation_metrics(space_id, created_at);
  `);
  const columns = new Set((sqlite.pragma("table_info(mcp_tool_stats)") as Array<{ name: string }>).map((column) => column.name));
  const additions = [
    ["total_duration_ms", "INTEGER NOT NULL DEFAULT 0"], ["max_duration_ms", "INTEGER NOT NULL DEFAULT 0"],
    ["error_count", "INTEGER NOT NULL DEFAULT 0"], ["cache_hit_count", "INTEGER NOT NULL DEFAULT 0"],
    ["truncated_count", "INTEGER NOT NULL DEFAULT 0"]
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) sqlite.exec(`ALTER TABLE mcp_tool_stats ADD COLUMN ${name} ${definition}`);
  }
}

function addAgentAttemptDiagnostics(sqlite: Database.Database): void {
  const columns = new Set(
    (sqlite.pragma("table_info(agent_turn_attempts)") as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const additions = [
    [
      "failure_category",
      "failure_category TEXT CHECK (failure_category IS NULL OR length(failure_category) <= 64)",
    ],
    [
      "failure_stage",
      "failure_stage TEXT CHECK (failure_stage IS NULL OR length(failure_stage) <= 64)",
    ],
    [
      "provider_code",
      "provider_code TEXT CHECK (provider_code IS NULL OR length(provider_code) <= 128)",
    ],
    [
      "http_status",
      "http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599)",
    ],
    [
      "provider_request_id",
      "provider_request_id TEXT CHECK (provider_request_id IS NULL OR length(provider_request_id) <= 256)",
    ],
    [
      "provider_response_id",
      "provider_response_id TEXT CHECK (provider_response_id IS NULL OR length(provider_response_id) <= 256)",
    ],
    ["transport", "transport TEXT CHECK (transport IS NULL OR length(transport) <= 32)"],
    ["retryable", "retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0, 1))"],
    [
      "retry_after_ms",
      "retry_after_ms INTEGER CHECK (retry_after_ms IS NULL OR retry_after_ms BETWEEN 0 AND 86400000)",
    ],
    [
      "diagnostic_summary",
      "diagnostic_summary TEXT CHECK (diagnostic_summary IS NULL OR length(diagnostic_summary) <= 1024)",
    ],
    [
      "time_to_first_provider_event_ms",
      "time_to_first_provider_event_ms INTEGER CHECK (time_to_first_provider_event_ms IS NULL OR time_to_first_provider_event_ms >= 0)",
    ],
    [
      "attempt_duration_ms",
      "attempt_duration_ms INTEGER CHECK (attempt_duration_ms IS NULL OR attempt_duration_ms >= 0)",
    ],
  ] as const;

  for (const [name, definition] of additions) {
    if (!columns.has(name)) sqlite.exec(`ALTER TABLE agent_turn_attempts ADD COLUMN ${definition};`);
  }
}

function addRepositoryBatches(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS repository_batches (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      repository_ids_json TEXT NOT NULL,
      snapshot_job_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(space_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS repository_batches_space_created_idx
      ON repository_batches(space_id, created_at);

    CREATE TABLE IF NOT EXISTS repository_batch_jobs (
      batch_id TEXT NOT NULL REFERENCES repository_batches(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      space_repository_id TEXT,
      PRIMARY KEY (batch_id, job_id)
    );
    CREATE INDEX IF NOT EXISTS repository_batch_jobs_job_idx
      ON repository_batch_jobs(job_id);
    CREATE INDEX IF NOT EXISTS repository_batch_jobs_repository_stage_idx
      ON repository_batch_jobs(batch_id, space_repository_id, stage);
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

function addSnapshotSizes(sqlite: Database.Database): void {
  const columns = sqlite.pragma("table_info(space_snapshots)") as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "size_bytes")) {
    sqlite.exec("ALTER TABLE space_snapshots ADD COLUMN size_bytes INTEGER;");
  }
}

function addAgentQueueAndModes(sqlite: Database.Database): void {
  sqlite.exec(`
    ALTER TABLE agent_turns ADD COLUMN mode TEXT NOT NULL DEFAULT 'standard';
    ALTER TABLE agent_turns ADD COLUMN max_run_seconds INTEGER NOT NULL DEFAULT 360;
    ALTER TABLE agent_turns ADD COLUMN max_tool_calls INTEGER NOT NULL DEFAULT 32;
    ALTER TABLE agent_turns ADD COLUMN max_provider_rounds INTEGER NOT NULL DEFAULT 6;

    DROP INDEX IF EXISTS agent_turns_active_chat_unique;
    CREATE UNIQUE INDEX agent_turns_active_chat_unique
      ON agent_turns(chat_id)
      WHERE status IN ('queued', 'pending', 'running');
    CREATE INDEX agent_turns_queue_created_idx
      ON agent_turns(status, created_at, id);
  `);
}

function addAgentSubmissionSequence(sqlite: Database.Database): void {
  const columns = sqlite.pragma("table_info(agent_turns)") as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "submission_sequence")) {
    sqlite.exec(`
      ALTER TABLE agent_turns ADD COLUMN submission_sequence INTEGER NOT NULL DEFAULT 0;
      WITH ordered AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS sequence
        FROM agent_turns
      )
      UPDATE agent_turns
        SET submission_sequence = (SELECT sequence FROM ordered WHERE ordered.id = agent_turns.id);
    `);
  }

  sqlite.exec(`
    DROP INDEX IF EXISTS agent_turns_queue_created_idx;
    CREATE UNIQUE INDEX IF NOT EXISTS agent_turns_submission_sequence_unique
      ON agent_turns(submission_sequence);
    CREATE INDEX agent_turns_queue_created_idx
      ON agent_turns(status, submission_sequence);
  `);
}

function addAdaptiveAgentRuns(sqlite: Database.Database): void {
  const columns = new Set(
    (sqlite.pragma("table_info(agent_turns)") as Array<{ name: string }>).map((column) => column.name)
  );
  const addColumn = (name: string, definition: string) => {
    if (!columns.has(name)) sqlite.exec(`ALTER TABLE agent_turns ADD COLUMN ${definition};`);
  };
  addColumn("execution_policy", "execution_policy TEXT NOT NULL DEFAULT 'legacy'");
  addColumn("phase", "phase TEXT NOT NULL DEFAULT 'queued'");
  addColumn("completion_reason", "completion_reason TEXT");
  addColumn("answer_quality", "answer_quality TEXT");
  addColumn("resumable", "resumable INTEGER NOT NULL DEFAULT 0");
  addColumn("attempt_count", "attempt_count INTEGER NOT NULL DEFAULT 0");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_turn_attempts (
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

    CREATE INDEX IF NOT EXISTS agent_turn_attempts_turn_idx
      ON agent_turn_attempts(turn_id, attempt_number DESC);

    CREATE TABLE IF NOT EXISTS agent_tool_cache (
      cache_key TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL REFERENCES space_snapshots(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      sources_json TEXT NOT NULL DEFAULT '[]',
      result_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS agent_tool_cache_snapshot_lru_idx
      ON agent_tool_cache(snapshot_id, last_used_at DESC);

    CREATE TABLE IF NOT EXISTS agent_turn_tool_results (
      turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
      cache_key TEXT NOT NULL REFERENCES agent_tool_cache(cache_key) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      PRIMARY KEY(turn_id, cache_key)
    );

    CREATE INDEX IF NOT EXISTS agent_turn_tool_results_turn_sequence_idx
      ON agent_turn_tool_results(turn_id, sequence);
  `);
}

function addAgentModelPreferences(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_model_preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      effort TEXT,
      verbosity TEXT,
      updated_at TEXT NOT NULL
    );
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
