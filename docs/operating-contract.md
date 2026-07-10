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

MemoRepo expects these runtime inputs:

- `GH_TOKEN`: a GitHub personal access token used by the API container.
- `MEMOREPO_CONTROL_TOKEN`: a 43-128-character URL-safe value generated from at least 32 random bytes, used to authenticate the local control API and unlock the dashboard.
- `MEMOREPO_HOME`: the local state root for SQLite data, managed clones, indexes, logs, temporary files, and helper scripts.
- `API_PORT`: the local API port, defaulting to `8787`.
- `MEMOREPO_PUBLIC_API_URL`: the base URL agents on the host use in generated HTTP MCP configs. Docker Compose derives it from `API_PORT`; set it manually only for unusual setups.
- `WEB_PORT`: the local dashboard port, defaulting to `5173`.
- `MEMOREPO_API_CONTAINER_NAME`: the Docker container name used by generated stdio MCP configs, defaulting to `memorepo-api`.
- `CODEBASE_MEMORY_MCP_VERSION`: the `codebase-memory-mcp` release used by the API Docker image.
- `CODEBASE_MEMORY_MCP_SHA256_AMD64` and `CODEBASE_MEMORY_MCP_SHA256_ARM64`: trusted hashes for the portable CBM release archives. Update them together with the CBM version.
- `MEMOREPO_SNAPSHOT_RETENTION`: the default number of latest snapshots to keep when pruning a space, defaulting to `3`.
- `MEMOREPO_JOB_RETENTION_DAYS`: the default age threshold for deleting terminal jobs during garbage collection, defaulting to `30`.
- `MEMOREPO_JOB_CONCURRENCY`: the maximum number of background jobs MemoRepo runs at once, defaulting to `2`.
- `MEMOREPO_RATE_LIMIT_WINDOW_MS` and the `MEMOREPO_*_RATE_LIMIT_MAX` values: per-IP budgets for authentication checks, API reads, API mutations, SSE connections, and MCP requests.

`MEMOREPO_HOME` defaults to `./.memorepo` for a simple first run. For regular use, place it outside the repository source tree.

## Core Concepts

Space:
A named isolated workspace. Each space owns its repository membership, active snapshot, jobs, and MCP connections. Agents connected to one space should not see another space.

Managed repository:
A GitHub repository cloned by MemoRepo under `MEMOREPO_HOME`. The API owns this clone and may reset or clean it during checkout and reindex operations.

GitHub repository record:
The SQLite metadata MemoRepo stores for a repository visible to `GH_TOKEN`. It includes owner, name, visibility flags, default branch, and GitHub URLs.

Space repository:
The membership record linking one GitHub repository to one space. It tracks local clone state, selected branch, selected commit, index state, branch list, and removal state.

Job:
A background operation persisted in SQLite. Jobs cover GitHub sync, clone, checkout, branch refresh, repository indexing, and space snapshot rebuild. Jobs may depend on earlier jobs.

Repository index:
A `codebase-memory-mcp` cache for one managed repository at one selected branch and commit. Repository indexes are operational artifacts and can be regenerated.

Snapshot:
An immutable per-space index artifact. It is built from the selected repositories and commits in a space. A snapshot is activated only after the build succeeds.

Active snapshot:
The snapshot currently served to MCP clients for a space. Agents query this snapshot rather than live working trees.

Stale snapshot:
An active snapshot that remains available after a repository or branch change makes it no longer reflect the desired current state. A successful reindex creates and activates a replacement snapshot.

MCP connection:
A local token plus generated client configuration for one space. Tokens are stored as hashes in SQLite. Deleting a connection prevents future use of that token and removes it from the dashboard list.

## What MemoRepo Does

- Discovers GitHub repositories visible to `GH_TOKEN`.
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

## What MemoRepo Does Not Do

- It does not edit source files in managed repositories.
- It does not commit, push, merge, or open pull requests.
- It does not provide a writable agent gateway.
- It does not replace GitHub access control.
- It does not manage GitHub tokens for users.
- It does not host a public multi-user deployment by default.
- It does not expose arbitrary filesystem browsing.
- It does not guarantee a snapshot reflects remote changes until reindexing succeeds.

