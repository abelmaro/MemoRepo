import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    error: text("error"),
    sizeBytes: integer("size_bytes")
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

export const jobDependencies = sqliteTable(
  "job_dependencies",
  {
    jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    dependencyJobId: text("dependency_job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.dependencyJobId] }),
    index("job_dependencies_dependency_idx").on(table.dependencyJobId, table.jobId)
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

export const repositoryBatches = sqliteTable(
  "repository_batches",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    repositoryIdsJson: text("repository_ids_json").notNull(),
    snapshotJobId: text("snapshot_job_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("repository_batches_space_request_unique").on(table.spaceId, table.requestId),
    index("repository_batches_space_created_idx").on(table.spaceId, table.createdAt)
  ]
);

export const repositoryBatchJobs = sqliteTable(
  "repository_batch_jobs",
  {
    batchId: text("batch_id")
      .notNull()
      .references(() => repositoryBatches.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    spaceRepositoryId: text("space_repository_id")
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.jobId] }),
    index("repository_batch_jobs_job_idx").on(table.jobId),
    index("repository_batch_jobs_repository_stage_idx").on(table.batchId, table.spaceRepositoryId, table.stage)
  ]
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
    totalDurationMs: integer("total_duration_ms").notNull().default(0),
    maxDurationMs: integer("max_duration_ms").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    cacheHitCount: integer("cache_hit_count").notNull().default(0),
    truncatedCount: integer("truncated_count").notNull().default(0),
    lastCalledAt: text("last_called_at").notNull()
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.toolName] })]
);

export const cbmOperationMetrics = sqliteTable(
  "cbm_operation_metrics",
  {
    id: text("id").primaryKey(),
    operation: text("operation").notNull(),
    spaceId: text("space_id"),
    snapshotId: text("snapshot_id"),
    spaceRepositoryId: text("space_repository_id"),
    projectName: text("project_name"),
    engineVersion: text("engine_version"),
    indexMode: text("index_mode"),
    status: text("status").notNull(),
    durationMs: integer("duration_ms").notNull(),
    exitCode: integer("exit_code"),
    terminationKind: text("termination_kind"),
    nodes: integer("nodes"),
    edges: integer("edges"),
    skippedCount: integer("skipped_count"),
    artifactBytes: integer("artifact_bytes"),
    responseBytes: integer("response_bytes"),
    cacheHit: integer("cache_hit").notNull().default(0),
    truncated: integer("truncated").notNull().default(0),
    cgroupPeakBytes: integer("cgroup_peak_bytes"),
    createdAt: text("created_at").notNull()
  },
  (table) => [index("cbm_operation_metrics_created_idx").on(table.createdAt), index("cbm_operation_metrics_space_created_idx").on(table.spaceId, table.createdAt)]
);

export const agentAccountSessions = sqliteTable("agent_account_sessions", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  accountKey: text("account_key").notNull(),
  connectedAt: text("connected_at").notNull(),
  disconnectedAt: text("disconnected_at")
});

