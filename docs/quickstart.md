# MemoRepo Quickstart

This guide takes a local user from a clean checkout to a working read-only MCP connection.

## 1. Prepare Runtime

Install Docker Desktop or Docker Engine.

Create an environment file:

```bash
cp .env.example .env
```

Generate a random control token, for example:

```bash
openssl rand -hex 32
```

PowerShell 7:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
```

Edit `.env` and set the local control secret:

```bash
MEMOREPO_CONTROL_TOKEN=your-random-control-token
```

To use an existing GitHub personal access token and skip OAuth login, also set:

```bash
GH_TOKEN=your-github-token
```

`GH_TOKEN` must be able to read every repository you want to index. Leave it empty to use the default OAuth Device Flow. When both an environment token and a stored OAuth credential exist, `GH_TOKEN` takes priority.

Official builds already include MemoRepo's public GitHub OAuth Client ID. Fork maintainers and contributors can optionally set `GITHUB_OAUTH_CLIENT_ID` to use a different OAuth App during development.

Docker Compose includes the supported `codebase-memory-mcp` release. If you run the Node workspaces directly for development, install `codebase-memory-mcp` v0.9.0 on `PATH`. MemoRepo fails closed when the runtime cannot verify that `auto_index` and `auto_watch` are both disabled for immutable snapshot caches.

New Docker Compose installations use the `memorepo-data` named volume from `.env.example`. This avoids Docker Desktop bind-mount overhead during the many small reads and writes performed by Git and the indexer. For direct Node development, set `MEMOREPO_HOME` to a path outside this repository.

Existing installations remain compatible: when `MEMOREPO_STORAGE` is absent, Compose continues mounting the existing `MEMOREPO_HOME` path. To opt into the faster named volume, stop MemoRepo, back up the current state directory, copy its complete contents into the volume named by `MEMOREPO_DATA_VOLUME_NAME` (default `memorepo-data`), set `MEMOREPO_STORAGE=memorepo-data`, and start MemoRepo again. Verify that spaces and chats are present before removing the backup. On Linux bind-mount installations, create the host directory yourself before first startup because the containers run as an unprivileged user.

Keep `MEMOREPO_API_CONTAINER_NAME=memorepo-api` unless you also change `container_name` in `docker-compose.yml`.

## 2. Start MemoRepo

```bash
docker compose up --build
```

Open:

```text
http://127.0.0.1:5173
```

Paste `MEMOREPO_CONTROL_TOKEN` into the unlock screen. The dashboard keeps it only in `sessionStorage` for that browser tab.

The dashboard preflight panel should show the local runtime checks. Fix failed local checks before adding repositories; when `GH_TOKEN` is empty, a GitHub connection warning is expected until the next step.

## 3. Connect GitHub

If `GH_TOKEN` is configured, MemoRepo validates and uses it automatically. System health displays **GH_TOKEN configured** and does not request OAuth login; continue to the next step.

If `GH_TOKEN` is empty, open **System health**, choose **Sign in with GitHub**, and follow the modal:

- MemoRepo attempts to copy the one-time user code and opens GitHub's official device page;
- if the browser blocks the page, use **Continue on GitHub** from the modal;
- enter the displayed code and confirm the MemoRepo OAuth App and requested `repo` scope;
- approve the code and return to MemoRepo.

MemoRepo validates the GitHub profile before storing the credential and automatically queues the first repository sync. The connection panel then shows the account, granted scopes, and visible repository counts.

Only authorize a device code that you initiated from your local MemoRepo dashboard, and verify the expected application name on GitHub before approving it. GitHub documents the protocol in [Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).

If organization repositories are missing, review the organization's OAuth App policy and complete any required SAML SSO authorization. The OAuth scope cannot grant access the connected GitHub user does not already have.

## 4. Sync Repositories

The first sync starts after connection. Use `Sync GitHub` later whenever you want to refresh the repository catalog.

MemoRepo stores repository metadata in SQLite. It does not clone repositories during this sync; cloning starts when a repository is added to a space.

## 5. Create A Space

Click `New Space` and choose a name that matches the agent context you want, such as:

```text
analytics
```

A space isolates repository membership, snapshots, and MCP connections.

## 6. Add A Repository

Click `Add repo`.

Choose a synced repository or add one by URL:

```text
owner/repo
https://github.com/owner/repo
```

MemoRepo will enqueue jobs to clone, checkout, index, and build the first space snapshot. Open the job log to follow progress.

## 7. Connect An Agent

Click `Connect agent`.

Choose the client tab, create a read-only token, test the connection, and copy or download the generated config.

For stdio clients, the generated command uses:

```text
docker exec -i -e MEMOREPO_MCP_TOKEN=... memorepo-api node /app/dist/cli/mcp.js --space <space-slug>
```

For HTTP clients, use the local endpoint and bearer token shown in the config.

## 8. Ask A Space Directly (Optional)

After a space has an active snapshot, open **Ask this Space**, choose a provider and model, and select the connection action. Follow the provider's authorization instructions and return to MemoRepo. Use only an authorization flow that you initiated from your local dashboard.

The connection button remains disabled until you accept the data disclosure. Questions, chat history, snapshot query results, and relevant code excerpts are sent to the selected provider for inference. Repository-access credentials and the MemoRepo control token are not included in model prompts or tool request/result payloads.

The initial provider and model come from `MEMOREPO_AGENT_PROVIDER_ID` and `MEMOREPO_AGENT_MODEL_ID`; the supplied `.env.example` selects Pi's `openai-codex` provider and GPT-5.4. The dashboard can switch among OAuth-capable entries from the bundled Pi catalog while no login or running answer is active. Open **Advanced** to change verbosity or reasoning effort when the selected model supports them; unsupported controls are omitted. MemoRepo stores the global provider, model, verbosity, and reasoning-effort selection in SQLite and restores it after API restarts. If a saved selection is no longer available in the current catalog, the configured initial selection is restored. OAuth flows that Pi can complete through an external verification URL are supported; flows that require an interactive prompt inside MemoRepo, API keys, and ambient provider credentials are not. Managed OAuth credentials are stored in the private `memorepo-secrets` volume.

Ask the question directly; there is no research-mode selector. The agent chooses the investigation depth from the question and available evidence, stops naturally when the answer is supported, and reserves part of its budget to synthesize a response. `MEMOREPO_AGENT_MAX_RUN_SECONDS`, `MEMOREPO_AGENT_MAX_TOOL_CALLS`, and `MEMOREPO_AGENT_MAX_PROVIDER_ROUNDS` are high internal safety ceilings rather than user-facing quality modes. The defaults are 1,800 seconds, 200 tool calls, and 50 provider rounds.

By default, two answers run at once and up to twenty more wait in a durable FIFO queue. The panel shows current capacity and queue position. You can cancel a queued or running answer. A transient provider failure is retried automatically up to three total attempts; if recovery is exhausted, **Resume** continues the same logical turn. A best-effort answer offers **Continue investigating**. Both paths reuse successful tool results from the pinned snapshot and keep the original two transcript messages.

Waiting and active answers survive an API restart. An answer that was running resumes from its recorded attempts and cached evidence once the matching provider is available.

Chats are read-only, are pinned to the active immutable snapshot at creation time, and remain visible after signing out. If a pinned snapshot is pruned, its transcript remains readable but can no longer be continued.

Every turn records its completion reason, answer quality, attempt count, final provider stop reason, provider round count, tool-call count, and token totals. Raw model reasoning is not retained. Successful bounded read-only tool results are cached separately by immutable snapshot for recovery and are deleted with that snapshot.

Each snapshot indexes exact-commit trees stored in MemoRepo's content-addressed immutable source store. Later updates to the managed clone therefore do not change source-backed answers for a retained chat snapshot, while unchanged commits avoid another full source copy.

Snapshot materialization intentionally rejects tracked symbolic links. Replace them with regular files or directories before adding or reindexing that repository.

## 9. Recommended Agent Workflow

For the full tool contract, see [mcp-tools.md](mcp-tools.md).

When using the MCP server from an agent:

- start with `list_space_repositories` or `list_projects`;
- inspect `snapshot_index_coverage` before making an exhaustive or negative claim;
- use `list_snapshot_files` with an explicit project for file inventories or path and extension existence questions;
- use `search_snapshot_text` for exact literals and files that CBM may not index, following every page until `has_more=false`;
- use `read_snapshot_file` to verify the final source evidence;
- use `get_graph_schema` before custom Cypher;
- search with `search_graph` or `search_code`;
- use `trace_path` and `get_code_snippet` after graph or semantic search;
- use `query_graph` only for bounded read-only Cypher; `max_rows` is optional and capped at 25.

Do not interpret an empty CBM result as proof of absence when coverage is partial or unknown. A negative answer is exhaustive only when source integrity is valid, coverage reports `exhaustive=true`, the source search is complete and untruncated, and every result page was consumed.

For multi-repository spaces, omit `project` when you want CBM to use cross-repo intelligence across the whole space snapshot. Pass `project` only when you want to narrow a call to one indexed project.

## 10. When Something Fails

Use the preflight panel first. It checks GitHub connection and access, reported scopes, `codebase-memory-mcp`, `MEMOREPO_HOME` writability, disk space, and the Docker container target used by generated MCP configs.

Then open the failed job log. Job logs show phase timings and usually contain the failing GitHub, Git, indexing, or snapshot operation. Job-runner failures carry stable `MR-*` codes. Errors handled by the central API application handler return a stable code and request ID that API clients can match with server logs. A GitHub 502, 503, or 504 response is reduced to a retryable message instead of exposing an upstream HTML page.

## 11. Manage Or Revoke GitHub Access

**Disconnect locally** deletes MemoRepo's encrypted credential while keeping existing clones, indexes, and snapshots available. It does not revoke the authorization at GitHub. Use **Manage authorization on GitHub** in the connection panel to review or revoke the OAuth App itself.

If the `memorepo-secrets` Docker volume is lost or replaced, the encryption key is no longer available and you must reconnect GitHub. Back up the data directory and secrets volume together if you need restorable credentials.

## 12. Keep Local State Tidy

Use the `Data lifecycle` panel inside a space to:

- inspect snapshots and their approximate index-artifact size; shared immutable revision trees are counted separately as garbage-collection candidates when no retained snapshot references them;
- prune inactive snapshots while always keeping the active snapshot;
- run garbage collection for failed snapshot artifacts, removed clones, stale repo index records, orphan repo index directories, unreferenced revision trees, and old terminal jobs;
- delete a space together with its space-scoped MemoRepo data; revision trees still referenced by another retained snapshot remain shared, and newly unreferenced trees are removed by garbage collection.

The defaults come from:

```bash
MEMOREPO_SNAPSHOT_RETENTION=3
MEMOREPO_JOB_RETENTION_DAYS=30
MEMOREPO_JOB_CONCURRENCY=2
MEMOREPO_CBM_INDEX_CONCURRENCY=1
MEMOREPO_CBM_INTERACTIVE_CONCURRENCY=2
MEMOREPO_ENFORCE_SNAPSHOT_QUALITY=true
MEMOREPO_COMPACT_CBM_RESPONSES=true
MEMOREPO_BATCH_REPOSITORY_OPERATIONS=true
MEMOREPO_SNAPSHOT_ONLY_INDEXING=true
```

Keep quality enforcement and snapshot-only indexing enabled for normal Docker Compose use. To diagnose or immediately roll back the indexing flow without removing stored artifacts, set `MEMOREPO_SNAPSHOT_ONLY_INDEXING=false` and restart the API. The snapshot list reports CBM engine versions, index modes, source coverage, skipped files, indexing duration, artifact size, and any degraded-quality reason so rollout regressions are visible without reading server logs.

## 13. Manage Jobs

Recent jobs are shown at the bottom of the dashboard. Open a job to inspect logs, dependencies, and dependent jobs.

MemoRepo supports:

- retrying failed, skipped, or cancelled jobs;
- cancelling pending jobs before they start or requesting cancellation of an active Git, indexing, or snapshot subprocess;
- automatically marking abandoned running jobs as failed after an API restart;
- returning the existing active job when the submitted job type, scope, dependency, and canonical payload match exactly;
- configuring global job concurrency with `MEMOREPO_JOB_CONCURRENCY`, heavyweight index concurrency with `MEMOREPO_CBM_INDEX_CONCURRENCY`, and independent query capacity with `MEMOREPO_CBM_INTERACTIVE_CONCURRENCY`.

Active cancellation is cooperative: MemoRepo signals the current subprocess, escalates if it does not stop, and records the job as cancelled after the handler exits. A running row recovered without an active process cannot be cancelled safely and is marked failed during startup recovery instead.

Use `Check & update` in a space to fetch each selected remote branch and compare its commit with MemoRepo's indexed commit. Repositories that are already current are skipped. Changed or incomplete indexes are rebuilt, and MemoRepo creates one replacement space snapshot only when needed.
