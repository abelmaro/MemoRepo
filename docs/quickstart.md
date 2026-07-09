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

Edit `.env` and set both secrets:

```bash
GH_TOKEN=your-github-token
MEMOREPO_CONTROL_TOKEN=your-random-control-token
```

For regular use, set `MEMOREPO_HOME` to a path outside this repository. The default works for a first run, but it keeps managed clones and indexes under `./.memorepo`.

On Linux, create the `MEMOREPO_HOME` directory yourself before the first `docker compose up`. The containers run as an unprivileged user, and a directory auto-created by Docker would be owned by root.

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

The dashboard preflight panel should show the local runtime checks. Fix failed checks before adding repositories.

## 3. Check GitHub Access

Use the GitHub access panel to confirm:

- the token is accepted;
- repositories are visible;
- organization repositories are visible when expected;
- SAML SSO warnings are resolved for protected organizations.

If repositories are missing, authorize the token for the relevant organization SSO flow or adjust the token scopes.

## 4. Sync Repositories

Click `Sync GitHub`.

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
docker exec -i -e MEMOREPO_MCP_TOKEN=... memorepo-api node /app/apps/api/dist/cli/mcp.js --space <space-slug>
```

For HTTP clients, use the local endpoint and bearer token shown in the config.

## 8. Recommended Agent Workflow

For the full tool contract, see [mcp-tools.md](mcp-tools.md).

When using the MCP server from an agent:

- start with `list_space_repositories` or `list_projects`;
- use `get_graph_schema` before custom Cypher;
- search with `search_graph`, `semantic_query`, or `search_code`;
- use `trace_path` and `get_code_snippet` after graph or semantic search;
- use `query_graph` only for bounded read-only Cypher; `max_rows` is optional and capped at 25.

For multi-repository spaces, omit `project` when you want CBM to use cross-repo intelligence across the whole space snapshot. Pass `project` only when you want to narrow a call to one indexed project.

## 9. When Something Fails

Use the preflight panel first. It checks GitHub token presence, GitHub access, reported scopes, `codebase-memory-mcp`, `MEMOREPO_HOME` writability, disk space, and the Docker container target used by generated MCP configs.

Then open the failed job log. Job logs usually contain the failing GitHub, Git, indexing, or snapshot operation.

## 10. Keep Local State Tidy

Use the `Data lifecycle` panel inside a space to:

- inspect snapshots and their approximate size;
- prune inactive snapshots while always keeping the active snapshot;
- run garbage collection for failed snapshot artifacts, removed clones, stale repo index records, orphan repo index directories, and old terminal jobs;
- delete a space together with MemoRepo-managed local data.

The defaults come from:

```bash
MEMOREPO_SNAPSHOT_RETENTION=3
MEMOREPO_JOB_RETENTION_DAYS=30
MEMOREPO_JOB_CONCURRENCY=2
```

## 11. Manage Jobs

Recent jobs are shown at the bottom of the dashboard. Open a job to inspect logs, dependencies, and dependent jobs.

MemoRepo supports:

- retrying failed, skipped, or cancelled jobs;
- cancelling pending jobs before they start;
- automatically marking abandoned running jobs as failed after an API restart;
- returning the existing active job when the submitted job type, scope, dependency, and canonical payload match exactly;
- configuring global job concurrency with `MEMOREPO_JOB_CONCURRENCY`.

Running jobs are not interrupted in place. If a Git or indexing command is already executing, let it finish and retry if needed.
