import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import type { AppDatabase } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { sha256 } from "../src/domain/ids.js";
import type { CbmService, McpToolDescriptor } from "../src/services/cbmService.js";
import { assertCbmV090Compatible } from "../src/services/cbmV090Capabilities.js";
import { McpGateway } from "../src/services/mcpGateway.js";
import { SpaceService } from "../src/services/spaceService.js";
import {
  createSnapshotSourceIntegrityManifest,
  snapshotSourceIntegrityManifestPath,
  snapshotSourceIntegritySummary,
  writeSnapshotSourceIntegrityManifestAtomic
} from "../src/services/snapshotSourceIntegrity.js";

test("snapshot tools reject undeclared and nested filesystem arguments before CBM execution", async () => {
  const fixture = createGatewayFixture();

  try {
    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "search_code", {
        pattern: "needle",
        undeclared: "value"
      }),
      /search_code received unsupported arguments: undeclared/
    );

    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "search_code", {
        pattern: "needle",
        project: { scope: [{ sourcePath: "C:\\outside\\source" }] }
      }),
      /search_code cannot receive filesystem path arguments/
    );

    assert.equal(fixture.cbmToolCalls.length, 0);
  } finally {
    fixture.close();
  }
});

test("snapshot chats neither advertise nor execute mutable change detection", async () => {
  const fixture = createGatewayFixture();

  try {
    const definitions = await fixture.gateway.toolDefinitionsForSnapshot("spc_gateway", "snp_gateway");
    assert.equal(definitions.some((definition) => definition.name === "detect_changes"), false);
    assert.equal(definitions.every((definition) => definition.inputSchema.additionalProperties === false), true);

    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "detect_changes", {}),
      /detect_changes is not available for immutable snapshot queries/
    );
    assert.equal(fixture.cbmToolCalls.length, 0);
  } finally {
    fixture.close();
  }
});

test("snapshot tool schemas match the supported CBM v0.9 read contract", async () => {
  const fixture = createGatewayFixture();

  try {
    const definitions = await fixture.gateway.toolDefinitionsForSnapshot("spc_gateway", "snp_gateway");
    const byName = new Map(definitions.map((definition) => [definition.name, definition.inputSchema as {
      properties?: Record<string, { enum?: string[]; items?: { enum?: string[] } }>;
    }]));

    assert.equal(byName.has("semantic_query"), false);
    assert.equal(byName.get("get_architecture")?.properties?.aspects?.items?.enum?.includes("adr"), false);
    assert.ok(byName.get("get_architecture")?.properties?.path);
    assert.ok(byName.get("search_graph")?.properties?.qn_pattern);
    assert.ok(byName.get("search_graph")?.properties?.relationship);
    assert.ok(byName.get("search_code")?.properties?.path_filter);
    assert.deepEqual(byName.get("search_code")?.properties?.mode?.enum, ["compact", "full", "files"]);
    assert.deepEqual(byName.get("trace_path")?.properties?.mode?.enum, ["calls", "data_flow", "cross_service"]);

    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "get_architecture", { aspects: ["adr"] }),
      /unsupported aspects: adr/
    );
    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "search_code", { pattern: "needle", mode: "raw" }),
      /mode must be compact, full, or files/
    );
    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "trace_path", { function_name: "run", mode: "unknown" }),
      /mode must be calls, data_flow, or cross_service/
    );
    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "query_graph", {
        query: "MATCH (caller)-[:CALLS]->(target) RETURN caller.name, target.name"
      }),
      /requires explicit labels on relationship nodes \(caller, target\)/
    );
    assert.equal(fixture.cbmToolCalls.length, 0);
  } finally {
    fixture.close();
  }
});

test("fast snapshots hide semantic_query even when the native schema supports it", async () => {
  const fixture = createGatewayFixture({ indexMode: "fast" });
  try {
    const definitions = await fixture.gateway.toolDefinitionsForSnapshot("spc_gateway", "snp_gateway");
    const searchGraph = definitions.find(({ name }) => name === "search_graph");
    const properties = (searchGraph?.inputSchema as { properties?: Record<string, unknown> }).properties;
    assert.equal(properties?.semantic_query, undefined);
    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "search_graph", {
        project: "pinned-project",
        semantic_query: ["find the request boundary"]
      }),
      /unsupported arguments: semantic_query/
    );
    assert.equal(fixture.cbmToolCalls.length, 0);
  } finally {
    fixture.close();
  }
});

