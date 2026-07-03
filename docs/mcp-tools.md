# MemoRepo MCP Tools

MemoRepo exposes one read-only MCP server per space. Each connection is scoped to the active immutable snapshot for that space and requires a local bearer token generated from the dashboard.

The agent-facing graph tools use native `codebase-memory-mcp` names. MemoRepo acts as the space gateway: it selects the snapshot store, validates optional project scope, caps large responses, redacts internal paths, and blocks write-style graph queries.

Use `Connect agent` in the dashboard to create a connection, test it, and copy or download the generated client config.

## Connection Modes

Generated stdio configs run the server inside the API container:

```text
docker exec -i -e MEMOREPO_MCP_TOKEN=... memorepo-api node /app/apps/api/dist/cli/mcp.js --space <space-slug>
```

Generated HTTP configs call:

```text
http://127.0.0.1:8787/mcp/<space-slug>
Authorization: Bearer <token>
```

The host and port come from `MEMOREPO_PUBLIC_API_URL`, which Docker Compose derives from `API_PORT`, so generated configs follow a custom port automatically.

The HTTP endpoint supports normal JSON-RPC MCP calls such as `initialize`, `tools/list`, and `tools/call`.

When the connection token is valid, `initialize` returns `instructions` with the space summary: repositories with their project names, branches, commits, the active snapshot version, and the recommended tool flow. Agents can usually skip a separate `list_space_repositories` discovery call.

## Recommended Agent Workflow

1. Start with `list_space_repositories` or `list_projects`.
2. Use `get_graph_schema` before custom Cypher.
3. Use `get_architecture` for a high-level map of the active space snapshot.
4. Use `search_graph`, `semantic_query`, or `search_code` for discovery.
5. Use `trace_path` and `get_code_snippet` with names returned by CBM search tools.
6. Use `query_graph` for bounded read-only Cypher only when the higher-level tools are not enough.

For multi-repository spaces, omit `project` when you want CBM cross-repo intelligence across the whole space store. Pass `project` only when you intentionally want to narrow a call to one indexed project.

## Common Limits

- Tools read from the active snapshot, not live working trees.
- If no active snapshot exists, tools return `no_active_snapshot`.
- A stale active snapshot remains queryable until a successful reindex activates a replacement.
- Graph calls have a 10 second timeout.
- Search-style calls cap `limit` at `25`.
- `query_graph` accepts `max_rows` from `1` to `25`, defaulting to `25`.
- Large responses are truncated to the size limit with a `truncated` marker; when nothing can be truncated they are replaced with `response_too_large`.
- Internal clone paths, cache paths, clone URLs, and `MEMOREPO_HOME` paths are redacted from normal tool responses.
- MCP tokens are local secrets. Delete a connection from the dashboard if a config is no longer trusted.

## Tools

### `list_space_repositories`

Lists compact MemoRepo repository metadata for the current space.

Arguments:

- `include_branches` optional boolean, default `false`.
- `include_details` optional boolean, default `false`.

Use this when you need MemoRepo metadata such as selected branch, selected commit, clone status, index status, or the CBM `project` names for repositories in the space.

### `list_projects`

Runs native CBM `list_projects` against the active space snapshot store.

Arguments: none.

### `index_status`

Runs native CBM `index_status`.

Arguments:

- `project` optional string. MemoRepo accepts either the CBM project name or the repository full name and maps it to the CBM project.

### `get_architecture`

Runs native CBM `get_architecture`.

Arguments:

- `project` optional string.
- `aspects` optional string array.

Without `project`, this asks CBM for the architecture of the whole space snapshot store, including cross-repo context when available.

### `get_graph_schema`

Runs native CBM `get_graph_schema`.

Arguments:

- `project` optional string.

### `search_graph`

Runs native CBM structured graph search.

Arguments:

- `project` optional string.
- `query` optional string.
- `name_pattern` optional string.
- `label` optional string.
- `file_pattern` optional string.
- `min_degree` optional number.
- `max_degree` optional number.
- `limit` optional integer, max `25`.
- `offset` optional integer.

### `semantic_query`

Runs native CBM semantic search.

Arguments:

- `project` optional string.
- `query` required string.
- `limit` optional integer, max `25`.

### `search_code`

Runs native CBM indexed code text search.

Arguments:

- `project` optional string.
- `pattern` required string.
- `regex` optional boolean, default `false`.
- `limit` optional integer, max `25`.

Use this for literals, error messages, route strings, config keys, and text that may not be represented as a graph symbol.

### `trace_path`

Runs native CBM graph traversal for a function or method.

Arguments:

- `project` optional string.
- `function_name` required string.
- `direction` optional string: `inbound`, `outbound`, or `both`.
- `depth` optional integer from `1` to `5`.

Use names returned by `search_graph` or `semantic_query`.

### `get_code_snippet`

Runs native CBM snippet lookup by qualified symbol name.

Arguments:

- `project` optional string.
- `qualified_name` required string.
- `include_neighbors` optional boolean, default `false`.

This tool does not accept arbitrary filesystem paths.

### `detect_changes`

Runs native CBM change impact analysis.

Arguments:

- `project` optional string.

### `query_graph`

Runs bounded read-only Cypher against the active space snapshot store.

Arguments:

- `project` optional string.
- `query` required string.
- `max_rows` optional integer from `1` to `25`, defaulting to `25`.

`query_graph` rejects write operations such as `CREATE`, `MERGE`, `SET`, `DELETE`, `REMOVE`, `DROP`, `LOAD CSV`, and `CALL db.*`. If the query does not include a `LIMIT`, MemoRepo appends one from `max_rows`.

## Not Exposed

MemoRepo does not expose CBM tools that mutate graph state from agent connections, including `index_repository` and `delete_project`. Indexing and lifecycle changes are owned by MemoRepo jobs and the dashboard.
