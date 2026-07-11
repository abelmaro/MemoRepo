import path from "node:path";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/connection.js";
import { insertRecord, updateRecord } from "../db/sql.js";
import { NotFoundError } from "../domain/errors.js";
import { sanitizePublicMessage } from "../domain/publicSanitize.js";
import { createId, createSecretToken, sha256 } from "../domain/ids.js";
import { nowIso } from "../domain/time.js";
import type { CbmService } from "./cbmService.js";
import type { SnapshotManifest } from "./snapshotService.js";
import type { SpaceService } from "./spaceService.js";

const QUERY_GRAPH_MAX_ROWS = 25;
const QUERY_GRAPH_TIMEOUT_MS = 10_000;
const MCP_RESPONSE_MAX_BYTES = 50_000;
const SEARCH_RESULT_MAX_LIMIT = 25;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const MANIFEST_CACHE_MAX_ENTRIES = 16;
const CBM_RESPONSE_CACHE_MAX_ENTRIES = 256;
const CBM_RESPONSE_CACHE_MAX_ITEM_BYTES = 200_000;

const DIRECT_CBM_READ_TOOLS = new Set([
  "list_projects",
  "index_status",
  "get_architecture",
  "get_graph_schema",
  "search_graph",
  "semantic_query",
  "search_code",
  "trace_path",
  "get_code_snippet",
  "detect_changes"
]);

const FORBIDDEN_CBM_INPUT_KEYS = new Set([
  "absolute_path",
  "absolutePath",
  "cache_dir",
  "cacheDir",
  "cache_path",
  "cachePath",
  "local_path",
  "localPath",
  "repo_path",
  "repoPath",
  "root_path",
  "rootPath",
  "source_path",
  "sourcePath"
]);

export class McpGateway {
  private readonly manifestCache = new Map<string, SnapshotManifest>();
  private readonly cbmResponseCache = new Map<string, unknown>();

  constructor(
    private readonly database: AppDatabase,
    private readonly config: AppConfig,
    private readonly spacesService: SpaceService,
    private readonly cbm: CbmService
  ) {}

  createConnection(spaceId: string, name: string, client: string) {
    const space = this.spacesService.getSpaceById(spaceId);
    const token = createSecretToken();
    const timestamp = nowIso();
    const record = {
      id: createId("mcp"),
      spaceId,
      name,
      client,
      tokenHash: sha256(token),
      createdAt: timestamp,
      lastUsedAt: null,
      revokedAt: null
    };

    insertRecord(this.database, "mcp_connections", record);

    return {
      connection: { ...record, tokenHash: undefined },
      token,
      configs: this.buildConfigs(space.slug, token)
    };
  }

  listConnections(spaceId: string) {
    return this.database.sqlite
      .prepare(
        `
        SELECT id, space_id, name, client, created_at, last_used_at, revoked_at
        FROM mcp_connections
        WHERE space_id = ?
        ORDER BY created_at DESC
      `
      )
      .all(spaceId);
  }

  revokeConnection(connectionId: string) {
    const timestamp = nowIso();
    updateRecord(this.database, "mcp_connections", { revokedAt: timestamp }, "id", connectionId);
    return { revokedAt: timestamp };
  }

  deleteConnection(connectionId: string) {
    const deletedAt = nowIso();
    const result = this.database.sqlite.prepare("DELETE FROM mcp_connections WHERE id = ?").run(connectionId);
    if (result.changes === 0) {
      throw new NotFoundError("MCP connection not found");
    }
    return { deletedAt };
  }

  async handleJsonRpc(spaceSlug: string, token: string, request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    try {
      if (!request.id && request.method?.startsWith("notifications/")) {
        return null;
      }

      if (request.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            protocolVersion: protocolVersionFrom(request.params),
            capabilities: { tools: {} },
            serverInfo: { name: `memorepo-${spaceSlug}`, version: "0.1.8" },
            instructions: await this.buildInstructions(spaceSlug, token)
          }
        };
      }

      await this.assertConnection(spaceSlug, token);

      if (request.method === "tools/list") {
        return { jsonrpc: "2.0", id: request.id ?? null, result: { tools: await this.availableTools(spaceSlug, token) } };
      }