test("moderate snapshots expose and execute semantic_query only when the native schema supports it", async () => {
  const fixture = createGatewayFixture({ indexMode: "moderate" });
  try {
    const definitions = await fixture.gateway.toolDefinitionsForSnapshot("spc_gateway", "snp_gateway");
    const searchGraph = definitions.find(({ name }) => name === "search_graph");
    const properties = (searchGraph?.inputSchema as { properties?: Record<string, unknown> }).properties;
    assert.ok(properties?.semantic_query);

    await fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "search_graph", {
      project: "pinned-project",
      semantic_query: ["find the request boundary"]
    });
    assert.deepEqual(fixture.cbmToolCalls.at(-1), {
      toolName: "search_graph",
      input: {
        project: "pinned-project",
        semantic_query: ["find the request boundary"],
        limit: 10
      }
    });
  } finally {
    fixture.close();
  }
});

test("moderate snapshots fail closed when the native schema omits semantic_query", async () => {
  const fixture = createGatewayFixture({
    indexMode: "moderate",
    descriptorFields: { search_graph: ["qn_pattern", "relationship"] }
  });
  try {
    await assert.rejects(
      () => fixture.gateway.toolDefinitionsForSnapshot("spc_gateway", "snp_gateway"),
      /moderate\/full CBM indexing.*does not expose semantic_query/
    );
    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "search_graph", { query: "boundary" }),
      /moderate\/full CBM indexing.*does not expose semantic_query/
    );
    assert.equal(fixture.cbmToolCalls.length, 0);
  } finally {
    fixture.close();
  }
});

test("gateway removes optional native fields omitted by tools/list descriptors", async () => {
  const fixture = createGatewayFixture({
    descriptorFields: {
      get_architecture: [],
      search_code: ["mode"],
      trace_path: ["include_tests"]
    }
  });
  try {
    const definitions = await fixture.gateway.toolDefinitionsForSnapshot("spc_gateway", "snp_gateway");
    const byName = new Map(definitions.map(({ name, inputSchema }) => [
      name,
      (inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    ]));
    assert.equal(byName.get("get_architecture")?.path, undefined);
    assert.ok(byName.get("search_code")?.mode);
    assert.equal(byName.get("search_code")?.path_filter, undefined);
    assert.ok(byName.get("trace_path")?.include_tests);
    assert.equal(byName.get("trace_path")?.mode, undefined);
  } finally {
    fixture.close();
  }
});

test("gateway fails closed when the runtime omits a required CBM tool", async () => {
  const fixture = createGatewayFixture({ omitTools: ["query_graph"] });
  try {
    await assert.rejects(
      () => fixture.gateway.toolDefinitionsForSnapshot("spc_gateway", "snp_gateway"),
      /missing required tools: query_graph/
    );
    assert.equal(fixture.cbmToolCalls.length, 0);
  } finally {
    fixture.close();
  }
});

test("gateway defaults to compact evidence responses and preserves full detail on request", async () => {
  const fixture = createGatewayFixture({
    toolResponse: (toolName) => toolName === "get_architecture"
      ? {
          overview: "deterministic architecture",
          fp: "internal-fingerprint",
          sp: "internal-structural-profile",
          bt: ["internal", "behavioral", "tags"],
          packages: [{ name: "core", fingerprint: "package-fingerprint" }]
        }
      : { results: [] }
  });
  try {
    const compact = await fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "get_architecture", {
      project: "pinned-project",
      aspects: ["overview"]
    }) as Record<string, unknown>;
    const full = await fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "get_architecture", {
      project: "pinned-project",
      aspects: ["overview"],
      detail: "full"
    }) as Record<string, unknown>;

    assert.equal(compact.fp, undefined);
    assert.equal((compact.packages as Array<Record<string, unknown>>)[0]?.fingerprint, undefined);
    assert.equal(full.fp, "internal-fingerprint");
    assert.equal((full.packages as Array<Record<string, unknown>>)[0]?.fingerprint, "package-fingerprint");
    assert.equal(compact.analysis_kind, "static_analysis");
    assert.equal(compact.evidence_status, "mixed");
    assert.deepEqual(compact.snapshot, { version: 1, quality: "unknown" });
    assert.equal(fixture.cbmToolCalls.length, 1);
    assert.equal("detail" in fixture.cbmToolCalls[0]!.input, false);
  } finally {
    fixture.close();
  }
});