export const agentModelPreferences = sqliteTable("agent_model_preferences", {
  id: integer("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  effort: text("effort"),
  verbosity: text("verbosity"),
  updatedAt: text("updated_at").notNull()
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
    mode: text("mode").notNull().default("standard"),
    executionPolicy: text("execution_policy").notNull().default("legacy"),
    phase: text("phase").notNull().default("queued"),
    completionReason: text("completion_reason"),
    answerQuality: text("answer_quality"),
    resumable: integer("resumable", { mode: "boolean" }).notNull().default(false),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxRunSeconds: integer("max_run_seconds").notNull().default(1800),
    maxToolCalls: integer("max_tool_calls").notNull().default(200),
    maxProviderRounds: integer("max_provider_rounds").notNull().default(50),
    submissionSequence: integer("submission_sequence").notNull().default(0),
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
      .where(sql`${table.status} IN ('queued', 'pending', 'running')`),
    uniqueIndex("agent_turns_submission_sequence_unique").on(table.submissionSequence),
    index("agent_turns_queue_created_idx").on(table.status, table.submissionSequence)
  ]
);

export const agentTurnAttempts = sqliteTable(
  "agent_turn_attempts",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id")
      .notNull()
      .references(() => agentTurns.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    assistantContent: text("assistant_content").notNull().default(""),
    sourcesJson: text("sources_json").notNull().default("[]"),
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
    failureCategory: text("failure_category"),
    failureStage: text("failure_stage"),
    providerCode: text("provider_code"),
    httpStatus: integer("http_status"),
    providerRequestId: text("provider_request_id"),
    providerResponseId: text("provider_response_id"),
    transport: text("transport"),
    retryable: integer("retryable", { mode: "boolean" }),
    retryAfterMs: integer("retry_after_ms"),
    diagnosticSummary: text("diagnostic_summary"),
    timeToFirstProviderEventMs: integer("time_to_first_provider_event_ms"),
    attemptDurationMs: integer("attempt_duration_ms"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at")
  },
  (table) => [
    uniqueIndex("agent_turn_attempts_turn_number_unique").on(table.turnId, table.attemptNumber),
    index("agent_turn_attempts_turn_idx").on(table.turnId, table.attemptNumber),
    check(
      "agent_turn_attempts_failure_category_length_check",
      sql`${table.failureCategory} IS NULL OR length(${table.failureCategory}) <= 64`
    ),
    check(
      "agent_turn_attempts_failure_stage_length_check",
      sql`${table.failureStage} IS NULL OR length(${table.failureStage}) <= 64`
    ),
    check(
      "agent_turn_attempts_provider_code_length_check",
      sql`${table.providerCode} IS NULL OR length(${table.providerCode}) <= 128`
    ),
    check(
      "agent_turn_attempts_http_status_check",
      sql`${table.httpStatus} IS NULL OR ${table.httpStatus} BETWEEN 100 AND 599`
    ),
    check(
      "agent_turn_attempts_provider_request_id_length_check",
      sql`${table.providerRequestId} IS NULL OR length(${table.providerRequestId}) <= 256`
    ),
    check(
      "agent_turn_attempts_provider_response_id_length_check",
      sql`${table.providerResponseId} IS NULL OR length(${table.providerResponseId}) <= 256`
    ),
    check(
      "agent_turn_attempts_transport_length_check",
      sql`${table.transport} IS NULL OR length(${table.transport}) <= 32`
    ),
    check(
      "agent_turn_attempts_retryable_check",
      sql`${table.retryable} IS NULL OR ${table.retryable} IN (0, 1)`
    ),
    check(
      "agent_turn_attempts_retry_after_check",
      sql`${table.retryAfterMs} IS NULL OR ${table.retryAfterMs} BETWEEN 0 AND 86400000`
    ),
    check(
      "agent_turn_attempts_diagnostic_summary_length_check",
      sql`${table.diagnosticSummary} IS NULL OR length(${table.diagnosticSummary}) <= 1024`
    ),
    check(
      "agent_turn_attempts_first_event_latency_check",
      sql`${table.timeToFirstProviderEventMs} IS NULL OR ${table.timeToFirstProviderEventMs} >= 0`
    ),
    check(
      "agent_turn_attempts_duration_check",
      sql`${table.attemptDurationMs} IS NULL OR ${table.attemptDurationMs} >= 0`
    )
  ]
);

export const agentToolCache = sqliteTable(
  "agent_tool_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => spaceSnapshots.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    argumentsJson: text("arguments_json").notNull(),
    resultJson: text("result_json").notNull(),
    sourcesJson: text("sources_json").notNull().default("[]"),
    resultBytes: integer("result_bytes").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull()
  },
  (table) => [index("agent_tool_cache_snapshot_lru_idx").on(table.snapshotId, table.lastUsedAt)]
);

export const agentTurnToolResults = sqliteTable(
  "agent_turn_tool_results",
  {
    turnId: text("turn_id")
      .notNull()
      .references(() => agentTurns.id, { onDelete: "cascade" }),
    cacheKey: text("cache_key")
      .notNull()
      .references(() => agentToolCache.cacheKey, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.turnId, table.cacheKey] }),
    index("agent_turn_tool_results_turn_sequence_idx").on(table.turnId, table.sequence)
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
  repository_batches: repositoryBatches,
  repository_batch_jobs: repositoryBatchJobs,
  mcp_connections: mcpConnections,
  mcp_tool_stats: mcpToolStats,
  cbm_operation_metrics: cbmOperationMetrics,
  agent_account_sessions: agentAccountSessions,
  agent_model_preferences: agentModelPreferences,
  agent_chats: agentChats,
  agent_messages: agentMessages,
  agent_turns: agentTurns,
  agent_turn_attempts: agentTurnAttempts,
  agent_tool_cache: agentToolCache,
  agent_turn_tool_results: agentTurnToolResults
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
  repositoryBatches,
  repositoryBatchJobs,
  mcpConnections,
  mcpToolStats,
  cbmOperationMetrics,
  agentAccountSessions,
  agentModelPreferences,
  agentChats,
  agentMessages,
  agentTurns,
  agentTurnAttempts,
  agentToolCache,
  agentTurnToolResults
};

export type DatabaseTableName = keyof typeof databaseTables;
