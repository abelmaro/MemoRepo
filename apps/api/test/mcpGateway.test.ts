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
import type { CbmService } from "../src/services/cbmService.js";
import { McpGateway } from "../src/services/mcpGateway.js";
import { SpaceService } from "../src/services/spaceService.js";

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
      /use list_snapshot_files for file inventories/
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

function createGatewayFixture() {
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
    async listTools(cacheDir: string) {
      cbmListToolsCalls.push(cacheDir);
      return ["search_code", "detect_changes"];
    },
    async tool(toolName: string, input: Record<string, unknown>) {
      cbmToolCalls.push({ toolName, input });
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

  seedPinnedSnapshot(database, { artifactPath, snapshotSourcePath, liveRepositoryPath });

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

function seedPinnedSnapshot(
  database: AppDatabase,
  paths: { artifactPath: string; snapshotSourcePath: string; liveRepositoryPath: string }
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
        localPath: paths.snapshotSourcePath
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
    cbmInteractiveConcurrency: 2
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