## Runtime Boundaries

Frontend:
The dashboard calls the API. It does not run shell commands and does not touch repository paths directly.

API:
The API is the only component that mutates managed clones, writes SQLite state, runs `git`, invokes `codebase-memory-mcp`, and creates MCP configs.

SQLite:
SQLite is the source of truth for spaces, repositories, jobs, snapshots, and MCP connections.

Managed clones:
Managed clones are disposable operational state. MemoRepo may run branch checkout, hard reset, and clean operations against them.

Snapshots:
Snapshots are the stable read model for agents. A failed snapshot build must not replace the last active snapshot.

Maintenance:
MemoRepo can prune inactive snapshots, remove failed snapshot artifacts, clean removed repository clones, delete stale repository index records, delete orphan repository index directories, and delete old terminal jobs. Maintenance operations refuse to remove active snapshots and should not run against spaces with pending or running jobs.

Jobs:
MemoRepo runs background jobs with configurable global concurrency. Jobs that target the same managed repository are serialized. When a submitted job exactly matches an active job's type, space, managed repository, dependency, and canonical JSON payload, enqueue returns that existing pending or running job instead of inserting another row. This is exact input deduplication, not semantic deduplication of similar operations. A new matching job can be created after the prior one reaches a terminal state. Pending jobs can be cancelled before they start. Failed, skipped, or cancelled jobs can be retried as new jobs with the same payload. Running jobs are not interrupted because Git and indexing commands do not yet support cooperative cancellation. If the API restarts while a job is running, that abandoned job is marked failed on startup so the queue can move forward.

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
- `detect_changes`
- `query_graph`

The detailed agent-facing contract is documented in [mcp-tools.md](mcp-tools.md).

Important limits:

- `query_graph` accepts read-only Cypher only.
- `query_graph` accepts `max_rows` from 1 to 25, defaulting to 25.
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
- `indexes`: repository and snapshot index artifacts.
- `logs`: operational logs, if enabled.
- `tmp`: temporary files.
- `bin`: helper scripts such as `git-askpass.sh`.

Repository and snapshot indexes can be regenerated. SQLite contains the durable operational record and should be backed up before destructive maintenance.

Deleting a space through the managed-data flow removes that space's managed clones, snapshot artifacts, repository index artifacts, jobs, repository membership, local MCP connections, and the space record. It does not delete GitHub repositories.

## Local Security Model

MemoRepo is designed for trusted local use. It binds services to localhost through Docker Compose by default.

The API validates the HTTP hostname and browser origin before routing requests. Browser origins must match the configured dashboard origin, cross-site browser requests are rejected, and POST/PUT/PATCH calls to MemoRepo routes must use a JSON content type. Except for health checks and CORS preflight, `/api` requires `MEMOREPO_CONTROL_TOKEN` as a bearer credential. State-changing `/api` methods also require `X-MemoRepo-CSRF: 1`. Local non-browser clients may omit `Origin`, but still need an allowed API hostname, the bearer credential, and the CSRF header for mutations.

The dashboard stores the control token only in the current tab's `sessionStorage`. It does not place it in URLs, build arguments, generated MCP configs, or API responses, and it does not send it to `/mcp`. That endpoint accepts separate per-connection bearer tokens. Authentication checks, control reads, mutations, SSE handshakes, and MCP calls have separate per-IP rate limits; forwarded IP headers are not trusted.

`GH_TOKEN` is used only by the API container. Git remotes are stored as clean HTTPS URLs, and credentials are injected through `GIT_ASKPASS` during Git operations. Git child processes receive a minimal allowlisted system environment plus the Git credential variables required for that operation. CBM child processes use the same system allowlist without `GH_TOKEN`, Git credential environment variables, or unrelated application secrets.

MCP tokens are local secrets. Anyone who can read a generated MCP config can query that space until the connection is deleted.

Anyone with access to the local Docker daemon or `MEMOREPO_HOME` should be treated as having access to MemoRepo's managed data.
