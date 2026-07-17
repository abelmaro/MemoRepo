import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/connection.js";
import { insertRecord, updateRecord } from "../db/sql.js";
import { NotFoundError } from "../domain/errors.js";
import { sanitizePublicMessage } from "../domain/publicSanitize.js";
import { createId, createSecretToken, sha256 } from "../domain/ids.js";
import { nowIso } from "../domain/time.js";
import type { CbmService } from "./cbmService.js";
import type { SnapshotManifest, SnapshotManifestRepository } from "./snapshotService.js";
import {
  buildSnapshotInstructions,
  SNAPSHOT_QUERY_GRAPH_MAX_ROWS,
  SNAPSHOT_SEARCH_RESULT_MAX,
  snapshotToolWorkflow
} from "./snapshotAgentInstructions.js";
import type { SpaceService } from "./spaceService.js";

const QUERY_GRAPH_MAX_ROWS = SNAPSHOT_QUERY_GRAPH_MAX_ROWS;
const ENGINE_RESULT_WINDOW = 250;
const QUERY_GRAPH_MAX_OFFSET = ENGINE_RESULT_WINDOW - 1;
const QUERY_GRAPH_TIMEOUT_MS = 10_000;
const MCP_RESPONSE_MAX_BYTES = 50_000;
const SEARCH_RESULT_MAX_LIMIT = SNAPSHOT_SEARCH_RESULT_MAX;
const SEARCH_CODE_SCOPED_MAX_OFFSET = ENGINE_RESULT_WINDOW - 1;
const GLOBAL_SEARCH_CODE_CANDIDATE_TARGET = ENGINE_RESULT_WINDOW - 1;
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
const MUTABLE_SNAPSHOT_TOOLS = new Set(["detect_changes"]);

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
  private readonly snapshotToolSignal = new AsyncLocalStorage<AbortSignal>();

  constructor(
    private readonly database: AppDatabase,
    private readonly config: AppConfig,
    private readonly spacesService: SpaceService,
    private readonly cbm: CbmService
  ) {}

  createConnection(spaceId: string, name: string, client: string) {
    this.spacesService.assertSpaceAcceptsWork(spaceId);
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

      await this.spacesService.withSpaceReaderBySlug(spaceSlug, () => this.assertConnection(spaceSlug, token));
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
    return this.spacesService.withSpaceReaderBySlug(spaceSlug, async () => {
      this.validateToolArgs(toolName, args);
      if (MUTABLE_SNAPSHOT_TOOLS.has(toolName)) {
        throw new Error(`${toolName} is not available for immutable snapshot queries`);
      }
      const { space, snapshot, manifest } = await this.snapshotContext(spaceSlug, token);
      const response = limitMcpResponse(await this.toolResult(space, snapshot, manifest, toolName, args));
      this.recordToolStats(space.id, toolName, responseBytes(response));
      return response;
    });
  }

  async toolDefinitionsForSnapshot(spaceId: string, snapshotId: string) {
    return this.spacesService.withSpaceReader(spaceId, async () => {
      const { snapshot } = this.snapshotContextById(spaceId, snapshotId);
      return this.filterAvailableTools(snapshot);
    });
  }

  async instructionsForSnapshot(spaceId: string, snapshotId: string): Promise<string> {
    return this.spacesService.withSpaceReader(spaceId, async () => {
      const { space, snapshot, manifest } = this.snapshotContextById(spaceId, snapshotId);
      if (!snapshot || !manifest) throw new Error("The pinned snapshot is unavailable");
      return buildSnapshotInstructions({
        spaceName: space.name,
        snapshotVersion: snapshot.version,
        stale: space.snapshotStatus === "stale",
        repositories: manifest.repositories
      });
    });
  }

  async callSnapshotTool(
    spaceId: string,
    snapshotId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) {
    const execute = async () => {
      throwIfAborted(signal);
      if (MUTABLE_SNAPSHOT_TOOLS.has(toolName)) {
        throw new Error(`${toolName} is not available for immutable snapshot queries`);
      }
      this.validateToolArgs(toolName, args);
      const { space, snapshot, manifest } = this.snapshotContextById(spaceId, snapshotId);
      const response = limitMcpResponse(await this.toolResult(space, snapshot, manifest, toolName, args));
      throwIfAborted(signal);
      this.recordToolStats(space.id, toolName, responseBytes(response));
      return response;
    };
    return this.spacesService.withSpaceReader(spaceId, () =>
      signal ? this.snapshotToolSignal.run(signal, execute) : execute()
    );
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
    try {
      return await this.spacesService.withSpaceReaderBySlug(spaceSlug, async () => {
        const { space, snapshot, manifest } = await this.snapshotContext(spaceSlug, token);
        if (!snapshot || !manifest) {
          return [
            `MemoRepo serves read-only code intelligence for the "${space.name}" space, but it has no active snapshot yet.`,
            "Ask the user to open the MemoRepo dashboard and run Reindex space, then reconnect."
          ].join("\n");
        }

        return buildSnapshotInstructions({
          spaceName: space.name,
          snapshotVersion: snapshot.version,
          stale: space.snapshotStatus === "stale",
          repositories: manifest.repositories
        });
      });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 409) throw error;
      return [
        `MemoRepo serves read-only code intelligence for the "${spaceSlug}" space from an immutable snapshot.`,
        "Start with list_space_repositories to see repositories and project names.",
        snapshotToolWorkflow()
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

  private snapshotContextById(spaceId: string, snapshotId: string) {
    const space = this.spacesService.getSpaceById(spaceId) as SpaceRow;
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
        WHERE id = ? AND space_id = ?
      `
      )
      .get(snapshotId, spaceId) as SnapshotRow | undefined;

    if (!snapshot) {
      throw new NotFoundError("Snapshot not found");
    }

    return { space, snapshot, manifest: this.manifestFor(snapshot) };
  }

  private manifestFor(snapshot: SnapshotRow): SnapshotManifest {
    const cached = this.manifestCache.get(snapshot.id);
    if (cached) {
      this.assertImmutableSnapshotSources(snapshot, cached);
      return cached;
    }

    const manifest = JSON.parse(snapshot.manifestJson) as SnapshotManifest;
    this.assertImmutableSnapshotSources(snapshot, manifest);
    evictOldest(this.manifestCache, MANIFEST_CACHE_MAX_ENTRIES);
    this.manifestCache.set(snapshot.id, manifest);
    return manifest;
  }

  private assertImmutableSnapshotSources(snapshot: SnapshotRow, manifest: SnapshotManifest): void {
    try {
      const managedHome = fs.realpathSync(path.resolve(this.config.memorepoHome));
      const managedSnapshotsRoot = path.resolve(this.config.snapshotIndexesDir);
      const realManagedSnapshotsRoot = fs.realpathSync(managedSnapshotsRoot);
      if (!isStrictlyInside(managedHome, realManagedSnapshotsRoot)) throw legacySnapshotError();

      const artifactPath = path.resolve(snapshot.artifactPath);
      if (!isStrictlyInside(managedSnapshotsRoot, artifactPath) || !isDirectory(artifactPath)) {
        throw legacySnapshotError();
      }
      const realArtifactPath = fs.realpathSync(artifactPath);
      if (!isStrictlyInside(realManagedSnapshotsRoot, realArtifactPath)) throw legacySnapshotError();

      const sourcesRoot = path.join(artifactPath, "sources");
      if (!Array.isArray(manifest.repositories) || manifest.repositories.length === 0 || !isDirectory(sourcesRoot)) {
        throw legacySnapshotError();
      }
      const realSourcesRoot = fs.realpathSync(sourcesRoot);
      if (!isStrictlyInside(realArtifactPath, realSourcesRoot)) throw legacySnapshotError();

      for (const repository of manifest.repositories) {
        if (!repository || typeof repository.localPath !== "string") throw legacySnapshotError();
        const sourcePath = path.resolve(repository.localPath);
        if (!isStrictlyInside(sourcesRoot, sourcePath) || !isDirectory(sourcePath)) throw legacySnapshotError();
        const realSourcePath = fs.realpathSync(sourcePath);
        if (!isStrictlyInside(realSourcesRoot, realSourcePath)) throw legacySnapshotError();
      }
    } catch {
      throw legacySnapshotError();
    }
  }

  private async cachedCbmTool(snapshot: SnapshotRow, toolName: string, input: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const signal = this.snapshotToolSignal.getStore();
    throwIfAborted(signal);
    const key = `${snapshot.id}\n${toolName}\n${stableStringify(input)}`;
    if (this.cbmResponseCache.has(key)) {
      const cached = this.cbmResponseCache.get(key);
      this.cbmResponseCache.delete(key);
      this.cbmResponseCache.set(key, cached);
      throwIfAborted(signal);
      return cached;
    }

    const response = await this.cbm.tool(toolName, input, snapshot.artifactPath, timeoutMs, signal);
    throwIfAborted(signal);
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
    if (hasRepeatedRelationshipNodeVariable(queryStructure)) {
      throw new Error(
        "query_graph does not support reusing the same node variable on both sides of a relationship pattern reliably; use distinct variables and verify identity client-side"
      );
    }
    if (hasUnlabeledNodePropertyMap(queryStructure)) {
      throw new Error(
        "query_graph requires an explicit node label when matching inline properties; add a label such as :Function or :Method instead of relying on unsupported unlabeled property-map semantics"
      );
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
      const routeResponse = await this.executeRouteGraphQuery(snapshot, requestedProject, query, maxRowsValue, offset);
      if (routeResponse) {
        return this.withCbmResponse(space, snapshot, manifest, routeResponse);
      }
    }
    if (requestedProject) {
      await this.validateGraphQueryProperties(snapshot, [requestedProject], query);
      const response = await this.executeProjectGraphQuery(snapshot, requestedProject, query, maxRowsValue, offset);
      return this.withCbmResponse(space, snapshot, manifest, response);
    }

    const projects = uniqueProjectNames(manifest);
    if (isSimpleRouteQuery(query)) {
      const routeOutcomes = await mapWithConcurrency(projects, PROJECT_FANOUT_CONCURRENCY, async (project) => ({
        project,
        result: await this.executeRouteGraphQuery(snapshot, project, query, maxRowsValue, 0) ?? { rows: [] }
      }));
      const routeAggregate = aggregateGraphQueryOutcomes(routeOutcomes, maxRowsValue);
      routeAggregate.max_rows_scope = "global";
      routeAggregate.max_rows = maxRowsValue;
      return this.withSnapshotMeta(space, snapshot, manifest, routeAggregate);
    }
    await this.validateGraphQueryProperties(snapshot, projects, query);
    const outcomes = await mapWithConcurrency(projects, PROJECT_FANOUT_CONCURRENCY, async (project) => {
      try {
        return { project, result: await this.executeProjectGraphQuery(snapshot, project, query, maxRowsValue, 0) } as ProjectToolSuccess;
      } catch (error) {
        return { project, error: errorMessage(error) } as ProjectToolFailure;
      }
    });
    const aggregated = aggregateGraphQueryOutcomes(outcomes, maxRowsValue);
    aggregated.max_rows_scope = "global";
    aggregated.max_rows = maxRowsValue;
    return this.withSnapshotMeta(space, snapshot, manifest, aggregated);
  }

  private async validateGraphQueryProperties(snapshot: SnapshotRow, projects: string[], query: string): Promise<void> {
    const referenced = cypherPropertyNames(query);
    if (referenced.length === 0) {
      return;
    }
    const schemas = await mapWithConcurrency(projects, PROJECT_FANOUT_CONCURRENCY, async (project) => {
      try {
        return await this.cachedCbmTool(snapshot, "get_graph_schema", { project }, QUERY_GRAPH_TIMEOUT_MS);
      } catch {
        return undefined;
      }
    });
    const known = new Set(schemas.flatMap((schema) => graphSchemaProperties(schema)));
    if (known.size === 0) {
      return;
    }
    const unknown = referenced.filter((property) => !known.has(property));
    if (unknown.length > 0) {
      throw new Error(
        `query_graph references unknown graph properties: ${unknown.join(", ")}; inspect get_graph_schema before querying custom properties`
      );
    }
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

    const internalLimit = Math.min(ENGINE_RESULT_WINDOW, offset + maxRows + 1);
    let response = await this.cachedCbmTool(snapshot, "query_graph", {
      project,
      query: `${query} LIMIT ${internalLimit}`,
      max_rows: internalLimit
    }, QUERY_GRAPH_TIMEOUT_MS);
    response = await this.filterCallsQueryResponse(snapshot, project, query, response);
    if (hasAggregateFunction(query) && graphRows(response).some((row) => row.some((value) => Number(value) === 250))) {
      throw new Error("query_graph aggregation reached the engine's 250-entity scan ceiling and may be inaccurate; narrow the MATCH by label or filters");
    }
    return paginateGraphResponse(response, offset, maxRows, ENGINE_RESULT_WINDOW);
  }

  private async filterCallsQueryResponse(snapshot: SnapshotRow, project: string, query: string, response: unknown): Promise<unknown> {
    const endpoint = callsQualifiedEndpoint(query);
    if (!endpoint || !isRecord(response) || !Array.isArray(response.columns) || !Array.isArray(response.rows)) {
      return response;
    }
    const qualifiedNameIndex = response.columns.findIndex((column) =>
      typeof column === "string" && /(?:caller_qn|qualified_name)$/i.test(column)
    );
    if (qualifiedNameIndex < 0) {
      return response;
    }
    let exactSource: string | undefined;
    if (endpoint.role === "source") {
      try {
        const snippet = await this.cachedCbmTool(snapshot, "get_code_snippet", {
          project,
          qualified_name: endpoint.qualifiedName
        }, QUERY_GRAPH_TIMEOUT_MS);
        exactSource = snippetSource(snippet);
      } catch {
        exactSource = undefined;
      }
    }
    const decisions = await mapWithConcurrency(response.rows, PROJECT_FANOUT_CONCURRENCY, async (row) => {
      if (!Array.isArray(row) || typeof row[qualifiedNameIndex] !== "string") {
        return { row, compatible: undefined };
      }
      if (endpoint.role === "source") {
        return { row, compatible: sourceCallsQualifiedTarget(exactSource, row[qualifiedNameIndex], endpoint.qualifiedName) };
      }
      try {
        const snippet = await this.snippetForQualifiedIdentity(snapshot, project, row[qualifiedNameIndex]);
        return { row, compatible: sourceCallsQualifiedTarget(snippetSource(snippet), endpoint.qualifiedName) };
      } catch {
        return { row, compatible: undefined };
      }
    });
    const filtered = decisions.filter(({ compatible }) => compatible !== false).map(({ row }) => row);
    const removed = decisions.length - filtered.length;
    return {
      ...response,
      rows: filtered,
      ...(removed > 0 ? {
        filtered_receiver_incompatible_calls: removed,
        analysis_warnings: [
          ...(Array.isArray(response.analysis_warnings) ? response.analysis_warnings : []),
          `Removed ${removed} CALLS edges contradicted by the exact qualified endpoint and indexed source evidence.`
        ]
      } : {})
    };
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
    if (toolName === "search_graph" && input.label === "Route" && optionalString(input.project)) {
      const response = await this.searchRouteInventory(snapshot, String(input.project), input);
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
          aggregateSearchOutcomes(
            outcomes,
            optionalNonNegativeInteger(args.offset, 0),
            Number(input.limit)
          )
        );
      }
      return this.withSnapshotMeta(space, snapshot, manifest, aggregateProjectOutcomes(outcomes));
    }
    const response = await this.cachedCbmTool(snapshot, toolName, input, QUERY_GRAPH_TIMEOUT_MS);
    const prepared = await this.prepareToolResponse(snapshot, toolName, input, response);
    return this.withCbmResponse(space, snapshot, manifest, prepared);
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
    const nativeInput: Record<string, unknown> = { ...input, limit: Math.min(ENGINE_RESULT_WINDOW, offset + limit + 1) };
    delete nativeInput.offset;
    const response = await this.cachedCbmTool(snapshot, "search_code", nativeInput, QUERY_GRAPH_TIMEOUT_MS);
    const prepared = await this.prepareToolResponse(snapshot, "search_code", input, response);
    return paginateSearchResponse(prepared, offset, limit, ENGINE_RESULT_WINDOW);
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
    const enriched = toolName === "get_architecture" && architectureRoutesRequested(input)
      ? await this.enrichArchitectureRoutes(snapshot, input, response)
      : response;
    const prepared = sanitizeToolGuidance(toolName, enriched, input);
    if (toolName === "get_graph_schema" && optionalString(input.project) && isRecord(prepared)) {
      try {
        const routeCount = (await this.routeInventory(snapshot, String(input.project))).length;
        reconcileRouteSchemaCount(prepared, routeCount);
        prepared.route_inventory_count = routeCount;
        prepared.route_inventory_notice = "Route counts include normalized routes discovered from indexed source evidence.";
      } catch {
        // Preserve the native schema if route enrichment is unavailable.
      }
    }
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

  private async enrichArchitectureRoutes(snapshot: SnapshotRow, input: Record<string, unknown>, response: unknown): Promise<unknown> {
    const project = optionalString(input.project);
    if (!project || !isRecord(response)) {
      return response;
    }
    const nativeRoutes = Array.isArray(response.routes) ? response.routes : [];
    const routes = await mapWithConcurrency(nativeRoutes, PROJECT_FANOUT_CONCURRENCY, async (route) => {
      if (!isRecord(route) || optionalString(route.method)) {
        return route;
      }
      const routePath = optionalString(route.path);
      const dottedParameter = routePath?.match(/:([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)/)?.[1];
      if (!routePath || !dottedParameter) {
        return route;
      }
      try {
        const search = await this.cachedCbmTool(snapshot, "search_code", {
          project,
          pattern: dottedParameter,
          limit: 10
        }, QUERY_GRAPH_TIMEOUT_MS);
        const snippets = await mapWithConcurrency(searchItems(search), PROJECT_FANOUT_CONCURRENCY, async (item) => {
          if (!isRecord(item)) {
            return undefined;
          }
          const qualifiedName = optionalString(item.qualified_name) ?? optionalString(item.qualifiedName);
          if (!qualifiedName) {
            return undefined;
          }
          try {
            return await this.cachedCbmTool(snapshot, "get_code_snippet", {
              project,
              qualified_name: qualifiedName
            }, QUERY_GRAPH_TIMEOUT_MS);
          } catch {
            return undefined;
          }
        });
        const methods = [...new Set(snippets.flatMap((snippet) => inferHttpMethods(snippetSource(snippet), dottedParameter)))];
        return methods.length === 1 ? { ...route, method: methods[0], method_source: "indexed_code" } : route;
      } catch {
        return route;
      }
    });
    const discovered = await this.discoverHttpRoutes(snapshot, project);
    const merged = new Map<string, unknown>();
    for (const route of [...routes, ...discovered]) {
      if (!isRecord(route)) {
        continue;
      }
      const routePath = normalizeHttpRoutePath(optionalString(route.path) ?? optionalString(route.name) ?? "");
      const method = optionalString(route.method)?.toUpperCase();
      if (!routePath) {
        continue;
      }
      merged.set(`${method ?? "ANY"} ${routePath}`, { ...route, path: routePath, ...(method ? { method } : {}) });
    }
    const mergedRoutes = [...merged.values()].filter((route) => {
      if (!isRecord(route) || optionalString(route.method)) {
        return true;
      }
      const routePath = optionalString(route.path);
      return !routePath || ![...merged.values()].some((candidate) =>
        isRecord(candidate) && optionalString(candidate.path) === routePath && optionalString(candidate.method) !== undefined
      );
    });
    return { ...response, routes: mergedRoutes };
  }

  private async discoverHttpRoutes(snapshot: SnapshotRow, project: string): Promise<Array<Record<string, unknown>>> {
    const verbs = ["get", "post", "put", "patch", "delete"];
    const searches = await mapWithConcurrency(verbs, PROJECT_FANOUT_CONCURRENCY, async (verb) => {
      try {
        return await this.cachedCbmTool(snapshot, "search_code", { project, pattern: `.${verb}`, limit: 25 }, QUERY_GRAPH_TIMEOUT_MS);
      } catch {
        return undefined;
      }
    });
    const qualifiedNames = [...new Set(searches.flatMap((search) => searchItems(search).flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }
      const qualifiedName = optionalString(item.qualified_name) ?? optionalString(item.qualifiedName);
      return qualifiedName ? [qualifiedName] : [];
    })))];
    const snippets = await mapWithConcurrency(qualifiedNames, PROJECT_FANOUT_CONCURRENCY, async (qualifiedName) => {
      try {
        return await this.cachedCbmTool(snapshot, "get_code_snippet", { project, qualified_name: qualifiedName }, QUERY_GRAPH_TIMEOUT_MS);
      } catch {
        return undefined;
      }
    });
    return snippets.flatMap((snippet) => extractHttpRoutes(snippetSource(snippet)).map(({ method, path: routePath }) => ({
      label: "Route",
      name: routePath,
      path: routePath,
      method,
      qualified_name: `__route__${method}__${routePath}`,
      synthetic: true,
      source_available: true,
      method_source: "indexed_code"
    })));
  }

  private async routeInventory(snapshot: SnapshotRow, project: string): Promise<Array<Record<string, unknown>>> {
    const architecture = await this.cachedCbmTool(snapshot, "get_architecture", { project, aspects: ["routes"] }, QUERY_GRAPH_TIMEOUT_MS);
    const enriched = await this.enrichArchitectureRoutes(snapshot, { project, aspects: ["routes"] }, architecture);
    const normalized = normalizeSyntheticRouteValue(enriched);
    return isRecord(normalized) && Array.isArray(normalized.routes)
      ? normalized.routes.filter((route): route is Record<string, unknown> => isRecord(route))
      : [];
  }

  private async searchRouteInventory(snapshot: SnapshotRow, project: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const inventory = await this.routeInventory(snapshot, project);
    const namePattern = optionalString(input.name_pattern);
    const query = optionalString(input.query);
    const filtered = inventory.filter((route) => {
      const routePath = optionalString(route.path) ?? "";
      return (!namePattern || new RegExp(namePattern).test(routePath))
        && (!query || routePath.includes(query) || String(route.method ?? "").includes(query.toUpperCase()));
    });
    const offset = optionalNonNegativeInteger(input.offset, 0);
    const limit = Number(input.limit ?? 10);
    const page = await mapWithConcurrency(filtered.slice(offset, offset + limit), PROJECT_FANOUT_CONCURRENCY, async (route) => {
      const qualifiedName = routeQualifiedName(route);
      let navigable = false;
      try {
        const snippet = await this.cachedCbmTool(snapshot, "get_code_snippet", { project, qualified_name: qualifiedName }, QUERY_GRAPH_TIMEOUT_MS);
        const returnedQualifiedName = isRecord(snippet)
          ? optionalString(snippet.qualified_name) ?? optionalString(snippet.qualifiedName)
          : undefined;
        navigable = returnedQualifiedName === qualifiedName;
      } catch {
        navigable = false;
      }
      return {
        ...route,
        label: "Route",
        name: optionalString(route.path),
        qualified_name: qualifiedName,
        navigable,
        ...(!navigable ? { navigation_notice: "This synthesized route has no exact get_code_snippet target; use source search or method_source evidence." } : {})
      };
    });
    return { results: page, total: filtered.length, offset, effective_limit: limit, returned: page.length, has_more: offset + page.length < filtered.length };
  }

  private async executeRouteGraphQuery(
    snapshot: SnapshotRow,
    project: string,
    query: string,
    limit: number,
    offset: number
  ): Promise<Record<string, unknown> | undefined> {
    const projection = parseSimpleRouteProjection(query);
    if (!projection) {
      return undefined;
    }
    const inventory = await this.routeInventory(snapshot, project);
    const rows = inventory.map((route) => projection.fields.map(({ property }) => routeProperty(route, property)));
    return paginateGraphResponse({ columns: projection.fields.map(({ alias }) => alias), rows }, offset, limit) as Record<string, unknown>;
  }

  private async availableTools(spaceSlug: string, token: string) {
    return this.spacesService.withSpaceReaderBySlug(spaceSlug, async () => {
      const { snapshot } = await this.snapshotContext(spaceSlug, token);
      return this.filterAvailableTools(snapshot);
    });
  }

  private async filterAvailableTools(snapshot: SnapshotRow | null) {
    const declared = this.tools().filter((candidate) => !MUTABLE_SNAPSHOT_TOOLS.has(candidate.name));
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
        const graphCandidates = graphRows(response).map((row) => ({ project, row }));
        if (graphCandidates.length > 0) {
          return graphCandidates;
        }
        if (qualifiedName) {
          const snippet = await this.cachedCbmTool(snapshot, "get_code_snippet", {
            project,
            qualified_name: qualifiedName
          }, QUERY_GRAPH_TIMEOUT_MS);
          if (isRecord(snippet)) {
            const snippetQualifiedName = optionalString(snippet.qualified_name)
              ?? optionalString(snippet.qualifiedName)
              ?? qualifiedNameVariants(qualifiedName, project).at(-1)!;
            const variants = new Set(qualifiedNameVariants(qualifiedName, project));
            if (variants.has(snippetQualifiedName)) {
              return [{
                project,
                row: [
                  optionalString(snippet.name) ?? requestedName,
                  snippetQualifiedName,
                  optionalString(snippet.file_path) ?? optionalString(snippet.filePath) ?? ""
                ]
              }];
            }
          }
          return [];
        }
        const fallback = await this.cachedCbmTool(snapshot, "search_graph", {
          project,
          name_pattern: `^${escapeRegExp(requestedName)}$`,
          limit: SEARCH_RESULT_MAX_LIMIT
        }, QUERY_GRAPH_TIMEOUT_MS);
        return searchItems(fallback).flatMap((item) => {
          if (!isRecord(item)) {
            return [];
          }
          const name = optionalString(item.name);
          const candidateQualifiedName = optionalString(item.qualified_name) ?? optionalString(item.qualifiedName);
          if (!name || !candidateQualifiedName) {
            return [];
          }
          return [{ project, row: [name, candidateQualifiedName, optionalString(item.file_path) ?? optionalString(item.filePath) ?? ""] }];
        });
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
    const identityProbe = await this.cachedCbmTool(snapshot, "get_code_snippet", {
      project: selected.project,
      qualified_name: selectedQualifiedName
    }, QUERY_GRAPH_TIMEOUT_MS);
    const preparedIdentityProbe = await this.prepareToolResponse(snapshot, "get_code_snippet", {
      project: selected.project,
      qualified_name: selectedQualifiedName
    }, identityProbe);
    if (isRecord(preparedIdentityProbe) && preparedIdentityProbe.symbol_identity_confidence === "low") {
      return this.withCbmResponse(space, snapshot, manifest, {
        resolved_symbol: { project: selected.project, name: selected.row[0], qualified_name: selected.row[1], file_path: selected.row[2] },
        trace_available: false,
        symbol_identity_confidence: "low",
        analysis_warnings: [
          ...(Array.isArray(preparedIdentityProbe.analysis_warnings) ? preparedIdentityProbe.analysis_warnings : []),
          "Trace edges were omitted because the indexed symbol may merge homonymous methods. The code snippet remains available with the same confidence warning."
        ]
      });
    }
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
    const normalizedTrace = isRecord(preparedIdentityProbe)
      && preparedIdentityProbe.self_recursive === false
      && preparedIdentityProbe.recursive === false
      ? normalizeTraceAgainstSnippet(data, selectedQualifiedName, resolvedName)
      : { value: data, removed: 0 };
    const identityFilteredTrace = await this.filterTraceAgainstIdentity(
      snapshot,
      selected.project,
      normalizedTrace.value,
      selectedQualifiedName,
      snippetSource(preparedIdentityProbe),
      optionalString(input.direction) ?? "both"
    );
    return this.withCbmResponse(space, snapshot, manifest, {
      ...identityFilteredTrace.value,
      resolved_symbol: { project: selected.project, name: selected.row[0], qualified_name: selected.row[1], file_path: selected.row[2] },
      references,
      ...(normalizedTrace.removed > 0 ? {
        filtered_contradictory_self_hops: normalizedTrace.removed,
        analysis_warnings: [
          ...(Array.isArray(normalizedTrace.value.analysis_warnings) ? normalizedTrace.value.analysis_warnings : []),
          "Removed self-referential trace hops contradicted by the normalized snippet recursion evidence."
        ]
      } : {}),
      ...(identityFilteredTrace.removed > 0 ? {
        filtered_identity_incompatible_hops: identityFilteredTrace.removed,
        analysis_warnings: [
          ...(Array.isArray(identityFilteredTrace.value.analysis_warnings) ? identityFilteredTrace.value.analysis_warnings : []),
          ...(normalizedTrace.removed > 0
            ? ["Removed self-referential trace hops contradicted by the normalized snippet recursion evidence."]
            : []),
          "Removed trace hops contradicted by the exact qualified symbol and indexed source evidence."
        ]
      } : {}),
      confidence_notice: "CALLS edges are static-analysis results. USAGE references include callbacks and functions passed as values."
    });
  }

  private async filterTraceAgainstIdentity(
    snapshot: SnapshotRow,
    project: string,
    response: Record<string, unknown>,
    qualifiedName: string,
    source: string | undefined,
    direction: string
  ): Promise<{ value: Record<string, unknown>; removed: number }> {
    let removed = 0;
    const value = { ...response };
    if (Array.isArray(value.callees) && direction !== "inbound") {
      const decisions = value.callees.map((item) => ({
        item,
        compatible: isRecord(item)
          ? sourceCallsQualifiedTarget(
            source,
            optionalString(item.qualified_name) ?? optionalString(item.qualifiedName) ?? optionalString(item.symbol) ?? "",
            qualifiedName
          )
          : undefined
      }));
      value.callees = decisions.filter(({ compatible }) => compatible !== false).map(({ item }) => item);
      removed += decisions.filter(({ compatible }) => compatible === false).length;
      const discoveredRoutes = extractHttpRoutes(source).map(({ method, path: routePath }) => ({
        name: normalizeHttpRoutePath(routePath),
        qualified_name: `__route__${method}__${normalizeHttpRoutePath(routePath)}`,
        method,
        path: normalizeHttpRoutePath(routePath),
        relation: "CALLS",
        evidence: "indexed_source"
      }));
      const existing = new Set((value.callees as unknown[]).flatMap((item) => isRecord(item)
        ? [optionalString(item.qualified_name) ?? optionalString(item.qualifiedName) ?? ""]
        : []));
      value.callees = [...(value.callees as unknown[]), ...discoveredRoutes.filter((route) => !existing.has(route.qualified_name))];
    }
    if (Array.isArray(value.callers) && direction !== "outbound") {
      const decisions = await mapWithConcurrency(value.callers, PROJECT_FANOUT_CONCURRENCY, async (item) => {
        if (!isRecord(item)) {
          return { item, compatible: undefined };
        }
        const callerQualifiedName = optionalString(item.qualified_name) ?? optionalString(item.qualifiedName) ?? optionalString(item.symbol);
        if (!callerQualifiedName) {
          return { item, compatible: undefined };
        }
        try {
          const snippet = await this.snippetForQualifiedIdentity(snapshot, project, callerQualifiedName);
          return { item, compatible: sourceCallsQualifiedTarget(snippetSource(snippet), qualifiedName) };
        } catch {
          return { item, compatible: undefined };
        }
      });
      value.callers = decisions.filter(({ compatible }) => compatible !== false).map(({ item }) => item);
      removed += decisions.filter(({ compatible }) => compatible === false).length;
    }
    return { value, removed };
  }

  private async snippetForQualifiedIdentity(snapshot: SnapshotRow, project: string, qualifiedName: string): Promise<unknown> {
    let lastError: unknown;
    for (const candidate of qualifiedNameVariants(qualifiedName, project)) {
      try {
        return await this.cachedCbmTool(snapshot, "get_code_snippet", {
          project,
          qualified_name: candidate
        }, QUERY_GRAPH_TIMEOUT_MS);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`snippet not found for ${qualifiedName}`);
  }

  private validateToolArgs(toolName: string, args: Record<string, unknown>): void {
    const definition = this.tools().find((candidate) => candidate.name === toolName);
    if (!definition) {
      throw new Error(`Unknown MCP tool: ${toolName}`);
    }
    const schema = definition.inputSchema as Record<string, unknown>;
    const schemaProperties = isRecord(schema.properties)
      ? new Set(Object.keys(schema.properties))
      : new Set<string>();
    const unsupported = Object.keys(args).filter((key) => !schemaProperties.has(key));
    if (unsupported.length > 0) {
      throw new Error(`${toolName} received unsupported arguments: ${unsupported.join(", ")}`);
    }
    assertNoForbiddenCbmInput(args, toolName);
    if (args.project !== undefined) {
      requiredNonEmptyString(args.project, `${toolName} project`);
    }
    if (toolName === "search_graph" || toolName === "search_code" || toolName === "semantic_query") {
      optionalBoundedInteger(args.limit, `${toolName} limit`, 1);
    }
    if (toolName === "search_code") {
      validateSearchText(requiredNonEmptyString(args.pattern, "search_code pattern"), "search_code pattern");
      optionalBoundedInteger(
        args.offset,
        "search_code offset",
        0,
        optionalString(args.project) ? SEARCH_CODE_SCOPED_MAX_OFFSET : undefined
      );
    }
    if (toolName === "semantic_query") {
      validateSearchText(requiredNonEmptyString(args.query, "semantic_query query"), "semantic_query query");
    }
    if (toolName === "get_code_snippet") {
      requiredNonEmptyString(args.qualified_name, "get_code_snippet qualified_name");
    }
    if (toolName === "search_graph") {
      for (const field of ["query", "name_pattern", "file_pattern"] as const) {
        if (args[field] !== undefined) {
          const value = validateSearchText(requiredNonEmptyString(args[field], `search_graph ${field}`), `search_graph ${field}`);
          if (field === "name_pattern" || field === "file_pattern") {
            validateRegularExpression(value, `search_graph ${field}`);
          }
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
      tool("search_code", "Run native CBM indexed code text search within this space snapshot. Use offset and has_more for pagination; requested limits above 25 use an effective limit of 25. Scoped searches expose the engine's first 250 matches; cross-project searches can page across the combined accessible matches.", {
        type: "object",
        required: ["pattern"],
        properties: {
          project: { type: "string" },
          pattern: { type: "string" },
          regex: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: SEARCH_RESULT_MAX_LIMIT },
          offset: { type: "integer", minimum: 0 }
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
    if (manifest) {
      return manifest.repositories.map((repository) => toSnapshotMcpRepository(repository, options));
    }
    return this.spacesService
      .listSpaceRepositories(spaceId)
      .map((repository) =>
        toMcpRepository(repository as Record<string, unknown>, undefined, options)
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
  const schema = inputSchema.type ? inputSchema : { type: "object", properties: {} };
  return { name, description, inputSchema: { ...schema, additionalProperties: false } };
}

function assertNoForbiddenCbmInput(value: unknown, toolName: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenCbmInput(item, toolName);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_CBM_INPUT_KEYS.has(key)) {
      throw new Error(`${toolName} cannot receive filesystem path arguments through MemoRepo MCP`);
    }
    assertNoForbiddenCbmInput(nested, toolName);
  }
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

function hasRepeatedRelationshipNodeVariable(query: string): boolean {
  const pattern = /\(\s*([A-Za-z_]\w*)\b[^)]*\)\s*-\s*\[[^\]]*\]\s*->\s*\(\s*([A-Za-z_]\w*)\b[^)]*\)/g;
  return [...query.matchAll(pattern)].some((match) => match[1] === match[2]);
}

function hasUnlabeledNodePropertyMap(query: string): boolean {
  return /\(\s*(?:[A-Za-z_]\w*\s*)?\{/.test(query);
}

function requiredNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function validateSearchText(value: string, label: string): string {
  if (/[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }
  return value;
}

function validateRegularExpression(value: string, label: string): void {
  try {
    new RegExp(value);
  } catch (error) {
    throw new Error(`${label} must be a valid regular expression: ${errorMessage(error)}`);
  }
}

function escapeCypherString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function qualifiedNameVariants(qualifiedName: string, project: string): string[] {
  const projectPrefix = `${project}.`;
  const relative = qualifiedName.startsWith(projectPrefix)
    ? qualifiedName.slice(projectPrefix.length)
    : qualifiedName;
  return [...new Set([
    qualifiedName,
    relative,
    `${project}.${relative}`
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

function paginateGraphResponse(response: unknown, offset: number, limit: number, ceiling?: number): unknown {
  if (!isRecord(response) || !Array.isArray(response.rows)) {
    return response;
  }
  const rows = response.rows;
  const pageEnd = ceiling === undefined ? offset + limit : Math.min(offset + limit, ceiling);
  const page = rows.slice(offset, pageEnd);
  const reachedCeiling = ceiling !== undefined && offset + page.length >= ceiling;
  const truncatedAtCeiling = reachedCeiling && rows.length >= ceiling;
  const hasMore = !reachedCeiling && rows.length > offset + page.length;
  const paginated = { ...response };
  delete paginated.total;
  return {
    ...paginated,
    rows: page,
    offset,
    effective_limit: limit,
    returned: page.length,
    has_more: hasMore,
    ...(truncatedAtCeiling ? {
      truncated: true,
      pagination_ceiling: ceiling,
      pagination_notice: `The graph engine exposes at most ${ceiling} rows for one query; narrow the query to recover additional matches.`
    } : !hasMore ? { total: offset + page.length } : {})
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
    if (Array.isArray(sanitized.caller_names) && typeof sanitized.callers === "number" && sanitized.callers !== sanitized.caller_names.length) {
      sanitized.callers = sanitized.caller_names.length;
      sanitized.analysis_warnings = [
        ...(Array.isArray(sanitized.analysis_warnings) ? sanitized.analysis_warnings : []),
        "Corrected caller count to match the caller_names returned by the native snippet response."
      ];
    }
    markSuffixResolvedIdentity(sanitized, args);
  }
  if (toolName === "get_graph_schema" && typeof sanitized.adr_hint === "string" && /manage_adr/i.test(sanitized.adr_hint)) {
    delete sanitized.adr_hint;
    sanitized.adr_notice = "ADR mutation is unavailable through this read-only connection.";
  }
  if (toolName === "get_architecture" && Array.isArray(args.aspects)) {
    if (!args.aspects.includes("routes")) {
      delete sanitized.routes;
    }
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

function markSuffixResolvedIdentity(snippet: Record<string, unknown>, args: Record<string, unknown>): void {
  const requested = optionalString(args.qualified_name);
  const returned = optionalString(snippet.qualified_name) ?? optionalString(snippet.qualifiedName);
  const project = optionalString(args.project);
  if (!requested || !returned) {
    return;
  }
  const normalizedRequested = project && requested.startsWith(`${project}.`)
    ? requested.slice(project.length + 1)
    : requested;
  const normalizedReturned = project && returned.startsWith(`${project}.`)
    ? returned.slice(project.length + 1)
    : returned;
  if (normalizedRequested === normalizedReturned) {
    return;
  }
  if (!normalizedReturned.endsWith(`.${normalizedRequested}`) && snippet.match_method !== "suffix") {
    return;
  }
  snippet.symbol_identity_confidence = "low";
  for (const key of ["callers", "caller_names", "callees", "callee_names"]) {
    delete snippet[key];
  }
  snippet.analysis_warnings = [
    ...(Array.isArray(snippet.analysis_warnings) ? snippet.analysis_warnings : []),
    "The requested symbol was resolved only by suffix. Neighbor call metadata was omitted because the abbreviated identity may match homonymous symbols; retry with the full qualified_name."
  ];
}

function architectureRoutesRequested(input: Record<string, unknown>): boolean {
  return !Array.isArray(input.aspects) || input.aspects.includes("routes");
}

function normalizeSyntheticRouteValue(value: unknown, routeContext = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSyntheticRouteValue(item, routeContext));
  }
  if (!isRecord(value)) {
    return value;
  }
  const normalized = Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    normalizeSyntheticRouteValue(entry, routeContext || key === "routes")
  ]));
  const qualifiedName = optionalString(normalized.qualified_name);
  const syntheticRoute = normalized.label === "Route"
    || qualifiedName?.startsWith("__route__") === true
    || (routeContext && typeof normalized.path === "string")
    || (typeof normalized.path === "string" && ("method" in normalized || "handler" in normalized));
  if (!syntheticRoute) {
    return normalized;
  }

  normalized.synthetic = true;
  if (typeof normalized.path === "string") {
    normalized.path = normalizeHttpRoutePath(normalized.path);
  }
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
  if (typeof snippet.return_type === "string") {
    snippet.return_type = snippet.return_type.replace(/^\s*:\s*/, "").trim();
  }
  const source = typeof snippet.code === "string"
    ? snippet.code
    : typeof snippet.source === "string"
      ? snippet.source
      : undefined;
  if (!source) {
    return;
  }
  const qualifiedName = optionalString(snippet.qualified_name);
  const symbolName = optionalString(snippet.name) ?? qualifiedName?.split(".").at(-1);
  if (!symbolName) {
    return;
  }
  const bodyStart = source.indexOf("{");
  const body = bodyStart >= 0 ? source.slice(bodyStart + 1) : source;
  const warnings = [...(Array.isArray(snippet.analysis_warnings) ? snippet.analysis_warnings : [])];
  const hasSelfCall = containsSelfCall(body, symbolName);
  if (snippet.self_recursive === true && !hasSelfCall) {
    snippet.self_recursive = false;
    snippet.unguarded_recursion = false;
    if (Number(snippet.callees) === 0) {
      snippet.recursive = false;
    }
    warnings.push(`Corrected contradictory recursion metadata: no self-call to ${symbolName} appears in the returned source.`);
  }
  if (snippet.recursive === true && snippet.self_recursive !== true && !containsNamedCall(body, symbolName)) {
    snippet.recursive = false;
    snippet.unguarded_recursion = false;
    warnings.push(`Corrected contradictory recursion metadata: no recursive call involving ${symbolName} appears in the returned source.`);
  }
  if (!hasSelfCall && containsNonSelfQualifiedCall(body, symbolName)) {
    snippet.symbol_identity_confidence = "low";
    warnings.push(
      "The indexed symbol may merge homonymous methods: the returned source calls the same method name through a different receiver."
    );
  }
  if (warnings.length > 0) {
    snippet.analysis_warnings = warnings;
  }
}

function containsSelfCall(code: string, symbolName: string): boolean {
  const escaped = escapeRegExp(symbolName);
  return new RegExp(`(?:\\bthis\\s*\\.\\s*${escaped}\\s*\\(|(?<![.\\w])${escaped}\\s*\\()`).test(code);
}

function containsNonSelfQualifiedCall(code: string, symbolName: string): boolean {
  const escaped = escapeRegExp(symbolName);
  return new RegExp(`(?<![.\\w$])(?!this\\b)[A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*\\s*\\.\\s*${escaped}\\s*\\(`).test(code);
}

function containsNamedCall(code: string, symbolName: string): boolean {
  const escaped = escapeRegExp(symbolName);
  return new RegExp(`(?:\\.\\s*${escaped}\\s*\\(|(?<![.\\w])${escaped}\\s*\\()`).test(code);
}

function snippetSource(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.code === "string" ? value.code : typeof value.source === "string" ? value.source : undefined;
}

function callsQualifiedEndpoint(query: string): { role: "source" | "target"; qualifiedName: string } | undefined {
  if (!/:CALLS\b/i.test(query)) {
    return undefined;
  }
  const relationship = /\(\s*([A-Za-z_]\w*)\s*([^)]*)\)\s*-\s*\[[^\]]*:CALLS[^\]]*\]\s*->\s*\(\s*([A-Za-z_]\w*)\s*([^)]*)\)/i.exec(query);
  if (!relationship) {
    return undefined;
  }
  const endpoints = [
    { role: "source" as const, variable: relationship[1]!, body: relationship[2] ?? "" },
    { role: "target" as const, variable: relationship[3]!, body: relationship[4] ?? "" }
  ];
  for (const endpoint of endpoints) {
    const inline = /\bqualified_name\s*:\s*["']([^"']+)["']/i.exec(endpoint.body);
    const where = new RegExp(`${escapeRegExp(endpoint.variable)}\\.qualified_name\\s*=\\s*["']([^"']+)["']`, "i").exec(query);
    const qualifiedName = inline?.[1] ?? where?.[1];
    if (qualifiedName) {
      return { role: endpoint.role, qualifiedName: qualifiedName.replaceAll("\\'", "'").replaceAll("\\\\", "\\") };
    }
  }
  return undefined;
}

function sourceCallsQualifiedTarget(
  source: string | undefined,
  qualifiedName: string,
  sourceQualifiedName?: string
): boolean | undefined {
  if (!source || !qualifiedName) {
    return undefined;
  }
  const route = /^__route__(GET|POST|PUT|PATCH|DELETE|ANY)__(.+)$/i.exec(qualifiedName);
  if (route) {
    const expectedMethod = route[1]!.toUpperCase();
    const expectedPath = normalizeHttpRoutePath(route[2]!);
    const discovered = extractHttpRoutes(source);
    return discovered.some(({ method, path: routePath }) =>
      (expectedMethod === "ANY" || method === expectedMethod) && normalizeHttpRoutePath(routePath) === expectedPath
    );
  }
  const segments = qualifiedName.split(".");
  const method = segments.at(-1);
  const owner = segments.at(-2);
  if (!method || !owner) {
    return undefined;
  }
  const bodyStart = source.indexOf("{");
  const body = bodyStart >= 0 ? source.slice(bodyStart + 1) : source;
  if (sourceQualifiedName === qualifiedName) {
    return containsSelfCall(body, method);
  }
  const invocationSuffix = `(?:\\s*<[^>]+>)?\\s*\\(`;
  if (new RegExp(`(?<![.\\w])${escapeRegExp(method)}${invocationSuffix}`).test(body)) {
    return true;
  }
  const receiverCalls = [...body.matchAll(new RegExp(
    `(?:\\bthis\\s*\\.\\s*)?([A-Za-z_$][\\w$]*)\\s*\\.\\s*${escapeRegExp(method)}${invocationSuffix}`,
    "g"
  ))].map((match) => match[1]!);
  if (receiverCalls.some((receiver) => receiver.toLowerCase() === "this")) {
    return true;
  }
  if (!/Service$/i.test(owner)) {
    return undefined;
  }
  const ownerBase = owner.replace(/Service$/i, "");
  const singularBase = ownerBase.replace(/s$/i, "");
  const receivers = new Set([owner, lowerCamel(owner), lowerCamel(`${ownerBase}Service`), lowerCamel(`${singularBase}Service`)]);
  if (receiverCalls.some((receiver) => receivers.has(receiver))) {
    return true;
  }
  return receiverCalls.length > 0 ? false : undefined;
}

function lowerCamel(value: string): string {
  return value.length === 0 ? value : value[0]!.toLowerCase() + value.slice(1);
}

function inferHttpMethods(source: string | undefined, dottedParameter: string): string[] {
  if (!source || !source.includes(dottedParameter)) {
    return [];
  }
  return [...source.matchAll(/\.\s*(get|post|put|patch|delete)\s*\(/gi)].map((match) => match[1]!.toUpperCase());
}

function extractHttpRoutes(source: string | undefined): Array<{ method: string; path: string }> {
  if (!source) {
    return [];
  }
  const routes: Array<{ method: string; path: string }> = [];
  const pattern = /\.\s*(get|post|put|patch|delete)(?:\s*<[^>]+>)?\s*\(\s*([^,\r\n]+)/gi;
  for (const match of source.matchAll(pattern)) {
    const routePath = parseHttpRouteArgument(match[2] ?? "");
    if (routePath.startsWith("/")) {
      routes.push({ method: match[1]!.toUpperCase(), path: routePath });
    }
  }
  return routes;
}

function parseHttpRouteArgument(expression: string): string {
  let remaining = expression.trim();
  const parts: string[] = [];
  while (remaining) {
    const template = /^`([^`]*)`/.exec(remaining);
    const quoted = /^(['"])(.*?)\1/.exec(remaining);
    const identifier = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.exec(remaining);
    if (template) {
      parts.push(template[1]!);
      remaining = remaining.slice(template[0].length).trimStart();
    } else if (quoted) {
      parts.push(quoted[2]!);
      remaining = remaining.slice(quoted[0].length).trimStart();
    } else if (identifier) {
      parts.push(`:${identifier[1]!.split(".").at(-1)}`);
      remaining = remaining.slice(identifier[0].length).trimStart();
    } else {
      break;
    }
    if (!remaining.startsWith("+")) {
      break;
    }
    remaining = remaining.slice(1).trimStart();
  }
  return normalizeHttpRoutePath(parts.join(""));
}

function normalizeHttpRoutePath(value: string): string {
  return value
    .replace(/\$\{([^}]+)\}/g, (_match, expression: string) => `:${expression.split(".").at(-1)}`)
    .replace(/:([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g, ":$2");
}

function routeQualifiedName(route: Record<string, unknown>): string {
  const method = optionalString(route.method)?.toUpperCase() ?? "ANY";
  const routePath = optionalString(route.path) ?? optionalString(route.name) ?? "";
  return `__route__${method}__${routePath}`;
}

function parseSimpleRouteProjection(query: string): { fields: Array<{ property: string; alias: string }> } | undefined {
  const match = /^\s*MATCH\s*\(\s*([A-Za-z_]\w*)\s*:\s*Route\s*\)\s*RETURN\s+(.+?)\s*$/i.exec(query);
  if (!match) {
    return undefined;
  }
  const variable = match[1]!;
  const fields = match[2]!.split(",").map((part) => {
    const field = new RegExp(`^\\s*${escapeRegExp(variable)}\\.(name|path|qualified_name|method)\\s*(?:AS\\s+([A-Za-z_]\\w*))?\\s*$`, "i").exec(part);
    return field ? { property: field[1]!.toLowerCase(), alias: field[2] ?? field[1]! } : undefined;
  });
  return fields.every((field): field is { property: string; alias: string } => field !== undefined) ? { fields } : undefined;
}

function isSimpleRouteQuery(query: string): boolean {
  return parseSimpleRouteProjection(query) !== undefined;
}

function routeProperty(route: Record<string, unknown>, property: string): unknown {
  if (property === "qualified_name") {
    return routeQualifiedName(route);
  }
  if (property === "name" || property === "path") {
    return optionalString(route.path) ?? optionalString(route.name) ?? "";
  }
  if (property === "method") {
    return optionalString(route.method) ?? "";
  }
  return "";
}

function reconcileRouteSchemaCount(value: unknown, count: number, parentKey?: string): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      reconcileRouteSchemaCount(item, count, parentKey);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const label = optionalString(value.label) ?? optionalString(value.name) ?? parentKey;
  if (label === "Route" && ("count" in value || parentKey === "Route")) {
    value.count = count;
  }
  for (const [key, child] of Object.entries(value)) {
    reconcileRouteSchemaCount(child, count, key);
  }
}

function normalizeTraceAgainstSnippet(
  response: Record<string, unknown>,
  qualifiedName: string,
  symbolName: string
): { value: Record<string, unknown>; removed: number } {
  let removed = 0;
  const edgeKeys = new Set(["callees", "callers", "hops", "paths", "edges"]);
  const isSelfReference = (item: unknown): boolean => {
    if (!isRecord(item)) {
      return false;
    }
    const candidateQualifiedName = optionalString(item.qualified_name)
      ?? optionalString(item.qualifiedName)
      ?? optionalString(item.symbol);
    if (candidateQualifiedName) {
      return candidateQualifiedName === qualifiedName || candidateQualifiedName.endsWith(`.${qualifiedName}`);
    }
    const candidateName = optionalString(item.name) ?? optionalString(item.function) ?? optionalString(item.function_name);
    return candidateName === symbolName;
  };
  const visit = (value: unknown, parentKey?: string): unknown => {
    if (Array.isArray(value)) {
      const filtered = edgeKeys.has(parentKey ?? "") ? value.filter((item) => {
        if (isSelfReference(item)) {
          removed += 1;
          return false;
        }
        return true;
      }) : value;
      return filtered.map((item) => visit(item, parentKey));
    }
    if (!isRecord(value)) {
      return value;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child, key)]));
  };
  return { value: visit(response) as Record<string, unknown>, removed };
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

function graphSchemaProperties(schema: unknown): string[] {
  const properties = new Set<string>();
  const visit = (value: unknown, parentKey?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (parentKey === "properties") {
          if (typeof item === "string" && item.trim()) {
            properties.add(item);
          } else if (isRecord(item)) {
            const name = optionalString(item.name) ?? optionalString(item.property) ?? optionalString(item.key);
            if (name) {
              properties.add(name);
            }
          }
        }
        visit(item, parentKey);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (parentKey === "properties") {
      for (const key of Object.keys(value)) {
        properties.add(key);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, key);
    }
  };
  visit(schema);
  return [...properties].sort((left, right) => left.localeCompare(right));
}

function cypherPropertyNames(query: string): string[] {
  const structure = maskCypherLiteralsAndComments(query);
  return [...new Set([...structure.matchAll(/\.\s*([A-Za-z_]\w*)/g)].map((match) => match[1]!))];
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

function aggregateGraphQueryOutcomes(outcomes: ProjectToolOutcome[], maxRows: number): Record<string, unknown> {
  const successes = outcomes.filter((outcome): outcome is ProjectToolSuccess => outcome.error === undefined);
  if (successes.length === 0) {
    throw new Error(projectFailureMessage("query_graph", outcomes));
  }
  let remaining = maxRows;
  const continuationProjects: string[] = [];
  const projects = successes.map(({ project, result }) => {
    if (!isRecord(result) || !Array.isArray(result.rows)) {
      return { project, ...(isRecord(result) ? result : { result }) };
    }
    const visibleRows = result.rows.slice(0, remaining);
    const limitedByGlobalMax = result.rows.length > visibleRows.length;
    remaining -= visibleRows.length;
    if (limitedByGlobalMax || directBooleanField(result, "has_more") === true) {
      continuationProjects.push(project);
    }
    return {
      project,
      ...result,
      rows: visibleRows,
      returned: visibleRows.length,
      ...(limitedByGlobalMax ? { limited_by_global_max_rows: true } : {})
    };
  });
  const failures = outcomes.filter((outcome): outcome is ProjectToolFailure => outcome.error !== undefined);
  return {
    projects,
    returned: maxRows - remaining,
    projects_searched: successes.map(({ project }) => project),
    ...(continuationProjects.length > 0 ? {
      scope_continuation_required: true,
      continuation_projects: continuationProjects,
      pagination_notice: "Projectless graph results are grouped by repository and do not support a global offset. Continue with an explicit project from continuation_projects."
    } : { has_more: false }),
    ...(failures.length > 0 ? {
      partial: true,
      project_errors: failures.map(({ project, error }) => ({ project, message: error }))
    } : {})
  };
}

function aggregateSearchOutcomes(
  outcomes: ProjectToolOutcome[],
  offset: number,
  limit: number
): Record<string, unknown> {
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
    candidate_count: total ?? candidates.length,
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

function paginateSearchResponse(response: unknown, offset: number, limit: number, ceiling?: number): unknown {
  if (!isRecord(response)) {
    return response;
  }
  const items = searchItems(response);
  const pageEnd = ceiling === undefined ? offset + limit : Math.min(offset + limit, ceiling);
  const page = items.slice(offset, pageEnd);
  const upstreamTotal = directNumericField(response, "total")
    ?? directNumericField(response, "total_results")
    ?? directNumericField(response, "totalResults");
  const reachedCeiling = ceiling !== undefined && offset + page.length >= ceiling;
  const truncatedAtCeiling = reachedCeiling && (upstreamTotal !== undefined ? upstreamTotal > ceiling : items.length >= ceiling);
  const hasMore = !reachedCeiling && (upstreamTotal !== undefined
    ? offset + page.length < upstreamTotal
    : items.length > offset + page.length);
  return {
    ...response,
    results: page,
    offset,
    effective_limit: limit,
    returned: page.length,
    has_more: hasMore,
    ...(upstreamTotal !== undefined ? { total: upstreamTotal } : !hasMore && !truncatedAtCeiling ? { total: offset + page.length } : {}),
    ...(truncatedAtCeiling ? {
      truncated: true,
      pagination_ceiling: ceiling,
      pagination_notice: `Code search exposes at most ${ceiling} matches per snapshot query; narrow the pattern to recover additional matches.`
    } : {})
  };
}

function projectFailureMessage(toolName: string, outcomes: ProjectToolOutcome[]): string {
  return `${toolName} failed for every project: ${outcomes.map(({ project, error }) => `${project}: ${error ?? "unknown error"}`).join("; ")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Snapshot query was interrupted");
  error.name = "AbortError";
  throw error;
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
    && ("method" in value || "handler" in value || value.type === "route" || value.label === "Route" || value.synthetic === true);
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

function toSnapshotMcpRepository(
  repository: SnapshotManifestRepository,
  options: McpRepositoryListOptions
): McpRepository {
  const result: McpRepository = {
    fullName: repository.fullName,
    project: repository.projectName
  };
  if (options.includeBranches) result.branches = [repository.branch];
  if (options.includeDetails) {
    result.spaceRepositoryId = repository.spaceRepositoryId;
    result.githubRepositoryId = repository.githubRepositoryId;
    result.selectedBranch = repository.branch;
    result.selectedCommit = repository.commit;
    result.snapshotIncluded = true;
    result.branchCount = 1;
  }
  return result;
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

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isStrictlyInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function legacySnapshotError(): Error {
  return Object.assign(new Error("Rebuild this snapshot before using immutable code queries"), { statusCode: 409 });
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