test("route enrichment keeps server registrations and excludes client references and test fixtures", async () => {
  const fixture = createGatewayFixture({
    toolResponse: (toolName, input) => {
      if (toolName === "get_architecture") {
        return {
          routes: [
            { path: "/api/spaces/:selectedSpace!.id" },
            { path: "/native", method: "GET" },
            { path: "/native-test", method: "GET", file_path: "test/routes.test.ts" }
          ]
        };
      }
      if (toolName === "search_code") {
        return {
          results: [
            { qualified_name: "routes.server" },
            { qualified_name: "client.reference" },
            { qualified_name: "tests.fixture" }
          ]
        };
      }
      if (toolName === "get_code_snippet") {
        const qualifiedName = String(input.qualified_name);
        if (qualifiedName === "routes.server") {
          return { qualified_name: qualifiedName, file_path: "src/routes.ts", start_line: 10, code: "app.get('/orders', handler);" };
        }
        if (qualifiedName === "client.reference") {
          return { qualified_name: qualifiedName, file_path: "src/client.ts", code: "client.get('/client', options);" };
        }
        return { qualified_name: qualifiedName, file_path: "test/routes.test.ts", code: "app.get('/test-only', fixture);" };
      }
      return { results: [] };
    }
  });
  try {
    const response = await fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "get_architecture", {
      project: "pinned-project",
      aspects: ["routes"]
    }) as { routes: Array<Record<string, unknown>> };
    assert.deepEqual(response.routes.map(({ method, path: routePath, route_kind, confidence }) => ({
      method,
      path: routePath,
      route_kind,
      confidence
    })), [
      { method: "GET", path: "/native", route_kind: "server_route", confidence: "inferred" },
      { method: "GET", path: "/orders", route_kind: "server_route", confidence: "verified" }
    ]);
    assert.doesNotMatch(JSON.stringify(response.routes), /selectedSpace|client|test-only|native-test/);
  } finally {
    fixture.close();
  }
});

test("trace responses separate source-verified edges from unverified static inference", async () => {
  const fixture = createGatewayFixture({
    toolResponse: (toolName, input) => {
      if (toolName === "query_graph") {
        const query = String(input.query);
        if (query.includes("MATCH (n)")) {
          return { columns: ["name", "qualified_name", "file_path"], rows: [["run", "App.run", "src/app.ts"]] };
        }
        return {
          columns: ["name", "qualified_name", "file_path", "callee"],
          rows: [["callback", "Callbacks.callback", "src/callbacks.ts", "run"]]
        };
      }
      if (toolName === "trace_path") {
        return {
          fp: "internal-trace-fingerprint",
          callees: [
            { name: "execute", qualified_name: "App.Service.execute" },
            { name: "execute", qualified_name: "App.Other.execute" },
            { name: "execute", qualified_name: "App.WrongService.execute" }
          ],
          callers: [
            { name: "good", qualified_name: "Caller.good" },
            { name: "unknown", qualified_name: "Caller.unknown" }
          ]
        };
      }
      if (toolName === "get_code_snippet") {
        const qualifiedName = String(input.qualified_name);
        if (qualifiedName === "App.run") {
          return { name: "run", qualified_name: qualifiedName, code: "function run() { service.execute(); loose(); }" };
        }
        if (qualifiedName === "Caller.good") {
          return { name: "good", qualified_name: qualifiedName, code: "function good() { run(); }" };
        }
        if (qualifiedName === "Caller.unknown") throw new Error("snippet unavailable");
      }
      return { results: [] };
    }
  });
  try {
    const response = await fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "trace_path", {
      project: "pinned-project",
      function_name: "run",
      qualified_name: "App.run"
    }) as Record<string, unknown>;
    const verified = response.verified_edges as Array<Record<string, unknown>>;
    const inferred = response.inferred_edges as Array<Record<string, unknown>>;

    assert.equal(response.fp, undefined);
    assert.equal(verified.length, 2);
    assert.equal(inferred.length, 3);
    assert.ok(verified.every(({ confidence, evidence }) => confidence === "verified" && evidence === "indexed_source"));
    assert.ok(inferred.every(({ confidence, evidence }) => confidence === "inferred" && evidence === "static_graph"));
    assert.doesNotMatch(JSON.stringify(response), /WrongService/);
    assert.match(String(response.confidence_notice), /require source verification/);
  } finally {
    fixture.close();
  }
});

