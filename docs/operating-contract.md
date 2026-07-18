# MemoRepo Operating Contract

This document defines MemoRepo's public product contract for local productive use. It describes what the system manages, what it exposes to agents, and which responsibilities remain with the user.

## Purpose

MemoRepo is a local-first control plane for codebase context. It helps a developer group GitHub repositories into isolated spaces, index those repositories with `codebase-memory-mcp`, and expose the active snapshot of each space to coding agents through a constrained MCP gateway.

The product value is the operational layer around repository context: managed clones, repeatable indexing, immutable snapshots, job visibility, path redaction, and agent-ready MCP configuration. MemoRepo does not replace `codebase-memory-mcp` code intelligence; it exposes selected native CBM read tools under a space-scoped gateway.

## Supported Runtime Target

MemoRepo is designed for local Docker Compose usage.

- Windows: Docker Desktop
- macOS: Docker Desktop
- Linux: Docker Engine or Docker Desktop

The Node workspaces can be run directly for development, but productive local use should use Docker Compose. The Docker runtime keeps the API, dashboard, `git`, and `codebase-memory-mcp` environment consistent.

## Configuration Contract

MemoRepo accepts these runtime inputs:

- `MEMOREPO_CONTROL_TOKEN`: a 43-128-character URL-safe value generated from at least 32 random bytes, used to authenticate the local control API and unlock the dashboard.
- `MEMOREPO_HOME`: the local state root for SQLite data, managed clones, indexes, logs, temporary files, and helper scripts.
- `MEMOREPO_SECRETS_DIR`: the separate location for the local credential-encryption key. Docker Compose maps this to the `memorepo-secrets` named volume.
- `API_PORT`: the local API port, defaulting to `8787`.
- `MEMOREPO_PUBLIC_API_URL`: the base URL agents on the host use in generated HTTP MCP configs. Docker Compose derives it from `API_PORT`; set it manually only for unusual setups.
- `WEB_PORT`: the local dashboard port, defaulting to `5173`.
- `MEMOREPO_API_CONTAINER_NAME`: the Docker container name used by generated stdio MCP configs, defaulting to `memorepo-api`.
- `MEMOREPO_AGENT_CREDENTIAL_FILE`: an optional credential-store path override. By default it is `agent-credentials.json` under `MEMOREPO_SECRETS_DIR`; Docker Compose therefore persists it in the existing private `memorepo-secrets` volume.
- `MEMOREPO_AGENT_PROVIDER_ID` and `MEMOREPO_AGENT_MODEL_ID`: the initial Ask this Space selection. They are read from the environment; `.env.example` supplies `openai-codex` and `gpt-5.4`. The dashboard can change the in-memory selection until the API restarts.
- `MEMOREPO_AGENT_MAX_RUN_SECONDS`: the per-answer wall-clock budget, defaulting to `600`.
- `MEMOREPO_AGENT_MAX_TOOL_CALLS`: the per-answer tool-call budget, defaulting to `96`.
- `MEMOREPO_AGENT_MAX_PROVIDER_ROUNDS`: the global ceiling for provider rounds in one answer, defaulting to `16`.
- `MEMOREPO_AGENT_MAX_ACTIVE_TURNS`: the number of answers that may run concurrently, defaulting to `2`.
- `MEMOREPO_AGENT_MAX_QUEUED_TURNS`: the maximum durable waiting queue, defaulting to `20`.
- `CODEBASE_MEMORY_MCP_VERSION`: the `codebase-memory-mcp` release used by the API Docker image.
- `CODEBASE_MEMORY_MCP_SHA256_AMD64` and `CODEBASE_MEMORY_MCP_SHA256_ARM64`: trusted hashes for the portable CBM release archives. Update them together with the CBM version.
- `MEMOREPO_SNAPSHOT_RETENTION`: the default number of latest snapshots to keep when pruning a space, defaulting to `3`.
- `MEMOREPO_JOB_RETENTION_DAYS`: the default age threshold for deleting terminal jobs during garbage collection, defaulting to `30`.
- `MEMOREPO_JOB_CONCURRENCY`: the maximum number of background jobs MemoRepo runs at once, defaulting to `2`.
- `MEMOREPO_CBM_INDEX_CONCURRENCY`: the maximum number of heavyweight CBM indexing commands, defaulting to `1`.
- `MEMOREPO_CBM_INTERACTIVE_CONCURRENCY`: the independent capacity reserved for snapshot query sessions, defaulting to `2`.
- `MEMOREPO_STORAGE`: the Docker Compose storage source. New installations use the `memorepo-data` named volume; existing configurations without this variable continue using `MEMOREPO_HOME` as a bind mount.
- `MEMOREPO_DATA_VOLUME_NAME`: the physical Docker volume name used when `MEMOREPO_STORAGE` selects the managed data volume, defaulting to `memorepo-data`.
- `MEMOREPO_RATE_LIMIT_WINDOW_MS` and the `MEMOREPO_*_RATE_LIMIT_MAX` values: per-IP budgets for authentication checks, API reads, API mutations, SSE connections, and MCP requests.