      if (request.method === "tools/call") {
        const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        if (!params?.name) {
          throw new Error("tools/call requires a tool name");
        }
        const result = await this.callTool(spaceSlug, token, params.name, params.arguments ?? {});
        return {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }]
          }
        };
      }

      throw new Error(`Unsupported MCP method: ${request.method}`);
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: {
          code: -32000,
          message: sanitizePublicMessage(error, [this.config.memorepoHome])
        }
      };
    }
  }

  async callTool(spaceSlug: string, token: string, toolName: string, args: Record<string, unknown>) {
    const { space, snapshot, manifest } = await this.snapshotContext(spaceSlug, token);
    const response = limitMcpResponse(await this.toolResult(space, snapshot, manifest, toolName, args));
    this.recordToolStats(space.id, toolName, responseBytes(response));
    return response;
  }

  listToolStats(spaceId: string) {
    return this.database.sqlite
      .prepare(
        `
        SELECT
          tool_name AS toolName,
          call_count AS callCount,
          total_response_bytes AS totalResponseBytes,
          max_response_bytes AS maxResponseBytes,
          last_called_at AS lastCalledAt
        FROM mcp_tool_stats
        WHERE space_id = ?
        ORDER BY total_response_bytes DESC
      `
      )
      .all(spaceId);
  }

  private async toolResult(
    space: SpaceRow,
    snapshot: SnapshotRow | null,
    manifest: SnapshotManifest | null,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (!snapshot || !manifest) {
      return {
        status: "no_active_snapshot",
        message: "No active snapshot for this space. Open MemoRepo and run Reindex space.",
        space: {
          id: space.id,
          name: space.name,
          slug: space.slug,
          snapshotStatus: space.snapshotStatus
        },
        repositories: this.mcpRepositories(space.id, null, repositoryListOptions(args))
      };
    }

    switch (toolName) {
      case "list_space_repositories":
        return {
          ...this.withSnapshotMeta(space, snapshot, manifest, {
            repositories: this.mcpRepositories(space.id, manifest, repositoryListOptions(args))
          }),
          space: { name: space.name, slug: space.slug, snapshotStatus: space.snapshotStatus }
        };
      case "query_graph":
        return this.queryGraph(space, snapshot, manifest, args);
      default:
        if (DIRECT_CBM_READ_TOOLS.has(toolName)) {
          return this.callCbmReadTool(space, snapshot, manifest, toolName, args);
        }
        throw new Error(`Unknown MCP tool: ${toolName}`);
    }
  }

  private recordToolStats(spaceId: string, toolName: string, bytes: number): void {
    this.database.sqlite
      .prepare(
        `
        INSERT INTO mcp_tool_stats (space_id, tool_name, call_count, total_response_bytes, max_response_bytes, last_called_at)
        VALUES (?, ?, 1, ?, ?, ?)
        ON CONFLICT(space_id, tool_name) DO UPDATE SET
          call_count = call_count + 1,
          total_response_bytes = total_response_bytes + excluded.total_response_bytes,
          max_response_bytes = MAX(max_response_bytes, excluded.max_response_bytes),
          last_called_at = excluded.last_called_at
      `
      )
      .run(spaceId, toolName, bytes, bytes, nowIso());
  }

  private async buildInstructions(spaceSlug: string, token: string): Promise<string> {
    const recommendedFlow = `Recommended flow: get_graph_schema before custom Cypher; use an advertised search tool to locate symbols, then trace_path or get_code_snippet. Tool availability is negotiated with the installed CBM engine. Search limits cap at ${SEARCH_RESULT_MAX_LIMIT} results and query_graph at ${QUERY_GRAPH_MAX_ROWS} rows.`;

    try {
      const { space, snapshot, manifest } = await this.snapshotContext(spaceSlug, token);
      if (!snapshot || !manifest) {
        return [
          `MemoRepo serves read-only code intelligence for the "${space.name}" space, but it has no active snapshot yet.`,
          "Ask the user to open the MemoRepo dashboard and run Reindex space, then reconnect."
        ].join("\n");
      }

      const stale = space.snapshotStatus === "stale";
      const repositories = manifest.repositories
        .map((repo) => `- ${repo.fullName} (project: ${repo.projectName}, branch: ${repo.branch}, commit: ${repo.commit.slice(0, 12)})`)
        .join("\n");

      return [
        `MemoRepo serves read-only code intelligence for the "${space.name}" space from immutable snapshot v${snapshot.version}${stale ? " (stale: repositories changed after this snapshot was built)" : ""}.`,
        `Repositories in this snapshot:\n${repositories}`,
        'Pass "project" to scope a tool to one repository; omit it to search across all of them.',
        recommendedFlow
      ].join("\n\n");
    } catch {
      return [
        `MemoRepo serves read-only code intelligence for the "${spaceSlug}" space from an immutable snapshot.`,
        "Start with list_space_repositories to see repositories and project names.",
        recommendedFlow
      ].join("\n\n");
    }
  }

  private async assertConnection(spaceSlug: string, token: string) {
    const space = this.spacesService.getSpaceBySlug(spaceSlug);
    const tokenHash = sha256(token);
    const connection = this.database.sqlite
      .prepare(
        `
        SELECT
          id,
          space_id AS spaceId,
          token_hash AS tokenHash,
          last_used_at AS lastUsedAt,
          revoked_at AS revokedAt
        FROM mcp_connections
        WHERE token_hash = ?
      `
      )
      .get(tokenHash) as McpConnectionRow | undefined;

    if (!connection || connection.spaceId !== space.id || connection.revokedAt) {
      throw new Error("Invalid or revoked MCP token");
    }

    const lastUsedMs = connection.lastUsedAt ? Date.parse(connection.lastUsedAt) : Number.NaN;
    if (Number.isNaN(lastUsedMs) || Date.now() - lastUsedMs >= LAST_USED_WRITE_INTERVAL_MS) {
      updateRecord(this.database, "mcp_connections", { lastUsedAt: nowIso() }, "id", connection.id);
    }

    return { space, connection };
  }

  private async snapshotContext(spaceSlug: string, token: string) {
    const { space } = await this.assertConnection(spaceSlug, token);
    if (!space.activeSnapshotId) {
      return { space, snapshot: null, manifest: null };
    }

    const snapshot = this.database.sqlite
      .prepare(
        `
        SELECT
          id,
          version,
          status,
          artifact_path AS artifactPath,
          manifest_json AS manifestJson,
          created_at AS createdAt,
          activated_at AS activatedAt
        FROM space_snapshots
        WHERE id = ?
      `
      )
      .get(space.activeSnapshotId) as SnapshotRow | undefined;

    if (!snapshot) {
      return { space, snapshot: null, manifest: null };
    }

    return {
      space,
      snapshot,
      manifest: this.manifestFor(snapshot)
    };
  }

  private manifestFor(snapshot: SnapshotRow): SnapshotManifest {
    const cached = this.manifestCache.get(snapshot.id);
    if (cached) {
      return cached;
    }

    const manifest = JSON.parse(snapshot.manifestJson) as SnapshotManifest;
    evictOldest(this.manifestCache, MANIFEST_CACHE_MAX_ENTRIES);
    this.manifestCache.set(snapshot.id, manifest);
    return manifest;
  }

  private async cachedCbmTool(snapshot: SnapshotRow, toolName: string, input: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const key = `${snapshot.id}\n${toolName}\n${stableStringify(input)}`;
    if (this.cbmResponseCache.has(key)) {
      const cached = this.cbmResponseCache.get(key);
      this.cbmResponseCache.delete(key);
      this.cbmResponseCache.set(key, cached);
      return cached;
    }

    const response = await this.cbm.tool(toolName, input, snapshot.artifactPath, timeoutMs);
    if (responseBytes(response) <= CBM_RESPONSE_CACHE_MAX_ITEM_BYTES) {
      evictOldest(this.cbmResponseCache, CBM_RESPONSE_CACHE_MAX_ENTRIES);
      this.cbmResponseCache.set(key, response);
    }
    return response;
  }

  private async queryGraph(space: SpaceRow, snapshot: SnapshotRow, manifest: SnapshotManifest, args: Record<string, unknown>) {
    const query = requiredString(args.query, "query").trim().replace(/;+$/, "");
    const maxRowsValue = args.max_rows ?? QUERY_GRAPH_MAX_ROWS;
    if (typeof maxRowsValue !== "number" || !Number.isInteger(maxRowsValue)) {
      throw new Error("query_graph max_rows must be an integer");
    }
    if (maxRowsValue < 1 || maxRowsValue > QUERY_GRAPH_MAX_ROWS) {
      throw new Error(`query_graph max_rows must be between 1 and ${QUERY_GRAPH_MAX_ROWS}`);
    }
    const queryStructure = maskCypherLiteralsAndComments(query);
    if (queryStructure.includes(";")) {
      throw new Error("query_graph accepts exactly one Cypher statement");
    }
    if (/\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|LOAD\s+CSV|CALL|FOREACH|USE)\b/i.test(queryStructure)) {
      throw new Error("query_graph only accepts read-only Cypher");
    }
    if (/\bLIMIT\b/i.test(queryStructure)) {
      throw new Error("query_graph LIMIT is controlled by max_rows; remove LIMIT from the query");
    }

    const scopedQuery = `${query} LIMIT ${maxRowsValue}`;
    const input = this.scopedCbmArgs(manifest, args, "query_graph");
    input.query = scopedQuery;
    input.max_rows = maxRowsValue;
    const response = await this.cachedCbmTool(snapshot, "query_graph", input, QUERY_GRAPH_TIMEOUT_MS);

    return this.withCbmResponse(space, snapshot, manifest, response);
  }

  private async callCbmReadTool(
    space: SpaceRow,
    snapshot: SnapshotRow,
    manifest: SnapshotManifest,
    toolName: string,
    args: Record<string, unknown>
  ) {
    const input = this.scopedCbmArgs(manifest, args, toolName);
    if (toolName === "search_graph" || toolName === "search_code" || toolName === "semantic_query") {
      input.limit = boundedLimit(args.limit, 10, SEARCH_RESULT_MAX_LIMIT);
    }
    if (toolName === "trace_path") {
      return this.tracePath(space, snapshot, manifest, input);
    }
    const response = await this.cachedCbmTool(snapshot, toolName, input, QUERY_GRAPH_TIMEOUT_MS);
    return this.withCbmResponse(space, snapshot, manifest, response);
  }

  private async availableTools(spaceSlug: string, token: string) {
    const declared = this.tools();
    const { snapshot } = await this.snapshotContext(spaceSlug, token);
    const native = new Set(await this.cbm.listTools(snapshot?.artifactPath ?? this.config.memorepoHome));
    return declared.filter((candidate) =>
      candidate.name === "list_space_repositories" || (candidate.name === "query_graph" ? native.has("query_graph") : native.has(candidate.name))
    );
  }

  private async tracePath(
    space: SpaceRow,
    snapshot: SnapshotRow,
    manifest: SnapshotManifest,
    input: Record<string, unknown>
  ) {
    const requestedName = requiredString(input.function_name, "function_name");
    const qualifiedName = optionalString(input.qualified_name);
    const selector = qualifiedName
      ? `n.qualified_name = '${escapeCypherString(qualifiedName)}'`
      : `n.name = '${escapeCypherString(requestedName)}'`;
    const candidatesResponse = await this.cachedCbmTool(snapshot, "query_graph", {
      ...(optionalString(input.project) ? { project: input.project } : {}),
      query: `MATCH (n) WHERE (n:Function OR n:Method) AND ${selector} RETURN n.name AS name, n.qualified_name AS qualified_name, n.file_path AS file_path LIMIT 20`,
      max_rows: 20
    }, QUERY_GRAPH_TIMEOUT_MS);
    const candidates = graphRows(candidatesResponse);
    if (candidates.length > 1 && !qualifiedName) {
      throw new Error(`trace_path symbol "${requestedName}" is ambiguous; retry with qualified_name from search_graph`);
    }
    if (candidates.length === 0) {
      throw new Error(`trace_path could not resolve function or method "${qualifiedName ?? requestedName}"`);
    }

    const selected = candidates[0]!;
    const selectedQualifiedName = String(selected[1]);
    const nativeInput: Record<string, unknown> = { ...input, function_name: String(selected[0]) };
    delete nativeInput.qualified_name;
    const response = await this.cachedCbmTool(snapshot, "trace_path", nativeInput, QUERY_GRAPH_TIMEOUT_MS);
    const referencesResponse = await this.cachedCbmTool(snapshot, "query_graph", {
      ...(optionalString(input.project) ? { project: input.project } : {}),
      query: `MATCH (source)-[r:USAGE]->(target) WHERE target.qualified_name = '${escapeCypherString(selectedQualifiedName)}' RETURN source.name AS name, source.qualified_name AS qualified_name, source.file_path AS file_path, r.callee AS callee LIMIT 25`,
      max_rows: 25
    }, QUERY_GRAPH_TIMEOUT_MS);
    const references = graphRows(referencesResponse).map((row) => ({
      name: row[0], qualified_name: row[1], file_path: row[2], callee: row[3], relation: "USAGE"
    }));
    const data = isRecord(response) ? response : { result: response };
    return this.withCbmResponse(space, snapshot, manifest, {
      ...data,
      resolved_symbol: { name: selected[0], qualified_name: selected[1], file_path: selected[2] },
      references,
      confidence_notice: "CALLS edges are static-analysis results. USAGE references include callbacks and functions passed as values."
    });
  }

  private scopedCbmArgs(manifest: SnapshotManifest, args: Record<string, unknown>, toolName: string): Record<string, unknown> {
    const input: Record<string, unknown> = { ...args };
    delete input.all_projects;
    for (const key of Object.keys(input)) {
      if (FORBIDDEN_CBM_INPUT_KEYS.has(key)) {
        throw new Error(`${toolName} cannot receive filesystem path arguments through MemoRepo MCP`);
      }
    }

    const requestedProject = optionalString(args.project);
    if (!requestedProject) {
      delete input.project;
      return input;
    }

    const repository = manifest.repositories.find(
      (candidate) => candidate.projectName === requestedProject || candidate.fullName === requestedProject
    );
    if (!repository) {
      throw new Error(`${toolName} project is outside this space snapshot`);
    }
    input.project = repository.projectName;
    return input;
  }

  private withSnapshotMeta(space: SpaceRow, snapshot: SnapshotRow, manifest: SnapshotManifest, data: Record<string, unknown>) {
    const stale = space.snapshotStatus === "stale";
    return {
      ...(sanitizeMcpValue(data, manifest, this.config.memorepoHome) as Record<string, unknown>),
      snapshot: { version: snapshot.version, ...(stale ? { stale: true } : {}) }
    };
  }

  private withCbmResponse(space: SpaceRow, snapshot: SnapshotRow, manifest: SnapshotManifest, response: unknown) {
    return this.withSnapshotMeta(space, snapshot, manifest, isRecord(response) ? response : { result: response });
  }

  private tools() {
    return [
      tool(
        "list_space_repositories",
        "List compact repositories and project names for this MemoRepo space. Branches and detailed metadata are omitted unless explicitly requested.",
        {
          type: "object",
          properties: {
            include_branches: { type: "boolean" },
            include_details: { type: "boolean" }
          }
        }
      ),
      tool("list_projects", "List CBM projects available inside this MemoRepo space snapshot.", {}),
      tool("index_status", "Check CBM indexing status for this space snapshot or one project inside it.", {
        type: "object",
        properties: {
          project: { type: "string" }
        }
      }),
      tool("get_architecture", "Return the native CBM architecture summary for this space snapshot, or one project when project is provided.", {
        type: "object",
        properties: {
          project: { type: "string" },
          aspects: { type: "array", items: { type: "string" } }
        }
      }),
      tool("get_graph_schema", "Return native CBM graph schema details for this space snapshot.", {
        type: "object",
        properties: {
          project: { type: "string" }
        }
      }),
      tool("search_graph", "Run native CBM structured graph search within this space snapshot.", {
        type: "object",
        properties: {
          project: { type: "string" },
          query: { type: "string" },
          name_pattern: { type: "string" },
          label: { type: "string" },
          file_pattern: { type: "string" },
          min_degree: { type: "number" },
          max_degree: { type: "number" },
          limit: { type: "number", maximum: SEARCH_RESULT_MAX_LIMIT },
          offset: { type: "number" }
        }
      }),
      tool("semantic_query", "Run native CBM semantic search within this space snapshot.", {
        type: "object",
        required: ["query"],
        properties: {
          project: { type: "string" },
          query: { type: "string" },
          limit: { type: "number", maximum: SEARCH_RESULT_MAX_LIMIT }
        }
      }),
      tool("search_code", "Run native CBM indexed code text search within this space snapshot.", {
        type: "object",
        required: ["pattern"],
        properties: {
          project: { type: "string" },
          pattern: { type: "string" },
          regex: { type: "boolean" },
          limit: { type: "number", maximum: SEARCH_RESULT_MAX_LIMIT }
        }
      }),
      tool("trace_path", "Trace a uniquely resolved function or method. Includes USAGE references for callbacks and functions passed as values.", {
        type: "object",
        required: ["function_name"],
        properties: {
          project: { type: "string" },
          function_name: { type: "string" },
          qualified_name: { type: "string" },
          direction: { type: "string", enum: ["inbound", "outbound", "both"] },
          depth: { type: "number", minimum: 1, maximum: 5 }
        }
      }),
      tool("get_code_snippet", "Run native CBM snippet lookup by qualified symbol name.", {
        type: "object",
        required: ["qualified_name"],
        properties: {
          project: { type: "string" },
          qualified_name: { type: "string" },
          include_neighbors: { type: "boolean" }
        }
      }),
      tool("detect_changes", "Run native CBM change impact analysis for this space snapshot or one project inside it.", {
        type: "object",
        properties: {
          project: { type: "string" }
        }
      }),
      tool("query_graph", `Run native CBM read-only Cypher against this space snapshot. max_rows defaults to and is capped at ${QUERY_GRAPH_MAX_ROWS}.`, {
        type: "object",
        required: ["query"],
        properties: {
          project: { type: "string" },
          query: { type: "string" },
          max_rows: { type: "number", maximum: QUERY_GRAPH_MAX_ROWS }
        }
      })
    ];
  }

  private buildConfigs(spaceSlug: string, token: string) {
    const serverName = `memorepo-${spaceSlug}`;
    const stdio = {
      mcpServers: {
        [serverName]: {
          command: "docker",
          args: [
            "exec",
            "-i",
            "-e",
            `MEMOREPO_MCP_TOKEN=${token}`,
            this.config.mcpContainerName,
            "node",
            "/app/apps/api/dist/cli/mcp.js",
            "--space",
            spaceSlug
          ]
        }
      }
    };

    return {
      generic: stdio,
      codex: stdio,
      claude: stdio,
      gemini: stdio,
      http: {
        url: `${this.config.publicApiUrl}/mcp/${spaceSlug}`,
        headers: { authorization: `Bearer ${token}` }
      }
    };
  }

  private mcpRepositories(spaceId: string, manifest: SnapshotManifest | null, options: McpRepositoryListOptions): McpRepository[] {
    const projectsBySpaceRepositoryId = new Map(
      manifest?.repositories.map((repository) => [repository.spaceRepositoryId, repository.projectName]) ?? []
    );
    return this.spacesService
      .listSpaceRepositories(spaceId)
      .map((repository) =>
        toMcpRepository(repository as Record<string, unknown>, projectsBySpaceRepositoryId.get(String((repository as Record<string, unknown>).id)), options)
      );
  }
}