test("MCP connections neither advertise nor execute mutable change detection", async () => {
  const fixture = createGatewayFixture();

  try {
    const token = "mcp-test-token";
    fixture.database.sqlite
      .prepare(
        `INSERT INTO mcp_connections
         (id, space_id, name, client, token_hash, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
      )
      .run("mcp_gateway", "spc_gateway", "Test connection", "test-client", sha256(token), TEST_TIME);
    const response = await fixture.gateway.handleJsonRpc("gateway-space", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    });
    const definitions = (response?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
    assert.equal(definitions.some((definition) => definition.name === "detect_changes"), false);

    await assert.rejects(
      () => fixture.gateway.callTool("gateway-space", token, "detect_changes", {}),
      /detect_changes is not available for immutable snapshot queries/
    );
    assert.equal(fixture.cbmToolCalls.length, 0);
  } finally {
    fixture.close();
  }
});

test("pinned snapshot repository listings remain manifest-derived after live repository changes", async () => {
  const fixture = createGatewayFixture();

  try {
    const expectedRepositories = [
      {
        fullName: "example/pinned-repository",
        project: "pinned-project",
        branches: ["release"],
        spaceRepositoryId: "spr_gateway",
        githubRepositoryId: "ghr_gateway",
        selectedBranch: "release",
        selectedCommit: "pinned-commit",
        snapshotIncluded: true,
        branchCount: 1
      }
    ];
    const argumentsWithDetails = { include_branches: true, include_details: true };

    const before = await fixture.gateway.callSnapshotTool(
      "spc_gateway",
      "snp_gateway",
      "list_space_repositories",
      argumentsWithDetails
    ) as { repositories: unknown[] };
    assert.deepEqual(before.repositories, expectedRepositories);

    fixture.database.sqlite
      .prepare(
        "UPDATE github_repositories SET owner = ?, name = ?, full_name = ?, default_branch = ?, updated_at = ? WHERE id = ?"
      )
      .run("example", "live-repository", "example/live-repository", "next", TEST_TIME, "ghr_gateway");
    fixture.database.sqlite
      .prepare(
        "UPDATE space_repositories SET selected_branch = ?, selected_commit = ?, branches_json = ?, updated_at = ? WHERE id = ?"
      )
      .run("next", "live-commit", JSON.stringify(["next"]), TEST_TIME, "spr_gateway");
    fixture.database.sqlite
      .prepare("UPDATE spaces SET snapshot_status = ?, snapshot_status_updated_at = ?, updated_at = ? WHERE id = ?")
      .run("stale", TEST_TIME, TEST_TIME, "spc_gateway");

    const after = await fixture.gateway.callSnapshotTool(
      "spc_gateway",
      "snp_gateway",
      "list_space_repositories",
      argumentsWithDetails
    ) as { repositories: unknown[]; snapshot: { stale?: boolean } };
    assert.deepEqual(after.repositories, expectedRepositories);
    assert.equal(after.snapshot.stale, true);
    assert.doesNotMatch(JSON.stringify(after.repositories), /live-repository|live-commit|next/);
    assert.equal(fixture.cbmToolCalls.length, 0);
  } finally {
    fixture.close();
  }
});

test("legacy snapshots pointing at a live checkout fail closed before CBM execution", async () => {
  const fixture = createGatewayFixture();

  try {
    const snapshot = fixture.database.sqlite
      .prepare("SELECT manifest_json AS manifestJson FROM space_snapshots WHERE id = ?")
      .get("snp_gateway") as { manifestJson: string };
    const legacyManifest = JSON.parse(snapshot.manifestJson) as {
      repositories: Array<{ localPath: string }>;
    };
    legacyManifest.repositories[0]!.localPath = fixture.liveRepositoryPath;
    fixture.database.sqlite
      .prepare("UPDATE space_snapshots SET manifest_json = ? WHERE id = ?")
      .run(JSON.stringify(legacyManifest), "snp_gateway");

    await assert.rejects(
      () => fixture.gateway.toolDefinitionsForSnapshot("spc_gateway", "snp_gateway"),
      isLegacySnapshotError
    );
    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "search_code", { pattern: "needle" }),
      isLegacySnapshotError
    );
    assert.equal(fixture.cbmListToolsCalls.length, 0);
    assert.equal(fixture.cbmToolCalls.length, 0);
  } finally {
    fixture.close();
  }
});

test("cached snapshot manifests are revalidated after the sources root becomes a link", async () => {
  const fixture = createGatewayFixture();

  try {
    await fixture.gateway.toolDefinitionsForSnapshot("spc_gateway", "snp_gateway");
    assert.equal(fixture.cbmListToolsCalls.length, 1);

    const sourcesRoot = path.dirname(fixture.snapshotSourcePath);
    fs.rmSync(sourcesRoot, { recursive: true, force: true });
    fs.symlinkSync(
      path.dirname(fixture.liveRepositoryPath),
      sourcesRoot,
      process.platform === "win32" ? "junction" : "dir"
    );

    await assert.rejects(
      () => fixture.gateway.toolDefinitionsForSnapshot("spc_gateway", "snp_gateway"),
      isLegacySnapshotError
    );
    assert.equal(fixture.cbmListToolsCalls.length, 1);
    assert.equal(fixture.cbmToolCalls.length, 0);
  } finally {
    fixture.close();
  }
});

test("snapshot file inventory lists the captured tree with project scope, filters, and pagination", async () => {
  const fixture = createGatewayFixture();

  try {
    const definitions = await fixture.gateway.toolDefinitionsForSnapshot("spc_gateway", "snp_gateway");
    const definition = definitions.find((candidate) => candidate.name === "list_snapshot_files");
    assert.ok(definition);
    assert.deepEqual((definition.inputSchema as { required?: string[] }).required, ["project"]);
    assert.match(
      await fixture.gateway.instructionsForSnapshot("spc_gateway", "snp_gateway"),
      /Use list_snapshot_files for path or extension inventories/
    );

    const firstPage = await fixture.gateway.callSnapshotTool(
      "spc_gateway",
      "snp_gateway",
      "list_snapshot_files",
      { project: "pinned-project", limit: 2 }
    ) as { files: string[]; total: number; returned: number; has_more: boolean; next_offset?: number };
    assert.deepEqual(firstPage.files, ["README.md", "assets/css/estilos.css"]);
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.returned, 2);
    assert.equal(firstPage.has_more, true);
    assert.equal(firstPage.next_offset, 2);

    const secondPage = await fixture.gateway.callSnapshotTool(
      "spc_gateway",
      "snp_gateway",
      "list_snapshot_files",
      { project: "example/pinned-repository", limit: 2, offset: 2 }
    ) as { files: string[]; has_more: boolean };
    assert.deepEqual(secondPage.files, ["index.html"]);
    assert.equal(secondPage.has_more, false);

    const cssFiles = await fixture.gateway.callSnapshotTool(
      "spc_gateway",
      "snp_gateway",
      "list_snapshot_files",
      { project: "pinned-project", path_prefix: "assets", glob: "**/*.css" }
    ) as { files: string[]; repository: string; project: string };
    assert.deepEqual(cssFiles.files, ["assets/css/estilos.css"]);
    assert.equal(cssFiles.repository, "example/pinned-repository");
    assert.equal(cssFiles.project, "pinned-project");
    assert.doesNotMatch(JSON.stringify(cssFiles), new RegExp(escapeRegExp(fixture.snapshotSourcePath)));
    assert.equal(fixture.cbmToolCalls.length, 0);
  } finally {
    fixture.close();
  }
});

test("snapshot file inventory rejects unscoped, external, and traversal requests", async () => {
  const fixture = createGatewayFixture();

  try {
    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "list_snapshot_files", {}),
      /list_snapshot_files project must be a non-empty string/
    );
    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "list_snapshot_files", { project: "other-project" }),
      /project is outside this space snapshot/
    );
    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "list_snapshot_files", {
        project: "pinned-project",
        path_prefix: "../outside"
      }),
      /must not contain.*parent-directory/
    );
    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "list_snapshot_files", {
        project: "pinned-project",
        glob: "C:\\**\\*.css"
      }),
      /glob must be relative/
    );
    assert.equal(fixture.cbmToolCalls.length, 0);
  } finally {
    fixture.close();
  }
});

test("snapshot source tools read and exhaustively search files outside the CBM index", async () => {
  const fixture = createGatewayFixture();
  try {
    const definitions = await fixture.gateway.toolDefinitionsForSnapshot("spc_gateway", "snp_gateway");
    assert.ok(definitions.some((definition) => definition.name === "read_snapshot_file"));
    assert.ok(definitions.some((definition) => definition.name === "search_snapshot_text"));

    const read = await fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "read_snapshot_file", {
      project: "pinned-project",
      path: "assets/css/estilos.css"
    }) as { content: string; digest_complete: boolean };
    assert.match(read.content, /1: body \{ color: rebeccapurple; \}/);
    assert.equal(read.digest_complete, true);

    const search = await fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "search_snapshot_text", {
      query: "rebeccapurple",
      extensions: ["css"]
    }) as { complete: boolean; truncated: boolean; has_more: boolean; negative_result_safe: boolean; matches: Array<{ project: string; path: string }> };
    assert.equal(search.complete, true);
    assert.equal(search.truncated, false);
    assert.equal(search.has_more, false);
    assert.equal(search.negative_result_safe, true);
    assert.deepEqual(search.matches.map(({ project, path }) => ({ project, path })), [{
      project: "pinned-project",
      path: "assets/css/estilos.css"
    }]);
    assert.doesNotMatch(JSON.stringify({ read, search }), new RegExp(escapeRegExp(fixture.snapshotSourcePath)));
    assert.equal(fixture.cbmToolCalls.length, 0);
  } finally { fixture.close(); }
});

test("snapshot_index_coverage is local, scoped, integrity-verified, and explicit about exhaustiveness", async () => {
  const fixture = createGatewayFixture();
  try {
    const integrity = await createSnapshotSourceIntegrityManifest(fixture.snapshotSourcePath, "a".repeat(40));
    await writeSnapshotSourceIntegrityManifestAtomic(
      snapshotSourceIntegrityManifestPath(fixture.snapshotSourcePath),
      integrity
    );
    const row = fixture.database.sqlite
      .prepare("SELECT manifest_json AS manifestJson FROM space_snapshots WHERE id = 'snp_gateway'")
      .get() as { manifestJson: string };
    const manifest = JSON.parse(row.manifestJson) as {
      quality?: string;
      repositories: Array<Record<string, unknown>>;
    };
    manifest.quality = "complete";
    manifest.repositories[0] = {
      ...manifest.repositories[0],
      sourceIntegrity: snapshotSourceIntegritySummary(integrity),
      cbmIndex: {
        engineVersion: "codebase-memory-mcp 0.9.0",
        mode: "fast",
        status: "indexed",
        quality: "clean",
        skippedCount: 0,
        snapshotQuality: "complete"
      }
    };
    fixture.database.sqlite
      .prepare("UPDATE space_snapshots SET manifest_json = ? WHERE id = 'snp_gateway'")
      .run(JSON.stringify(manifest));

    const definitions = await fixture.gateway.toolDefinitionsForSnapshot("spc_gateway", "snp_gateway");
    assert.ok(definitions.some((definition) => definition.name === "snapshot_index_coverage"));
    const result = await fixture.gateway.callSnapshotTool(
      "spc_gateway",
      "snp_gateway",
      "snapshot_index_coverage",
      { project: "pinned-project" }
    ) as {
      quality: string;
      coverage_basis: string;
      indexed_file_membership_proven: boolean;
      exhaustive: boolean;
      totals: { source_files: number; candidate_files: number };
      projects: Array<{ project: string; integrity: { verified: boolean } }>;
    };
    assert.equal(result.quality, "complete");
    assert.equal(result.coverage_basis, "source_inventory_minus_reported_exclusions_and_skips");
    assert.equal(result.indexed_file_membership_proven, false);
    assert.equal(result.exhaustive, true);
    assert.deepEqual(result.totals, {
      extension: "all",
      source_files: 3,
      source_bytes: integrity.totalBytes,
      excluded_files: 0,
      skipped_files: 0,
      candidate_files: 3,
      candidate_bytes: integrity.totalBytes,
      coverage_ratio: 1
    });
    assert.equal(result.projects[0]?.project, "pinned-project");
    assert.equal(result.projects[0]?.integrity.verified, true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(escapeRegExp(fixture.snapshotSourcePath)));
    assert.equal(fixture.cbmToolCalls.length, 0);

    await assert.rejects(
      () => fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "snapshot_index_coverage", {
        project: "outside-project"
      }),
      /outside this space snapshot/
    );
  } finally {
    fixture.close();
  }
});

test("CSS search results from CBM remain visible alongside snapshot inventory", async () => {
  const fixture = createGatewayFixture();

  try {
    const response = await fixture.gateway.callSnapshotTool("spc_gateway", "snp_gateway", "search_code", {
      project: "pinned-project",
      pattern: "rebeccapurple"
    });
    const serialized = JSON.stringify(response);
    assert.match(serialized, /assets\/css\/estilos\.css/);
    assert.match(serialized, /rebeccapurple/);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(fixture.snapshotSourcePath)));
    assert.deepEqual(fixture.cbmToolCalls, [{
      toolName: "search_code",
      input: { project: "pinned-project", pattern: "rebeccapurple", limit: 11 }
    }]);
  } finally {
    fixture.close();
  }
});

const TEST_TIME = "2026-01-01T00:00:00.000Z";

interface GatewayFixtureOptions {
  indexMode?: "fast" | "moderate" | "full";
  reportedVersion?: string;
  descriptorFields?: Record<string, string[]>;
  omitTools?: string[];
  toolResponse?: (toolName: string, input: Record<string, unknown>) => unknown;
}

function createGatewayFixture(options: GatewayFixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-mcp-gateway-"));
  const artifactPath = path.join(root, "indexes", "s", "snp_gateway");
  const snapshotSourcePath = path.join(artifactPath, "sources", "pinned-repository");
  const liveRepositoryPath = path.join(root, "spaces", "gateway-space", "pinned-repository");
  fs.mkdirSync(snapshotSourcePath, { recursive: true });
  fs.mkdirSync(path.join(snapshotSourcePath, "assets", "css"), { recursive: true });
  fs.writeFileSync(path.join(snapshotSourcePath, "README.md"), "# Pinned repository\n", "utf8");
  fs.writeFileSync(path.join(snapshotSourcePath, "index.html"), "<link rel=\"stylesheet\" href=\"assets/css/estilos.css\">\n", "utf8");
  fs.writeFileSync(path.join(snapshotSourcePath, "assets", "css", "estilos.css"), "body { color: rebeccapurple; }\n", "utf8");
  fs.mkdirSync(liveRepositoryPath, { recursive: true });
  fs.mkdirSync(path.join(root, "indexes", "c"), { recursive: true });
  const sqlite = new Database(":memory:");
  migrate(sqlite);
  const database = { sqlite } as AppDatabase;
  const cbmListToolsCalls: string[] = [];
  const cbmToolCalls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  const cbm = {
    async capabilities(cacheDir: string) {
      cbmListToolsCalls.push(cacheDir);
      return assertCbmV090Compatible(
        options.reportedVersion ?? "codebase-memory-mcp 0.9.0",
        gatewayToolDescriptors(options.descriptorFields, options.omitTools)
      );
    },
    async listTools(cacheDir: string) {
      cbmListToolsCalls.push(cacheDir);
      return ["get_architecture", "search_graph", "search_code", "trace_path", "query_graph", "detect_changes"];
    },
    async tool(toolName: string, input: Record<string, unknown>) {
      cbmToolCalls.push({ toolName, input });
      if (options.toolResponse) return options.toolResponse(toolName, input);
      if (toolName === "search_code" && input.pattern === "rebeccapurple") {
        return {
          results: [{
            file_path: path.join(snapshotSourcePath, "assets", "css", "estilos.css"),
            snippet: "body { color: rebeccapurple; }"
          }]
        };
      }
      return { results: [] };
    }
  } as unknown as CbmService;
  const config = testConfig(root);
  const spaces = new SpaceService(database, config, cbm);

  seedPinnedSnapshot(database, { artifactPath, snapshotSourcePath, liveRepositoryPath }, options.indexMode);

  return {
    database,
    cbmListToolsCalls,
    cbmToolCalls,
    gateway: new McpGateway(database, config, spaces, cbm),
    liveRepositoryPath,
    snapshotSourcePath,
    close() {
      database.sqlite.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function gatewayToolDescriptors(
  descriptorFields: Record<string, string[]> = {},
  omitTools: string[] = []
): McpToolDescriptor[] {
  const fields: Record<string, string[]> = {
    get_architecture: ["path"],
    search_graph: ["semantic_query", "qn_pattern", "relationship", "exclude_entry_points", "include_connected"],
    search_code: ["file_pattern", "path_filter", "mode", "context"],
    trace_path: ["mode", "parameter_name", "edge_types", "risk_labels", "include_tests"]
  };
  return [
    "list_projects",
    "index_status",
    "get_architecture",
    "get_graph_schema",
    "search_graph",
    "search_code",
    "trace_path",
    "get_code_snippet",
    "query_graph",
    "detect_changes",
    "index_repository"
  ].filter((name) => !omitTools.includes(name)).map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries((descriptorFields[name] ?? fields[name] ?? []).map((field) => [field, {}]))
    }
  }));
}

function seedPinnedSnapshot(
  database: AppDatabase,
  paths: { artifactPath: string; snapshotSourcePath: string; liveRepositoryPath: string },
  indexMode?: "fast" | "moderate" | "full"
): void {
  const manifest = {
    snapshotId: "snp_gateway",
    version: 1,
    createdAt: TEST_TIME,
    repositories: [
      {
        spaceRepositoryId: "spr_gateway",
        githubRepositoryId: "ghr_gateway",
        fullName: "example/pinned-repository",
        branch: "release",
        commit: "pinned-commit",
        projectName: "pinned-project",
        localPath: paths.snapshotSourcePath,
        ...(indexMode ? {
          cbmIndex: {
            engineVersion: "codebase-memory-mcp 0.9.0",
            mode: indexMode,
            status: "indexed",
            quality: "clean",
            skippedCount: 0
          }
        } : {})
      }
    ]
  };

  database.sqlite
    .prepare(
      `INSERT INTO spaces
       (id, name, slug, root_path, active_snapshot_id, snapshot_status, snapshot_status_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`
    )
    .run("spc_gateway", "Gateway Space", "gateway-space", path.dirname(paths.liveRepositoryPath), "active", TEST_TIME, TEST_TIME, TEST_TIME);
  database.sqlite
    .prepare(
      `INSERT INTO github_repositories
       (id, github_id, owner, name, full_name, html_url, clone_url, default_branch, private, archived, fork,
        description, topics_json, pushed_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, NULL, '[]', NULL, ?, ?, ?)`
    )
    .run(
      "ghr_gateway",
      1001,
      "example",
      "pinned-repository",
      "example/pinned-repository",
      "https://example.test/example/pinned-repository",
      "https://example.test/example/pinned-repository.git",
      "release",
      TEST_TIME,
      TEST_TIME,
      TEST_TIME
    );
  database.sqlite
    .prepare(
      `INSERT INTO space_repositories
       (id, space_id, github_repository_id, local_path, selected_branch, selected_commit, remote_ref, clone_status,
        index_status, snapshot_included, branches_json, last_fetched_at, last_indexed_at, last_error, removed_at,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, ?, ?)`
    )
    .run(
      "spr_gateway",
      "spc_gateway",
      "ghr_gateway",
      paths.liveRepositoryPath,
      "release",
      "pinned-commit",
      "refs/remotes/origin/release",
      "cloned",
      "indexed",
      JSON.stringify(["release"]),
      TEST_TIME,
      TEST_TIME,
      TEST_TIME,
      TEST_TIME
    );
  database.sqlite
    .prepare(
      `INSERT INTO space_snapshots
       (id, space_id, version, status, artifact_path, manifest_json, created_at, activated_at, error)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      "snp_gateway",
      "spc_gateway",
      "active",
      paths.artifactPath,
      JSON.stringify(manifest),
      TEST_TIME,
      TEST_TIME
    );
  database.sqlite.prepare("UPDATE spaces SET active_snapshot_id = ? WHERE id = ?").run("snp_gateway", "spc_gateway");
}

function testConfig(root: string): AppConfig {
  return {
    apiHost: "127.0.0.1",
    apiPort: 8787,
    publicApiUrl: "http://127.0.0.1:8787",
    frontendOrigin: "http://127.0.0.1:5173",
    githubToken: null,
    githubOAuthClientId: "test",
    memorepoHome: root,
    secretsDir: path.join(root, "secrets"),
    githubCredentialKeyPath: path.join(root, "secrets", "github.key"),
    dataDir: path.join(root, "data"),
    spacesDir: path.join(root, "spaces"),
    indexesDir: path.join(root, "indexes"),
    repoIndexesDir: path.join(root, "indexes", "r"),
    snapshotIndexesDir: path.join(root, "indexes", "s"),
    revisionSourcesDir: path.join(root, "indexes", "c"),
    logsDir: path.join(root, "logs"),
    tmpDir: path.join(root, "tmp"),
    binDir: path.join(root, "bin"),
    databasePath: ":memory:",
    mcpContainerName: "test",
    agentProvider: "test-provider",
    agentModel: "test-model",
    agentCredentialPath: path.join(root, "secrets", "agent-credentials.json"),
    agentMaxRunSeconds: 600,
    agentMaxToolCalls: 96,
    agentMaxProviderRounds: 16,
    agentMaxActiveTurns: 2,
    agentMaxQueuedTurns: 20,
    snapshotRetentionDefault: 3,
    jobRetentionDaysDefault: 30,
    jobConcurrency: 2,
    cbmIndexConcurrency: 1,
    cbmInteractiveConcurrency: 2,
    enforceSnapshotQuality: true,
    compactCbmResponses: true,
    batchRepositoryOperations: true,
    snapshotOnlyIndexing: false
  };
}

function isLegacySnapshotError(error: unknown): boolean {
  return error instanceof Error
    && error.message === "Rebuild this snapshot before using immutable code queries"
    && (error as Error & { statusCode?: number }).statusCode === 409;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