Official builds include MemoRepo's public GitHub OAuth Client ID. End users do not register an OAuth App or configure a Client Secret. They may optionally provide an existing personal access token through `GH_TOKEN`; fork maintainers and local contributors may set `GITHUB_OAUTH_CLIENT_ID` as a development override.

The API Docker image pins `codebase-memory-mcp` v0.9.0. Direct Node development requires that release on `PATH`. Before a snapshot cache is indexed or queried for the first time in a process, MemoRepo verifies and, when needed, disables `auto_index` and `auto_watch`. If either setting is unavailable or cannot be confirmed as disabled, the operation fails closed rather than allowing the snapshot to follow mutable source state.

The optional **Ask this Space** integration is included in the API image. The adapter exposes OAuth-capable providers and models from the bundled Pi catalog, initializes its selection from the environment, and permits a dashboard selection change only when no provider login or answer is active. The catalog also declares supported verbosity and reasoning-effort values per model; the dashboard renders only declared controls and keeps the advanced section closed by default. Selections are in-memory runtime state and reset when the API restarts. OAuth flows that Pi can complete through an external verification URL are supported; flows that require an interactive prompt inside MemoRepo, API keys, and ambient provider credentials are unsupported. External credentials are rejected; removing a MemoRepo-managed credential still completes local sign-out even if unsupported ambient authentication remains. `AgentService` uses provider-neutral contracts with the in-process `agent-runtime`, and the runtime adapter remains the provider boundary. No separate runtime service or IPC configuration is required.

Direct Node development defaults `MEMOREPO_HOME` to `./.memorepo`. Docker Compose defaults new installations to the `memorepo-data` named volume because its small-file and SQLite I/O is substantially cheaper than a Docker Desktop host bind mount. Existing `.env` files remain compatible.

## Core Concepts

Space:
A named isolated workspace. Each space owns its repository membership, active snapshot, jobs, and MCP connections. Agents connected to one space should not see another space.

Managed repository:
A GitHub repository cloned by MemoRepo under `MEMOREPO_HOME`. The API owns this clone and may reset or clean it during checkout and reindex operations.

GitHub repository record:
The SQLite metadata MemoRepo stores for a repository visible to the connected GitHub account. It includes owner, name, visibility flags, default branch, and GitHub URLs.

Space repository:
The membership record linking one GitHub repository to one space. It tracks local clone state, selected branch, selected commit, index state, branch list, and removal state.

Job:
A background operation persisted in SQLite. Jobs cover GitHub sync, clone, checkout, branch refresh, repository indexing, and space snapshot rebuild. Jobs may depend on earlier jobs.

Repository index:
A `codebase-memory-mcp` cache for one managed repository at one selected branch and commit. Repository indexes are operational artifacts and can be regenerated.

Snapshot:
An immutable per-space index artifact. It is built by materializing each selected repository's recorded commit directly from Git into a content-addressed immutable source store, then indexing those exact trees. An unchanged repository commit reuses its existing tree instead of copying it into every replacement snapshot. A snapshot is activated only after the build succeeds, and later managed-clone changes cannot alter its source-backed query results. Tracked symbolic links are intentionally unsupported and make materialization fail closed; replace them with regular files or directories before indexing.

Active snapshot:
The snapshot currently served to MCP clients for a space. Agents query this snapshot rather than live working trees.

Stale snapshot:
An active snapshot that remains available after a repository or branch change makes it no longer reflect the desired current state. A successful reindex creates and activates a replacement snapshot.

