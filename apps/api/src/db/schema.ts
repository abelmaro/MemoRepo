import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const spaces = sqliteTable("spaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  rootPath: text("root_path").notNull(),
  activeSnapshotId: text("active_snapshot_id"),
  snapshotStatus: text("snapshot_status").notNull().default("none"),
  snapshotStatusUpdatedAt: text("snapshot_status_updated_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const githubRepositories = sqliteTable("github_repositories", {
  id: text("id").primaryKey(),
  githubId: integer("github_id").notNull().unique(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  fullName: text("full_name").notNull().unique(),
  htmlUrl: text("html_url").notNull(),
  cloneUrl: text("clone_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  private: integer("private", { mode: "boolean" }).notNull(),
  archived: integer("archived", { mode: "boolean" }).notNull(),
  fork: integer("fork", { mode: "boolean" }).notNull(),
  description: text("description"),
  topicsJson: text("topics_json").notNull(),
  pushedAt: text("pushed_at"),
  lastSeenAt: text("last_seen_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const githubOauthCredentials = sqliteTable("github_oauth_credentials", {
  id: text("id").primaryKey(),
  githubUserId: integer("github_user_id").notNull(),
  login: text("login").notNull(),
  name: text("name"),
  avatarUrl: text("avatar_url").notNull(),
  tokenCiphertext: text("token_ciphertext").notNull(),
  tokenType: text("token_type").notNull(),
  scopesJson: text("scopes_json").notNull(),
  connectedAt: text("connected_at").notNull(),
  lastValidatedAt: text("last_validated_at"),
  updatedAt: text("updated_at").notNull()
});

export const spaceRepositories = sqliteTable(
  "space_repositories",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id),
    githubRepositoryId: text("github_repository_id")
      .notNull()
      .references(() => githubRepositories.id),
    localPath: text("local_path").notNull(),
    selectedBranch: text("selected_branch"),
    selectedCommit: text("selected_commit"),
    remoteRef: text("remote_ref"),
    cloneStatus: text("clone_status").notNull().default("not_cloned"),
    indexStatus: text("index_status").notNull().default("not_indexed"),
    snapshotIncluded: integer("snapshot_included", { mode: "boolean" }).notNull().default(false),
    branchesJson: text("branches_json").notNull().default("[]"),
    lastFetchedAt: text("last_fetched_at"),
    lastIndexedAt: text("last_indexed_at"),
    lastError: text("last_error"),
    removedAt: text("removed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    index("space_repositories_space_repository_idx").on(table.spaceId, table.githubRepositoryId),
    index("space_repositories_removed_idx").on(table.removedAt)
  ]
);

export const repoIndexes = sqliteTable("repo_indexes", {
  id: text("id").primaryKey(),
  spaceRepositoryId: text("space_repository_id")
    .notNull()
    .references(() => spaceRepositories.id),
  projectName: text("project_name").notNull(),
  cachePath: text("cache_path").notNull(),
  branch: text("branch").notNull(),
  commitSha: text("commit_sha").notNull(),
  status: text("status").notNull(),
  indexedAt: text("indexed_at"),
  error: text("error"),
  createdAt: text("created_at").notNull()
});

export const spaceSnapshots = sqliteTable(
  "space_snapshots",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    artifactPath: text("artifact_path").notNull(),
    manifestJson: text("manifest_json").notNull(),
    createdAt: text("created_at").notNull(),
    activatedAt: text("activated_at"),
    error: text("error")
  },
  (table) => [uniqueIndex("space_snapshots_space_version_unique").on(table.spaceId, table.version)]
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    spaceId: text("space_id"),
    spaceRepositoryId: text("space_repository_id"),
    dependsOnJobId: text("depends_on_job_id"),
    payloadJson: text("payload_json").notNull(),
    deduplicationKey: text("deduplication_key"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at")
  },
  (table) => [
    index("jobs_status_created_idx").on(table.status, table.createdAt),
    index("jobs_space_repository_idx").on(table.spaceRepositoryId, table.status),
    uniqueIndex("jobs_active_deduplication_unique")
      .on(table.deduplicationKey)
      .where(sql`${table.deduplicationKey} IS NOT NULL AND ${table.status} IN ('pending', 'running')`)
  ]
);

export const jobEvents = sqliteTable(
  "job_events",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    eventType: text("event_type").notNull(),
    message: text("message").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [index("job_events_job_created_idx").on(table.jobId, table.createdAt)]
);

export const mcpConnections = sqliteTable(
  "mcp_connections",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id),
    name: text("name").notNull(),
    client: text("client").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at")
  },
  (table) => [
    index("mcp_connections_space_idx").on(table.spaceId, table.revokedAt),
    index("mcp_connections_token_hash_idx").on(table.tokenHash)
  ]
);