function maskCypherLiteralsAndComments(query: string): string {
  let result = "";
  let index = 0;
  while (index < query.length) {
    const current = query[index]!;
    const next = query[index + 1];

    if (current === "/" && next === "/") {
      const end = query.indexOf("\n", index + 2);
      result += " ".repeat((end === -1 ? query.length : end) - index);
      index = end === -1 ? query.length : end;
      continue;
    }
    if (current === "/" && next === "*") {
      const closing = query.indexOf("*/", index + 2);
      if (closing === -1) {
        throw new Error("query_graph contains an unterminated comment");
      }
      const end = closing + 2;
      result += " ".repeat(end - index);
      index = end;
      continue;
    }
    if (current === "'" || current === '"') {
      const quote = current;
      const start = index;
      index += 1;
      while (index < query.length) {
        if (query[index] === "\\") {
          index += 2;
          continue;
        }
        if (query[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      if (query[index - 1] !== quote) {
        throw new Error("query_graph contains an unterminated string literal");
      }
      result += " ".repeat(index - start);
      continue;
    }

    result += current;
    index += 1;
  }
  return result;
}

function tool(name: string, description: string, inputSchema: Record<string, unknown>) {
  return { name, description, inputSchema: inputSchema.type ? inputSchema : { type: "object", properties: {} } };
}

function protocolVersionFrom(params: unknown): string {
  if (params && typeof params === "object" && "protocolVersion" in params && typeof params.protocolVersion === "string") {
    return params.protocolVersion;
  }
  return "2024-11-05";
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing argument: ${name}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function escapeCypherString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function graphRows(response: unknown): unknown[][] {
  if (!isRecord(response) || !Array.isArray(response.rows)) {
    return [];
  }
  return response.rows.filter((row): row is unknown[] => Array.isArray(row));
}

function repositoryListOptions(args: Record<string, unknown>): McpRepositoryListOptions {
  return {
    includeBranches: args.include_branches === true,
    includeDetails: args.include_details === true
  };
}

function boundedLimit(value: unknown, fallback: number, maximum = 50): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(value, maximum));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function evictOldest(cache: Map<string, unknown>, maxEntries: number): void {
  while (cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    cache.delete(oldest);
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([entryKey, entry]) => `${JSON.stringify(entryKey)}:${stableStringify(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function withoutNulls<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null)) as T;
}

function limitMcpResponse(value: unknown): unknown {
  if (responseBytes(value) <= MCP_RESPONSE_MAX_BYTES) {
    return value;
  }

  if (isRecord(value)) {
    const truncated = truncateLargestArray(value);
    if (truncated) {
      return truncated;
    }
  }

  return {
    status: "response_too_large",
    message: "MemoRepo generated more data than this MCP connection can return. Retry with a narrower query, a lower limit/max_rows, or include_neighbors=false.",
    limits: {
      responseMaxBytes: MCP_RESPONSE_MAX_BYTES,
      actualBytes: responseBytes(value)
    }
  };
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

interface ArrayTarget {
  path: string[];
  array: unknown[];
  bytes: number;
}

function truncateLargestArray(value: Record<string, unknown>): Record<string, unknown> | null {
  const target = findLargestArray(value, []);
  if (!target || target.array.length === 0) {
    return null;
  }

  let low = 0;
  let high = target.array.length - 1;
  let best: Record<string, unknown> | null = null;

  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const candidate = markTruncated(withArraySlice(value, target.path, keep), target, keep);
    if (responseBytes(candidate) <= MCP_RESPONSE_MAX_BYTES) {
      best = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }

  return best;
}

function findLargestArray(value: Record<string, unknown>, path: string[]): ArrayTarget | null {
  let best: ArrayTarget | null = null;
  for (const [key, entry] of Object.entries(value)) {
    let candidate: ArrayTarget | null = null;
    if (Array.isArray(entry)) {
      candidate = { path: [...path, key], array: entry, bytes: responseBytes(entry) };
    } else if (isRecord(entry)) {
      candidate = findLargestArray(entry, [...path, key]);
    }
    if (candidate && (!best || candidate.bytes > best.bytes)) {
      best = candidate;
    }
  }
  return best;
}

function withArraySlice(value: Record<string, unknown>, path: string[], keep: number): Record<string, unknown> {
  const [head, ...rest] = path;
  if (!head) {
    return value;
  }
  const child = value[head];
  if (rest.length === 0) {
    return { ...value, [head]: Array.isArray(child) ? child.slice(0, keep) : child };
  }
  if (!isRecord(child)) {
    return value;
  }
  return { ...value, [head]: withArraySlice(child, rest, keep) };
}

function markTruncated(value: Record<string, unknown>, target: ArrayTarget, keep: number): Record<string, unknown> {
  return {
    ...value,
    truncated: {
      field: target.path.join("."),
      returned: keep,
      total: target.array.length,
      message: "Response exceeded the size limit; retry with a narrower query or a lower limit/max_rows for the full set."
    }
  };
}

function sanitizeMcpValue(value: unknown, manifest: SnapshotManifest, memorepoHome: string, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMcpValue(item, manifest, memorepoHome));
  }

  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (OMITTED_MCP_KEYS.has(entryKey)) {
        continue;
      }

      if (typeof entryValue === "string" && PATH_MCP_KEYS.has(entryKey)) {
        sanitized[entryKey] = publicPathReference(entryValue, manifest, memorepoHome);
        continue;
      }

      sanitized[entryKey] = sanitizeMcpValue(entryValue, manifest, memorepoHome, entryKey);
    }
    return sanitized;
  }

  if (typeof value === "string") {
    return PATH_MCP_KEYS.has(key ?? "") ? publicPathReference(value, manifest, memorepoHome) : redactInternalPaths(value, manifest, memorepoHome);
  }

  return value;
}

function publicPathReference(value: string, manifest: SnapshotManifest, memorepoHome: string): string {
  for (const repository of manifest.repositories) {
    const relative = relativeInside(repository.localPath, value);
    if (relative !== null) {
      return `${repository.fullName}/${relative.replaceAll("\\", "/")}`;
    }
  }

  if (relativeInside(memorepoHome, value) !== null) {
    return "[internal-path]";
  }

  return path.isAbsolute(value) ? "[absolute-path]" : value.replaceAll("\\", "/");
}

function redactInternalPaths(value: string, manifest: SnapshotManifest, memorepoHome: string): string {
  let redacted = value;
  for (const repository of manifest.repositories) {
    redacted = replacePathVariants(redacted, repository.localPath, `[repo:${repository.fullName}]`);
  }
  return replacePathVariants(redacted, memorepoHome, "[MEMOREPO_HOME]");
}

function replacePathVariants(value: string, targetPath: string, replacement: string): string {
  const normalized = path.resolve(targetPath);
  const variants = new Set([normalized, normalized.replaceAll("\\", "/"), normalized.replaceAll("/", "\\")]);
  let result = value;
  for (const variant of variants) {
    result = result.split(variant).join(replacement);
  }
  return result;
}

function relativeInside(root: string, candidate: string): string | null {
  if (!path.isAbsolute(candidate)) {
    return null;
  }

  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function toMcpRepository(repository: Record<string, unknown>, project: string | undefined, options: McpRepositoryListOptions): McpRepository {
  const branches = parseBranches(repository.branches_json, String(repository.default_branch));
  const result: McpRepository = {
    spaceRepositoryId: String(repository.id),
    fullName: String(repository.full_name),
    project,
    defaultBranch: String(repository.default_branch),
    selectedBranch: stringOrNull(repository.selected_branch),
    selectedCommit: stringOrNull(repository.selected_commit),
    cloneStatus: String(repository.clone_status),
    indexStatus: String(repository.index_status),
    snapshotIncluded: Boolean(repository.snapshot_included),
    branchCount: branches.length
  };

  if (options.includeBranches) {
    result.branches = branches;
  }

  if (options.includeDetails) {
    result.githubRepositoryId = String(repository.github_repository_id);
    result.owner = String(repository.owner);
    result.name = String(repository.name);
    result.htmlUrl = String(repository.html_url);
    result.remoteRef = stringOrNull(repository.remote_ref);
    result.lastFetchedAt = stringOrNull(repository.last_fetched_at);
    result.lastIndexedAt = stringOrNull(repository.last_indexed_at);
    result.lastError = stringOrNull(repository.last_error);
    result.private = Boolean(repository.private);
    result.archived = Boolean(repository.archived);
    result.fork = Boolean(repository.fork);
    result.description = stringOrNull(repository.description);
    result.pushedAt = stringOrNull(repository.pushed_at);
  }

  return withoutNulls(result);
}

const OMITTED_MCP_KEYS = new Set([
  "artifact_path",
  "artifactPath",
  "cache_path",
  "cachePath",
  "clone_url",
  "cloneUrl",
  "local_path",
  "localPath",
  "root_path",
  "rootPath"
]);

const PATH_MCP_KEYS = new Set([
  "absolute_path",
  "absolutePath",
  "file",
  "file_path",
  "filePath",
  "path",
  "repo_path",
  "repoPath",
  "source_path",
  "sourcePath"
]);

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseBranches(value: unknown, fallback: string): string[] {
  if (typeof value !== "string") {
    return [fallback].filter(Boolean);
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [fallback].filter(Boolean);
    }
    const branches = parsed.filter((branch): branch is string => typeof branch === "string" && branch.length > 0);
    return Array.from(new Set(branches.length > 0 ? branches : [fallback]));
  } catch {
    return [fallback].filter(Boolean);
  }
}

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface SpaceRow {
  id: string;
  name: string;
  slug: string;
  activeSnapshotId: string | null;
  snapshotStatus: string;
}

interface SnapshotRow {
  id: string;
  version: number;
  status: string;
  artifactPath: string;
  manifestJson: string;
  createdAt: string;
  activatedAt: string | null;
}

interface McpConnectionRow {
  id: string;
  spaceId: string;
  tokenHash: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface McpRepository {
  spaceRepositoryId: string;
  fullName: string;
  project?: string | undefined;
  defaultBranch: string;
  selectedBranch: string | null;
  selectedCommit: string | null;
  cloneStatus: string;
  indexStatus: string;
  snapshotIncluded: boolean;
  branchCount: number;
  branches?: string[];
  githubRepositoryId?: string;
  owner?: string;
  name?: string;
  htmlUrl?: string;
  remoteRef?: string | null;
  lastFetchedAt?: string | null;
  lastIndexedAt?: string | null;
  lastError?: string | null;
  private?: boolean;
  archived?: boolean;
  fork?: boolean;
  description?: string | null;
  pushedAt?: string | null;
}

interface McpRepositoryListOptions {
  includeBranches: boolean;
  includeDetails: boolean;
}