MCP connection:
A local token plus generated client configuration for one space. Tokens are stored as hashes in SQLite. Deleting a connection prevents future use of that token and removes it from the dashboard list.

Agent chat:
A persistent visible user/assistant transcript associated with one provider account session and pinned to the exact immutable snapshot that was active when the chat started. It never follows a newer snapshot implicitly.

## What MemoRepo Does

- Discovers GitHub repositories visible to the connected account and granted OAuth scope.
- Creates local spaces that group repositories for agent context.
- Clones repositories into MemoRepo-managed paths.
- Checks out selected remote branches.
- Records the selected commit for each managed repository.
- Runs `codebase-memory-mcp` indexing.
- Builds immutable snapshots for spaces.
- Keeps the previous active snapshot available when a replacement snapshot fails.
- Exposes read-only MCP tools over the active snapshot.
- Redacts internal filesystem paths from public API and MCP responses.
- Generates MCP configs for local agents.
- Provides an optional read-only agent chat panel for each space.

## What MemoRepo Does Not Do

- It does not edit source files in managed repositories.
- It does not commit, push, merge, or open pull requests.
- It does not provide a writable agent gateway.
- It does not expose a general-purpose agent terminal, shell, editor, web browser, or external app gateway.
- It does not replace GitHub access control.
- It does not create GitHub identities, bypass repository permissions, or override organization OAuth policies.
- It does not host a public multi-user deployment by default.
- It does not expose arbitrary filesystem browsing.
- It does not guarantee a snapshot reflects remote changes until reindexing succeeds.

## Runtime Boundaries

Frontend:
The dashboard calls the API. It does not run shell commands and does not touch repository paths directly. After its initial reads, it keeps one authenticated server-sent event stream open for state invalidations and selectively refetches the affected API resources. Reconnection, returning online, and returning to a visible tab trigger a one-time reconciliation from the API. Periodic reads remain only while an external GitHub or agent-provider authorization is actively pending.

API:
The API is the only component that mutates managed clones, writes SQLite state, runs `git`, invokes `codebase-memory-mcp`, and creates MCP configs.

AgentService:
The API's provider-neutral orchestration layer owns chat and turn persistence, pins each chat to one snapshot, starts runs through `agent-runtime`, streams visible events to the dashboard, and handles runtime tool callbacks.

agent-runtime:
An in-process workspace package built into the API image. Its provider-neutral `AgentRuntimeAdapter` contract normalizes authentication, model discovery and selection, model execution, streaming events, interruption, and tool requests. The application wires that contract to the OAuth-capable provider/model catalog exposed by the bundled Pi SDK. It has no separate HTTP listener or Compose service.

SnapshotQueryService:
The provider-neutral query boundary called by `AgentService` for each runtime tool request. It resolves the request through MemoRepo's read-only gateway using the chat's exact space and snapshot identifiers, then returns the bounded result directly to the runtime callback.

SQLite:
SQLite is the source of truth for spaces, repositories, jobs, snapshots, MCP connections, provider account sessions, and visible agent chat transcripts.

Managed clones:
Managed clones are disposable operational state. MemoRepo may run branch checkout, hard reset, and clean operations against them.

Snapshots:
Snapshots are the stable read model for agents. A failed snapshot build must not replace the last active snapshot.

Maintenance:
MemoRepo can prune inactive snapshots, remove failed snapshot artifacts, clean removed repository clones, delete stale repository index records, delete orphan repository index directories, delete content-addressed revision trees no longer referenced by any retained snapshot, and delete old terminal jobs. Revision-source collection is skipped while a snapshot build is active. Maintenance operations refuse to remove active snapshots and should not run against spaces with pending or running jobs. Snapshot pruning also refuses to remove a snapshot while an agent answer pinned to it is active.

Jobs:
MemoRepo runs background jobs with configurable global concurrency. Jobs that target the same managed repository are serialized. Heavy CBM indexing is additionally bounded by its own lane, while snapshot queries use independent interactive capacity so an active index does not consume every chat slot. One CBM session is reused across the tool calls of a single agent turn and closed at the turn boundary. When a submitted job exactly matches an active job's type, space, managed repository, dependency, and canonical JSON payload, enqueue returns that existing pending or running job instead of inserting another row. This is exact input deduplication, not semantic deduplication of similar operations. A new matching job can be created after the prior one reaches a terminal state. Pending jobs can be cancelled before they start. Active jobs accept cooperative cancellation through their Git, indexing, and snapshot subprocesses, with forced termination after a bounded grace period. Failed, skipped, or cancelled jobs can be retried as new jobs with the same payload. If the API restarts while a job is running, that abandoned job is marked failed on startup so the queue can move forward.