export const mcpToolStats = sqliteTable(
  "mcp_tool_stats",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id),
    toolName: text("tool_name").notNull(),
    callCount: integer("call_count").notNull().default(0),
    totalResponseBytes: integer("total_response_bytes").notNull().default(0),
    maxResponseBytes: integer("max_response_bytes").notNull().default(0),
    lastCalledAt: text("last_called_at").notNull()
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.toolName] })]
);

export const agentAccountSessions = sqliteTable("agent_account_sessions", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  accountKey: text("account_key").notNull(),
  connectedAt: text("connected_at").notNull(),
  disconnectedAt: text("disconnected_at")
});

export const agentChats = sqliteTable(
  "agent_chats",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    accountSessionId: text("account_session_id")
      .notNull()
      .references(() => agentAccountSessions.id),
    snapshotId: text("snapshot_id").references(() => spaceSnapshots.id, { onDelete: "set null" }),
    snapshotVersion: integer("snapshot_version").notNull(),
    snapshotMetaJson: text("snapshot_meta_json").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at")
  },
  (table) => [index("agent_chats_space_updated_idx").on(table.spaceId, table.status, table.updatedAt)]
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => agentChats.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    content: text("content").notNull(),
    sourcesJson: text("sources_json").notNull().default("[]"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at")
  },
  (table) => [uniqueIndex("agent_messages_chat_sequence_unique").on(table.chatId, table.sequence)]
);

export const agentTurns = sqliteTable(
  "agent_turns",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => agentChats.id, { onDelete: "cascade" }),
    userMessageId: text("user_message_id")
      .notNull()
      .references(() => agentMessages.id, { onDelete: "cascade" }),
    assistantMessageId: text("assistant_message_id")
      .notNull()
      .references(() => agentMessages.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    error: text("error"),
    providerId: text("provider_id"),
    modelId: text("model_id"),
    effort: text("effort"),
    verbosity: text("verbosity"),
    stopReason: text("stop_reason"),
    providerRoundCount: integer("provider_round_count").notNull().default(0),
    lengthStopCount: integer("length_stop_count").notNull().default(0),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at")
  },
  (table) => [
    index("agent_turns_chat_created_idx").on(table.chatId, table.createdAt),
    uniqueIndex("agent_turns_active_chat_unique")
      .on(table.chatId)
      .where(sql`${table.status} IN ('pending', 'running')`)
  ]
);

export const databaseTables = {
  spaces,
  github_oauth_credentials: githubOauthCredentials,
  github_repositories: githubRepositories,
  space_repositories: spaceRepositories,
  repo_indexes: repoIndexes,
  space_snapshots: spaceSnapshots,
  jobs,
  job_events: jobEvents,
  mcp_connections: mcpConnections,
  mcp_tool_stats: mcpToolStats,
  agent_account_sessions: agentAccountSessions,
  agent_chats: agentChats,
  agent_messages: agentMessages,
  agent_turns: agentTurns
} as const;

export const schema = {
  spaces,
  githubOauthCredentials,
  githubRepositories,
  spaceRepositories,
  repoIndexes,
  spaceSnapshots,
  jobs,
  jobEvents,
  mcpConnections,
  mcpToolStats,
  agentAccountSessions,
  agentChats,
  agentMessages,
  agentTurns
};

export type DatabaseTableName = keyof typeof databaseTables;
