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
const QUERY_GRAPH_MAX_OFFSET = 224;
const QUERY_GRAPH_TIMEOUT_MS = 10_000;
const MCP_RESPONSE_MAX_BYTES = 50_000;
const SEARCH_RESULT_MAX_LIMIT = 25;
const SEARCH_CODE_MAX_OFFSET = 224;
const GLOBAL_SEARCH_CODE_CANDIDATE_TARGET = SEARCH_CODE_MAX_OFFSET + SEARCH_RESULT_MAX_LIMIT;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const MANIFEST_CACHE_MAX_ENTRIES = 16;
const CBM_RESPONSE_CACHE_MAX_ENTRIES = 256;
const CBM_RESPONSE_CACHE_MAX_ITEM_BYTES = 200_000;
const PROJECT_FANOUT_CONCURRENCY = 4;
const GLOBAL_SEARCH_MAX_PAGES = 50;
const ARCHITECTURE_ASPECTS = ["languages", "packages", "entry_points", "routes", "hotspots", "boundaries", "layers", "clusters", "adr"] as const;

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
        try {
          const result = await this.callTool(spaceSlug, token, params.name, params.arguments ?? {});
          return {
            jsonrpc: "2.0",
            id: request.id ?? null,
            result: {
              content: [{ type: "text", text: JSON.stringify(result) }],
              isError: false
            }
          };
        } catch (error) {
          return {
            jsonrpc: "2.0",
            id: request.id ?? null,
            result: {
              content: [{ type: "text", text: sanitizePublicMessage(error, [this.config.memorepoHome]) }],
              isError: true
            }
          };
        }
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
    this.validateToolArgs(toolName, args);
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
    const offset = optionalBoundedInteger(args.offset, "query_graph offset", 0, QUERY_GRAPH_MAX_OFFSET) ?? 0;
    const queryStructure = maskCypherLiteralsAndComments(query);
    if (queryStructure.includes(";")) {
      throw new Error("query_graph accepts exactly one Cypher statement");
    }
    const mutationStructure = maskCypherPropertyNames(queryStructure);
    if (/\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|LOAD\s+CSV|CALL|FOREACH|USE)\b/i.test(mutationStructure)) {
      throw new Error("query_graph only accepts read-only Cypher");
    }
    if (/\bLIMIT\b/i.test(queryStructure)) {
      throw new Error("query_graph LIMIT is controlled by max_rows; remove LIMIT from the query");
    }
    if (/\bORDER\s+BY\b/i.test(queryStructure)) {
      throw new Error("query_graph ORDER BY is not supported reliably by the installed graph engine; remove it and sort the returned page client-side");
    }
    if (/\bSKIP\b/i.test(queryStructure)) {
      throw new Error("query_graph SKIP is controlled by the offset argument; remove SKIP from the query and pass offset instead");
    }
    if (!/^\s*MATCH\b/i.test(queryStructure)) {
      throw new Error("query_graph supports the read-only Cypher subset starting with MATCH; standalone RETURN, UNWIND, and other clauses are not supported");
    }

    const input = this.scopedCbmArgs(manifest, args, "query_graph");
    const requestedProject = optionalString(input.project);
    if (!requestedProject && offset > 0) {
      throw new Error("query_graph offset requires project because projectless results are grouped by repository");
    }
    if (requestedProject) {
      const response = await this.executeProjectGraphQuery(snapshot, requestedProject, query, maxRowsValue, offset);
      return this.withCbmResponse(space, snapshot, manifest, response);
    }

    const projects = uniqueProjectNames(manifest);
    const quotas = allocateGlobalLimit(maxRowsValue, projects.length);
    const activeProjects = projects.flatMap((project, index) => quotas[index]! > 0 ? [{ project, limit: quotas[index]! }] : []);
    const outcomes = await mapWithConcurrency(activeProjects, PROJECT_FANOUT_CONCURRENCY, async ({ project, limit }) => {
      try {
        return { project, result: await this.executeProjectGraphQuery(snapshot, project, query, limit, 0) } as ProjectToolSuccess;
      } catch (error) {
        return { project, error: errorMessage(error) } as ProjectToolFailure;
      }
    });
    const aggregated = aggregateProjectOutcomes(outcomes);
    aggregated.max_rows_scope = "global";
    aggregated.max_rows = maxRowsValue;
    const omittedProjects = projects.filter((_, index) => quotas[index] === 0);
    if (omittedProjects.length > 0) {
      aggregated.projects_omitted_due_to_max_rows = omittedProjects;
    }
    return this.withSnapshotMeta(space, snapshot, manifest, aggregated);
  }

  private async executeProjectGraphQuery(snapshot: SnapshotRow, project: string, query: string, maxRows: number, offset: number): Promise<unknown> {
    const totalCount = totalNodeCountQuery(query);
    if (totalCount) {
      const status = await this.cachedCbmTool(snapshot, "index_status", { project }, QUERY_GRAPH_TIMEOUT_MS);
      const nodes = numericField(status, ["nodes", "node_count", "total_nodes"]);
      if (nodes !== undefined) {
        return paginateGraphResponse({
          columns: [totalCount.alias],
          rows: [[String(nodes)]],
          total: 1,
          aggregation_source: "index_status"
        }, offset, maxRows);
      }
    }

    const internalLimit = offset + maxRows + 1;
    const response = await this.cachedCbmTool(snapshot, "query_graph", {
      project,
      query: `${query} LIMIT ${internalLimit}`,
      max_rows: internalLimit
    }, QUERY_GRAPH_TIMEOUT_MS);
    if (hasAggregateFunction(query) && graphRows(response).some((row) => row.some((value) => Number(value) === 250))) {
      throw new Error("query_graph aggregation reached the engine's 250-entity scan ceiling and may be inaccurate; narrow the MATCH by label or filters");
    }
    return paginateGraphResponse(response, offset, maxRows);
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
    if (toolName === "search_code" && optionalString(input.project)) {
      const response = await this.executeSearchCode(snapshot, input, optionalNonNegativeInteger(args.offset, 0), Number(input.limit));
      return this.withCbmResponse(space, snapshot, manifest, response);
    }
    if (toolName === "get_code_snippet" && !optionalString(input.project)) {
      return this.codeSnippetAcrossProjects(space, snapshot, manifest, input);
    }
    if (!optionalString(input.project) && toolName !== "list_projects") {
      const searchTarget = optionalNonNegativeInteger(args.offset, 0) + Number(input.limit);
      const outcomes = toolName === "search_graph"
        ? await this.searchGraphAcrossProjects(snapshot, manifest, input, searchTarget)
        : toolName === "search_code"
          ? await this.searchCodeAcrossProjects(snapshot, manifest, input, GLOBAL_SEARCH_CODE_CANDIDATE_TARGET)
          : await this.callForProjects(snapshot, manifest, toolName, input);
      if (toolName === "search_graph" || toolName === "search_code" || toolName === "semantic_query") {
        return this.withSnapshotMeta(
          space,
          snapshot,
          manifest,
          aggregateSearchOutcomes(outcomes, optionalNonNegativeInteger(args.offset, 0), Number(input.limit))
        );
      }
      return this.withSnapshotMeta(space, snapshot, manifest, aggregateProjectOutcomes(outcomes));
    }
    const response = await this.cachedCbmTool(snapshot, toolName, input, QUERY_GRAPH_TIMEOUT_MS);
    return this.withCbmResponse(space, snapshot, manifest, await this.prepareToolResponse(snapshot, toolName, input, response));
  }

  private async searchGraphAcrossProjects(
    snapshot: SnapshotRow,
    manifest: SnapshotManifest,
    input: Record<string, unknown>,
    targetCandidateCount: number
  ): Promise<ProjectToolOutcome[]> {
    const states: ProjectSearchState[] = uniqueProjectNames(manifest).map((project) => ({
      project,
      results: [],
      total: undefined,
      hasMore: true,
      pages: 0,
      lastResponse: undefined,
      error: undefined
    }));

    while (states.reduce((sum, state) => sum + state.results.length, 0) < targetCandidateCount) {
      const active = states.filter((state) => state.hasMore && !state.error && state.pages < GLOBAL_SEARCH_MAX_PAGES);
      if (active.length === 0) {
        break;
      }
      await mapWithConcurrency(active, PROJECT_FANOUT_CONCURRENCY, async (state) => {
        try {
          const page = await this.cachedCbmTool(snapshot, "search_graph", {
            ...input,
            project: state.project,
            limit: SEARCH_RESULT_MAX_LIMIT,
            offset: state.results.length
          }, QUERY_GRAPH_TIMEOUT_MS);
          const prepared = await this.prepareToolResponse(snapshot, "search_graph", { ...input, project: state.project }, page);
          const items = searchItems(prepared);
          state.results.push(...items);
          state.lastResponse = prepared;
          state.pages += 1;
          state.total = directNumericField(prepared, "total") ?? state.total;
          state.hasMore = isRecord(prepared) && typeof prepared.has_more === "boolean"
            ? prepared.has_more
            : state.total !== undefined
              ? state.results.length < state.total
              : items.length === SEARCH_RESULT_MAX_LIMIT;
          if (items.length === 0) {
            state.hasMore = false;
          }
        } catch (error) {
          state.error = errorMessage(error);
          state.hasMore = false;
        }
      });
    }

    return states.map((state): ProjectToolOutcome => {
      if (state.error) {
        return { project: state.project, error: state.error };
      }
      const base = isRecord(state.lastResponse) ? state.lastResponse : {};
      return {
        project: state.project,
        result: {
          ...base,
          results: state.results,
          total: state.total ?? state.results.length,
          has_more: state.hasMore
        }
      };
    });
  }

  private async executeSearchCode(
    snapshot: SnapshotRow,
    input: Record<string, unknown>,
    offset: number,
    limit: number
  ): Promise<unknown> {
    const nativeInput: Record<string, unknown> = { ...input, limit: offset + limit + 1 };
    delete nativeInput.offset;
    const response = await this.cachedCbmTool(snapshot, "search_code", nativeInput, QUERY_GRAPH_TIMEOUT_MS);
    const prepared = await this.prepareToolResponse(snapshot, "search_code", input, response);
    return paginateSearchResponse(prepared, offset, limit);
  }

  private async searchCodeAcrossProjects(
    snapshot: SnapshotRow,
    manifest: SnapshotManifest,
    input: Record<string, unknown>,
    targetCandidateCount: number
  ): Promise<ProjectToolOutcome[]> {
    return mapWithConcurrency(uniqueProjectNames(manifest), PROJECT_FANOUT_CONCURRENCY, async (project) => {
      try {
        const nativeInput: Record<string, unknown> = { ...input, project, limit: targetCandidateCount + 1 };
        delete nativeInput.offset;
        const response = await this.cachedCbmTool(snapshot, "search_code", nativeInput, QUERY_GRAPH_TIMEOUT_MS);
        const prepared = await this.prepareToolResponse(snapshot, "search_code", { ...input, project }, response);
        const items = searchItems(prepared);
        const base = isRecord(prepared) ? prepared : {};
        return {
          project,
          result: {
            ...base,
            results: items,
            has_more: directBooleanField(prepared, "has_more") ?? items.length > targetCandidateCount,
            effective_limit: Number(input.limit)
          }
        } as ProjectToolSuccess;
      } catch (error) {
        return { project, error: errorMessage(error) } as ProjectToolFailure;
      }
    });
  }

  private async callForProjects(
    snapshot: SnapshotRow,
    manifest: SnapshotManifest,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<ProjectToolOutcome[]> {
    const projects = uniqueProjectNames(manifest);
    return mapWithConcurrency(projects, PROJECT_FANOUT_CONCURRENCY, async (project) => {
      try {
        const projectInput: Record<string, unknown> = { ...input, project };
        if (toolName === "search_graph" || toolName === "search_code" || toolName === "semantic_query") {
          projectInput.limit = SEARCH_RESULT_MAX_LIMIT;
          delete projectInput.offset;
        }
        const result = await this.cachedCbmTool(snapshot, toolName, projectInput, QUERY_GRAPH_TIMEOUT_MS);
        return { project, result: await this.prepareToolResponse(snapshot, toolName, projectInput, result) };
      } catch (error) {
        return { project, error: errorMessage(error) };
      }
    });
  }

  private async codeSnippetAcrossProjects(
    space: SpaceRow,
    snapshot: SnapshotRow,
    manifest: SnapshotManifest,
    input: Record<string, unknown>
  ) {
    const outcomes = await this.callForProjects(snapshot, manifest, "get_code_snippet", input);
    const matches = outcomes.filter((outcome): outcome is ProjectToolSuccess => outcome.error === undefined);
    if (matches.length === 0) {
      throw new Error(projectFailureMessage("get_code_snippet", outcomes));
    }
    if (matches.length > 1) {
      throw new Error(`get_code_snippet symbol is ambiguous across projects: ${matches.map((match) => match.project).join(", ")}; retry with project`);
    }
    return this.withSnapshotMeta(space, snapshot, manifest, {
      project: matches[0]!.project,
      ...(isRecord(matches[0]!.result) ? matches[0]!.result : { result: matches[0]!.result })
    });
  }

  private async prepareToolResponse(
    snapshot: SnapshotRow,
    toolName: string,
    input: Record<string, unknown>,
    response: unknown
  ): Promise<unknown> {
    const prepared = sanitizeToolGuidance(toolName, response, input);
    if (toolName !== "search_graph" || !optionalString(input.label) || searchItems(prepared).length > 0) {
      return prepared;
    }

    const project = optionalString(input.project);
    if (!project) {
      return removeStaticLabelHint(prepared);
    }
    try {
      const schema = await this.cachedCbmTool(snapshot, "get_graph_schema", { project }, QUERY_GRAPH_TIMEOUT_MS);
      const labels = graphSchemaLabels(schema);
      return labels.length > 0
        ? replaceLabelHint(prepared, `Available labels for ${project}: ${labels.join(", ")}`)
        : removeStaticLabelHint(prepared);
    } catch {
      return removeStaticLabelHint(prepared);
    }
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
    const requestedProject = optionalString(input.project);
    const projects = requestedProject ? [requestedProject] : uniqueProjectNames(manifest);
    const candidateOutcomes = await mapWithConcurrency(projects, PROJECT_FANOUT_CONCURRENCY, async (project) => {
      try {
        const selector = qualifiedName
          ? qualifiedNameVariants(qualifiedName, project)
            .map((candidate) => `n.qualified_name = '${escapeCypherString(candidate)}'`)
            .join(" OR ")
          : `n.name = '${escapeCypherString(requestedName)}'`;
        const response = await this.cachedCbmTool(snapshot, "query_graph", {
          project,
          query: `MATCH (n) WHERE (n:Function OR n:Method) AND ${selector} RETURN n.name AS name, n.qualified_name AS qualified_name, n.file_path AS file_path LIMIT 20`,
          max_rows: 20
        }, QUERY_GRAPH_TIMEOUT_MS);
        return graphRows(response).map((row) => ({ project, row }));
      } catch {
        return [];
      }
    });
    const candidates = candidateOutcomes.flat();
    if (candidates.length > 1) {
      const choices = candidates.map((candidate) => `${candidate.project}:${String(candidate.row[1])}`).join(", ");
      throw new Error(`trace_path symbol "${requestedName}" is ambiguous (${choices}); retry with project and qualified_name from search_graph`);
    }
    if (candidates.length === 0) {
      throw new Error(`trace_path could not resolve function or method "${qualifiedName ?? requestedName}"`);
    }

    const selected = candidates[0]!;
    const resolvedName = String(selected.row[0]);
    if (qualifiedName && resolvedName !== requestedName) {
      throw new Error(
        `trace_path function_name "${requestedName}" does not match qualified_name resolved symbol "${resolvedName}"`
      );
    }
    const selectedQualifiedName = String(selected.row[1]);
    const nativeInput: Record<string, unknown> = { ...input, project: selected.project, function_name: resolvedName };
    delete nativeInput.qualified_name;
    const response = await this.cachedCbmTool(snapshot, "trace_path", nativeInput, QUERY_GRAPH_TIMEOUT_MS);
    const referencesResponse = await this.cachedCbmTool(snapshot, "query_graph", {
      project: selected.project,
      query: `MATCH (source)-[r:USAGE]->(target) WHERE target.qualified_name = '${escapeCypherString(selectedQualifiedName)}' RETURN source.name AS name, source.qualified_name AS qualified_name, source.file_path AS file_path, r.callee AS callee LIMIT 25`,
      max_rows: 25
    }, QUERY_GRAPH_TIMEOUT_MS);
    const references = graphRows(referencesResponse).map((row) => ({
      name: row[0], qualified_name: row[1], file_path: row[2], callee: row[3], relation: "USAGE"
    }));
    const data = isRecord(response) ? response : { result: response };
    return this.withCbmResponse(space, snapshot, manifest, {
      ...data,
      resolved_symbol: { project: selected.project, name: selected.row[0], qualified_name: selected.row[1], file_path: selected.row[2] },
      references,
      confidence_notice: "CALLS edges are static-analysis results. USAGE references include callbacks and functions passed as values."
    });
  }

  private validateToolArgs(toolName: string, args: Record<string, unknown>): void {
    if (!this.tools().some((candidate) => candidate.name === toolName)) {
      throw new Error(`Unknown MCP tool: ${toolName}`);
    }
    if (toolName === "search_graph" || toolName === "search_code" || toolName === "semantic_query") {
      optionalBoundedInteger(args.limit, `${toolName} limit`, 1);
    }
    if (toolName === "search_code") {
      requiredNonEmptyString(args.pattern, "search_code pattern");
      optionalBoundedInteger(args.offset, "search_code offset", 0, SEARCH_CODE_MAX_OFFSET);
    }
    if (toolName === "get_code_snippet") {
      requiredNonEmptyString(args.qualified_name, "get_code_snippet qualified_name");
    }
    if (toolName === "search_graph") {
      for (const field of ["query", "name_pattern", "file_pattern"] as const) {
        if (args[field] !== undefined) {
          requiredNonEmptyString(args[field], `search_graph ${field}`);
        }
      }
      optionalNonNegativeInteger(args.offset, 0, "search_graph offset");
      const minDegree = optionalNonNegativeNumber(args.min_degree, "search_graph min_degree");
      const maxDegree = optionalNonNegativeNumber(args.max_degree, "search_graph max_degree");
      if (minDegree !== undefined && maxDegree !== undefined && minDegree > maxDegree) {
        throw new Error("search_graph min_degree cannot be greater than max_degree");
      }
    }
    if (toolName === "trace_path") {
      optionalBoundedInteger(args.depth, "trace_path depth", 1, 5);
    }
    if (toolName === "get_architecture" && args.aspects !== undefined) {
      if (!Array.isArray(args.aspects) || args.aspects.length === 0 || args.aspects.some((aspect) => typeof aspect !== "string" || !aspect.trim())) {
        throw new Error("get_architecture aspects must be a non-empty array of non-empty strings");
      }
      const unsupported = args.aspects.filter((aspect) => !ARCHITECTURE_ASPECTS.includes(aspect as typeof ARCHITECTURE_ASPECTS[number]));
      if (unsupported.length > 0) {
        throw new Error(`get_architecture unsupported aspects: ${unsupported.join(", ")}; supported aspects: ${ARCHITECTURE_ASPECTS.join(", ")}`);
      }
    }
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
          aspects: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: [...ARCHITECTURE_ASPECTS] } }
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
          min_degree: { type: "number", minimum: 0 },
          max_degree: { type: "number", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: SEARCH_RESULT_MAX_LIMIT },
          offset: { type: "integer", minimum: 0 }
        }
      }),
      tool("semantic_query", "Run native CBM semantic search within this space snapshot.", {
        type: "object",
        required: ["query"],
        properties: {
          project: { type: "string" },
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: SEARCH_RESULT_MAX_LIMIT }
        }
      }),
      tool("search_code", "Run native CBM indexed code text search within this space snapshot. Use offset and has_more for pagination; requested limits above 25 use an effective limit of 25.", {
        type: "object",
        required: ["pattern"],
        properties: {
          project: { type: "string" },
          pattern: { type: "string" },
          regex: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: SEARCH_RESULT_MAX_LIMIT },
          offset: { type: "integer", minimum: 0, maximum: SEARCH_CODE_MAX_OFFSET }
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
          depth: { type: "integer", minimum: 1, maximum: 5 }
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
      tool("query_graph", `Run the supported read-only Cypher subset against this space snapshot. max_rows must be between 1 and ${QUERY_GRAPH_MAX_ROWS} and is a global limit for projectless calls. Use offset for scoped pagination.`, {
        type: "object",
        required: ["query"],
        properties: {
          project: { type: "string" },
          query: { type: "string" },
          max_rows: { type: "integer", minimum: 1, maximum: QUERY_GRAPH_MAX_ROWS },
          offset: { type: "integer", minimum: 0, maximum: QUERY_GRAPH_MAX_OFFSET }
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
            "/app/dist/cli/mcp.js",
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

function maskCypherPropertyNames(query: string): string {
  return query.replace(/\.\s*(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|LOAD|CALL|FOREACH|USE)\b/gi, ".property");
}

function requiredNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function escapeCypherString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function qualifiedNameVariants(qualifiedName: string, project: string): string[] {
  const projectPrefix = `${project}.`;
  return [...new Set([
    qualifiedName,
    ...(qualifiedName.startsWith(projectPrefix) ? [qualifiedName.slice(projectPrefix.length)] : [])
  ])];
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
  if (value === undefined) {
    return fallback;
  }
  return Math.min(value as number, maximum);
}

function paginateGraphResponse(response: unknown, offset: number, limit: number): unknown {
  if (!isRecord(response) || !Array.isArray(response.rows)) {
    return response;
  }
  const rows = response.rows;
  const page = rows.slice(offset, offset + limit);
  const hasMore = rows.length > offset + limit;
  const paginated = { ...response };
  delete paginated.total;
  return {
    ...paginated,
    rows: page,
    offset,
    effective_limit: limit,
    returned: page.length,
    has_more: hasMore,
    ...(!hasMore ? { total: offset + page.length } : {})
  };
}

function optionalBoundedInteger(value: unknown, label: string, minimum: number, maximum?: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  if (value < minimum || (maximum !== undefined && value > maximum)) {
    const range = maximum === undefined ? `at least ${minimum}` : `between ${minimum} and ${maximum}`;
    throw new Error(`${label} must be ${range}`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, fallback: number, label = "offset"): number {
  if (value === undefined) {
    return fallback;
  }
  return optionalBoundedInteger(value, label, 0) ?? fallback;
}

function optionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function uniqueProjectNames(manifest: SnapshotManifest): string[] {
  return [...new Set(manifest.repositories.map((repository) => repository.projectName))];
}

function sanitizeToolGuidance(toolName: string, response: unknown, args: Record<string, unknown>): unknown {
  if (!isRecord(response)) {
    return response;
  }
  const sanitized = normalizeSyntheticRouteValue(response) as Record<string, unknown>;
  if (toolName === "get_code_snippet" && optionalString(args.project) && !optionalString(sanitized.project)) {
    sanitized.project = args.project;
  }
  if (toolName === "get_code_snippet") {
    correctContradictoryRecursionMetadata(sanitized);
  }
  if (toolName === "get_graph_schema" && typeof sanitized.adr_hint === "string" && /manage_adr/i.test(sanitized.adr_hint)) {
    delete sanitized.adr_hint;
    sanitized.adr_notice = "ADR mutation is unavailable through this read-only connection.";
  }
  if (toolName === "get_architecture" && Array.isArray(args.aspects)) {
    const missing = args.aspects.filter((aspect): aspect is string => typeof aspect === "string" && !(aspect in sanitized));
    if (missing.length > 0) {
      sanitized.warnings = [
        ...(Array.isArray(sanitized.warnings) ? sanitized.warnings : []),
        `Requested architecture aspects were not returned: ${missing.join(", ")}`
      ];
    }
  }
  return sanitized;
}

function normalizeSyntheticRouteValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSyntheticRouteValue(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  const normalized = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeSyntheticRouteValue(entry)]));
  const qualifiedName = optionalString(normalized.qualified_name);
  const syntheticRoute = normalized.label === "Route"
    || qualifiedName?.startsWith("__route__") === true
    || (typeof normalized.path === "string" && ("method" in normalized || "handler" in normalized));
  if (!syntheticRoute) {
    return normalized;
  }

  normalized.synthetic = true;
  for (const key of ["method", "handler", "file_path", "filePath"]) {
    if (normalized[key] === "") {
      delete normalized[key];
    }
  }
  const sourceUnavailable = [normalized.source, normalized.code]
    .some((entry) => typeof entry === "string" && /source not available/i.test(entry));
  const hasSourcePath = optionalString(normalized.file_path) || optionalString(normalized.filePath);
  if (sourceUnavailable || !hasSourcePath) {
    normalized.source_available = false;
  }
  if (sourceUnavailable) {
    for (const key of ["file_path", "filePath", "start_line", "startLine", "end_line", "endLine", "source", "code"]) {
      delete normalized[key];
    }
    normalized.analysis_warnings = [
      ...(Array.isArray(normalized.analysis_warnings) ? normalized.analysis_warnings : []),
      "Synthetic route node has no source location; file and line metadata were omitted."
    ];
  }
  return normalized;
}

function correctContradictoryRecursionMetadata(snippet: Record<string, unknown>): void {
  if (snippet.self_recursive !== true || typeof snippet.code !== "string") {
    return;
  }
  const qualifiedName = optionalString(snippet.qualified_name);
  const symbolName = optionalString(snippet.name) ?? qualifiedName?.split(".").at(-1);
  if (!symbolName) {
    return;
  }
  const bodyStart = snippet.code.indexOf("{");
  const body = bodyStart >= 0 ? snippet.code.slice(bodyStart + 1) : snippet.code;
  if (containsSelfCall(body, symbolName)) {
    return;
  }

  snippet.self_recursive = false;
  snippet.unguarded_recursion = false;
  if (Number(snippet.callees) === 0) {
    snippet.recursive = false;
  }
  snippet.analysis_warnings = [
    ...(Array.isArray(snippet.analysis_warnings) ? snippet.analysis_warnings : []),
    `Corrected contradictory recursion metadata: no self-call to ${symbolName} appears in the returned source.`
  ];
}

function containsSelfCall(code: string, symbolName: string): boolean {
  const escaped = escapeRegExp(symbolName);
  return new RegExp(`(?:\\bthis\\s*\\.\\s*${escaped}\\s*\\(|(?<![.\\w])${escaped}\\s*\\()`).test(code);
}

function graphSchemaLabels(schema: unknown): string[] {
  if (!isRecord(schema)) {
    return [];
  }
  const candidates = Array.isArray(schema.labels)
    ? schema.labels
    : Array.isArray(schema.node_labels)
      ? schema.node_labels
      : [];
  return [...new Set(candidates.flatMap((candidate) => {
    if (typeof candidate === "string" && candidate.trim()) {
      return [candidate];
    }
    if (isRecord(candidate)) {
      const label = optionalString(candidate.label) ?? optionalString(candidate.name);
      return label ? [label] : [];
    }
    return [];
  }))].sort((left, right) => left.localeCompare(right));
}

function replaceLabelHint(response: unknown, hint: string): unknown {
  if (!isRecord(response)) {
    return response;
  }
  const prepared = { ...response };
  let replaced = false;
  for (const [key, value] of Object.entries(prepared)) {
    if (typeof value === "string" && /available labels:/i.test(value)) {
      prepared[key] = hint;
      replaced = true;
    }
  }
  if (!replaced) {
    prepared.hint = hint;
  }
  return prepared;
}

function removeStaticLabelHint(response: unknown): unknown {
  if (!isRecord(response)) {
    return response;
  }
  const prepared = { ...response };
  for (const [key, value] of Object.entries(prepared)) {
    if (typeof value === "string" && /available labels:/i.test(value)) {
      delete prepared[key];
    }
  }
  return prepared;
}

function aggregateProjectOutcomes(outcomes: ProjectToolOutcome[]): Record<string, unknown> {
  const successes = outcomes.filter((outcome): outcome is ProjectToolSuccess => outcome.error === undefined);
  if (successes.length === 0) {
    throw new Error(projectFailureMessage("cross-project call", outcomes));
  }
  const failures = outcomes.filter((outcome): outcome is ProjectToolFailure => outcome.error !== undefined);
  return {
    projects: successes.map(({ project, result }) => ({
      project,
      ...(isRecord(result) ? result : { result })
    })),
    ...(failures.length > 0 ? {
      partial: true,
      project_errors: failures.map(({ project, error }) => ({ project, message: error }))
    } : {})
  };
}

function aggregateSearchOutcomes(outcomes: ProjectToolOutcome[], offset: number, limit: number): Record<string, unknown> {
  const successes = outcomes.filter((outcome): outcome is ProjectToolSuccess => outcome.error === undefined);
  if (successes.length === 0) {
    throw new Error(projectFailureMessage("cross-project search", outcomes));
  }
  const projectResults = successes.map(({ project, result }) => searchItems(result).map((item) =>
    isRecord(item) ? { ...item, project: optionalString(item.project) ?? project } : { project, result: item }
  ));
  const candidates: Array<Record<string, unknown>> = [];
  const largestProjectResult = Math.max(0, ...projectResults.map((results) => results.length));
  for (let resultIndex = 0; resultIndex < largestProjectResult; resultIndex += 1) {
    for (const results of projectResults) {
      const candidate = results[resultIndex];
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }
  const failures = outcomes.filter((outcome): outcome is ProjectToolFailure => outcome.error !== undefined);
  const projectTotals = successes.map(({ result }) => directNumericField(result, "total"));
  const total = projectTotals.every((value): value is number => value !== undefined)
    ? projectTotals.reduce((sum, value) => sum + value, 0)
    : undefined;
  const returned = candidates.slice(offset, offset + limit);
  const upstreamHasMore = successes.some(({ result }) => directBooleanField(result, "has_more") === true);
  return {
    results: returned,
    candidate_count: candidates.length,
    offset,
    effective_limit: limit,
    ...(total !== undefined
      ? { total, has_more: offset + returned.length < total }
      : { has_more: upstreamHasMore || candidates.length > offset + returned.length }),
    projects_searched: successes.map(({ project }) => project),
    merge_strategy: "round_robin_by_project",
    ...(failures.length > 0 ? {
      partial: true,
      project_errors: failures.map(({ project, error }) => ({ project, message: error }))
    } : {})
  };
}

function allocateGlobalLimit(total: number, projectCount: number): number[] {
  if (projectCount <= 0) {
    return [];
  }
  const base = Math.floor(total / projectCount);
  const remainder = total % projectCount;
  return Array.from({ length: projectCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

function totalNodeCountQuery(query: string): { alias: string } | null {
  const match = /^\s*MATCH\s*\(\s*([A-Za-z_]\w*)\s*\)\s*RETURN\s+count\s*\(\s*\1\s*\)(?:\s+AS\s+([A-Za-z_]\w*))?\s*$/i.exec(query);
  if (!match) {
    return null;
  }
  return { alias: match[2] ?? `count(${match[1]})` };
}

function hasAggregateFunction(query: string): boolean {
  return /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(maskCypherLiteralsAndComments(query));
}

function numericField(value: unknown, keys: string[]): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if ((typeof candidate === "number" || typeof candidate === "string") && Number.isFinite(Number(candidate))) {
      return Number(candidate);
    }
  }
  for (const candidate of Object.values(value)) {
    const nested = numericField(candidate, keys);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function directNumericField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return (typeof candidate === "number" || typeof candidate === "string") && Number.isFinite(Number(candidate))
    ? Number(candidate)
    : undefined;
}

function directBooleanField(value: unknown, key: string): boolean | undefined {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : undefined;
}

function searchItems(response: unknown): unknown[] {
  if (!isRecord(response)) {
    return [];
  }
  if (Array.isArray(response.results)) {
    return response.results;
  }
  if (Array.isArray(response.matches)) {
    return response.matches;
  }
  return [];
}

function paginateSearchResponse(response: unknown, offset: number, limit: number): unknown {
  if (!isRecord(response)) {
    return response;
  }
  const items = searchItems(response);
  const page = items.slice(offset, offset + limit);
  const upstreamTotal = directNumericField(response, "total");
  const hasMore = upstreamTotal !== undefined
    ? offset + page.length < upstreamTotal
    : items.length > offset + limit;
  return {
    ...response,
    results: page,
    offset,
    effective_limit: limit,
    returned: page.length,
    has_more: hasMore,
    ...(upstreamTotal !== undefined ? { total: upstreamTotal } : !hasMore ? { total: offset + page.length } : {})
  };
}

function projectFailureMessage(toolName: string, outcomes: ProjectToolOutcome[]): string {
  return `${toolName} failed for every project: ${outcomes.map(({ project, error }) => `${project}: ${error ?? "unknown error"}`).join("; ")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

interface ProjectToolSuccess {
  project: string;
  result: unknown;
  error?: undefined;
}

interface ProjectToolFailure {
  project: string;
  result?: undefined;
  error: string;
}

type ProjectToolOutcome = ProjectToolSuccess | ProjectToolFailure;

interface ProjectSearchState {
  project: string;
  results: unknown[];
  total: number | undefined;
  hasMore: boolean;
  pages: number;
  lastResponse: unknown;
  error: string | undefined;
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

      if (entryKey === "path" && typeof entryValue === "string" && isHttpRouteRecord(value as Record<string, unknown>)) {
        sanitized[entryKey] = entryValue;
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

function isHttpRouteRecord(value: Record<string, unknown>): boolean {
  return typeof value.path === "string"
    && value.path.startsWith("/")
    && ("method" in value || "handler" in value || value.type === "route" || value.label === "Route");
}

function publicPathReference(value: string, manifest: SnapshotManifest, memorepoHome: string): string {
  for (const repository of manifest.repositories) {
    const relative = relativeInside(repository.localPath, value);
    if (relative !== null) {
      return relative.replaceAll("\\", "/");
    }
    const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
    for (const prefix of [`${repository.fullName}/`, `${repository.projectName}/`]) {
      if (normalized.startsWith(prefix)) {
        return normalized.slice(prefix.length);
      }
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
    fullName: String(repository.full_name),
    project
  };

  if (options.includeBranches) {
    result.branches = branches;
  }

  if (options.includeDetails) {
    result.spaceRepositoryId = String(repository.id);
    result.defaultBranch = String(repository.default_branch);
    result.selectedBranch = stringOrNull(repository.selected_branch);
    result.selectedCommit = stringOrNull(repository.selected_commit);
    result.cloneStatus = String(repository.clone_status);
    result.indexStatus = String(repository.index_status);
    result.snapshotIncluded = Boolean(repository.snapshot_included);
    result.branchCount = branches.length;
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
  fullName: string;
  project?: string | undefined;
  spaceRepositoryId?: string;
  defaultBranch?: string;
  selectedBranch?: string | null;
  selectedCommit?: string | null;
  cloneStatus?: string;
  indexStatus?: string;
  snapshotIncluded?: boolean;
  branchCount?: number;
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