Subprocess stdout and stderr capture, unterminated output lines, persisted job-event messages, and retained log-event counts are bounded. MemoRepo preserves recent stream output, emits explicit truncation markers when additional diagnostic output is discarded, records phase timings for clone/index/snapshot pipelines, and attaches stable `MR-*` codes to job-runner failures. Errors handled by the central API application handler include a stable code and request ID for server-log correlation; early HTTP boundary and authentication rejections keep their dedicated response shape.

The space-level check and update job fetches each selected remote branch and compares its remote commit with the commit recorded by MemoRepo. It skips current repository indexes, repairs stale or failed indexes even when the commit is unchanged, and builds one replacement snapshot only when repository or snapshot state requires it. Per-repository reindex remains an explicit forced rebuild operation.

## MCP Gateway Contract

The MCP gateway is scoped to one space and serves its active snapshot.

Available tools:

- `list_space_repositories`
- `list_projects`
- `index_status`
- `get_architecture`
- `get_graph_schema`
- `search_graph`
- `semantic_query`
- `search_code`
- `trace_path`
- `get_code_snippet`
- `query_graph`

The detailed agent-facing contract is documented in [mcp-tools.md](mcp-tools.md).

Important limits:

- `query_graph` accepts read-only Cypher only.
- `query_graph` accepts `max_rows` from 1 to 25, defaulting to 25.
- `query_graph` rejects caller-supplied limits, multiple statements, write clauses, and procedure calls, then appends the enforced `max_rows` limit itself.
- MCP graph calls have a 10 second timeout.
- Large MCP responses are truncated to the size cap with a `truncated` marker, or replaced with a structured `response_too_large` result when truncation is not possible.
- Search-style calls cap `limit` at 25.
- Multi-repository spaces share one CBM snapshot store so native cross-repo intelligence can run without manual per-repository fan-out.

The gateway should not expose internal clone paths, cache paths, clone URLs, or `MEMOREPO_HOME` paths in normal tool responses.

## Data Ownership

State under `MEMOREPO_HOME` belongs to MemoRepo.

The important categories are:

- `data`: SQLite database files.
- `spaces`: managed repository clones.
- `indexes`: repository indexes, snapshot index artifacts, and content-addressed immutable revision trees.
- `logs`: operational logs, if enabled.
- `tmp`: temporary files.
- `bin`: helper scripts such as `git-askpass.sh`.

The GitHub access token is encrypted before it is stored in SQLite. Its randomly generated encryption key lives under `MEMOREPO_SECRETS_DIR`, outside `MEMOREPO_HOME` in the default Docker layout. A backup intended to preserve the connection must protect and restore both locations together; losing the key requires reconnecting GitHub.

Repository and snapshot indexes can be regenerated. SQLite contains the durable operational record and should be backed up before destructive maintenance.

Visible agent messages, source references, chat metadata, provider account-session identifiers, selected provider/model settings, answer mode and limits, queue state, and aggregate turn diagnostics are stored in SQLite. Turn diagnostics include the final stop reason, provider round and length-stop counts, tool-call count, and input, output, reasoning, cache, and total token usage. Raw model reasoning and internal tool request or response payloads are not persisted there. Managed agent OAuth credentials are stored separately in an owner-only file under `MEMOREPO_SECRETS_DIR`; Docker Compose persists that file in the existing private `memorepo-secrets` volume.

Answers run through a configurable-capacity FIFO dispatcher. Waiting answers survive an API restart and resume when the matching provider connection is available; answers that were running during shutdown become interrupted. Queue position and aggregate capacity are part of the API contract. Queued and running answers can be cancelled, while failed or interrupted answers can be retried as new turns. A queue-full response is returned only after the configured waiting capacity is exhausted.

If an inactive snapshot is pruned, its chats keep their stored transcripts and snapshot metadata but become non-continuable. A chat pinned to a retained older snapshot remains continuable; activating a newer snapshot only offers a separate new chat.

