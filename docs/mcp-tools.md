# MemoRepo MCP Tools

MemoRepo exposes one read-only MCP server per space. Each connection is scoped to the active immutable snapshot for that space and requires a local bearer token generated from the dashboard.

The agent-facing graph tools use native `codebase-memory-mcp` names. MemoRepo acts as the space gateway: it selects the snapshot store, validates optional project scope, caps large responses, redacts internal paths, and blocks write-style graph queries.

Use `Connect agent` in the dashboard to create a connection, test it, and copy or download the generated client config.

## Connection Modes

Generated stdio configs run the server inside the API container:

```text
docker exec -i -e MEMOREPO_MCP_TOKEN=... memorepo-api node /app/dist/cli/mcp.js --space <space-slug>
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

For multi-repository spaces, omit `project` to have MemoRepo run the tool against every repository in the immutable snapshot. Pass `project` only when you intentionally want to narrow a call to one indexed project.

MemoRepo internally paginates each project as needed, then aggregates projectless graph searches into one deterministic, round-robin `results` array and adds `project` to every item. Responses include the combined `total` and `has_more`, allowing offsets beyond the first 100 candidates without silently losing repositories. Other projectless tools return a `projects` array with one result per project. If only some projects fail, the successful data is returned with `partial: true` and a `project_errors` array. If every project fails, the tool result has `isError: true` with actionable feedback.

## Common Limits

- Tools read from the active snapshot, not live working trees.
- If no active snapshot exists, tools return `no_active_snapshot`.
- A stale active snapshot remains queryable until a successful reindex activates a replacement.
- Graph calls have a 10 second timeout.
- Search-style calls require a positive integer `limit` and cap values above `25` at `25`.
- Empty search queries and code patterns are rejected instead of being treated as broad listing operations.
- Search offsets must be non-negative integers.
- Trace depth must be an integer from `1` to `5`.
- `query_graph` accepts `max_rows` from `1` to `25`, defaulting to `25`. For projectless calls this is a global limit distributed across projects.
- Large responses are truncated to the size limit with a `truncated` marker; when nothing can be truncated they are replaced with `response_too_large`.
- Internal clone paths, cache paths, clone URLs, and `MEMOREPO_HOME` paths are redacted from normal tool responses.
- MCP tokens are local secrets. Delete a connection from the dashboard if a config is no longer trusted.
- Correctable tool failures and invalid argument values are returned as MCP tool results with `isError: true`; malformed protocol requests remain JSON-RPC errors.

## Tools

### `list_space_repositories`

Lists compact MemoRepo repository metadata for the current space.

Arguments:

- `include_branches` optional boolean, default `false`.
- `include_details` optional boolean, default `false`.

Use this when you need MemoRepo metadata such as selected branch, selected commit, clone status, index status, or the CBM `project` names for repositories in the space.

The default response is intentionally compact and contains only `fullName` and `project`. Set `include_details: true` for repository IDs, selected revisions, lifecycle status, URLs, and other metadata; set `include_branches: true` for the branch array.

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

Supported aspects are `languages`, `packages`, `entry_points`, `routes`, `hotspots`, `boundaries`, `layers`, `clusters`, and `adr`. Unknown aspects are rejected with an actionable tool error.

Without `project`, this asks CBM for the architecture of the whole space snapshot store, including cross-repo context when available.

HTTP endpoint paths such as `/users/login` are preserved as routes and are not treated as filesystem paths by public-response sanitization.

If the underlying engine does not return a requested aspect, MemoRepo includes a warning instead of silently hiding the unsupported or misspelled value.

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
- `offset` optional non-negative integer.

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
- `offset` optional integer from `0` to `224`.

Use this for literals, error messages, route strings, config keys, and text that may not be represented as a graph symbol.

Code text matching is case-sensitive. Responses include `offset`, `effective_limit`, `returned`, and `has_more`; increase `offset` to recover matches beyond the first 25. For projectless searches, `candidate_count` is computed from a fixed snapshot-and-query candidate window, so it remains stable across pages.

### `trace_path`

Runs native CBM graph traversal for a function or method.

Arguments:

- `project` optional string.
- `function_name` required string.
- `direction` optional string: `inbound`, `outbound`, or `both`.
- `depth` optional integer from `1` to `5`.

Use names returned by `search_graph` or `semantic_query`.

`qualified_name` accepts the exact project-prefixed value returned by discovery tools; MemoRepo also resolves the engine's internal project-relative form when necessary. When both identifiers are supplied, `function_name` must match the symbol resolved by `qualified_name`; contradictory identifiers are rejected.

### `get_code_snippet`

Runs native CBM snippet lookup by qualified symbol name.

Arguments:

- `project` optional string.
- `qualified_name` required string.
- `include_neighbors` optional boolean, default `false`.

This tool does not accept arbitrary filesystem paths.

`qualified_name` must contain a non-whitespace symbol name. Snippet responses include `project` separately and expose `file_path` relative to the repository root, matching search results.

When native recursion flags contradict the returned source—for example, a method calls a same-named method on another object—MemoRepo clears the unsupported self-recursion flags and adds an `analysis_warnings` entry.

Synthetic route nodes without source are marked with `synthetic: true` and `source_available: false`. Fictitious file paths, line ranges, empty methods/handlers, and unavailable-source placeholders are omitted.

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
- `offset` optional integer from `0` to `224`; requires an explicit `project`.

`query_graph` rejects multiple statements, caller-supplied `LIMIT` clauses, write operations, and procedure calls. MemoRepo controls the internal query window from `offset` and `max_rows`, then returns at most `max_rows` rows.

Without `project`, query results are grouped by project so rows or columns from different repository graphs are never mixed ambiguously. The response includes `max_rows_scope: "global"`; when the limit is lower than the project count, it also identifies projects omitted from that call.

The supported read-only subset starts with `MATCH`. Standalone `RETURN`, `UNWIND`, and unsupported clauses are rejected before execution with an actionable message. `ORDER BY` is rejected because the installed engine does not apply it reliably; sort returned pages client-side.

Caller-supplied `SKIP` is rejected. For scoped pagination, pass `offset`; MemoRepo expands the internal query window before slicing so later pages are not lost to `max_rows`.

Read-only property access remains valid even when a property is named `create`, `delete`, `set`, or `remove`; mutation keywords are evaluated in Cypher context rather than as raw substrings.

The exact broad count `MATCH (n) RETURN count(n)` is answered from snapshot index status to avoid the native engine's internal scan ceiling. Other aggregate queries that hit that ceiling fail explicitly instead of returning a potentially inaccurate value; narrow them by label or filters.

## Not Exposed

MemoRepo does not expose CBM tools that mutate graph state from agent connections, including `index_repository` and `delete_project`. Indexing and lifecycle changes are owned by MemoRepo jobs and the dashboard.

Native response hints that recommend unavailable mutation tools are replaced with a read-only notice before being returned to the client.

Label recovery hints from structured search are rebuilt from the selected project's graph schema instead of forwarding a static engine-wide list.
