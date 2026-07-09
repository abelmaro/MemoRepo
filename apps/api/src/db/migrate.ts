import type Database from "better-sqlite3";

export function migrate(sqlite: Database.Database): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");

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
      deduplication_key TEXT,
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

  const addJobDeduplication = sqlite.transaction(() => {
    const jobColumns = sqlite.pragma("table_info(jobs)") as Array<{ name: string }>;
    if (!jobColumns.some((column) => column.name === "deduplication_key")) {
      sqlite.exec("ALTER TABLE jobs ADD COLUMN deduplication_key TEXT");
    }

    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_deduplication_unique
        ON jobs(deduplication_key)
        WHERE deduplication_key IS NOT NULL
          AND status IN ('pending', 'running');
    `);
  });
  addJobDeduplication.immediate();
}