Deleting a space through the managed-data flow removes that space's managed clones, snapshot artifacts, repository index artifacts, jobs, repository membership, local MCP connections, and the space record. Content-addressed revision trees may be shared by retained snapshots from other spaces; once unreferenced, they are removed by garbage collection. It does not delete GitHub repositories.

## Local Security Model

MemoRepo is designed for trusted local use. It binds services to localhost through Docker Compose by default.

The API validates the HTTP hostname and browser origin before routing requests. Browser origins must match the configured dashboard origin, cross-site browser requests are rejected, and POST/PUT/PATCH calls to MemoRepo routes must use a JSON content type. Except for health checks and CORS preflight, `/api` requires `MEMOREPO_CONTROL_TOKEN` as a bearer credential. State-changing `/api` methods also require `X-MemoRepo-CSRF: 1`. Local non-browser clients may omit `Origin`, but still need an allowed API hostname, the bearer credential, and the CSRF header for mutations.

The dashboard stores the control token only in the current tab's `sessionStorage`. It does not place it in URLs, build arguments, generated MCP configs, or API responses, and it does not send it to `/mcp`. That endpoint accepts separate per-connection bearer tokens. The dashboard event stream carries only typed invalidation scopes and opaque event metadata; current state remains available from the existing JSON APIs. Authentication checks, control reads, mutations, SSE handshakes, and MCP calls have separate per-IP rate limits; forwarded IP headers are not trusted.

API and dashboard responses set defensive content security, framing, referrer, content-type, and no-store cache policies. MemoRepo creates new private artifacts with a restrictive process umask and applies owner-only directory and database modes when the backing storage supports POSIX permissions. Docker Desktop bind mounts backed by Windows may not expose POSIX mode changes, so host access controls remain part of the local trust boundary.

GitHub authorization uses OAuth Device Flow for the single local user by default. When a non-empty `GH_TOKEN` is supplied in the environment, it takes priority and MemoRepo does not request OAuth login. The private device code exists only in API memory while authorization is pending. After GitHub returns an access token, MemoRepo validates the user profile and stores the token encrypted with AES-256-GCM; the encryption key is generated locally with owner-only permissions where the host filesystem supports them. Environment tokens are not copied into that store. Official builds include the public OAuth App Client ID, and no Client Secret is used.

Git remotes are stored as clean HTTPS URLs, and the active credential is supplied ephemerally through `GIT_ASKPASS` during Git operations. Git child processes receive a minimal allowlisted system environment plus only the credential variables required for that operation. CBM child processes receive no GitHub credential variables or unrelated application secrets. An environment token cannot be disconnected from the dashboard and must be removed from `.env`; disconnecting an OAuth session locally deletes its encrypted credential, while revoking the authorization remains an explicit action in GitHub settings.

MCP tokens are local secrets. Anyone who can read a generated MCP config can query that space until the connection is deleted.

Ask this Space accepts only authenticated control-plane requests. `agent-runtime` executes inside the API process and receives only dynamically declared MemoRepo snapshot query tools. Every tool request returns directly to `AgentService`, which validates the chat context and calls `SnapshotQueryService` with the pinned space and snapshot; arbitrary command, filesystem, web, and external-app tools are not registered. The system prompt includes the same repository, project-scoping, pagination, truncation, and recommended tool-flow instructions returned by the snapshot gateway, plus an investigation protocol that requires evidence verification and separates evidence from inference. Repository content is treated as untrusted evidence rather than agent instructions. At most two answers run concurrently; by default each run is limited to 600 seconds and 96 tool calls, and reconstructed history is capped at 100 messages and 192,000 UTF-8 bytes. The agent OAuth credential in `MEMOREPO_SECRETS_DIR` is a local secret and must be protected with the same care as the GitHub credential key.

Before starting provider authorization, the dashboard requires explicit consent to send questions, chat history, snapshot query results, and relevant code excerpts to the selected provider for inference. Repository-access credentials and the MemoRepo control token are excluded from model prompts and tool request/result payloads. The provider OAuth credential is kept separately and is used only to authenticate the provider request.

Anyone with access to the local Docker daemon or `MEMOREPO_HOME` should be treated as having access to MemoRepo's managed data.
