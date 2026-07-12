![MemoRepo](docs/assets/banner.png)

# MemoRepo

MemoRepo is a local-first dashboard for building isolated repository spaces, indexing them with `codebase-memory-mcp`, and exposing each space to coding agents through a read-only MCP gateway.

MemoRepo is meant to be run by one developer or one local workstation environment. It manages local clones, builds immutable code graph snapshots, and gives coding agents a narrow MCP interface over those snapshots.

![MemoRepo dashboard](docs/assets/dashboard.png)

## Requirements

- Docker Desktop
- A GitHub personal access token in `GH_TOKEN`
- A 43-128-character URL-safe control token in `MEMOREPO_CONTROL_TOKEN`, generated from at least 32 random bytes

For the first MVP, a classic GitHub PAT with `repo` scope is the simplest path for private repositories across users and organizations. Fine-grained tokens can work when scoped to the repositories you need.

## Supported Local Environments

The supported runtime target is Docker Compose on:

- Windows with Docker Desktop
- macOS with Docker Desktop
- Linux with Docker Engine or Docker Desktop

Running the Node workspaces directly is intended for development. Productive local use should go through Docker Compose so the API, dashboard, `git`, and `codebase-memory-mcp` runtime stay consistent.

## Run

For a first productive setup, follow [docs/quickstart.md](docs/quickstart.md).

```bash
cp .env.example .env
```

Set `GH_TOKEN` and `MEMOREPO_CONTROL_TOKEN` in `.env`, then run:

```bash
docker compose up --build
```

Open the dashboard:

```text
http://127.0.0.1:5173
```

Persistent local state lives under `MEMOREPO_HOME`, which defaults to `./.memorepo`.

For day-to-day use, prefer setting `MEMOREPO_HOME` to a path outside this repository so managed clones, indexes, and SQLite state do not sit next to the source tree.

## What MemoRepo Does

- Creates isolated repository spaces for agent context.
- Clones GitHub repositories into MemoRepo-managed local paths.
- Checks out selected remote branches and records the selected commit.
- Indexes managed clones with `codebase-memory-mcp`.
- Checks selected remote branch commits and updates only repositories whose commit or index state changed.
- Builds immutable per-space snapshots from the selected repositories.
- Exposes the active snapshot through read-only native `codebase-memory-mcp` tools under a space-scoped MCP gateway.
- Prunes old inactive snapshots and cleans local maintenance artifacts.
- Runs background jobs with retry, pending cancellation, dependency tracking, and startup recovery.
- Returns an existing pending or running job instead of adding a duplicate when the submitted job type, scope, dependency, and canonical payload match exactly.
- Generates local MCP configs for agents that can run `docker exec` or call the local HTTP endpoint.
- Lets you test a generated MCP token from the dashboard before pasting it into an agent.
- Stores operational state in SQLite under `MEMOREPO_HOME`.

## What MemoRepo Does Not Do

- It does not edit, commit, push, or open pull requests in managed repositories.
- It does not replace GitHub permissions; the visible repositories are limited by `GH_TOKEN`.
- It does not host a public multi-user service by default.
- It does not provide a general filesystem MCP server.
- It does not expose arbitrary repository paths through MCP.
- It does not guarantee that stale snapshots reflect the latest remote commits until a reindex succeeds.

## Security Model

MemoRepo is a single-user local tool. It has no user accounts or roles, but it does authenticate its local control plane:

- The API and dashboard bind to `127.0.0.1` only. Do not map these ports to other interfaces, expose them through a reverse proxy, or run MemoRepo on a shared or public host.
- The control API requires `MEMOREPO_CONTROL_TOKEN` as a bearer credential. The dashboard asks for it and keeps it only in the current tab's `sessionStorage`; it is not baked into the frontend bundle or placed in URLs.
- The API rejects unrecognized HTTP hostnames, browser origins outside the dashboard allowlist, cross-site browser requests, and non-JSON POST/PUT/PATCH calls. State-changing control requests also require an explicit CSRF header, and API/MCP request classes have separate per-IP rate limits.
- API and dashboard responses use defensive content, framing, referrer, content-type, and no-store cache policies. On POSIX-capable storage, MemoRepo also restricts managed directories and SQLite artifacts to the service account.
- Each MCP connection has its own space-scoped bearer token. The dashboard does not send the control token to `/mcp`, which accepts connection tokens instead; treat generated MCP configs as secrets and revoke connections you no longer use.
- `GH_TOKEN` stays inside the API container; API responses and logs redact it, and generated MCP configs never include it. Git child processes receive an allowlisted environment plus only the credentials needed for the Git operation, while CBM child processes receive no GitHub or unrelated application credentials.
- The MCP gateway is read-only, scoped to one space's immutable snapshot, rejects filesystem path arguments, and sanitizes internal paths out of responses.

If you need multi-user access, network exposure, or tenant isolation, MemoRepo is not the right tool as-is.

## Core Concepts

- Space: an isolated set of repositories exposed to agents as one context.
- Managed repository: a GitHub repository cloned under `MEMOREPO_HOME` for one space.
- Job: a background operation such as GitHub sync, clone, checkout, index, or snapshot rebuild.
- Repository index: the per-repository `codebase-memory-mcp` cache for one selected branch and commit.
- Snapshot: an immutable per-space artifact built from the selected repositories and commits.
- Active snapshot: the snapshot currently served to MCP clients for a space.
- Stale snapshot: an older active snapshot that remains usable after repository membership or checkout changes.
- MCP connection: a local token and generated config that lets an agent query one space snapshot.

## Operating Model

- The frontend never runs commands or touches repository paths.
- The API container is the only component that mutates managed clones.
- Repositories are cloned per space.
- SQLite is the source of truth for spaces, repositories, jobs, snapshots, and MCP connections.
- Git remotes stay clean HTTPS URLs; `GH_TOKEN` is injected through `GIT_ASKPASS`.
- The MCP gateway is read-only and serves the active immutable snapshot for a single space.
- Native CBM read tools such as `search_graph`, `semantic_query`, `trace_path`, `get_code_snippet`, `get_architecture`, `get_graph_schema`, `search_code`, and `query_graph` are exposed with MemoRepo scope and safety policy.
- Multi-repository spaces are served from one CBM snapshot store so CBM can use cross-repo graph intelligence.
- `query_graph` is available to agents with a maximum of 25 rows and a 10 second timeout.
- Generated stdio MCP configs use `docker exec` against the stable `memorepo-api` container.

For the detailed product and runtime contract, see [docs/operating-contract.md](docs/operating-contract.md). For the agent-facing MCP tool contract, see [docs/mcp-tools.md](docs/mcp-tools.md).

## Contributing and Security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before
opening a change and follow the [Code of Conduct](CODE_OF_CONDUCT.md) when
participating in the project.

Do not report suspected vulnerabilities in public issues. Follow the private
disclosure process in the [Security Policy](.github/SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
