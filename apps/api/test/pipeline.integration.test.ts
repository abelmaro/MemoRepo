import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { createServices as createAppServices } from "../src/services/appServices.js";
import type {
  CbmCrossRepoLinksResult,
  CbmIndexRepositoryResult,
  CbmIndexStatusResult,
  CbmService,
  McpToolDescriptor
} from "../src/services/cbmService.js";
import { assertCbmV090Compatible } from "../src/services/cbmV090Capabilities.js";
import type { SnapshotManifest } from "../src/services/snapshotService.js";
import { snapshotSourceIntegrityManifestPath } from "../src/services/snapshotSourceIntegrity.js";
import { insertRecord, updateRecord } from "../src/db/sql.js";
import { spaces } from "../src/db/schema.js";
import { nowIso } from "../src/domain/time.js";
import { createId } from "../src/domain/ids.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const testsRoot = path.join(repoRoot, ".tmp-memorepo-tests");
const TEST_CONTROL_TOKEN = "test-control-token-0123456789abcdef0123456789abcdef";
const TEST_GITHUB_ACCESS_TOKEN = "test-oauth-access-token";
process.env.MEMOREPO_CONTROL_TOKEN = TEST_CONTROL_TOKEN;
process.env.GITHUB_OAUTH_CLIENT_ID = "test-oauth-client-id";
delete process.env.GH_TOKEN;

function createServices() {
  const services = createAppServices();
  services.githubCredentialStore.save(
    {
      githubUserId: 42,
      login: "test-user",
      name: "Test User",
      avatarUrl: "https://avatars.example/test-user",
      accessToken: TEST_GITHUB_ACCESS_TOKEN,
      tokenType: "bearer",
      scopes: ["repo"]
    },
    "2026-07-15T12:00:00.000Z"
  );
  return services;
}

test("database exposes a Drizzle client over the SQLite source of truth", () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "drizzle-db-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const created = services.spaces.createSpace("Drizzle Space");
    const row = services.database.db.select().from(spaces).where(eq(spaces.id, created.id)).get();

    assert.ok(row);
    assert.equal(row.id, created.id);
    assert.equal(row.slug, created.slug);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("managed repository pipeline clones, checks out, indexes, snapshots, and serves MCP tools", async (t) => {
  if (!supportsImmutableCbmConfiguration()) {
    t.skip("requires codebase-memory-mcp 0.9.0 or newer");
    return;
  }
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "pipeline-"));
  const memorepoHome = path.join(testRoot, "memorepo-home");

  process.env.MEMOREPO_HOME = memorepoHome;
  process.env.API_PORT = "8787";

  const remoteUrl = createGitRemote(testRoot);
  const services = createServices();
  services.jobs.start();

  try {
    const space = services.spaces.createSpace("Integration Space");
    const repositoryId = createRepositoryRecord(services.database, remoteUrl);
    const added = services.operations.enqueueAddRepository(space.id, repositoryId);

    await waitForJobs(services.database.sqlite, added.jobs.map((job) => job.id));

    const mainRepository = services.spaces.getSpaceRepository(added.spaceRepository.id);
    assert.equal(mainRepository.clone_status, "cloned");
    assert.equal(mainRepository.index_status, "indexed");
    assert.equal(mainRepository.selected_branch, "main");
    assert.ok(mainRepository.selected_commit);
    assert.equal(mainRepository.snapshot_included, 1);

    const activeSnapshot = services.snapshots.getActiveSnapshot(space.id) as { version: number } | null;
    assert.ok(activeSnapshot);
    assert.equal(activeSnapshot.version, 1);

    const checkoutJobs = services.operations.enqueueCheckout(added.spaceRepository.id, "develop");
    await waitForJobs(services.database.sqlite, checkoutJobs.map((job) => job.id));

    const developRepository = services.spaces.getSpaceRepository(added.spaceRepository.id);
    assert.equal(developRepository.selected_branch, "develop");
    assert.equal(developRepository.index_status, "indexed");
    assert.equal(developRepository.snapshot_included, 1);

    const secondSnapshot = services.snapshots.getActiveSnapshot(space.id) as { version: number } | null;
    assert.ok(secondSnapshot);
    assert.equal(secondSnapshot.version, 2);

    const indexCountBeforeUpdateCheck = countRows(services.database.sqlite, "repo_indexes");
    const unchangedUpdateJob = services.operations.enqueueReindexSpace(space.id);
    await waitForJobs(services.database.sqlite, [unchangedUpdateJob.id]);

    const unchangedSnapshot = services.snapshots.getActiveSnapshot(space.id) as { version: number } | null;
    assert.equal(unchangedSnapshot?.version, 2);
    assert.equal(countRows(services.database.sqlite, "repo_indexes"), indexCountBeforeUpdateCheck);
    const unchangedEvents = services.jobs.getJobEvents(unchangedUpdateJob.id) as Array<{ message: string }>;
    assert.ok(unchangedEvents.some((event) => event.message.includes("is up to date")));

    const sourcePath = path.join(testRoot, "source");
    fs.writeFileSync(path.join(sourcePath, "src", "update.ts"), "export const updateAvailable = true;\n");
    runGit(["add", "."], sourcePath);
    runGit(["commit", "-m", "update develop"], sourcePath);
    runGit(["push", "origin", "develop"], sourcePath);

    const previousCommit = developRepository.selected_commit;
    const changedUpdateJob = services.operations.enqueueReindexSpace(space.id);
    await waitForJobs(services.database.sqlite, [changedUpdateJob.id]);

    const updatedRepository = services.spaces.getSpaceRepository(added.spaceRepository.id);
    assert.notEqual(updatedRepository.selected_commit, previousCommit);
    assert.equal(updatedRepository.index_status, "indexed");
    assert.equal(countRows(services.database.sqlite, "repo_indexes"), indexCountBeforeUpdateCheck + 1);
    const updatedSnapshot = services.snapshots.getActiveSnapshot(space.id) as { version: number } | null;
    assert.equal(updatedSnapshot?.version, 3);

    const connection = services.mcp.createConnection(space.id, "Integration Agent", "generic");
    const listResponse = await services.mcp.callTool(space.slug, connection.token, "list_space_repositories", {});
    const listResponseJson = JSON.stringify(listResponse);
    assert.match(listResponseJson, /integration-owner\/integration-repo/);
    assert.doesNotMatch(listResponseJson, /spaceRepositoryId|defaultBranch|selectedBranch|selectedCommit|cloneStatus|indexStatus|snapshotIncluded|branchCount/);
    const projectName = findFirstString(listResponse, "project");
    assert.ok(projectName);
    assert.doesNotMatch(listResponseJson, /branches|githubRepositoryId|htmlUrl|remoteRef/);
    assert.doesNotMatch(listResponseJson, /local_path|localPath|clone_url|cloneUrl/);
    assert.doesNotMatch(listResponseJson, new RegExp(escapeRegExp(testRoot)));
    assert.doesNotMatch(listResponseJson, /file:\/\//);

    const callbackTrace = await services.mcp.callTool(space.slug, connection.token, "trace_path", {
      project: projectName,
      function_name: "callbackWorker",
      direction: "inbound"
    });
    assert.match(JSON.stringify(callbackTrace), /resolved_symbol/);
    assert.match(JSON.stringify(callbackTrace), /USAGE/);

    const expandedListResponse = await services.mcp.callTool(space.slug, connection.token, "list_space_repositories", {
      include_branches: true,
      include_details: true
    });
    const expandedListResponseJson = JSON.stringify(expandedListResponse);
    assert.match(expandedListResponseJson, /branches/);
    assert.match(expandedListResponseJson, /spaceRepositoryId/);
    assert.match(expandedListResponseJson, /selectedCommit/);
    assert.match(expandedListResponseJson, /githubRepositoryId/);
    assert.match(expandedListResponseJson, /snapshotIncluded/);
    assert.doesNotMatch(expandedListResponseJson, /htmlUrl|defaultBranch|cloneStatus|indexStatus|remoteRef|lastFetchedAt/);
    assertNoInternalPathLeak(expandedListResponseJson, testRoot);

    const searchResponse = await services.mcp.callTool(space.slug, connection.token, "search_graph", {
      project: projectName,
      query: "branchName",
      limit: 10
    });
    const searchResponseJson = JSON.stringify(searchResponse);
    assert.match(searchResponseJson, /branchName/);
    assertNoInternalPathLeak(searchResponseJson, testRoot);

    const qualifiedName =
      findFirstString(searchResponse, "qualified_name") ?? findFirstString(searchResponse, "qualifiedName") ?? findFirstString(searchResponse, "name");
    assert.ok(qualifiedName);
    const snippetResponse = await services.mcp.callTool(space.slug, connection.token, "get_code_snippet", {
      project: projectName,
      qualified_name: qualifiedName
    });
    const snippetResponseJson = JSON.stringify(snippetResponse);
    assert.match(snippetResponseJson, /branchName/);
    assertNoInternalPathLeak(snippetResponseJson, testRoot);

    const graphResponse = await services.mcp.callTool(space.slug, connection.token, "query_graph", {
      query: "MATCH (n) RETURN n",
      max_rows: 5
    });
    const graphResponseJson = JSON.stringify(graphResponse);
    assert.match(graphResponseJson, /snapshot/);
    assertNoInternalPathLeak(graphResponseJson, testRoot);

    const originalCbmTool = services.cbm.tool.bind(services.cbm);
    (services.cbm as unknown as { tool: typeof services.cbm.tool }).tool = async () => ({ payload: "x".repeat(300_000) });
    try {
      const largeResponse = await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        project: projectName,
        query: "MATCH (n) RETURN n",
        max_rows: 1
      });
      assert.equal((largeResponse as { status?: string }).status, "response_too_large");
      assert.match(JSON.stringify(largeResponse), /responseMaxBytes/);
    } finally {
      (services.cbm as unknown as { tool: typeof services.cbm.tool }).tool = originalCbmTool;
    }

    const clonedPath = developRepository.local_path;
    assert.equal(fs.existsSync(clonedPath), true);
    services.spaces.softRemoveSpaceRepository(added.spaceRepository.id);
    assert.equal(services.spaces.listSpaceRepositories(space.id).length, 0);
    assert.equal(services.spaces.listRemovedSpaceRepositories(space.id).length, 1);

    const cleanup = services.spaces.cleanupSpaceRepositoryFiles(added.spaceRepository.id);
    assert.equal(cleanup.existed, true);
    assert.equal(fs.existsSync(clonedPath), false);

    const cleanedRepository = services.spaces.getSpaceRepository(added.spaceRepository.id);
    assert.equal(cleanedRepository.clone_status, "cleaned");
    assert.equal(cleanedRepository.index_status, "not_indexed");
    assert.equal(services.spaces.listRemovedSpaceRepositories(space.id).length, 0);

    services.mcp.revokeConnection(connection.connection.id);
    await assert.rejects(
      () => services.mcp.callTool(space.slug, connection.token, "list_space_repositories", {}),
      /Invalid or revoked MCP token/
    );
  } finally {
    services.jobs.stop();
    await services.cbm.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("MCP HTTP endpoint initializes, lists tools, rejects revoked tokens, and deletes connections", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "mcp-http-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  stubCbmCapabilities(services.cbm);
  const app = await createApp(services);

  try {
    const space = services.spaces.createSpace("HTTP MCP Space");
    const connection = services.mcp.createConnection(space.id, "HTTP Agent", "http");
    const authorization = `Bearer ${connection.token}`;

    const deletePreflightResponse = await app.inject({
      method: "OPTIONS",
      url: `/api/mcp-connections/${connection.connection.id}`,
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "DELETE",
        "access-control-request-headers": "authorization, content-type, x-memorepo-csrf"
      }
    });
    assert.equal(deletePreflightResponse.statusCode, 204);
    assert.equal(deletePreflightResponse.headers["access-control-allow-origin"], "http://127.0.0.1:5173");
    assert.match(String(deletePreflightResponse.headers["access-control-allow-methods"]), /DELETE/);
    assert.match(String(deletePreflightResponse.headers["access-control-allow-headers"]), /content-type/i);
    assert.match(String(deletePreflightResponse.headers["access-control-allow-headers"]), /authorization/i);
    assert.match(String(deletePreflightResponse.headers["access-control-allow-headers"]), /x-memorepo-csrf/i);

    const initializeResponse = await app.inject({
      method: "POST",
      url: `/mcp/${space.slug}`,
      headers: { authorization },
      payload: {
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: { protocolVersion: "2024-11-05" }
      }
    });
    assert.equal(initializeResponse.statusCode, 200);
    const initializePayload = initializeResponse.json<{
      result?: { serverInfo?: { name?: string }; instructions?: string };
      error?: { message: string };
    }>();
    assert.equal(initializePayload.error, undefined);
    assert.equal(initializePayload.result?.serverInfo?.name, `memorepo-${space.slug}`);
    assert.match(initializePayload.result?.instructions ?? "", /no active snapshot/);
    assert.match(initializePayload.result?.instructions ?? "", /HTTP MCP Space/);

    const tokenlessInitialize = await app.inject({
      method: "POST",
      url: `/mcp/${space.slug}`,
      payload: {
        jsonrpc: "2.0",
        id: "init-anon",
        method: "initialize",
        params: { protocolVersion: "2024-11-05" }
      }
    });
    const tokenlessPayload = tokenlessInitialize.json<{ result?: { instructions?: string }; error?: unknown }>();
    assert.equal(tokenlessPayload.error, undefined);
    assert.match(tokenlessPayload.result?.instructions ?? "", /list_space_repositories/);
    assert.doesNotMatch(tokenlessPayload.result?.instructions ?? "", /HTTP MCP Space/);

    const toolsResponse = await app.inject({
      method: "POST",
      url: `/mcp/${space.slug}`,
      headers: { authorization },
      payload: {
        jsonrpc: "2.0",
        id: "tools",
        method: "tools/list"
      }
    });
    assert.equal(toolsResponse.statusCode, 200);
    const toolsPayload = toolsResponse.json<{
      result?: { tools: Array<{ name: string }> };
      error?: { message: string };
    }>();
    assert.equal(toolsPayload.error, undefined);
    assert.ok(toolsPayload.result?.tools.some((tool) => tool.name === "query_graph"));
    assert.ok(toolsPayload.result?.tools.some((tool) => tool.name === "search_graph"));
    assert.ok(toolsPayload.result?.tools.some((tool) => tool.name === "get_code_snippet"));
    assert.ok(toolsPayload.result?.tools.some((tool) => tool.name === "list_space_repositories"));
    assert.equal(toolsPayload.result?.tools.some((tool) => tool.name === "semantic_query"), false);
    for (const legacyTool of ["get_space_architecture", "search_symbols", "trace_symbol", "get_snippet"]) {
      assert.equal(toolsPayload.result?.tools.some((tool) => tool.name === legacyTool), false);
    }

    for (const callId of ["call-1", "call-2"]) {
      const callResponse = await app.inject({
        method: "POST",
        url: `/mcp/${space.slug}`,
        headers: { authorization },
        payload: {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name: "list_space_repositories", arguments: {} }
        }
      });
      assert.equal(callResponse.statusCode, 200);
      assert.equal(callResponse.json<{ error?: unknown }>().error, undefined);
    }

    const statsResponse = await injectControlApi(app, {
      method: "GET",
      url: `/api/spaces/${space.id}/mcp-tool-stats`
    });
    assert.equal(statsResponse.statusCode, 200);
    const statsPayload = statsResponse.json<{
      stats: Array<{ toolName: string; callCount: number; totalResponseBytes: number; maxResponseBytes: number; lastCalledAt: string }>;
    }>();
    const listStats = statsPayload.stats.find((entry) => entry.toolName === "list_space_repositories");
    assert.equal(listStats?.callCount, 2);
    assert.ok((listStats?.totalResponseBytes ?? 0) > (listStats?.maxResponseBytes ?? 0));
    assert.ok((listStats?.maxResponseBytes ?? 0) > 0);

    services.mcp.revokeConnection(connection.connection.id);
    const revokedResponse = await app.inject({
      method: "POST",
      url: `/mcp/${space.slug}`,
      headers: { authorization },
      payload: {
        jsonrpc: "2.0",
        id: "revoked-tools",
        method: "tools/list"
      }
    });
    const revokedPayload = revokedResponse.json<{ error?: { message: string } }>();
    assert.match(revokedPayload.error?.message ?? "", /Invalid or revoked MCP token/);

    const deleteRevokedResponse = await injectControlApi(app, {
      method: "DELETE",
      url: `/api/mcp-connections/${connection.connection.id}`
    });
    assert.equal(deleteRevokedResponse.statusCode, 200);

    const activeConnection = services.mcp.createConnection(space.id, "Delete Active Agent", "generic");
    const deleteActiveResponse = await injectControlApi(app, {
      method: "DELETE",
      url: `/api/mcp-connections/${activeConnection.connection.id}`
    });
    assert.equal(deleteActiveResponse.statusCode, 200);
    assert.equal(services.mcp.listConnections(space.id).length, 0);

    const deletedTokenResponse = await app.inject({
      method: "POST",
      url: `/mcp/${space.slug}`,
      headers: { authorization: `Bearer ${activeConnection.token}` },
      payload: {
        jsonrpc: "2.0",
        id: "deleted-tools",
        method: "tools/list"
      }
    });
    const deletedTokenPayload = deletedTokenResponse.json<{ error?: { message: string } }>();
    assert.match(deletedTokenPayload.error?.message ?? "", /Invalid or revoked MCP token/);
  } finally {
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("MCP connection configs follow the public API URL", () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "mcp-public-url-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";
  delete process.env.MEMOREPO_PUBLIC_API_URL;

  const defaults = createServices();
  let overridden: ReturnType<typeof createServices> | null = null;

  try {
    const space = defaults.spaces.createSpace("Public URL Space");
    const defaultConnection = defaults.mcp.createConnection(space.id, "Default Agent", "generic");
    assert.equal(defaultConnection.configs.http.url, `http://127.0.0.1:8787/mcp/${space.slug}`);

    process.env.MEMOREPO_PUBLIC_API_URL = "http://127.0.0.1:9100/";
    overridden = createServices();
    const overriddenConnection = overridden.mcp.createConnection(space.id, "Custom Port Agent", "generic");
    assert.equal(overriddenConnection.configs.http.url, `http://127.0.0.1:9100/mcp/${space.slug}`);

    const stdioArgs = overriddenConnection.configs.generic.mcpServers[`memorepo-${space.slug}`]!.args;
    assert.ok(stdioArgs.includes("memorepo-api"));
  } finally {
    delete process.env.MEMOREPO_PUBLIC_API_URL;
    defaults.database.sqlite.close();
    overridden?.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("synced repository listing supports kind filters", () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "filters-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    createRepositoryRecord(services.database, "https://github.com/example/public.git", {
      githubId: 2001,
      owner: "example",
      name: "public",
      description: "ordinary repository"
    });
    createRepositoryRecord(services.database, "https://github.com/example/fork.git", {
      githubId: 2002,
      owner: "example",
      name: "fork",
      fork: true,
      description: "forked repository"
    });
    createRepositoryRecord(services.database, "https://github.com/example/archive.git", {
      githubId: 2003,
      owner: "example",
      name: "archive",
      archived: true,
      description: "archived repository"
    });
    createRepositoryRecord(services.database, "https://github.com/example/private.git", {
      githubId: 2004,
      owner: "example",
      name: "private",
      private: true,
      description: "private repository"
    });
    createRepositoryRecord(services.database, "https://github.com/example/snake_case.git", {
      githubId: 2005,
      owner: "example",
      name: "snake_case",
      description: "100% coverage"
    });

    assert.deepEqual(repositoryNames(services.spaces.listGitHubRepositories()), [
      "example/archive",
      "example/fork",
      "example/private",
      "example/public",
      "example/snake_case"
    ]);
    assert.deepEqual(repositoryNames(services.spaces.listGitHubRepositories(undefined, "forks")), ["example/fork"]);
    assert.deepEqual(repositoryNames(services.spaces.listGitHubRepositories(undefined, "archived")), ["example/archive"]);
    assert.deepEqual(repositoryNames(services.spaces.listGitHubRepositories(undefined, "private")), ["example/private"]);
    assert.deepEqual(repositoryNames(services.spaces.listGitHubRepositories("repo", "private")), ["example/private"]);
    assert.deepEqual(repositoryNames(services.spaces.listGitHubRepositories("_")), ["example/snake_case"]);
    assert.deepEqual(repositoryNames(services.spaces.listGitHubRepositories("100%")), ["example/snake_case"]);
    assert.deepEqual(repositoryNames(services.spaces.listGitHubRepositories("%")), ["example/snake_case"]);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("GitHub sync includes organization repositories returned by the authenticated repository listing", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "github-org-sync-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    await withGitHubFetch(
      {
        "https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=full_name": [
          githubRepositoryPayload(8101, "VisibleOrg", "catalog-app", { private: true, ownerType: "Organization" }),
          githubRepositoryPayload(8102, "VisibleOrg", "catalog-api", { archived: true, ownerType: "Organization" })
        ]
      },
      async () => {
        const result = await services.github.syncRepositories();
        assert.equal(result.count, 2);
        assert.equal(result.warnings.length, 0);
      }
    );

    assert.deepEqual(repositoryNames(services.spaces.listGitHubRepositories("catalog")), [
      "VisibleOrg/catalog-api",
      "VisibleOrg/catalog-app"
    ]);
    assert.deepEqual(repositoryNames(services.spaces.listGitHubRepositories(undefined, "archived")), ["VisibleOrg/catalog-api"]);
    assert.deepEqual(repositoryNames(services.spaces.listGitHubRepositories(undefined, "private")), ["VisibleOrg/catalog-app"]);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("GitHub sync warns when an authenticated token exposes no repository scope", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "github-empty-scope-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    await withGitHubFetch(
      {
        "https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=full_name": [],
      },
      async () => {
        const result = await services.github.syncRepositories();
        assert.equal(result.count, 0);
        assert.equal(result.warnings.length, 1);
        assert.match(result.warnings[0]!, /no repositories are visible/);
      }
    );
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("GitHub diagnostics reports scopes, visible repos, and organization access", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "github-diagnostics-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  const app = await createApp(services);

  try {
    await withGitHubFetch(
      {
        "https://api.github.com/user": jsonResponse(
          { login: "diagnostic-user", name: "Diagnostic User" },
          200,
          { "x-oauth-scopes": "repo, read:org", "x-accepted-oauth-scopes": "user" }
        ),
        "https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=full_name": [
          githubRepositoryPayload(8201, "diagnostic-user", "personal-repo"),
          githubRepositoryPayload(8202, "VisibleOrg", "catalog-app", { ownerType: "Organization" })
        ]
      },
      async () => {
        const response = await injectControlApi(app, { method: "GET", url: "/api/github/diagnostics" });
        assert.equal(response.statusCode, 200);
        const payload = response.json<{
          connected: boolean;
          viewer: { login: string };
          tokenScopes: string[];
          acceptedScopes: string[];
          visibleRepositoryCount: number;
          userRepositoryCount: number;
          visibleOrganizationCount: number;
          organizations: Array<{ login: string; status: string; repositoryCount: number | null }>;
          warnings: string[];
        }>();

        assert.equal(payload.connected, true);
        assert.equal(payload.viewer.login, "diagnostic-user");
        assert.deepEqual(payload.tokenScopes, ["repo", "read:org"]);
        assert.deepEqual(payload.acceptedScopes, ["user"]);
        assert.equal(payload.visibleRepositoryCount, 2);
        assert.equal(payload.userRepositoryCount, 2);
        assert.equal(payload.visibleOrganizationCount, 1);
        assert.deepEqual(
          payload.organizations.map((organization) => ({
            login: organization.login,
            status: organization.status,
            repositoryCount: organization.repositoryCount
          })),
          [
            { login: "VisibleOrg", status: "visible", repositoryCount: 1 }
          ]
        );
        assert.deepEqual(payload.warnings, []);
      }
    );
  } finally {
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("preflight reports local runtime checks without leaking secrets", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "preflight-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";
  process.env.MEMOREPO_API_CONTAINER_NAME = "memorepo-api";

  const services = createServices();
  stubCbmCapabilities(services.cbm);
  const app = await createApp(services);

  try {
    await withGitHubFetch(
      {
        "https://api.github.com/user": jsonResponse(
          { login: "preflight-user", name: "Preflight User" },
          200,
          { "x-oauth-scopes": "repo", "x-accepted-oauth-scopes": "user" }
        ),
        "https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=full_name": [
          githubRepositoryPayload(8301, "preflight-user", "visible-repo")
        ],
        "https://api.github.com/user/orgs?per_page=100": []
      },
      async () => {
        const response = await injectControlApi(app, { method: "GET", url: "/api/preflight" });
        assert.equal(response.statusCode, 200);
        assert.doesNotMatch(response.body, /test-oauth-access-token/);

        const payload = response.json<{
          status: string;
          checks: Array<{ id: string; status: string; message: string }>;
          mcpContainerName: string;
        }>();
        const checkIds = payload.checks.map((check) => check.id);

        assert.equal(payload.mcpContainerName, "memorepo-api");
        assert.ok(["ready", "warning"].includes(payload.status));
        assert.equal(checkIds.includes("github-oauth-client"), false);
        assert.ok(checkIds.includes("github-connection"));
        assert.ok(checkIds.includes("github-access"));
        assert.ok(checkIds.includes("github-scopes"));
        assert.ok(checkIds.includes("codebase-memory-mcp"));
        assert.ok(checkIds.includes("memorepo-home-writable"));
        assert.ok(checkIds.includes("disk-space"));
        assert.ok(checkIds.includes("mcp-container-target"));
      }
    );
  } finally {
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("OAuth-first startup reports an actionable disconnected state without contacting GitHub", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "oauth-disconnected-"));
  const originalFetch = globalThis.fetch;
  let githubRequestCount = 0;

  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";
  process.env.MEMOREPO_API_CONTAINER_NAME = "memorepo-api";
  globalThis.fetch = (async () => {
    githubRequestCount += 1;
    throw new Error("GitHub should not be contacted before an account is connected");
  }) as typeof fetch;

  const services = createAppServices();
  stubCbmCapabilities(services.cbm);
  const app = await createApp(services);

  try {
    const preflightResponse = await injectControlApi(app, { method: "GET", url: "/api/preflight" });
    assert.equal(preflightResponse.statusCode, 200);
    const preflight = preflightResponse.json<{
      status: string;
      checks: Array<{ id: string; status: string; message: string }>;
      github: { connected: boolean; error?: string };
    }>();

    assert.equal(preflight.status, "warning");
    assert.equal(preflight.checks.some((check) => check.id === "github-oauth-client"), false);
    assert.equal(
      preflight.checks.find((check) => check.id === "github-connection")?.status,
      "warn"
    );
    assert.equal(preflight.checks.some((check) => check.id === "github-access"), false);
    assert.equal(preflight.github.connected, false);

    const systemResponse = await injectControlApi(app, { method: "GET", url: "/api/system" });
    assert.equal(systemResponse.statusCode, 200);
    const system = systemResponse.json<{ github: { connected: boolean; error?: string } }>();
    assert.equal(system.github.connected, false);
    assert.match(system.github.error ?? "", /Sign in with GitHub from System health/);
    assert.equal(githubRequestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("GitHub OAuth routes expose only public device authorization state", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "oauth-routes-"));
  const originalFetch = globalThis.fetch;
  let githubRequestCount = 0;

  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";
  globalThis.fetch = (async (input) => {
    githubRequestCount += 1;
    assert.equal(String(input), "https://github.com/login/device/code");
    return jsonResponse({
      device_code: "private-device-code",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5
    });
  }) as typeof fetch;

  const services = createAppServices();
  const app = await createApp(services);

  try {
    const initialStatus = await injectControlApi(app, { method: "GET", url: "/api/github/auth/status" });
    assert.deepEqual(initialStatus.json(), {
      authenticationMode: "oauth",
      connected: false,
      manageAuthorizationUrl: "https://github.com/settings/connections/applications/test-oauth-client-id"
    });

    const startResponse = await injectControlApi(app, {
      method: "POST",
      url: "/api/github/auth/device",
      payload: {}
    });
    assert.equal(startResponse.statusCode, 200);
    assert.doesNotMatch(startResponse.body, /private-device-code/);
    const started = startResponse.json<{ attemptId: string; userCode: string; verificationUri: string }>();
    assert.equal(started.userCode, "ABCD-1234");
    assert.equal(started.verificationUri, "https://github.com/login/device");

    const pendingResponse = await injectControlApi(app, {
      method: "GET",
      url: `/api/github/auth/device/${started.attemptId}`
    });
    assert.equal(pendingResponse.json<{ status: string }>().status, "pending");

    const cancelResponse = await injectControlApi(app, {
      method: "DELETE",
      url: `/api/github/auth/device/${started.attemptId}`
    });
    assert.equal(cancelResponse.statusCode, 204);
    assert.equal(githubRequestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("GH_TOKEN marks GitHub connected and disables the OAuth login route", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "token-auth-routes-"));
  const token = "github-token-from-env";
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";
  process.env.GH_TOKEN = token;

  const services = createAppServices();
  const app = await createApp(services);

  try {
    const statusResponse = await injectControlApi(app, { method: "GET", url: "/api/github/auth/status" });
    assert.deepEqual(statusResponse.json(), { authenticationMode: "token", connected: true });
    assert.doesNotMatch(statusResponse.body, new RegExp(token));
    assert.equal(services.githubCredentials.getAccessToken(), token);

    const loginResponse = await injectControlApi(app, {
      method: "POST",
      url: "/api/github/auth/device",
      payload: {}
    });
    assert.equal(loginResponse.statusCode, 409);
    assert.match(loginResponse.body, /already configured with GH_TOKEN/);
  } finally {
    delete process.env.GH_TOKEN;
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("job controls cancel pending jobs, retry terminal jobs, and reject orphaned running cancellation", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "job-controls-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";
  process.env.MEMOREPO_JOB_CONCURRENCY = "1";

  const services = createServices();
  services.jobs.register("manual_job", async () => {});
  const app = await createApp(services);

  try {
    assert.equal(services.jobs.getConcurrency(), 1);

    const createdAt = nowIso();
    const parentId = createId("job");
    const childId = createId("job");
    insertRecord(services.database, "jobs", {
      id: parentId,
      type: "manual_job",
      status: "pending",
      spaceId: null,
      spaceRepositoryId: null,
      dependsOnJobId: null,
      payloadJson: JSON.stringify({ value: 1 }),
      error: null,
      createdAt,
      startedAt: null,
      finishedAt: null
    });
    insertRecord(services.database, "jobs", {
      id: childId,
      type: "manual_job",
      status: "pending",
      spaceId: null,
      spaceRepositoryId: null,
      dependsOnJobId: parentId,
      payloadJson: JSON.stringify({ value: 2 }),
      error: null,
      createdAt,
      startedAt: null,
      finishedAt: null
    });
    services.database.sqlite
      .prepare("INSERT INTO job_dependencies (job_id, dependency_job_id, created_at) VALUES (?, ?, ?)")
      .run(childId, parentId, createdAt);

    const cancelResponse = await injectControlApi(app, { method: "POST", url: `/api/jobs/${parentId}/cancel`, payload: {} });
    assert.equal(cancelResponse.statusCode, 200);
    assert.equal((services.jobs.getJob(parentId) as { status: string }).status, "cancelled");
    const child = services.jobs.getJob(childId) as { status: string; error: string };
    assert.equal(child.status, "skipped");
    assert.match(child.error, /Dependency did not succeed/);

    const retryResponse = await injectControlApi(app, { method: "POST", url: `/api/jobs/${parentId}/retry`, payload: {} });
    assert.equal(retryResponse.statusCode, 200);
    const retryPayload = retryResponse.json<{ job: { id: string; type: string; status: string } }>();
    assert.equal(retryPayload.job.type, "manual_job");
    assert.equal(retryPayload.job.status, "pending");
    assert.notEqual(retryPayload.job.id, parentId);

    const runningId = createId("job");
    insertRecord(services.database, "jobs", {
      id: runningId,
      type: "manual_job",
      status: "running",
      spaceId: null,
      spaceRepositoryId: null,
      dependsOnJobId: null,
      payloadJson: "{}",
      error: null,
      createdAt,
      startedAt: createdAt,
      finishedAt: null
    });
    const runningCancel = await injectControlApi(app, { method: "POST", url: `/api/jobs/${runningId}/cancel`, payload: {} });
    assert.equal(runningCancel.statusCode, 400);
    assert.match(runningCancel.json<{ error: string }>().error, /can no longer be cancelled safely/);
  } finally {
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
    process.env.MEMOREPO_JOB_CONCURRENCY = "2";
  }
});

test("space-wide jobs serialize against other jobs of the same space", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "space-serialization-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";
  process.env.MEMOREPO_JOB_CONCURRENCY = "3";

  const services = createServices();
  const releases = new Map<string, () => void>();
  services.jobs.register("blocking_job", async (payload) => {
    await new Promise<void>((resolve) => {
      releases.set(String(payload.key), resolve);
    });
  });
  services.jobs.register("instant_job", async () => {});
  services.jobs.start();

  try {
    const spaceWide = services.jobs.enqueue({ type: "blocking_job", spaceId: "spc_lock", payload: { key: "space-wide" } });
    await waitForJobStatus(services.database.sqlite, spaceWide.id, "running");

    const sameSpaceRepo = services.jobs.enqueue({
      type: "instant_job",
      spaceId: "spc_lock",
      spaceRepositoryId: "spr_same"
    });
    assert.equal(jobStatus(services.database.sqlite, sameSpaceRepo.id), "pending");

    const otherSpaceRepo = services.jobs.enqueue({
      type: "instant_job",
      spaceId: "spc_other",
      spaceRepositoryId: "spr_other"
    });
    await waitForJobs(services.database.sqlite, [otherSpaceRepo.id]);
    assert.equal(jobStatus(services.database.sqlite, sameSpaceRepo.id), "pending");

    releases.get("space-wide")!();
    await waitForJobs(services.database.sqlite, [spaceWide.id, sameSpaceRepo.id]);

    const repoScoped = services.jobs.enqueue({
      type: "blocking_job",
      spaceId: "spc_lock",
      spaceRepositoryId: "spr_same",
      payload: { key: "repo-scoped" }
    });
    await waitForJobStatus(services.database.sqlite, repoScoped.id, "running");

    const blockedSpaceWide = services.jobs.enqueue({ type: "instant_job", spaceId: "spc_lock" });
    assert.equal(jobStatus(services.database.sqlite, blockedSpaceWide.id), "pending");

    const freeSpaceWide = services.jobs.enqueue({ type: "instant_job", spaceId: "spc_other" });
    await waitForJobs(services.database.sqlite, [freeSpaceWide.id]);
    assert.equal(jobStatus(services.database.sqlite, blockedSpaceWide.id), "pending");

    releases.get("repo-scoped")!();
    await waitForJobs(services.database.sqlite, [repoScoped.id, blockedSpaceWide.id]);
  } finally {
    services.jobs.stop();
    for (const release of releases.values()) {
      release();
    }
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
    process.env.MEMOREPO_JOB_CONCURRENCY = "2";
  }
});

test("job runner marks abandoned running jobs failed on startup recovery", () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "job-recovery-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const createdAt = nowIso();
    const runningId = createId("job");
    insertRecord(services.database, "jobs", {
      id: runningId,
      type: "manual_job",
      status: "running",
      spaceId: null,
      spaceRepositoryId: null,
      dependsOnJobId: null,
      payloadJson: "{}",
      error: null,
      createdAt,
      startedAt: createdAt,
      finishedAt: null
    });

    assert.equal(services.jobs.recoverRunningJobs(), 1);
    const recovered = services.jobs.getJob(runningId) as { status: string; error: string; finished_at: string | null };
    assert.equal(recovered.status, "failed");
    assert.match(recovered.error, /restarted/);
    assert.ok(recovered.finished_at);
    assert.equal(services.jobs.getJobEvents(runningId).length, 2);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("GitHub repository resolution returns actionable SAML errors", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "github-saml-error-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    await withGitHubFetch(
      {
        "https://api.github.com/repos/LockedOrg/private-repo": githubErrorResponse(
          403,
          "Resource protected by organization SAML enforcement.\nTo access this repository, visit https://github.com/enterprises/example-enterprise/sso?authorization_request=test and try your request again."
        )
      },
      async () => {
        await assert.rejects(
          () => services.github.resolveRepository("LockedOrg/private-repo"),
          (error) => {
            const message = error instanceof Error ? error.message : String(error);
            assert.match(message, /GitHub request failed 403/);
            assert.match(message, /Authorize this GitHub connection for SAML SSO/);
            assert.match(message, /https:\/\/github\.com\/enterprises\/example-enterprise\/sso/);
            assert.doesNotMatch(message, /\{"message"/);
            return true;
          }
        );
      }
    );
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("filesystem reconciliation updates missing active clones", () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "reconcile-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("Reconcile Space");
    const repositoryId = createRepositoryRecord(services.database, "https://github.com/example/reconcile.git", {
      githubId: 3001,
      owner: "example",
      name: "reconcile"
    });
    const spaceRepository = services.spaces.addRepositoryToSpace(space.id, repositoryId);
    updateRecord(services.database, "spaces", { activeSnapshotId: "snp_fake", snapshotStatus: "active" }, "id", space.id);
    updateRecord(
      services.database,
      "space_repositories",
      {
        cloneStatus: "cloned",
        indexStatus: "indexed",
        selectedBranch: "main",
        selectedCommit: "abc123",
        remoteRef: "refs/remotes/origin/main",
        snapshotIncluded: true,
        lastError: null
      },
      "id",
      spaceRepository.id
    );

    const reconciliation = services.spaces.reconcileSpaceFilesystem(space.id);
    assert.equal(reconciliation.checked, 1);
    assert.equal(reconciliation.changed, 1);

    const reconciledRepository = services.spaces.getSpaceRepository(spaceRepository.id);
    assert.equal(reconciledRepository.clone_status, "not_cloned");
    assert.equal(reconciledRepository.index_status, "not_indexed");
    assert.equal(reconciledRepository.snapshot_included, 0);
    assert.equal(reconciledRepository.selected_commit, null);
    assert.match(reconciledRepository.last_error ?? "", /not a Git clone/);

    const reconciledSpace = services.spaces.getSpaceById(space.id);
    assert.equal(reconciledSpace.snapshotStatus, "stale");
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("failed first snapshot does not activate a partial snapshot", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-first-failure-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("Snapshot Failure Space");
    createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 4001,
      owner: "example",
      name: "first"
    });
    const failingRepository = createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 4002,
      owner: "example",
      name: "second"
    });
    stubCbmSnapshots(services, failingRepository.local_path);

    await assert.rejects(() => services.snapshots.buildSpaceSnapshot(space.id), /index failed/);

    assert.equal(services.snapshots.getActiveSnapshot(space.id), null);
    assert.equal(services.spaces.getSpaceById(space.id).snapshotStatus, "failed");

    const snapshots = services.database.sqlite
      .prepare("SELECT version, status, error, activated_at FROM space_snapshots WHERE space_id = ? ORDER BY version ASC")
      .all(space.id) as Array<{ version: number; status: string; error: string | null; activated_at: string | null }>;
    assert.deepEqual(
      snapshots.map((snapshot) => ({ version: snapshot.version, status: snapshot.status })),
      [{ version: 1, status: "failed" }]
    );
    assert.match(snapshots[0]!.error ?? "", /index failed/);
    assert.match(snapshots[0]!.error ?? "", /\[MANAGED_PATH\]/);
    assert.doesNotMatch(snapshots[0]!.error ?? "", new RegExp(escapeRegExp(services.config.memorepoHome)));
    const publicSnapshot = services.snapshots.listSpaceSnapshots(space.id).snapshots[0];
    assert.match(publicSnapshot?.error ?? "", /\[MANAGED_PATH\]/);
    assert.doesNotMatch(publicSnapshot?.error ?? "", new RegExp(escapeRegExp(services.config.memorepoHome)));
    assert.equal(snapshots[0]!.activated_at, null);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("active snapshot manifests record the CBM engine version and clean repository quality", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-index-quality-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("Snapshot Quality Space");
    createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 4101,
      owner: "example",
      name: "quality"
    });
    stubCbmSnapshots(services, undefined, (repoPath) => ({
      project: path.basename(repoPath),
      status: "indexed",
      reportedStatus: "indexed",
      quality: "clean",
      skippedCount: 0,
      nodes: 11,
      edges: 17,
      expectedNodes: 11,
      expectedEdges: 17,
      excluded: { dirs: ["vendor"], count: 1, truncated: false }
    }));

    await services.snapshots.buildSpaceSnapshot(space.id);
    const snapshot = services.snapshots.getActiveSnapshot(space.id) as { manifest_json: string };
    const manifest = JSON.parse(snapshot.manifest_json) as SnapshotManifest;

    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.quality, "complete");
    assert.deepEqual(manifest.repositories[0]?.cbmIndex, {
      engineVersion: "codebase-memory-mcp test",
      mode: "fast",
      status: "indexed",
      reportedStatus: "indexed",
      quality: "clean",
      skippedCount: 0,
      excluded: { dirs: ["vendor"], count: 1, truncated: false },
      nodes: 11,
      edges: 17,
      expectedNodes: 11,
      expectedEdges: 17,
      snapshotQuality: "complete",
      statusChecks: {
        afterPrimary: readyIndexStatus("example__quality", 11, 17)
      }
    });
    assert.equal(services.snapshots.listSpaceSnapshots(space.id).snapshots[0]?.quality, "complete");
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("a degraded CBM index cannot activate a snapshot", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-index-degraded-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("Snapshot Degraded Space");
    createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 4102,
      owner: "example",
      name: "degraded"
    });
    stubCbmSnapshots(services, undefined, (repoPath) => ({
      project: path.basename(repoPath),
      status: "degraded",
      reportedStatus: "degraded",
      quality: "degraded",
      skippedCount: 0,
      nodes: 2,
      edges: 1,
      expectedNodes: 20,
      expectedEdges: 10
    }));

    await assert.rejects(
      services.snapshots.buildSpaceSnapshot(space.id),
      /reported degraded quality/
    );
    assert.equal(services.snapshots.getActiveSnapshot(space.id), null);
    assert.equal(services.spaces.getSpaceById(space.id).snapshotStatus, "failed");
    assert.deepEqual(
      services.snapshots.listSpaceSnapshots(space.id).snapshots.map((snapshot) => snapshot.status),
      ["failed"]
    );
    assert.equal(services.snapshots.listSpaceSnapshots(space.id).snapshots[0]?.quality, "degraded");
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("CBM skipped-file errors cannot replace the active snapshot", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-index-skipped-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("Snapshot Skipped File Space");
    createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 4103,
      owner: "example",
      name: "skipped-file"
    });
    stubCbmSnapshots(services);
    await services.snapshots.buildSpaceSnapshot(space.id);
    const activeBefore = services.snapshots.getActiveSnapshot(space.id) as { id: string };

    stubCbmSnapshots(services, undefined, (repoPath) => ({
      project: path.basename(repoPath),
      status: "indexed",
      reportedStatus: "indexed",
      quality: "partial",
      skippedCount: 1,
      skipped: {
        files: [{ path: "src/broken.ts", reason: "parse failed", phase: "parse" }],
        count: 1,
        truncated: false
      },
      nodes: 5,
      edges: 4
    }));

    await assert.rejects(
      services.snapshots.buildSpaceSnapshot(space.id),
      /skipped 1 file due to indexing errors/
    );
    const activeAfter = services.snapshots.getActiveSnapshot(space.id) as { id: string };
    assert.equal(activeAfter.id, activeBefore.id);
    assert.equal(services.spaces.getSpaceById(space.id).snapshotStatus, "stale");
    assert.deepEqual(
      services.snapshots.listSpaceSnapshots(space.id).snapshots.map((snapshot) => snapshot.status),
      ["failed", "active"]
    );
    assert.deepEqual(
      services.snapshots.listSpaceSnapshots(space.id).snapshots.map((snapshot) => snapshot.quality),
      ["partial", "complete"]
    );
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("a degraded post-index index_status prevents snapshot activation", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-index-status-degraded-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  try {
    const space = services.spaces.createSpace("Snapshot Status Degraded Space");
    createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 4104,
      owner: "example",
      name: "status-degraded"
    });
    stubCbmSnapshots(services, undefined, (repoPath) => ({
      project: path.basename(repoPath),
      status: "indexed",
      reportedStatus: "indexed",
      quality: "clean",
      skippedCount: 0,
      nodes: 8,
      edges: 4,
      indexStatus: {
        project: path.basename(repoPath),
        status: "degraded",
        reportedStatus: "degraded",
        quality: "degraded",
        nodes: 8,
        edges: 4
      }
    }));

    await assert.rejects(services.snapshots.buildSpaceSnapshot(space.id), /reported degraded quality/);
    assert.equal(services.snapshots.getActiveSnapshot(space.id), null);
    assert.equal(services.snapshots.listSpaceSnapshots(space.id).snapshots[0]?.quality, "degraded");
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("a degraded post-link index_status prevents a multi-repository snapshot from activating", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-link-status-degraded-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  try {
    const space = services.spaces.createSpace("Snapshot Link Status Degraded Space");
    createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 4105,
      owner: "example",
      name: "link-a"
    });
    createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 4106,
      owner: "example",
      name: "link-b"
    });
    stubCbmSnapshots(services, undefined, undefined, (repoPath) => ({
      project: path.basename(repoPath),
      status: "linked",
      indexStatus: {
        project: path.basename(repoPath),
        status: "error",
        reportedStatus: "error",
        quality: "degraded",
        nodes: 1,
        edges: 0
      }
    }));

    await assert.rejects(services.snapshots.buildSpaceSnapshot(space.id), /reported degraded quality/);
    assert.equal(services.snapshots.getActiveSnapshot(space.id), null);
    const failed = services.snapshots.listSpaceSnapshots(space.id).snapshots[0];
    assert.equal(failed?.quality, "degraded");
    const row = services.database.sqlite
      .prepare("SELECT manifest_json AS manifestJson FROM space_snapshots WHERE id = ?")
      .get(failed?.id) as { manifestJson: string };
    const manifest = JSON.parse(row.manifestJson) as SnapshotManifest;
    assert.equal(manifest.quality, "degraded");
    assert.equal(manifest.repositories[0]?.cbmIndex?.statusChecks?.afterLinking?.status, "error");
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("GitHub repository resolution hides upstream HTML outages behind a stable error code", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "github-upstream-error-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    await withGitHubFetch(
      {
        "https://api.github.com/repos/example/unavailable": new Response(
          "<!DOCTYPE html><html><body>Service unavailable</body></html>",
          { status: 503, headers: { "content-type": "text/html" } }
        )
      },
      async () => {
        await assert.rejects(
          () => services.github.resolveRepository("example/unavailable"),
          (error) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /temporarily unavailable \(HTTP 503\)/);
            assert.doesNotMatch(error.message, /DOCTYPE|<html>/i);
            assert.equal((error as Error & { code?: string }).code, "MR-GITHUB-UPSTREAM-503");
            return true;
          }
        );
      }
    );
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("service startup removes stale snapshot artifacts and worktrees without touching unrelated data", () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-worktree-cleanup-"));
  const memorepoHome = path.join(testRoot, "memorepo-home");
  const stagingRoot = path.join(memorepoHome, "tmp", "snapshot-worktrees");
  const staleWorktree = path.join(stagingRoot, "w-deadbeef");
  const unrelatedTemporaryData = path.join(stagingRoot, "keep-me");
  const worktreeRegistration = path.join(memorepoHome, "spaces", "source-repository", ".git", "worktrees", "w-deadbeef");
  const orphanedSnapshot = path.join(memorepoHome, "indexes", "s", "snp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const unrelatedSnapshotData = path.join(memorepoHome, "indexes", "s", "keep-me");
  fs.mkdirSync(staleWorktree, { recursive: true });
  fs.mkdirSync(unrelatedTemporaryData, { recursive: true });
  fs.mkdirSync(worktreeRegistration, { recursive: true });
  fs.mkdirSync(path.join(orphanedSnapshot, "sources"), { recursive: true });
  fs.mkdirSync(unrelatedSnapshotData, { recursive: true });
  fs.writeFileSync(path.join(staleWorktree, ".git"), `gitdir: ${worktreeRegistration}\n`, "utf8");
  fs.writeFileSync(path.join(staleWorktree, "private-source.ts"), "export const stale = true;\n", "utf8");
  fs.writeFileSync(path.join(worktreeRegistration, "gitdir"), `${path.join(staleWorktree, ".git")}\n`, "utf8");
  fs.writeFileSync(path.join(worktreeRegistration, "HEAD"), "deadbeef\n", "utf8");
  fs.writeFileSync(path.join(orphanedSnapshot, "sources", "private-source.ts"), "export const orphaned = true;\n", "utf8");
  fs.writeFileSync(path.join(unrelatedTemporaryData, "keep.txt"), "keep\n", "utf8");
  fs.writeFileSync(path.join(unrelatedSnapshotData, "keep.txt"), "keep\n", "utf8");
  process.env.MEMOREPO_HOME = memorepoHome;
  process.env.API_PORT = "8787";

  const services = createServices();
  try {
    assert.equal(fs.existsSync(staleWorktree), false);
    assert.equal(fs.existsSync(worktreeRegistration), false);
    assert.equal(fs.existsSync(orphanedSnapshot), false);
    assert.equal(fs.readFileSync(path.join(unrelatedTemporaryData, "keep.txt"), "utf8"), "keep\n");
    assert.equal(fs.readFileSync(path.join(unrelatedSnapshotData, "keep.txt"), "utf8"), "keep\n");
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("snapshot source materializes the exact selected commit independently of the live checkout", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-source-immutability-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("Snapshot Source Space");
    const repository = createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 4501,
      owner: "example",
      name: "immutable-source"
    });
    const committedContent = fs.readFileSync(path.join(repository.local_path, "README.md"), "utf8");

    fs.writeFileSync(path.join(repository.local_path, "README.md"), "# newer-live-commit\n", "utf8");
    execFileSync("git", ["-C", repository.local_path, "add", "README.md"], { stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-C",
        repository.local_path,
        "-c",
        "user.name=MemoRepo Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-m",
        "Newer live revision"
      ],
      { stdio: "ignore" }
    );
    stubCbmSnapshots(services);

    await services.snapshots.buildSpaceSnapshot(space.id);
    const row = services.snapshots.getActiveSnapshot(space.id) as { artifact_path: string; manifest_json: string };
    const manifest = JSON.parse(row.manifest_json) as { repositories: Array<{ localPath: string }> };
    const snapshotSource = manifest.repositories[0]!.localPath;

    assert.notEqual(path.resolve(snapshotSource), path.resolve(repository.local_path));
    assert.ok(path.resolve(snapshotSource).startsWith(path.resolve(services.config.revisionSourcesDir) + path.sep));
    assert.equal(fs.readFileSync(path.join(snapshotSource, "README.md"), "utf8"), committedContent);
    assert.equal(fs.existsSync(path.join(snapshotSource, ".git")), false);

    fs.writeFileSync(path.join(repository.local_path, "README.md"), "# uncommitted-live-edit\n", "utf8");
    assert.equal(fs.readFileSync(path.join(snapshotSource, "README.md"), "utf8"), committedContent);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("replacement snapshots reuse an immutable source for the same repository commit", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-source-reuse-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("Snapshot Source Reuse Space");
    createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 4502,
      owner: "example",
      name: "reused-source"
    });
    stubCbmSnapshots(services);
    await services.snapshots.buildSpaceSnapshot(space.id);

    Object.defineProperty(services.snapshots, "materializeRepository", {
      value: async () => {
        throw new Error("unchanged source was materialized again");
      }
    });

    await services.snapshots.buildSpaceSnapshot(space.id);
    const snapshots = services.snapshots.listSpaceSnapshots(space.id).snapshots;
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0]?.status, "active");
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("replacement snapshots rebuild a cached source changed with the same size and mtime", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-source-integrity-rebuild-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  try {
    const space = services.spaces.createSpace("Snapshot Source Integrity Rebuild Space");
    createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 4503,
      owner: "example",
      name: "integrity-rebuild"
    });
    stubCbmSnapshots(services);
    await services.snapshots.buildSpaceSnapshot(space.id);
    const firstRow = services.snapshots.getActiveSnapshot(space.id) as { manifest_json: string };
    const firstManifest = JSON.parse(firstRow.manifest_json) as SnapshotManifest;
    const firstRepository = firstManifest.repositories[0]!;
    const sourceFile = path.join(firstRepository.localPath, "README.md");
    const original = fs.readFileSync(sourceFile);
    const originalStat = fs.statSync(sourceFile);
    const changed = Buffer.from(original);
    changed[0] = changed[0] === 0x23 ? 0x24 : (changed[0]! ^ 1);
    fs.writeFileSync(sourceFile, changed);
    fs.utimesSync(sourceFile, originalStat.atime, originalStat.mtime);
    assert.equal(fs.statSync(sourceFile).size, originalStat.size);
    assert.equal(fs.existsSync(snapshotSourceIntegrityManifestPath(firstRepository.localPath)), true);

    await services.snapshots.buildSpaceSnapshot(space.id);
    assert.deepEqual(fs.readFileSync(sourceFile), original);
    const secondRow = services.snapshots.getActiveSnapshot(space.id) as { manifest_json: string };
    const secondManifest = JSON.parse(secondRow.manifest_json) as SnapshotManifest;
    assert.deepEqual(secondManifest.repositories[0]?.sourceIntegrity, firstRepository.sourceIntegrity);
    assert.equal(secondManifest.repositories[0]?.sourceIntegrity?.fileCount, 1);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("cancelled integrity rebuild preserves the previous source and cleans staging directories", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-source-integrity-cancel-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  try {
    const space = services.spaces.createSpace("Snapshot Source Integrity Cancel Space");
    createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 4504,
      owner: "example",
      name: "integrity-cancel"
    });
    stubCbmSnapshots(services);
    await services.snapshots.buildSpaceSnapshot(space.id);
    const activeBefore = services.snapshots.getActiveSnapshot(space.id) as { id: string; manifest_json: string };
    const manifest = JSON.parse(activeBefore.manifest_json) as SnapshotManifest;
    const sourcePath = manifest.repositories[0]!.localPath;
    const sourceFile = path.join(sourcePath, "README.md");
    const changed = Buffer.from(fs.readFileSync(sourceFile));
    changed[0] = changed[0] === 0x23 ? 0x24 : (changed[0]! ^ 1);
    fs.writeFileSync(sourceFile, changed);
    const controller = new AbortController();
    Object.defineProperty(services.snapshots, "materializeRepository", {
      value: async (_home: string, _repositoryPath: string, _commit: string, targetPath: string) => {
        fs.mkdirSync(targetPath, { recursive: true });
        fs.writeFileSync(path.join(targetPath, "partial.txt"), "partial\n", "utf8");
        controller.abort(new Error("cancelled integrity rebuild"));
        const error = new Error("cancelled integrity rebuild");
        error.name = "AbortError";
        throw error;
      }
    });

    await assert.rejects(
      services.snapshots.buildSpaceSnapshot(space.id, undefined, controller.signal),
      /cancelled integrity rebuild/
    );
    assert.deepEqual(fs.readFileSync(sourceFile), changed);
    assert.equal((services.snapshots.getActiveSnapshot(space.id) as { id: string }).id, activeBefore.id);
    const commitRoot = path.dirname(sourcePath);
    assert.deepEqual(
      fs.readdirSync(path.dirname(commitRoot)).filter((entry) => entry.startsWith(".tmp-") || entry.startsWith(".stale-")),
      []
    );
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("failed replacement snapshot keeps the previous active snapshot", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-replacement-failure-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("Snapshot Replacement Space");
    createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 5001,
      owner: "example",
      name: "alpha"
    });
    const failingRepository = createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 5002,
      owner: "example",
      name: "beta"
    });
    stubCbmSnapshots(services);

    const firstSnapshot = await services.snapshots.buildSpaceSnapshot(space.id);
    const firstActiveSnapshot = services.snapshots.getActiveSnapshot(space.id) as { id: string; version: number; status: string };
    assert.equal(firstSnapshot.version, 1);
    assert.equal(firstActiveSnapshot.version, 1);
    assert.equal(firstActiveSnapshot.status, "active");

    stubCbmSnapshots(services, failingRepository.local_path);
    await assert.rejects(() => services.snapshots.buildSpaceSnapshot(space.id), /index failed/);

    const activeSnapshot = services.snapshots.getActiveSnapshot(space.id) as { id: string; version: number; status: string };
    assert.equal(activeSnapshot.id, firstActiveSnapshot.id);
    assert.equal(activeSnapshot.version, 1);
    assert.equal(activeSnapshot.status, "active");

    const staleSpace = services.spaces.getSpaceById(space.id);
    assert.equal(staleSpace.activeSnapshotId, firstActiveSnapshot.id);
    assert.equal(staleSpace.snapshotStatus, "stale");

    const snapshots = services.database.sqlite
      .prepare("SELECT version, status FROM space_snapshots WHERE space_id = ? ORDER BY version ASC")
      .all(space.id);
    assert.deepEqual(snapshots, [
      { version: 1, status: "active" },
      { version: 2, status: "failed" }
    ]);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("replacement snapshot leaves previous snapshot sessions available for pinned answers", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-replacement-session-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("Snapshot Session Space");
    createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 5100,
      owner: "example",
      name: "session-source"
    });
    stubCbmSnapshots(services);
    await services.snapshots.buildSpaceSnapshot(space.id);

    const closeCalls: string[] = [];
    services.cbm.closeSession = async (cacheDir) => {
      closeCalls.push(cacheDir);
    };

    await services.snapshots.buildSpaceSnapshot(space.id);
    assert.deepEqual(closeCalls, []);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("repository removal during a replacement build cannot reactivate removed content", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-membership-race-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  let releaseMaterialization = () => {};

  try {
    const space = services.spaces.createSpace("Snapshot Membership Space");
    const repository = createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 5150,
      owner: "example",
      name: "membership-source"
    });
    stubCbmSnapshots(services);
    await services.snapshots.buildSpaceSnapshot(space.id);

    const activeBeforeRemoval = services.snapshots.getActiveSnapshot(space.id) as { manifest_json: string };
    const activeManifest = JSON.parse(activeBeforeRemoval.manifest_json) as { repositories: Array<{ localPath: string }> };
    fs.rmSync(path.dirname(activeManifest.repositories[0]!.localPath), { recursive: true, force: true });

    let markMaterializationStarted!: () => void;
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    Object.defineProperty(services.snapshots, "materializeRepository", {
      value: async (_home: string, _repositoryPath: string, _commit: string, targetPath: string) => {
        fs.mkdirSync(targetPath, { recursive: true });
        markMaterializationStarted();
        await materializationGate;
      }
    });

    const replacement = services.snapshots.buildSpaceSnapshot(space.id);
    await materializationStarted;
    const removal = services.spaces.softRemoveSpaceRepository(repository.id);
    assert.ok(removal.revokedSnapshotId);
    assert.equal(services.spaces.getSpaceById(space.id).activeSnapshotId, null);

    releaseMaterialization();
    await assert.rejects(replacement, /repositories changed while the snapshot was building/);
    assert.equal(services.spaces.getSpaceById(space.id).activeSnapshotId, null);
    assert.equal(services.snapshots.getActiveSnapshot(space.id), null);
  } finally {
    releaseMaterialization();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("space snapshots can be listed and pruned by retention", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-prune-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";
  process.env.MEMOREPO_SNAPSHOT_RETENTION = "2";

  const services = createServices();
  const app = await createApp(services);

  try {
    const space = services.spaces.createSpace("Snapshot Prune Space");
    createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 5201,
      owner: "example",
      name: "snapshot-prune"
    });
    stubCbmSnapshots(services);

    await services.snapshots.buildSpaceSnapshot(space.id);
    await services.snapshots.buildSpaceSnapshot(space.id);
    await services.snapshots.buildSpaceSnapshot(space.id);

    const activatedStatuses = services.database.sqlite
      .prepare("SELECT version, status FROM space_snapshots WHERE space_id = ? ORDER BY version ASC")
      .all(space.id);
    assert.deepEqual(activatedStatuses, [
      { version: 1, status: "inactive" },
      { version: 2, status: "inactive" },
      { version: 3, status: "active" }
    ]);

    services.database.sqlite.prepare("UPDATE space_snapshots SET status = 'active' WHERE space_id = ?").run(space.id);
    migrate(services.database.sqlite);
    const normalizedStatuses = services.database.sqlite
      .prepare("SELECT version, status FROM space_snapshots WHERE space_id = ? ORDER BY version ASC")
      .all(space.id);
    assert.deepEqual(normalizedStatuses, activatedStatuses);

    const snapshotRows = services.database.sqlite
      .prepare("SELECT id, artifact_path AS artifactPath FROM space_snapshots WHERE space_id = ? ORDER BY version ASC")
      .all(space.id) as Array<{ id: string; artifactPath: string }>;
    for (const row of snapshotRows) {
      fs.writeFileSync(path.join(row.artifactPath, "marker.txt"), row.id);
    }

    const listResponse = await injectControlApi(app, { method: "GET", url: `/api/spaces/${space.id}/snapshots` });
    assert.equal(listResponse.statusCode, 200);
    const listPayload = listResponse.json<{
      snapshots: Array<{ active: boolean; status: string; sizeBytes: number }>;
      defaultRetention: number;
    }>();
    assert.equal(listPayload.snapshots.length, 3);
    assert.equal(listPayload.defaultRetention, 2);
    assert.equal(listPayload.snapshots.filter((snapshot) => snapshot.active).length, 1);
    assert.deepEqual(listPayload.snapshots.map((snapshot) => snapshot.status), ["active", "inactive", "inactive"]);
    assert.ok(listPayload.snapshots.every((snapshot) => snapshot.sizeBytes > 0));

    const pruneResponse = await injectControlApi(app, {
      method: "POST",
      url: `/api/spaces/${space.id}/snapshots/prune`,
      payload: { keepLatest: 1 }
    });
    assert.equal(pruneResponse.statusCode, 200);
    const prunePayload = pruneResponse.json<{ deletedCount: number; retainedCount: number }>();
    assert.equal(prunePayload.deletedCount, 2);
    assert.equal(prunePayload.retainedCount, 1);

    const remaining = services.database.sqlite.prepare("SELECT id FROM space_snapshots WHERE space_id = ?").all(space.id);
    assert.equal(remaining.length, 1);
    assert.equal(fs.existsSync(snapshotRows[0]!.artifactPath), false);
    assert.equal(fs.existsSync(snapshotRows[1]!.artifactPath), false);
    assert.equal(fs.existsSync(snapshotRows[2]!.artifactPath), true);
  } finally {
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("managed space deletion removes local artifacts and database records", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "delete-managed-space-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("Delete Managed Space");
    const repositoryId = createRepositoryRecord(services.database, "https://github.com/example/delete-managed.git", {
      githubId: 6201,
      owner: "example",
      name: "delete-managed"
    });
    const spaceRepository = services.spaces.addRepositoryToSpace(space.id, repositoryId) as { id: string; localPath: string };
    fs.mkdirSync(path.join(spaceRepository.localPath, ".git"), { recursive: true });
    fs.writeFileSync(path.join(spaceRepository.localPath, "repo.txt"), "repo");

    const repoIndexPath = path.join(process.env.MEMOREPO_HOME!, "indexes", "r", spaceRepository.id);
    fs.mkdirSync(repoIndexPath, { recursive: true });
    fs.writeFileSync(path.join(repoIndexPath, "index.db"), "index");
    const timestamp = nowIso();
    insertRecord(services.database, "repo_indexes", {
      id: createId("idx"),
      spaceRepositoryId: spaceRepository.id,
      projectName: "delete-managed",
      cachePath: repoIndexPath,
      branch: "main",
      commitSha: "delete-managed-commit",
      status: "indexed",
      indexedAt: timestamp,
      error: null,
      createdAt: timestamp
    });

    const snapshotId = createId("snp");
    const snapshotPath = path.join(process.env.MEMOREPO_HOME!, "indexes", "s", snapshotId);
    fs.mkdirSync(snapshotPath, { recursive: true });
    fs.writeFileSync(path.join(snapshotPath, "snapshot.db"), "snapshot");
    const snapshotSource = path.join(snapshotPath, "sources", spaceRepository.id, "delete-managed");
    fs.mkdirSync(snapshotSource, { recursive: true });
    fs.writeFileSync(path.join(snapshotSource, "repo.txt"), "repo");
    insertRecord(services.database, "space_snapshots", {
      id: snapshotId,
      spaceId: space.id,
      version: 1,
      status: "active",
      artifactPath: snapshotPath,
      manifestJson: JSON.stringify({
        snapshotId,
        version: 1,
        createdAt: timestamp,
        repositories: [
          {
            spaceRepositoryId: spaceRepository.id,
            githubRepositoryId: repositoryId,
            fullName: "example/delete-managed",
            branch: "main",
            commit: "delete-managed-commit",
            projectName: "delete-managed",
            localPath: snapshotSource
          }
        ]
      }),
      createdAt: timestamp,
      activatedAt: timestamp,
      error: null
    });
    updateRecord(services.database, "spaces", { activeSnapshotId: snapshotId, snapshotStatus: "active" }, "id", space.id);

    const jobId = createId("job");
    insertRecord(services.database, "jobs", {
      id: jobId,
      type: "rebuild_space_snapshot",
      status: "succeeded",
      spaceId: space.id,
      spaceRepositoryId: spaceRepository.id,
      dependsOnJobId: null,
      payloadJson: "{}",
      error: null,
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp
    });
    insertRecord(services.database, "job_events", {
      id: createId("evt"),
      jobId,
      eventType: "status",
      message: "succeeded",
      createdAt: timestamp
    });
    const connection = services.mcp.createConnection(space.id, "Delete Agent", "generic");
    await services.mcp.callTool(space.slug, connection.token, "list_space_repositories", {});
    assert.equal(
      (services.database.sqlite.prepare("SELECT COUNT(*) AS count FROM mcp_tool_stats WHERE space_id = ?").get(space.id) as { count: number })
        .count,
      1
    );

    services.database.sqlite
      .prepare(
        "INSERT INTO agent_account_sessions (id, provider_id, account_key, connected_at, disconnected_at) VALUES ('aas_delete_space', 'test-provider', 'test-account', ?, NULL)"
      )
      .run(timestamp);
    services.database.sqlite
      .prepare(
        `INSERT INTO agent_chats
          (id, space_id, account_session_id, snapshot_id, snapshot_version, snapshot_meta_json,
           title, status, created_at, updated_at, archived_at)
         VALUES ('ach_delete_space', ?, 'aas_delete_space', ?, 1, '{}',
                 'Active answer', 'active', ?, ?, NULL)`
      )
      .run(space.id, snapshotId, timestamp, timestamp);
    services.database.sqlite
      .prepare(
        `INSERT INTO agent_messages
          (id, chat_id, sequence, role, status, content, sources_json, error, created_at, completed_at)
         VALUES ('agm_delete_space_user', 'ach_delete_space', 1, 'user', 'completed', 'Question', '[]', NULL, ?, ?),
                ('agm_delete_space_assistant', 'ach_delete_space', 2, 'assistant', 'running', '', '[]', NULL, ?, NULL)`
      )
      .run(timestamp, timestamp, timestamp);
    services.database.sqlite
      .prepare(
        `INSERT INTO agent_turns
          (id, chat_id, user_message_id, assistant_message_id, status,
           error, created_at, started_at, finished_at)
         VALUES ('agt_delete_space', 'ach_delete_space',
                 'agm_delete_space_user', 'agm_delete_space_assistant', 'running', NULL, ?, ?, NULL)`
      )
      .run(timestamp, timestamp);

    await assert.rejects(
      () => services.spaces.deleteSpaceWithManagedData(space.id),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    );
    assert.equal(fs.existsSync(snapshotPath), true);
    services.database.sqlite.prepare("UPDATE agent_turns SET status = 'completed' WHERE id = 'agt_delete_space'").run();

    const result = await services.spaces.deleteSpaceWithManagedData(space.id);
    assert.equal(result.repositoriesDeleted, 1);
    assert.equal(result.snapshotsDeleted, 1);
    assert.equal(result.jobsDeleted, 1);
    assert.equal(result.toolStatsDeleted, 1);
    assert.equal(fs.existsSync(spaceRepository.localPath), false);
    assert.equal(fs.existsSync(repoIndexPath), false);
    assert.equal(fs.existsSync(snapshotPath), false);
    assert.throws(() => services.spaces.getSpaceById(space.id), /Space not found/);
    assert.equal((services.database.sqlite.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count, 0);
    assert.equal((services.database.sqlite.prepare("SELECT COUNT(*) AS count FROM mcp_connections").get() as { count: number }).count, 0);
    assert.equal((services.database.sqlite.prepare("SELECT COUNT(*) AS count FROM mcp_tool_stats").get() as { count: number }).count, 0);
    assert.equal(
      (services.database.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_account_sessions").get() as { count: number }).count,
      0
    );
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("managed space deletion keeps files when its database transaction fails", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "delete-managed-space-rollback-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("Delete Rollback Space");
    const markerPath = path.join(space.rootPath, "keep-on-failure.txt");
    fs.writeFileSync(markerPath, "keep");
    services.database.sqlite.exec(`
      CREATE TRIGGER block_space_delete
      BEFORE DELETE ON spaces
      BEGIN
        SELECT RAISE(ABORT, 'blocked deletion');
      END;
    `);

    await assert.rejects(() => services.spaces.deleteSpaceWithManagedData(space.id), /blocked deletion/);
    assert.equal(fs.existsSync(markerPath), true);
    assert.equal(services.spaces.getSpaceById(space.id).id, space.id);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("garbage collection removes failed snapshots, old jobs, stale indexes, and removed clone files", () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "maintenance-gc-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("Maintenance Space");
    const activeRepository = createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 6301,
      owner: "example",
      name: "active-index"
    });
    const removedRepository = createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 6302,
      owner: "example",
      name: "removed-index"
    });
    fs.writeFileSync(path.join(removedRepository.local_path, "clone.txt"), "clone");
    services.spaces.softRemoveSpaceRepository(removedRepository.id);

    const timestamp = nowIso();
    const olderTimestamp = "2020-01-01T00:00:00.000Z";
    insertRecord(services.database, "repo_indexes", {
      id: createId("idx"),
      spaceRepositoryId: activeRepository.id,
      projectName: "active-index",
      cachePath: path.join(process.env.MEMOREPO_HOME!, "indexes", "r", activeRepository.id),
      branch: "main",
      commitSha: "old",
      status: "indexed",
      indexedAt: olderTimestamp,
      error: null,
      createdAt: olderTimestamp
    });
    insertRecord(services.database, "repo_indexes", {
      id: createId("idx"),
      spaceRepositoryId: activeRepository.id,
      projectName: "active-index",
      cachePath: path.join(process.env.MEMOREPO_HOME!, "indexes", "r", activeRepository.id),
      branch: "main",
      commitSha: "new",
      status: "indexed",
      indexedAt: timestamp,
      error: null,
      createdAt: timestamp
    });

    const removedIndexPath = path.join(process.env.MEMOREPO_HOME!, "indexes", "r", removedRepository.id);
    fs.mkdirSync(removedIndexPath, { recursive: true });
    fs.writeFileSync(path.join(removedIndexPath, "index.db"), "index");
    insertRecord(services.database, "repo_indexes", {
      id: createId("idx"),
      spaceRepositoryId: removedRepository.id,
      projectName: "removed-index",
      cachePath: removedIndexPath,
      branch: "main",
      commitSha: "removed",
      status: "indexed",
      indexedAt: timestamp,
      error: null,
      createdAt: timestamp
    });

    const orphanIndexPath = path.join(process.env.MEMOREPO_HOME!, "indexes", "r", "spr_orphan");
    fs.mkdirSync(orphanIndexPath, { recursive: true });
    fs.writeFileSync(path.join(orphanIndexPath, "index.db"), "orphan");

    const failedSnapshotId = createId("snp");
    const failedSnapshotPath = path.join(process.env.MEMOREPO_HOME!, "indexes", "s", failedSnapshotId);
    fs.mkdirSync(failedSnapshotPath, { recursive: true });
    fs.writeFileSync(path.join(failedSnapshotPath, "snapshot.db"), "failed");
    insertRecord(services.database, "space_snapshots", {
      id: failedSnapshotId,
      spaceId: space.id,
      version: 1,
      status: "failed",
      artifactPath: failedSnapshotPath,
      manifestJson: JSON.stringify({ snapshotId: failedSnapshotId, version: 1, createdAt: timestamp, repositories: [] }),
      createdAt: timestamp,
      activatedAt: null,
      error: "failed"
    });

    const oldJobId = createId("job");
    insertRecord(services.database, "jobs", {
      id: oldJobId,
      type: "sync_github_repositories",
      status: "succeeded",
      spaceId: space.id,
      spaceRepositoryId: null,
      dependsOnJobId: null,
      payloadJson: "{}",
      error: null,
      createdAt: olderTimestamp,
      startedAt: olderTimestamp,
      finishedAt: olderTimestamp
    });
    insertRecord(services.database, "job_events", {
      id: createId("evt"),
      jobId: oldJobId,
      eventType: "status",
      message: "succeeded",
      createdAt: olderTimestamp
    });

    const retainedRevisionSource = path.join(
      services.config.revisionSourcesDir,
      "6301",
      "retained-commit",
      "active-index"
    );
    const orphanRevisionSource = path.join(
      services.config.revisionSourcesDir,
      "6302",
      "orphan-commit",
      "removed-index"
    );
    fs.mkdirSync(retainedRevisionSource, { recursive: true });
    fs.mkdirSync(orphanRevisionSource, { recursive: true });
    fs.writeFileSync(path.join(retainedRevisionSource, "source.ts"), "retained\n");
    fs.writeFileSync(path.join(orphanRevisionSource, "source.ts"), "orphan\n");
    const retainedSnapshotId = createId("snp");
    const retainedSnapshotPath = path.join(services.config.snapshotIndexesDir, retainedSnapshotId);
    fs.mkdirSync(retainedSnapshotPath, { recursive: true });
    insertRecord(services.database, "space_snapshots", {
      id: retainedSnapshotId,
      spaceId: space.id,
      version: 2,
      status: "inactive",
      artifactPath: retainedSnapshotPath,
      manifestJson: JSON.stringify({
        snapshotId: retainedSnapshotId,
        version: 2,
        createdAt: timestamp,
        repositories: [{ localPath: retainedRevisionSource }]
      }),
      createdAt: timestamp,
      activatedAt: timestamp,
      error: null,
      sizeBytes: 0
    });

    const summary = services.maintenance.summary(1);
    assert.equal(summary.candidates.failedSnapshots, 1);
    assert.equal(summary.candidates.removedClones, 1);
    assert.equal(summary.candidates.oldJobs, 1);
    assert.equal(summary.candidates.orphanRepoIndexDirectories, 1);
    assert.equal(summary.candidates.orphanRevisionSources, 1);

    const result = services.maintenance.runGarbageCollection(1);
    assert.equal(result.failedSnapshots.count, 1);
    assert.equal(result.removedClones.count, 1);
    assert.equal(result.oldJobs.count, 1);
    assert.equal(result.orphanRepoIndexDirectories.count, 1);
    assert.equal(result.orphanRevisionSources.count, 1);
    assert.equal(fs.existsSync(removedRepository.local_path), false);
    assert.equal(fs.existsSync(removedIndexPath), false);
    assert.equal(fs.existsSync(orphanIndexPath), false);
    assert.equal(fs.existsSync(failedSnapshotPath), false);
    assert.equal(fs.existsSync(orphanRevisionSource), false);
    assert.equal(fs.existsSync(retainedRevisionSource), true);

    const cleanedRepository = services.spaces.getSpaceRepository(removedRepository.id);
    assert.equal(cleanedRepository.clone_status, "cleaned");
    assert.equal((services.database.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs WHERE id = ?").get(oldJobId) as { count: number }).count, 0);
    assert.equal(
      (services.database.sqlite.prepare("SELECT COUNT(*) AS count FROM repo_indexes WHERE space_repository_id = ?").get(activeRepository.id) as { count: number }).count,
      1
    );
    assert.equal(
      (services.database.sqlite.prepare("SELECT COUNT(*) AS count FROM repo_indexes WHERE space_repository_id = ?").get(removedRepository.id) as { count: number }).count,
      0
    );
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("garbage collection rejects a failed snapshot redirected to another snapshot artifact", () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "maintenance-snapshot-path-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("Maintenance Path Space");
    const timestamp = nowIso();
    const activeSnapshotId = createId("snp");
    const activeSnapshotPath = path.join(process.env.MEMOREPO_HOME!, "indexes", "s", activeSnapshotId);
    fs.mkdirSync(activeSnapshotPath, { recursive: true });
    const markerPath = path.join(activeSnapshotPath, "snapshot.db");
    fs.writeFileSync(markerPath, "active");

    insertRecord(services.database, "space_snapshots", {
      id: activeSnapshotId,
      spaceId: space.id,
      version: 1,
      status: "active",
      artifactPath: activeSnapshotPath,
      manifestJson: JSON.stringify({ snapshotId: activeSnapshotId, version: 1, createdAt: timestamp, repositories: [] }),
      createdAt: timestamp,
      activatedAt: timestamp,
      error: null
    });
    services.database.sqlite
      .prepare("UPDATE spaces SET active_snapshot_id = ?, snapshot_status = 'ready' WHERE id = ?")
      .run(activeSnapshotId, space.id);

    const failedSnapshotId = createId("snp");
    insertRecord(services.database, "space_snapshots", {
      id: failedSnapshotId,
      spaceId: space.id,
      version: 2,
      status: "failed",
      artifactPath: activeSnapshotPath,
      manifestJson: JSON.stringify({ snapshotId: failedSnapshotId, version: 2, createdAt: timestamp, repositories: [] }),
      createdAt: timestamp,
      activatedAt: null,
      error: "failed"
    });

    assert.throws(
      () => services.maintenance.runGarbageCollection(1),
      /Snapshot artifact path does not match its snapshot ID/
    );
    assert.equal(fs.existsSync(markerPath), true);
    assert.equal(
      (services.database.sqlite.prepare("SELECT COUNT(*) AS count FROM space_snapshots WHERE id IN (?, ?)")
        .get(activeSnapshotId, failedSnapshotId) as { count: number }).count,
      2
    );
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("repository removal revokes the active snapshot before a replacement can be served", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "mcp-remove-revoke-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("Remove And Revoke Space");
    const alpha = createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 5001,
      owner: "example",
      name: "alpha"
    });
    createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 5002,
      owner: "example",
      name: "beta"
    });
    stubCbmSnapshots(services);
    await services.snapshots.buildSpaceSnapshot(space.id);

    const connection = services.mcp.createConnection(space.id, "Removal Agent", "generic");
    const beforeRemoval = await services.mcp.callTool(space.slug, connection.token, "list_space_repositories", {});
    assert.match(JSON.stringify(beforeRemoval), /example\/alpha/);

    const removal = services.spaces.softRemoveSpaceRepository(alpha.id);
    assert.ok(removal.revokedSnapshotId);

    const revokedSpace = services.spaces.getSpaceById(space.id);
    assert.equal(revokedSpace.activeSnapshotId, null);
    assert.equal(revokedSpace.snapshotStatus, "revoked");
    const whileRevoked = await services.mcp.callTool(space.slug, connection.token, "search_graph", { query: "alpha" });
    assert.equal((whileRevoked as { status?: string }).status, "no_active_snapshot");
    assert.doesNotMatch(JSON.stringify(whileRevoked), /example\/alpha/);

    await services.snapshots.buildSpaceSnapshot(space.id);
    const afterReplacement = await services.mcp.callTool(space.slug, connection.token, "list_space_repositories", {});
    assert.doesNotMatch(JSON.stringify(afterReplacement), /example\/alpha/);
    assert.match(JSON.stringify(afterReplacement), /example\/beta/);
    assert.equal(services.spaces.getSpaceById(space.id).snapshotStatus, "active");
  } finally {
    services.jobs.stop();
    await services.cbm.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("MCP graph tools route multi-repo spaces through the CBM snapshot store", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "mcp-multi-repo-scope-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const space = services.spaces.createSpace("MCP Multi Repo Space");
    const alpha = createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 5101,
      owner: "example",
      name: "alpha"
    });
    const beta = createSnapshotReadySpaceRepository(services, space.id, {
      githubId: 5102,
      owner: "example",
      name: "beta"
    });
    stubCbmSnapshots(services);
    await services.snapshots.buildSpaceSnapshot(space.id);

    const alphaProject = path.basename(alpha.local_path);
    const betaProject = path.basename(beta.local_path);
    const connection = services.mcp.createConnection(space.id, "Scope Agent", "generic");

    const initializeResponse = await services.mcp.handleJsonRpc(space.slug, connection.token, {
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: { protocolVersion: "2024-11-05" }
    });
    const instructions = (initializeResponse?.result as { instructions?: string } | undefined)?.instructions ?? "";
    assert.match(instructions, /snapshot v1/);
    assert.match(instructions, /example\/alpha/);
    assert.match(instructions, /example\/beta/);
    assert.ok(instructions.includes(`project: ${alphaProject}`));
    assert.ok(instructions.includes(`project: ${betaProject}`));
    assertNoInternalPathLeak(JSON.stringify(instructions), testRoot);
    const originalCbmTool = services.cbm.tool.bind(services.cbm);
    const toolCalls: Array<{ tool: string; input: Record<string, unknown> }> = [];

    (services.cbm as unknown as { tool: typeof services.cbm.tool }).tool = async (tool, input) => {
      toolCalls.push({ tool, input });
      if (tool === "query_graph") {
        if (typeof input.query === "string" && input.query.includes("MATCH (source:Method {qualified_name") && input.query.includes(":CALLS")) {
          return {
            columns: ["target", "qualified_name"],
            rows: [
              ["update", "src.ArticlesService.update"],
              ["/user", "__route__PUT__/user"],
              ["/articles/:slug", "__route__PUT__/articles/:slug"]
            ]
          };
        }
        if (typeof input.query === "string" && input.query.includes(":CALLS") && input.query.includes("src.ArticlesService.get")) {
          return {
            columns: ["caller", "caller_qn"],
            rows: [
              ["getAll", `${alphaProject}.src.CommentsService.getAll`],
              ["load", "src.ArticleComponent.load"]
            ]
          };
        }
        if (typeof input.query === "string" && input.query.includes(":CALLS") && input.query.includes("src.ArticlesService.update")) {
          return {
            columns: ["caller", "caller_qn"],
            rows: [
              ["addTag", "src.editor.addTag"],
              ["submitForm", "src.editor.submitForm"]
            ]
          };
        }
        if (typeof input.query === "string" && input.query.includes("MATCH (n:Method) RETURN n.qualified_name AS q")) {
          return {
            columns: ["q"],
            rows: Array.from({ length: Number(input.max_rows) }, (_, index) => [`method-${index}`])
          };
        }
        if (typeof input.query === "string" && input.query.includes("MATCH (n) WHERE") && input.query.includes("RETURN n.name AS name")) {
          if (input.query.includes("n.name = 'ambiguousRender'")) {
            return { rows: [] };
          }
          if (input.query.includes("src.merged.get")) {
            return { rows: [["get", "src.merged.get", "src/common/api/service.ts"]] };
          }
          if (input.query.includes("src.ArticlesService.get")) {
            return { rows: [["get", "src.ArticlesService.get", "src/articles.service.ts"]] };
          }
          if (input.query.includes("src.ArticlesService.update")) {
            return { rows: [] };
          }
          if (input.query.includes("src.ProfileService.follow")) {
            return { rows: [["follow", "src.ProfileService.follow", "src/profile.service.ts"]] };
          }
          if (input.query.includes("src.JwtService.getToken")) {
            return { rows: [["getToken", "src.JwtService.getToken", "src/jwt.service.ts"]] };
          }
          return { rows: [["render", "src.components.App.App.render", "src/components/App.js"]] };
        }
        if (typeof input.query === "string" && input.query.includes("count(f)")) {
          return { columns: ["c"], rows: [["250"]], total: 1 };
        }
        if (typeof input.query === "string" && input.query.includes("MATCH (n:Route)")) {
          return input.project === betaProject
            ? { columns: ["name"], rows: [["/articles/:slug/comments"]] }
            : { columns: ["name"], rows: [] };
        }
        return { rows: [{ project: input.project, query: input.query, maxRows: input.max_rows }] };
      }
      if (tool === "index_status") {
        return { project: input.project, nodes: input.project === alphaProject ? 314 : 330 };
      }
      if (tool === "get_graph_schema") {
        return {
          labels: ["Function"],
          node_types: { Route: { count: 9 } },
          properties: ["name", "qualified_name", "file_path", "callee", "create", "delete", "set", "remove"],
          adr_hint: "Use manage_adr(mode='update') to persist decisions"
        };
      }
      if (tool === "get_architecture") {
        if (Array.isArray(input.aspects) && input.aspects.includes("routes")) {
          if (input.project === betaProject) {
            return { languages: ["TypeScript"] };
          }
          return { routes: [
            { path: "/users/login", method: "POST", handler: "login" },
            { path: "/articles/:slug/comments", method: "", handler: "", file_path: "" },
            { path: "/articles/:slug/comments", method: "GET", handler: "getAll" },
            { path: "/articles/:article.slug" }
          ] };
        }
        return { languages: ["TypeScript"], routes: [{ path: "/should-not-leak", method: "GET" }] };
      }
      if (tool === "get_code_snippet") {
        if (input.qualified_name === "__route__POST__/articles") {
          return {
            qualified_name: input.qualified_name,
            file_path: "/var/lib/memorepo/internal/routes",
            start_line: 1,
            end_line: 51,
            source: "(source not available)"
          };
        }
        if (input.qualified_name === `${alphaProject}.src.falseRecursive`) {
          return {
            qualified_name: input.qualified_name,
            name: "get",
            file_path: "example/alpha/src/service.ts",
            code: "get() { return this.http.get('/articles'); }",
            self_recursive: true,
            recursive: true,
            unguarded_recursion: true,
            callees: 0
          };
        }
        if (input.qualified_name === "src.merged.get" || input.qualified_name === `${alphaProject}.src.merged.get`) {
          return {
            qualified_name: "src.merged.get",
            name: "get",
            file_path: "example/alpha/src/common/api/service.ts",
            source: "get(slug) { return ApiService.get(`/articles/${slug}/comments`); }",
            self_recursive: true,
            recursive: true,
            unguarded_recursion: true,
            callees: 1
          };
        }
        if (
          input.qualified_name === "ArticlesService.get"
          || input.qualified_name === "src.ArticlesService.get"
          || input.qualified_name === `${alphaProject}.src.ArticlesService.get`
        ) {
          return {
            qualified_name: "src.ArticlesService.get",
            name: "get",
            file_path: "example/alpha/src/articles.service.ts",
            source: "get(slug) { return this.http.get(`/articles/${slug}`); }",
            self_recursive: false,
            recursive: false,
            callers: 1,
            caller_names: ["getAll"],
            ...(input.qualified_name === "ArticlesService.get" ? { match_method: "suffix" } : {})
          };
        }
        if (input.qualified_name === `${alphaProject}.src.CommentsService.getAll`) {
          throw new Error("symbol not found with project-prefixed qualified name");
        }
        if (input.qualified_name === "src.CommentsService.getAll") {
          return { qualified_name: input.qualified_name, source: "getAll(slug) { return this.http.get<{ comments: unknown[] }>(`/articles/${slug}/comments`); }" };
        }
        if (input.qualified_name === "src.ArticleComponent.load") {
          return { qualified_name: input.qualified_name, source: "load(slug) { return this.articlesService.get(slug); }" };
        }
        if (input.qualified_name === "src.ArticlesService.update" || input.qualified_name === `${alphaProject}.src.ArticlesService.update`) {
          return {
            qualified_name: "src.ArticlesService.update",
            name: "update",
            file_path: "example/alpha/src/articles.service.ts",
            source: "update(article): Observable<Article> { return this.http.put(`/articles/${article.slug}`, { article }); }",
            self_recursive: false,
            recursive: true,
            unguarded_recursion: false,
            return_type: ": Observable<Article>"
          };
        }
        if (input.qualified_name === "src.editor.addTag") {
          return { qualified_name: input.qualified_name, source: "addTag() { this.tagList.update(tags => tags.concat('x')); }" };
        }
        if (input.qualified_name === "src.editor.submitForm") {
          return { qualified_name: input.qualified_name, source: "submitForm() { return this.articleService.update(this.article); }" };
        }
        if (input.qualified_name === "src.settings.submitForm") {
          return { qualified_name: input.qualified_name, source: "submitForm() { return this.userService.update(this.user); }" };
        }
        if (input.qualified_name === "src.JwtService.getToken") {
          return {
            qualified_name: input.qualified_name,
            name: "getToken",
            source: "getToken() { return localStorage.getItem('token'); }",
            self_recursive: false,
            recursive: false
          };
        }
        if (input.qualified_name === "src.JwtService.checkAuth") {
          return { qualified_name: input.qualified_name, source: "checkAuth() { return this.getToken(); }" };
        }
        if (input.qualified_name === "src.main.boot") {
          return { qualified_name: input.qualified_name, source: "boot() { return JwtService.getToken(); }" };
        }
        if (input.qualified_name === "src.comments.delete") {
          return {
            qualified_name: input.qualified_name,
            source: "delete(slug, commentId) { return this.http.delete<void>(`/articles/${slug}/comments/${commentId}`); }"
          };
        }
        if (input.qualified_name === "src.ProfileService.follow" || input.qualified_name === `${alphaProject}.src.ProfileService.follow`) {
          return {
            qualified_name: "src.ProfileService.follow",
            name: "follow",
            source: "follow(username) { return this.http.post('/profiles/' + username + '/follow', {}); }",
            self_recursive: true,
            recursive: true,
            unguarded_recursion: true,
            callees: 1
          };
        }
        if (input.qualified_name === "src.express.routes") {
          return { qualified_name: input.qualified_name, source: "router.get('/articles', listArticles);" };
        }
        if (input.qualified_name === "__route__ANY__/articles/:slug/comments") {
          return {
            qualified_name: input.qualified_name,
            source: "(source not available)",
            callers: 0,
            caller_names: ["add", "getAll"]
          };
        }
        return {
          qualified_name: `${input.project}.src.target`,
          file_path: input.project === alphaProject ? "example/alpha/src/target.ts" : "example/beta/src/target.ts",
          code: "export function target() {}"
        };
      }
      if (tool === "search_graph" && input.label === "NoSuchLabel") {
        return { results: [], hint: "Available labels: Function, Method, Class, Route, Package" };
      }
      if (tool === "search_graph" && input.label === "Route") {
        return { results: [{ label: "Route", qualified_name: "__route__POST__/articles", file_path: "", method: "" }] };
      }
      if (tool === "search_graph" && input.name_pattern === "^ambiguousRender$") {
        return { results: [
          { name: "ambiguousRender", qualified_name: "src.first.ambiguousRender", file_path: "src/first.ts" },
          { name: "ambiguousRender", qualified_name: "src.second.ambiguousRender", file_path: "src/second.ts" }
        ] };
      }
      if ((tool === "search_graph" || tool === "search_code") && (input.query === "fair-target" || input.pattern === "fair-target")) {
        return { results: Array.from({ length: 4 }, (_, index) => ({ name: `${input.project}-${index}` })) };
      }
      if (tool === "search_graph" && input.query === "deep-target") {
        const offset = Number(input.offset ?? 0);
        const total = input.project === alphaProject ? 213 : 314;
        const count = Math.max(0, Math.min(Number(input.limit ?? 25), total - offset));
        return {
          results: Array.from({ length: count }, (_, index) => ({ name: `${input.project}-${offset + index}` })),
          total,
          has_more: offset + count < total
        };
      }
      if (tool === "search_code" && input.pattern === "page-code") {
        const total = 80;
        const count = Math.min(Number(input.limit ?? 25), total);
        return { results: Array.from({ length: count }, (_, index) => ({ file_path: `src/file-${index}.ts` })), total };
      }
      if (tool === "search_code" && input.pattern === "stable-candidates") {
        const total = input.project === alphaProject ? 7 : 12;
        const count = Math.min(Number(input.limit ?? 25), total);
        return { results: Array.from({ length: count }, (_, index) => ({ file_path: `src/${input.project}-${index}.ts` })) };
      }
      if (tool === "search_code" && input.pattern === "stable-total") {
        const totalResults = 42;
        const count = Math.min(Number(input.limit ?? 25), totalResults);
        return {
          results: Array.from({ length: count }, (_, index) => ({ file_path: `src/stable-${index}.ts` })),
          total_results: totalResults
        };
      }
      if (tool === "search_code" && input.pattern === "ceiling-code") {
        const total = 169;
        const count = Math.min(Number(input.limit ?? 25), total);
        return { results: Array.from({ length: count }, (_, index) => ({ file_path: `src/${input.project}-${index}.ts` })) };
      }
      if (tool === "search_code" && input.pattern === "article.slug") {
        return { results: [{ qualified_name: "src.ArticlesService.update", file_path: "src/articles.service.ts" }] };
      }
      if (tool === "search_code" && input.pattern === ".delete") {
        return { results: [{ qualified_name: "src.comments.delete", file_path: "src/comments.service.ts" }] };
      }
      if (tool === "search_code" && input.pattern === ".post") {
        return { results: [{ qualified_name: "src.ProfileService.follow", file_path: "src/profile.service.ts" }] };
      }
      if (tool === "search_code" && input.pattern === ".get" && input.project === betaProject) {
        return { results: [{ qualified_name: "src.express.routes", file_path: "src/routes.ts" }] };
      }
      if (tool === "trace_path" && input.function_name === "follow") {
        return {
          function: "follow",
          callees: [
            { name: "follow", qualified_name: "src.ProfileService.follow", hop: 1 },
            { name: "follow", qualified_name: "src.ProfileService.follow", hop: 2 }
          ]
        };
      }
      if (tool === "trace_path" && input.function_name === "update") {
        return {
          function: "update",
          callees: [{ name: "/user", qualified_name: "__route__PUT__/user", hop: 1 }],
          callers: [{ name: "submitForm", qualified_name: "src.settings.submitForm", hop: 1 }]
        };
      }
      if (tool === "trace_path" && input.function_name === "getToken") {
        return {
          function: "getToken",
          callers: [
            { name: "checkAuth", qualified_name: "src.JwtService.checkAuth", hop: 1 },
            { name: "boot", qualified_name: "src.main.boot", hop: 1 }
          ],
          callees: []
        };
      }
      if (tool === "trace_path" && input.function_name === "get") {
        return {
          function: "get",
          callers: [
            { name: "getAll", qualified_name: `${alphaProject}.src.CommentsService.getAll`, hop: 1 },
            { name: "load", qualified_name: "src.ArticleComponent.load", hop: 1 }
          ],
          callees: []
        };
      }
      return { results: [{ name: "target", project: input.project ?? "cross-repo", qualified_name: `${input.project ?? "cross"}.target` }] };
    };

    try {
      toolCalls.length = 0;
      const crossProjectSearch = await services.mcp.callTool(space.slug, connection.token, "search_graph", {
        query: "target",
        limit: 10
      }) as { results: Array<{ project: string }>; projects_searched: string[] };
      assert.equal(toolCalls.length, 2);
      assert.deepEqual(toolCalls.map(({ tool }) => tool), ["search_graph", "search_graph"]);
      assert.deepEqual(toolCalls.map(({ input }) => input.project), [alphaProject, betaProject]);
      assert.deepEqual(toolCalls.map(({ input }) => input.limit), [25, 25]);
      assert.deepEqual(crossProjectSearch.results.map(({ project }) => project), [alphaProject, betaProject]);
      assert.deepEqual(crossProjectSearch.projects_searched, [alphaProject, betaProject]);

      toolCalls.length = 0;
      await services.mcp.callTool(space.slug, connection.token, "search_graph", {
        query: "target",
        limit: 10
      });
      assert.equal(toolCalls.length, 0);

      const fairGraphSearch = await services.mcp.callTool(space.slug, connection.token, "search_graph", {
        query: "fair-target",
        limit: 6
      }) as { results: Array<{ project: string }>; merge_strategy?: string };
      assert.deepEqual(fairGraphSearch.results.map(({ project }) => project), [
        alphaProject, betaProject, alphaProject, betaProject, alphaProject, betaProject
      ]);
      assert.equal(fairGraphSearch.merge_strategy, "round_robin_by_project");

      const fairCodeSearch = await services.mcp.callTool(space.slug, connection.token, "search_code", {
        pattern: "fair-target",
        limit: 4
      }) as { results: Array<{ project: string }> };
      assert.deepEqual(fairCodeSearch.results.map(({ project }) => project), [alphaProject, betaProject, alphaProject, betaProject]);

      const codePage = await services.mcp.callTool(space.slug, connection.token, "search_code", {
        project: alphaProject,
        pattern: "page-code",
        limit: 25,
        offset: 25
      }) as { results: Array<{ file_path: string }>; offset?: number; effective_limit?: number; total?: number; has_more?: boolean };
      assert.equal(codePage.results[0]?.file_path, "src/file-25.ts");
      assert.equal(codePage.results.length, 25);
      assert.equal(codePage.offset, 25);
      assert.equal(codePage.effective_limit, 25);
      assert.equal(codePage.total, 80);
      assert.equal(codePage.has_more, true);

      const beyondStableTotal = await services.mcp.callTool(space.slug, connection.token, "search_code", {
        project: alphaProject,
        pattern: "stable-total",
        limit: 5,
        offset: 43
      }) as { results: unknown[]; total?: number; total_results?: number; has_more?: boolean };
      const farBeyondStableTotal = await services.mcp.callTool(space.slug, connection.token, "search_code", {
        project: alphaProject,
        pattern: "stable-total",
        limit: 5,
        offset: 249
      }) as { results: unknown[]; total?: number; total_results?: number; has_more?: boolean };
      assert.deepEqual(beyondStableTotal.results, []);
      assert.equal(beyondStableTotal.total, 42);
      assert.equal(beyondStableTotal.total_results, 42);
      assert.equal(beyondStableTotal.has_more, false);
      assert.deepEqual(farBeyondStableTotal.results, []);
      assert.equal(farBeyondStableTotal.total, 42);
      assert.equal(farBeyondStableTotal.has_more, false);

      const firstCandidatePage = await services.mcp.callTool(space.slug, connection.token, "search_code", {
        pattern: "stable-candidates",
        limit: 5,
        offset: 0
      }) as { candidate_count?: number; results: unknown[] };
      const secondCandidatePage = await services.mcp.callTool(space.slug, connection.token, "search_code", {
        pattern: "stable-candidates",
        limit: 5,
        offset: 5
      }) as { candidate_count?: number; results: unknown[] };
      assert.equal(firstCandidatePage.candidate_count, 19);
      assert.equal(secondCandidatePage.candidate_count, 19);
      assert.equal(firstCandidatePage.results.length, 5);
      assert.equal(secondCandidatePage.results.length, 5);

      const formerlyCappedCodePage = await services.mcp.callTool(space.slug, connection.token, "search_code", {
        pattern: "ceiling-code",
        limit: 25,
        offset: 224
      }) as { results: unknown[]; has_more?: boolean };
      const pageBeyondFormerCeiling = await services.mcp.callTool(space.slug, connection.token, "search_code", {
        pattern: "ceiling-code",
        limit: 25,
        offset: 250
      }) as { results: unknown[]; has_more?: boolean; candidate_count?: number };
      const finalCombinedCodePage = await services.mcp.callTool(space.slug, connection.token, "search_code", {
        pattern: "ceiling-code",
        limit: 25,
        offset: 325
      }) as { results: unknown[]; has_more?: boolean; candidate_count?: number };
      assert.equal(formerlyCappedCodePage.results.length, 25);
      assert.equal(formerlyCappedCodePage.has_more, true);
      assert.equal(pageBeyondFormerCeiling.results.length, 25);
      assert.equal(pageBeyondFormerCeiling.has_more, true);
      assert.equal(pageBeyondFormerCeiling.candidate_count, 338);
      assert.equal(finalCombinedCodePage.results.length, 13);
      assert.equal(finalCombinedCodePage.has_more, false);
      assert.equal(finalCombinedCodePage.candidate_count, 338);

      await assert.rejects(
        services.mcp.callTool(space.slug, connection.token, "search_code", {
          project: alphaProject,
          pattern: "ceiling-code",
          limit: 1,
          offset: 250
        }),
        /search_code offset must be between 0 and 249/
      );

      toolCalls.length = 0;
      const deepSearch = await services.mcp.callTool(space.slug, connection.token, "search_graph", {
        query: "deep-target",
        limit: 1,
        offset: 100
      }) as { results: Array<{ project: string }>; total?: number; has_more?: boolean; candidate_count?: number };
      assert.equal(deepSearch.results.length, 1);
      assert.equal(deepSearch.total, 527);
      assert.equal(deepSearch.has_more, true);
      assert.equal(deepSearch.candidate_count, 527);
      assert.equal(toolCalls.filter(({ tool }) => tool === "search_graph").length, 6);

      toolCalls.length = 0;
      const schema = await services.mcp.callTool(space.slug, connection.token, "get_graph_schema", {}) as {
        projects: Array<{
          project: string;
          adr_hint?: string;
          adr_notice?: string;
          node_types?: { Route?: { count?: number } };
          route_inventory_count?: number;
        }>;
      };
      assert.equal(toolCalls.filter(({ tool }) => tool === "get_graph_schema").length, 2);
      assert.ok(schema.projects.every((project) => project.adr_hint === undefined));
      assert.ok(schema.projects.every((project) => project.adr_notice?.includes("read-only")));
      assert.ok(schema.projects.every((project) => project.node_types?.Route?.count === project.route_inventory_count));

      toolCalls.length = 0;
      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "get_architecture", { aspects: ["definitely_invalid"] }),
        /unsupported aspects/
      );
      assert.equal(toolCalls.length, 0);

      const languagesArchitecture = await services.mcp.callTool(space.slug, connection.token, "get_architecture", {
        project: alphaProject,
        aspects: ["languages"]
      }) as { languages?: string[]; routes?: unknown[] };
      assert.deepEqual(languagesArchitecture.languages, ["TypeScript"]);
      assert.equal(languagesArchitecture.routes, undefined);

      const routesArchitecture = await services.mcp.callTool(space.slug, connection.token, "get_architecture", {
        project: alphaProject,
        aspects: ["routes"]
      }) as { routes: Array<{ path: string; method?: string; handler?: string; file_path?: string; synthetic?: boolean; source_available?: boolean }> };
      assert.equal(routesArchitecture.routes[0]?.path, "/users/login");
      assert.equal(routesArchitecture.routes.some((route) =>
        route.path === "/articles/:slug/comments" && route.method === undefined
      ), false);
      assert.ok(routesArchitecture.routes.some((route) =>
        route.path === "/articles/:slug/comments" && route.method === "GET"
      ));
      assert.ok(routesArchitecture.routes.some((route) =>
        route.path === "/articles/:slug" && route.method === "PUT"
      ));
      assert.equal(routesArchitecture.routes.some((route) =>
        route.path === "/articles/:slug/comments/:commentId" && route.method === "DELETE"
      ), false);
      assert.equal(routesArchitecture.routes.some((route) =>
        route.path === "/profiles/:username/follow" && route.method === "POST"
      ), false);

      const expressArchitecture = await services.mcp.callTool(space.slug, connection.token, "get_architecture", {
        project: betaProject,
        aspects: ["routes"]
      }) as { routes: Array<{ path: string; method?: string }> };
      assert.ok(expressArchitecture.routes.some((route) => route.path === "/articles" && route.method === "GET"));

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "search_graph", { query: "" }),
        /query must be a non-empty string/
      );
      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "search_code", { pattern: "" }),
        /pattern must be a non-empty string/
      );
      for (const [tool, args] of [
        ["index_status", { project: "" }],
        ["search_code", { project: "", pattern: "target" }],
        ["query_graph", { project: "", query: "MATCH (n) RETURN n" }],
        ["get_code_snippet", { project: "", qualified_name: "src.target" }],
        ["trace_path", { project: "", function_name: "target" }]
      ] as const) {
        await assert.rejects(
          () => services.mcp.callTool(space.slug, connection.token, tool, args),
          /project must be a non-empty string/
        );
      }
      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "search_code", {
          project: alphaProject,
          pattern: String.fromCharCode(0),
          limit: 2
        }),
        /pattern must not contain control characters/
      );
      for (const args of [
        { project: alphaProject, query: String.fromCharCode(0), limit: 2 },
        { project: alphaProject, name_pattern: String.fromCharCode(0), limit: 2 }
      ]) {
        await assert.rejects(
          () => services.mcp.callTool(space.slug, connection.token, "search_graph", args),
          /must not contain control characters/
        );
      }
      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "search_graph", {
          project: alphaProject,
          name_pattern: "(",
          limit: 2
        }),
        /name_pattern must be a valid regular expression/
      );
      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "search_graph", {
          project: alphaProject,
          file_pattern: "[",
          limit: 2
        }),
        /file_pattern must be a valid regular expression/
      );
      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "get_code_snippet", { project: alphaProject, qualified_name: "" }),
        /qualified_name must be a non-empty string/
      );
      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "get_code_snippet", { project: alphaProject, qualified_name: "   " }),
        /qualified_name must be a non-empty string/
      );

      toolCalls.length = 0;
      const snippet = await services.mcp.callTool(space.slug, connection.token, "get_code_snippet", {
        project: alphaProject,
        qualified_name: `${alphaProject}.src.target`
      }) as { project: string; file_path: string };
      assert.equal(snippet.project, alphaProject);
      assert.equal(snippet.file_path, "src/target.ts");

      const correctedRecursion = await services.mcp.callTool(space.slug, connection.token, "get_code_snippet", {
        project: alphaProject,
        qualified_name: `${alphaProject}.src.falseRecursive`
      }) as { self_recursive?: boolean; recursive?: boolean; unguarded_recursion?: boolean; analysis_warnings?: string[] };
      assert.equal(correctedRecursion.self_recursive, false);
      assert.equal(correctedRecursion.recursive, false);
      assert.equal(correctedRecursion.unguarded_recursion, false);
      assert.ok(correctedRecursion.analysis_warnings?.some((warning) => warning.includes("no self-call")));

      const mergedSnippet = await services.mcp.callTool(space.slug, connection.token, "get_code_snippet", {
        project: alphaProject,
        qualified_name: `${alphaProject}.src.merged.get`
      }) as { symbol_identity_confidence?: string; analysis_warnings?: string[] };
      assert.equal(mergedSnippet.symbol_identity_confidence, "low");
      assert.ok(mergedSnippet.analysis_warnings?.some((warning) => warning.includes("merge homonymous methods")));

      toolCalls.length = 0;
      const mergedTrace = await services.mcp.callTool(space.slug, connection.token, "trace_path", {
        project: alphaProject,
        function_name: "get",
        qualified_name: `${alphaProject}.src.merged.get`,
        depth: 1
      }) as { trace_available?: boolean; symbol_identity_confidence?: string };
      assert.equal(mergedTrace.trace_available, false);
      assert.equal(mergedTrace.symbol_identity_confidence, "low");
      assert.equal(toolCalls.some(({ tool }) => tool === "trace_path"), false);

      const suffixSnippet = await services.mcp.callTool(space.slug, connection.token, "get_code_snippet", {
        project: alphaProject,
        qualified_name: "ArticlesService.get",
        include_neighbors: true
      }) as {
        symbol_identity_confidence?: string;
        callers?: number;
        caller_names?: string[];
        analysis_warnings?: string[];
      };
      assert.equal(suffixSnippet.symbol_identity_confidence, "low");
      assert.equal(suffixSnippet.callers, undefined);
      assert.equal(suffixSnippet.caller_names, undefined);
      assert.ok(suffixSnippet.analysis_warnings?.some((warning) => warning.includes("resolved only by suffix")));

      const exactGetTrace = await services.mcp.callTool(space.slug, connection.token, "trace_path", {
        project: alphaProject,
        function_name: "get",
        qualified_name: `${alphaProject}.src.ArticlesService.get`,
        depth: 1,
        direction: "both"
      }) as {
        callers?: Array<{ qualified_name?: string }>;
        callees?: Array<{ qualified_name?: string; evidence?: string }>;
        filtered_identity_incompatible_hops?: number;
      };
      assert.deepEqual(exactGetTrace.callers?.map((caller) => caller.qualified_name), ["src.ArticleComponent.load"]);
      assert.deepEqual(exactGetTrace.callees?.map((callee) => [callee.qualified_name, callee.evidence]), [
        ["__route__GET__/articles/:slug", "indexed_source"]
      ]);
      assert.equal(exactGetTrace.filtered_identity_incompatible_hops, 1);

      const exactGetCalls = await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        project: alphaProject,
        query: "MATCH (caller:Function)-[:CALLS]->(target:Method) WHERE target.qualified_name = 'src.ArticlesService.get' RETURN caller.name AS caller, caller.qualified_name AS caller_qn"
      }) as { rows: string[][]; filtered_receiver_incompatible_calls?: number };
      assert.deepEqual(exactGetCalls.rows, [["load", "src.ArticleComponent.load"]]);
      assert.equal(exactGetCalls.filtered_receiver_incompatible_calls, 1);

      const updateSnippet = await services.mcp.callTool(space.slug, connection.token, "get_code_snippet", {
        project: alphaProject,
        qualified_name: `${alphaProject}.src.ArticlesService.update`
      }) as { recursive?: boolean; self_recursive?: boolean; return_type?: string };
      assert.equal(updateSnippet.self_recursive, false);
      assert.equal(updateSnippet.recursive, false);
      assert.equal(updateSnippet.return_type, "Observable<Article>");

      toolCalls.length = 0;
      const updateTrace = await services.mcp.callTool(space.slug, connection.token, "trace_path", {
        project: alphaProject,
        function_name: "update",
        qualified_name: `${alphaProject}.src.ArticlesService.update`,
        depth: 1,
        direction: "both"
      }) as {
        resolved_symbol: { qualified_name: string };
        callees?: Array<{ qualified_name?: string }>;
        callers?: unknown[];
        filtered_identity_incompatible_hops?: number;
      };
      assert.equal(updateTrace.resolved_symbol.qualified_name, "src.ArticlesService.update");
      assert.equal(toolCalls.some(({ tool }) => tool === "trace_path"), true);
      assert.deepEqual(updateTrace.callees?.map((callee) => callee.qualified_name), ["__route__PUT__/articles/:slug"]);
      assert.deepEqual(updateTrace.callers, []);
      assert.equal(updateTrace.filtered_identity_incompatible_hops, 2);

      const followTrace = await services.mcp.callTool(space.slug, connection.token, "trace_path", {
        project: alphaProject,
        function_name: "follow",
        qualified_name: `${alphaProject}.src.ProfileService.follow`,
        depth: 2,
        direction: "outbound"
      }) as { callees?: Array<{ qualified_name?: string; evidence?: string }>; filtered_contradictory_self_hops?: number };
      assert.deepEqual(followTrace.callees, [{
        name: "/profiles/:username/follow",
        qualified_name: "__route__POST__/profiles/:username/follow",
        method: "POST",
        path: "/profiles/:username/follow",
        relation: "CALLS",
        evidence: "indexed_source",
        confidence: "verified",
        source_kind: "exact_source"
      }]);
      assert.equal(followTrace.filtered_contradictory_self_hops, 2);

      const internalCallerTrace = await services.mcp.callTool(space.slug, connection.token, "trace_path", {
        project: alphaProject,
        function_name: "getToken",
        qualified_name: `${alphaProject}.src.JwtService.getToken`,
        depth: 1,
        direction: "inbound"
      }) as { callers?: Array<{ qualified_name?: string }>; filtered_identity_incompatible_hops?: number };
      assert.deepEqual(internalCallerTrace.callers?.map((caller) => caller.qualified_name), [
        "src.JwtService.checkAuth",
        "src.main.boot"
      ]);
      assert.equal(internalCallerTrace.filtered_identity_incompatible_hops, undefined);

      const filteredCalls = await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        project: alphaProject,
        query: "MATCH (caller:Function)-[:CALLS]->(target:Method) WHERE target.qualified_name = 'src.ArticlesService.update' RETURN caller.name AS caller, caller.qualified_name AS caller_qn"
      }) as { rows: string[][]; filtered_receiver_incompatible_calls?: number };
      assert.deepEqual(filteredCalls.rows, [["submitForm", "src.editor.submitForm"]]);
      assert.equal(filteredCalls.filtered_receiver_incompatible_calls, 1);

      const filteredOutboundCalls = await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        project: alphaProject,
        query: "MATCH (source:Method {qualified_name: 'src.ArticlesService.update'})-[:CALLS]->(target:Method) RETURN target.name AS target, target.qualified_name AS qualified_name"
      }) as { rows: string[][]; filtered_receiver_incompatible_calls?: number };
      assert.deepEqual(filteredOutboundCalls.rows, [["/articles/:slug", "__route__PUT__/articles/:slug"]]);
      assert.equal(filteredOutboundCalls.filtered_receiver_incompatible_calls, 2);

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "query_graph", {
          project: alphaProject,
          query: "MATCH (source {qualified_name: 'src.ArticlesService.update'})-[:CALLS]->(target) RETURN target.qualified_name"
        }),
        /requires an explicit node label when matching inline properties/
      );

      toolCalls.length = 0;
      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "trace_path", {
          project: alphaProject,
          function_name: "ambiguousRender",
          direction: "both",
          depth: 2
        }),
        /symbol "ambiguousRender" is ambiguous.*src\.first\.ambiguousRender.*src\.second\.ambiguousRender/
      );
      assert.equal(toolCalls.some(({ tool, input }) => tool === "search_graph" && input.name_pattern === "^ambiguousRender$"), true);
      assert.equal(toolCalls.some(({ tool }) => tool === "trace_path"), false);

      const syntheticRoute = await services.mcp.callTool(space.slug, connection.token, "get_code_snippet", {
        project: alphaProject,
        qualified_name: "__route__POST__/articles"
      }) as Record<string, unknown>;
      assert.equal(syntheticRoute.synthetic, true);
      assert.equal(syntheticRoute.source_available, false);
      assert.equal(syntheticRoute.file_path, undefined);
      assert.equal(syntheticRoute.start_line, undefined);
      assert.equal(syntheticRoute.end_line, undefined);
      assert.equal(syntheticRoute.source, undefined);

      const aggregateRoute = await services.mcp.callTool(space.slug, connection.token, "get_code_snippet", {
        project: alphaProject,
        qualified_name: "__route__ANY__/articles/:slug/comments"
      }) as { callers?: number; caller_names?: string[]; analysis_warnings?: string[] };
      assert.equal(aggregateRoute.callers, 2);
      assert.deepEqual(aggregateRoute.caller_names, ["add", "getAll"]);
      assert.ok(aggregateRoute.analysis_warnings?.some((warning) => warning.includes("caller count")));

      const routeSearch = await services.mcp.callTool(space.slug, connection.token, "search_graph", {
        project: alphaProject,
        label: "Route",
        limit: 5
      }) as { results: Array<Record<string, unknown>> };
      assert.equal(routeSearch.results[0]?.synthetic, true);
      assert.equal(routeSearch.results[0]?.source_available, false);
      assert.equal(routeSearch.results[0]?.file_path, undefined);
      assert.equal(routeSearch.results[0]?.method, "POST");
      assert.ok(routeSearch.results.some((route) =>
        route.path === "/articles/:slug" && route.method === "PUT"
      ));
      assert.equal(routeSearch.results.some((route) =>
        route.path === "/articles/:slug/comments/:commentId" && route.method === "DELETE"
      ), false);
      assert.ok(routeSearch.results.some((route) => route.navigable === false && typeof route.navigation_notice === "string"));
      assert.equal(routeSearch.results.some((route) => route.path === "/articles/:slug/comments" && route.method === undefined), false);

      const routeGraph = await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        project: alphaProject,
        query: "MATCH (n:Route) RETURN n.name AS name, n.qualified_name AS q, n.method AS method",
        max_rows: 25
      }) as { rows: string[][] };
      assert.ok(routeGraph.rows.some((row) => row[0] === "/articles/:slug" && row[2] === "PUT"));
      assert.equal(routeGraph.rows.some((row) => row[0] === "/articles/:slug/comments/:commentId" && row[2] === "DELETE"), false);

      toolCalls.length = 0;
      const invalidLabel = await services.mcp.callTool(space.slug, connection.token, "search_graph", {
        project: alphaProject,
        label: "NoSuchLabel",
        limit: 2
      }) as { hint?: string };
      assert.equal(invalidLabel.hint, `Available labels for ${alphaProject}: Function`);

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "search_graph", { query: "target", limit: 0 }),
        /limit must be at least 1/
      );
      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "search_graph", { query: "target", offset: -1 }),
        /offset must be at least 0/
      );
      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "trace_path", { function_name: "target", depth: 999 }),
        /depth must be between 1 and 5/
      );

      const invalidLimitResponse = await services.mcp.handleJsonRpc(space.slug, connection.token, {
        jsonrpc: "2.0",
        id: "invalid-limit",
        method: "tools/call",
        params: { name: "search_graph", arguments: { query: "target", limit: 0 } }
      });
      assert.equal((invalidLimitResponse?.result as { isError?: boolean } | undefined)?.isError, true);

      toolCalls.length = 0;
      const traced = await services.mcp.callTool(space.slug, connection.token, "trace_path", {
        project: alphaProject,
        function_name: "render",
        qualified_name: `${alphaProject}.src.components.App.App.render`,
        depth: 1
      }) as { resolved_symbol: { project: string; qualified_name: string } };
      assert.equal(traced.resolved_symbol.project, alphaProject);
      assert.equal(traced.resolved_symbol.qualified_name, "src.components.App.App.render");
      const candidateLookup = toolCalls.find(({ tool, input }) => tool === "query_graph" && String(input.query).includes("MATCH (n) WHERE"));
      assert.match(String(candidateLookup?.input.query), /src\.components\.App\.App\.render/);
      const nativeTrace = toolCalls.find(({ tool }) => tool === "trace_path");
      assert.equal(nativeTrace?.input.function_name, "render");

      toolCalls.length = 0;
      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "trace_path", {
          project: alphaProject,
          function_name: "definitelyWrongName",
          qualified_name: `${alphaProject}.src.components.App.App.render`,
          depth: 1
        }),
        /function_name "definitelyWrongName" does not match qualified_name resolved symbol "render"/
      );
      assert.equal(toolCalls.some(({ tool }) => tool === "trace_path"), false);

      toolCalls.length = 0;
      await services.mcp.callTool(space.slug, connection.token, "search_graph", {
        query: "scoped-target",
        project: alphaProject,
        limit: 30
      });
      assert.equal(toolCalls.length, 1);
      assert.equal(toolCalls[0]!.input.project, alphaProject);
      assert.equal(toolCalls[0]!.input.limit, 25);

      toolCalls.length = 0;
      const graph = await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        query: "MATCH (n) RETURN n",
        max_rows: 10
      });
      assert.equal(toolCalls.length, 2);
      assert.deepEqual(toolCalls.map(({ tool }) => tool), ["query_graph", "query_graph"]);
      assert.deepEqual(toolCalls.map(({ input }) => input.project), [alphaProject, betaProject]);
      assert.deepEqual(toolCalls.map(({ input }) => input.max_rows), [11, 11]);
      assert.deepEqual(toolCalls.map(({ input }) => input.query), ["MATCH (n) RETURN n LIMIT 11", "MATCH (n) RETURN n LIMIT 11"]);
      assert.equal((graph as { snapshot: { version: number; stale?: boolean } }).snapshot.version, 1);
      assert.equal((graph as { max_rows_scope?: string }).max_rows_scope, "global");
      assert.equal((graph as { max_rows?: number }).max_rows, 10);
      assert.equal((graph as { snapshot: { stale?: boolean } }).snapshot.stale, undefined);
      assert.equal((graph as { limits?: unknown }).limits, undefined);
      assert.equal((graph as { space?: unknown }).space, undefined);

      toolCalls.length = 0;
      await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        query: "MATCH (n) RETURN n"
      });
      assert.equal(toolCalls.length, 2);
      assert.deepEqual(toolCalls.map(({ input }) => input.max_rows), [26, 26]);
      assert.deepEqual(toolCalls.map(({ input }) => input.query), ["MATCH (n) RETURN n LIMIT 26", "MATCH (n) RETURN n LIMIT 26"]);

      toolCalls.length = 0;
      const globalRoute = await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        query: "MATCH (n:Route) RETURN n.name AS name",
        max_rows: 1
      }) as {
        projects: Array<{ project: string; rows: string[][] }>;
        returned?: number;
        projects_searched?: string[];
        has_more?: boolean;
        continuation_projects?: string[];
      };
      assert.deepEqual(globalRoute.projects_searched, [alphaProject, betaProject]);
      assert.equal(globalRoute.returned, 1);
      assert.equal(globalRoute.has_more, undefined);
      assert.ok((globalRoute.continuation_projects?.length ?? 0) > 0);
      assert.equal(globalRoute.projects.reduce((sum, project) => sum + project.rows.length, 0), 1);

      const globalContinuation = await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        query: "MATCH (n) RETURN n",
        max_rows: 1
      }) as { has_more?: boolean; scope_continuation_required?: boolean; continuation_projects?: string[] };
      assert.equal(globalContinuation.has_more, undefined);
      assert.equal(globalContinuation.scope_continuation_required, true);
      assert.deepEqual(globalContinuation.continuation_projects, [betaProject]);

      toolCalls.length = 0;
      await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        query: "MATCH (n:Function) RETURN n",
        project: betaProject,
        max_rows: 5
      });
      assert.equal(toolCalls.length, 1);
      assert.equal(toolCalls[0]!.input.project, betaProject);
      assert.equal(toolCalls[0]!.input.query, "MATCH (n:Function) RETURN n LIMIT 6");

      toolCalls.length = 0;
      await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        query: "MATCH (n) WHERE n.name = 'DELETE ME' RETURN n",
        max_rows: 5
      });
      assert.equal(toolCalls.length, 2);
      assert.deepEqual(toolCalls.map(({ input }) => input.project), [alphaProject, betaProject]);
      assert.deepEqual(toolCalls.map(({ input }) => input.query), [
        "MATCH (n) WHERE n.name = 'DELETE ME' RETURN n LIMIT 6",
        "MATCH (n) WHERE n.name = 'DELETE ME' RETURN n LIMIT 6"
      ]);

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "query_graph", {
          project: alphaProject,
          query: "MATCH (n:Function) RETURN n.not_a_property AS x"
        }),
        /unknown graph properties: not_a_property/
      );

      toolCalls.length = 0;
      const totalCount = await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        project: alphaProject,
        query: "MATCH (n) RETURN count(n) AS c"
      }) as { rows: string[][]; aggregation_source?: string };
      assert.deepEqual(totalCount.rows, [["314"]]);
      assert.equal(totalCount.aggregation_source, "index_status");
      assert.deepEqual(toolCalls.map(({ tool }) => tool), ["index_status"]);

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "query_graph", {
          project: alphaProject,
          query: "MATCH (f) WHERE f.name CONTAINS 'x' RETURN count(f) AS c"
        }),
        /250-entity scan ceiling/
      );

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "query_graph", { query: "RETURN 1 AS one" }),
        /subset starting with MATCH/
      );

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "query_graph", {
          project: alphaProject,
          query: "MATCH (n:Method) RETURN n.name AS name ORDER BY n.name",
          max_rows: 10
        }),
        /ORDER BY is not supported reliably/
      );

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "query_graph", {
          project: alphaProject,
          query: "MATCH (n:Method) RETURN n.name AS name SKIP 25",
          max_rows: 25
        }),
        /SKIP is controlled by the offset argument/
      );

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "query_graph", {
          project: alphaProject,
          query: "MATCH (a)-[r:CALLS]->(a) RETURN count(*) AS c",
          max_rows: 25
        }),
        /does not support reusing the same node variable/
      );

      toolCalls.length = 0;
      const graphPage = await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        project: alphaProject,
        query: "MATCH (n:Method) RETURN n.qualified_name AS q",
        max_rows: 25,
        offset: 25
      }) as { rows: string[][]; offset?: number; effective_limit?: number; has_more?: boolean };
      assert.equal(graphPage.rows.length, 25);
      assert.equal(graphPage.rows[0]?.[0], "method-25");
      assert.equal(graphPage.rows[24]?.[0], "method-49");
      assert.equal(graphPage.offset, 25);
      assert.equal(graphPage.effective_limit, 25);
      assert.equal(graphPage.has_more, true);
      assert.equal(toolCalls[0]?.input.max_rows, 51);
      assert.equal(toolCalls[0]?.input.query, "MATCH (n:Method) RETURN n.qualified_name AS q LIMIT 51");

      toolCalls.length = 0;
      const finalGraphPage = await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        project: alphaProject,
        query: "MATCH (n:Method) RETURN n.qualified_name AS q",
        max_rows: 25,
        offset: 225
      }) as { rows: string[][]; has_more?: boolean; truncated?: boolean; pagination_ceiling?: number };
      assert.equal(finalGraphPage.rows.length, 25);
      assert.equal(finalGraphPage.rows[0]?.[0], "method-225");
      assert.equal(finalGraphPage.rows[24]?.[0], "method-249");
      assert.equal(finalGraphPage.has_more, false);
      assert.equal(finalGraphPage.truncated, true);
      assert.equal(finalGraphPage.pagination_ceiling, 250);
      assert.equal(toolCalls[0]?.input.max_rows, 250);

      for (const property of ["create", "delete", "set", "remove"]) {
        toolCalls.length = 0;
        await services.mcp.callTool(space.slug, connection.token, "query_graph", {
          project: alphaProject,
          query: `MATCH (n) RETURN n.${property} AS value`,
          max_rows: 1
        });
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0]!.tool, "query_graph");
      }

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "query_graph", { query: "MATCH (n) DELETE n", max_rows: 5 }),
        /read-only Cypher/
      );

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "query_graph", { query: "MATCH (n) RETURN n LIMIT 999999", max_rows: 5 }),
        /LIMIT is controlled by max_rows/
      );

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "query_graph", { query: "MATCH (n) RETURN n; MATCH (m) RETURN m", max_rows: 5 }),
        /exactly one Cypher statement/
      );

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "query_graph", { query: "MATCH (n) RETURN n /* LIMIT 999 */ CALL db.labels()", max_rows: 5 }),
        /read-only Cypher/
      );

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "detect_changes", { repo_path: testRoot }),
        /received unsupported arguments|cannot receive filesystem path arguments|not available for immutable snapshot queries/
      );

      for (const legacyTool of ["get_space_architecture", "search_symbols", "trace_symbol", "get_snippet"]) {
        await assert.rejects(() => services.mcp.callTool(space.slug, connection.token, legacyTool, {}), /Unknown MCP tool/);
      }

      const successfulStub = services.cbm.tool.bind(services.cbm);
      (services.cbm as unknown as { tool: typeof services.cbm.tool }).tool = async (tool, input, cacheDir, timeoutMs) => {
        if (input.project === betaProject) {
          throw new Error("project backend unavailable");
        }
        return successfulStub(tool, input, cacheDir, timeoutMs);
      };
      const partialSearch = await services.mcp.callTool(space.slug, connection.token, "search_graph", {
        query: "partial-target",
        limit: 10
      }) as { partial?: boolean; project_errors?: Array<{ project: string }> };
      assert.equal(partialSearch.partial, true);
      assert.deepEqual(partialSearch.project_errors?.map(({ project }) => project), [betaProject]);

      (services.cbm as unknown as { tool: typeof services.cbm.tool }).tool = async () => {
        throw new Error("backend unavailable");
      };
      const failedSearch = await services.mcp.handleJsonRpc(space.slug, connection.token, {
        jsonrpc: "2.0",
        id: "failed-search",
        method: "tools/call",
        params: { name: "search_graph", arguments: { query: "all-projects-fail", limit: 10 } }
      });
      assert.equal((failedSearch?.result as { isError?: boolean } | undefined)?.isError, true);

      (services.cbm as unknown as { tool: typeof services.cbm.tool }).tool = successfulStub;

      (services.cbm as unknown as { tool: typeof services.cbm.tool }).tool = async () => ({
        results: Array.from({ length: 400 }, (_, index) => ({ name: `node-${index}`, detail: "y".repeat(200) }))
      });
      const truncatedResponse = (await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        project: alphaProject,
        query: "MATCH (huge) RETURN huge",
        max_rows: 25
      })) as { results: unknown[]; truncated: { field: string; returned: number; total: number } };
      assert.ok(truncatedResponse.results.length > 0);
      assert.ok(truncatedResponse.results.length < 400);
      assert.equal(truncatedResponse.truncated.field, "results");
      assert.equal(truncatedResponse.truncated.returned, truncatedResponse.results.length);
      assert.equal(truncatedResponse.truncated.total, 400);
      assert.ok(Buffer.byteLength(JSON.stringify(truncatedResponse), "utf8") <= 50_000);
    } finally {
      (services.cbm as unknown as { tool: typeof services.cbm.tool }).tool = originalCbmTool;
    }
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("empty spaces can be deleted with local MCP connections and tool stats", () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "delete-space-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const emptySpace = services.spaces.createSpace("Delete Me");
    services.mcp.createConnection(emptySpace.id, "Local agent", "generic");
    insertRecord(services.database, "mcp_tool_stats", {
      spaceId: emptySpace.id,
      toolName: "list_projects",
      callCount: 1,
      totalResponseBytes: 100,
      maxResponseBytes: 100,
      lastCalledAt: nowIso()
    });
    assert.equal(fs.existsSync(emptySpace.rootPath), true);

    const deleted = services.spaces.deleteSpace(emptySpace.id);
    assert.equal(deleted.connectionsDeleted, 1);
    assert.equal(deleted.toolStatsDeleted, 1);
    assert.equal(fs.existsSync(emptySpace.rootPath), false);
    assert.throws(() => services.spaces.getSpaceById(emptySpace.id), /Space not found/);

    const protectedSpace = services.spaces.createSpace("Protected Space");
    const repositoryId = createRepositoryRecord(services.database, "https://github.com/example/protected.git", {
      githubId: 6001,
      owner: "example",
      name: "protected"
    });
    services.spaces.addRepositoryToSpace(protectedSpace.id, repositoryId);

    assert.throws(
      () => services.spaces.deleteSpace(protectedSpace.id),
      /Space must not have repositories, snapshots, or jobs/
    );
    assert.equal(services.spaces.getSpaceById(protectedSpace.id).id, protectedSpace.id);

    const activeSpace = services.spaces.createSpace("Active Chat Space");
    const createdAt = nowIso();
    services.database.sqlite
      .prepare(
        `INSERT INTO agent_account_sessions
          (id, provider_id, account_key, connected_at, disconnected_at)
         VALUES (?, ?, ?, ?, NULL)`
      )
      .run("aas_delete_guard", "openai-codex", "delete-guard", createdAt);
    services.database.sqlite
      .prepare(
        `INSERT INTO agent_chats
          (id, space_id, account_session_id, snapshot_id, snapshot_version, snapshot_meta_json,
           title, status, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        "ach_delete_guard",
        activeSpace.id,
        "aas_delete_guard",
        1,
        "{}",
        "Deletion guard",
        "active",
        createdAt,
        createdAt
      );
    services.database.sqlite
      .prepare(
        `INSERT INTO agent_messages
          (id, chat_id, sequence, role, status, content, sources_json, error, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', NULL, ?, ?)`
      )
      .run("agm_delete_guard_user", "ach_delete_guard", 1, "user", "completed", "Question", createdAt, createdAt);
    services.database.sqlite
      .prepare(
        `INSERT INTO agent_messages
          (id, chat_id, sequence, role, status, content, sources_json, error, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', NULL, ?, NULL)`
      )
      .run("agm_delete_guard_assistant", "ach_delete_guard", 2, "assistant", "streaming", "", createdAt);
    services.database.sqlite
      .prepare(
        `INSERT INTO agent_turns
          (id, chat_id, user_message_id, assistant_message_id, status, error, created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, 'running', NULL, ?, ?, NULL)`
      )
      .run(
        "atr_delete_guard",
        "ach_delete_guard",
        "agm_delete_guard_user",
        "agm_delete_guard_assistant",
        createdAt,
        createdAt
      );

    assert.throws(
      () => services.spaces.deleteSpace(activeSpace.id),
      /Wait for active agent answers before deleting this Space/
    );
    assert.equal(services.spaces.getSpaceById(activeSpace.id).id, activeSpace.id);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("space API responses do not expose managed filesystem paths", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "public-space-contract-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  const app = await createApp(services);

  try {
    const space = services.spaces.createSpace("Public Contract Space");
    const repositoryId = createRepositoryRecord(services.database, "https://github.com/example/public-contract.git", {
      githubId: 6101,
      owner: "example",
      name: "public-contract"
    });
    services.spaces.addRepositoryToSpace(space.id, repositoryId);

    const spacesResponse = await injectControlApi(app, { method: "GET", url: "/api/spaces" });
    assert.equal(spacesResponse.statusCode, 200);
    assertNoInternalPathLeak(spacesResponse.body, testRoot);

    const detailResponse = await injectControlApi(app, { method: "GET", url: `/api/spaces/${space.id}` });
    assert.equal(detailResponse.statusCode, 200);
    assertNoInternalPathLeak(detailResponse.body, testRoot);
  } finally {
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("HTTP boundary rejects untrusted browser requests before mutations run", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "http-boundary-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  let mutationCalls = 0;
  (services.operations as unknown as { enqueueGitHubSync: () => { id: string } }).enqueueGitHubSync = () => {
    mutationCalls += 1;
    return { id: "job_http_boundary" };
  };
  const app = await createApp(services);
  const allowedHost = "127.0.0.1:8787";
  const allowedOrigin = "http://127.0.0.1:5173";

  try {
    const untrustedHost = await app.inject({
      method: "POST",
      url: "/api/github/sync",
      headers: { host: "rebind.example:8787", origin: allowedOrigin },
      payload: {}
    });
    assert.equal(untrustedHost.statusCode, 403);

    const untrustedOrigin = await app.inject({
      method: "POST",
      url: "/api/github/sync",
      headers: { host: allowedHost, origin: "https://evil.example" },
      payload: {}
    });
    assert.equal(untrustedOrigin.statusCode, 403);

    const crossSite = await app.inject({
      method: "POST",
      url: "/api/github/sync",
      headers: { host: allowedHost, origin: allowedOrigin, "sec-fetch-site": "cross-site" },
      payload: {}
    });
    assert.equal(crossSite.statusCode, 403);

    const missingJson = await app.inject({
      method: "POST",
      url: "/api/github/sync",
      headers: {
        host: allowedHost,
        origin: allowedOrigin,
        authorization: `Bearer ${TEST_CONTROL_TOKEN}`,
        "x-memorepo-csrf": "1"
      }
    });
    assert.equal(missingJson.statusCode, 415);
    assert.equal(mutationCalls, 0);

    const encodedMissingJson = await app.inject({
      method: "POST",
      url: "/%61pi/github/sync",
      headers: {
        host: allowedHost,
        origin: allowedOrigin,
        authorization: `Bearer ${TEST_CONTROL_TOKEN}`,
        "x-memorepo-csrf": "1"
      }
    });
    assert.equal(encodedMissingJson.statusCode, 415);
    assert.equal(mutationCalls, 0);

    const missingAuthentication = await app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { host: allowedHost, origin: allowedOrigin }
    });
    assert.equal(missingAuthentication.statusCode, 401);
    assert.equal(missingAuthentication.headers["access-control-allow-origin"], allowedOrigin);

    const wrongAuthentication = await app.inject({
      method: "POST",
      url: "/api/github/sync",
      headers: {
        host: allowedHost,
        origin: allowedOrigin,
        authorization: "Bearer wrong-control-token",
        "x-memorepo-csrf": "1"
      },
      payload: {}
    });
    assert.equal(wrongAuthentication.statusCode, 401);

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/github/sync",
      headers: { host: allowedHost, origin: allowedOrigin, authorization: `Bearer ${TEST_CONTROL_TOKEN}` },
      payload: {}
    });
    assert.equal(missingCsrf.statusCode, 403);
    assert.equal(mutationCalls, 0);

    const missingDeleteCsrf = await app.inject({
      method: "DELETE",
      url: "/api/mcp-connections/mcp_missing",
      headers: { host: allowedHost, origin: allowedOrigin, authorization: `Bearer ${TEST_CONTROL_TOKEN}` }
    });
    assert.equal(missingDeleteCsrf.statusCode, 403);

    const allowed = await app.inject({
      method: "POST",
      url: "/api/github/sync",
      headers: {
        host: allowedHost,
        origin: allowedOrigin,
        authorization: `Bearer ${TEST_CONTROL_TOKEN}`,
        "x-memorepo-csrf": "1"
      },
      payload: {}
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.headers["access-control-allow-origin"], allowedOrigin);
    assert.equal(mutationCalls, 1);
  } finally {
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("HTTP rate limits run before authentication and preserve CORS error details", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "http-rate-limit-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  const app = await createApp(services, {
    controlToken: TEST_CONTROL_TOKEN,
    rateLimitWindowMs: 60_000,
    authRateLimitMax: 2,
    apiReadRateLimitMax: 10,
    apiWriteRateLimitMax: 10,
    apiSseRateLimitMax: 10,
    mcpRateLimitMax: 10
  });
  const origin = "http://127.0.0.1:5173";

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({ method: "GET", url: "/api/auth/status", headers: { origin } });
      assert.equal(response.statusCode, 401);
    }

    const limited = await app.inject({ method: "GET", url: "/api/auth/status", headers: { origin } });
    assert.equal(limited.statusCode, 429);
    assert.ok(limited.headers["retry-after"]);
    assert.equal(limited.headers["access-control-allow-origin"], origin);
    assert.match(limited.json<{ error: string }>().error, /Rate limit exceeded/);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
    }
  } finally {
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("route errors return actionable messages", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "route-errors-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  const app = await createApp(services);

  try {
    const space = services.spaces.createSpace("Route Error Space");
    const repositoryId = createRepositoryRecord(services.database, "https://github.com/example/route-error.git", {
      githubId: 7001,
      owner: "example",
      name: "route-error"
    });
    services.spaces.addRepositoryToSpace(space.id, repositoryId);

    const response = await injectControlApi(app, { method: "DELETE", url: `/api/spaces/${space.id}` });
    assert.equal(response.statusCode, 400);
    assert.match(response.json<{ error: string }>().error, /Space must not have repositories, snapshots, or jobs/);
  } finally {
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("unknown resources return 404 and invalid payloads return readable 400 messages", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "error-mapping-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  const app = await createApp(services);

  try {
    const missingSpace = await injectControlApi(app, { method: "GET", url: "/api/spaces/spc_missing" });
    assert.equal(missingSpace.statusCode, 404);
    const missingSpaceError = missingSpace.json<{ error: string; code: string; requestId: string }>();
    assert.match(missingSpaceError.error, /Space not found/);
    assert.equal(missingSpaceError.code, "MR-API-NOT-FOUND");
    assert.ok(missingSpaceError.requestId);

    const missingJob = await injectControlApi(app, { method: "GET", url: "/api/jobs/job_missing" });
    assert.equal(missingJob.statusCode, 404);
    assert.match(missingJob.json<{ error: string }>().error, /Job not found/);

    const missingJobRetry = await injectControlApi(app, { method: "POST", url: "/api/jobs/job_missing/retry", payload: {} });
    assert.equal(missingJobRetry.statusCode, 404);

    const missingJobEvents = await injectControlApi(app, { method: "GET", url: "/api/jobs/job_missing/events" });
    assert.equal(missingJobEvents.statusCode, 404);

    const missingConnection = await injectControlApi(app, { method: "DELETE", url: "/api/mcp-connections/mcp_missing" });
    assert.equal(missingConnection.statusCode, 404);
    assert.match(missingConnection.json<{ error: string }>().error, /MCP connection not found/);

    const invalidBody = await injectControlApi(app, { method: "POST", url: "/api/spaces", payload: {} });
    assert.equal(invalidBody.statusCode, 400);
    const invalidError = invalidBody.json<{ error: string; code: string; requestId: string }>();
    assert.match(invalidError.error, /Invalid request: name/);
    assert.doesNotMatch(invalidError.error, /[[{]/);
    assert.equal(invalidError.code, "MR-API-VALIDATION");
    assert.ok(invalidError.requestId);
  } finally {
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("job event stream replays events over SSE with CORS headers for the dashboard origin", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "job-events-sse-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  const app = await createApp(services);
  const controller = new AbortController();

  try {
    const job = services.jobs.enqueue({ type: "sse_test_job" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    const origin = "http://127.0.0.1:5173";

    const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs/${job.id}/events`, {
      headers: { origin, accept: "text/event-stream", authorization: `Bearer ${TEST_CONTROL_TOKEN}` },
      signal: controller.signal
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    assert.ok(response.body);
    const reader = response.body.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, /^data: /m);
    assert.match(text, /pending/);
  } finally {
    controller.abort();
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("GitHub status route reports invalid credentials without failing the request", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "github-status-"));
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  const app = await createApp(services);

  try {
    await withGitHubFetch(
      {
        "https://api.github.com/user": githubErrorResponse(401, "Bad credentials")
      },
      async () => {
        const response = await injectControlApi(app, { method: "GET", url: "/api/github/status" });
        assert.equal(response.statusCode, 200);
        const payload = response.json<{ connected: boolean; error: string }>();
        assert.equal(payload.connected, false);
        assert.match(payload.error, /Bad credentials/);
      }
    );
  } finally {
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

function createRepositoryRecord(
  database: ReturnType<typeof createServices>["database"],
  cloneUrl: string,
  options: RepositoryRecordOptions = {}
): string {
  const timestamp = nowIso();
  const id = createId("ghr");
  const owner = options.owner ?? "integration-owner";
  const name = options.name ?? "integration-repo";

  insertRecord(database, "github_repositories", {
    id,
    githubId: options.githubId ?? Math.floor(Date.now() / 1000),
    owner,
    name,
    fullName: `${owner}/${name}`,
    htmlUrl: `https://github.com/${owner}/${name}`,
    cloneUrl,
    defaultBranch: options.defaultBranch ?? "main",
    private: options.private ?? false,
    archived: options.archived ?? false,
    fork: options.fork ?? false,
    description: options.description ?? "Integration test repository",
    topicsJson: "[]",
    pushedAt: timestamp,
    lastSeenAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  return id;
}

function repositoryNames(rows: unknown[]): string[] {
  return rows.map((row) => (row as { full_name: string }).full_name);
}

async function withGitHubFetch(routes: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const result = routes[url];
    if (result === undefined) {
      return new Response(JSON.stringify({ message: `Unexpected test URL: ${url}` }), { status: 404 });
    }
    if (result instanceof Response) {
      return result;
    }
    return jsonResponse(result);
  }) as typeof fetch;

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function githubErrorResponse(status: number, message: string): Response {
  return jsonResponse(
    {
      message,
      documentation_url: "https://docs.github.com/rest/repos/repos#get-a-repository",
      status: String(status)
    },
    status
  );
}

function githubRepositoryPayload(
  id: number,
  owner: string,
  name: string,
  options: { private?: boolean; archived?: boolean; fork?: boolean; ownerType?: "User" | "Organization" } = {}
) {
  return {
    id,
    owner: { login: owner, type: options.ownerType ?? "User" },
    name,
    full_name: `${owner}/${name}`,
    html_url: `https://github.com/${owner}/${name}`,
    clone_url: `https://github.com/${owner}/${name}.git`,
    default_branch: "main",
    private: options.private ?? false,
    archived: options.archived ?? false,
    fork: options.fork ?? false,
    description: null,
    topics: [],
    pushed_at: "2026-01-01T00:00:00Z"
  };
}

function createSnapshotReadySpaceRepository(
  services: ReturnType<typeof createServices>,
  spaceId: string,
  options: RepositoryRecordOptions
) {
  const repositoryId = createRepositoryRecord(
    services.database,
    `https://github.com/${options.owner}/${options.name}.git`,
    options
  );
  const spaceRepository = services.spaces.addRepositoryToSpace(spaceId, repositoryId) as { id: string; localPath: string };
  fs.mkdirSync(spaceRepository.localPath, { recursive: true });
  fs.writeFileSync(path.join(spaceRepository.localPath, "README.md"), `# ${options.name}\n`, "utf8");
  execFileSync("git", ["init", "--initial-branch=main", spaceRepository.localPath], { stdio: "ignore" });
  execFileSync("git", ["-C", spaceRepository.localPath, "add", "README.md"], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      spaceRepository.localPath,
      "-c",
      "user.name=MemoRepo Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "Initial test snapshot"
    ],
    { stdio: "ignore" }
  );
  const selectedCommit = execFileSync("git", ["-C", spaceRepository.localPath, "rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
  updateRecord(
    services.database,
    "space_repositories",
    {
      cloneStatus: "cloned",
      indexStatus: "indexed",
      selectedBranch: "main",
      selectedCommit,
      remoteRef: "refs/remotes/origin/main",
      snapshotIncluded: false,
      lastError: null
    },
    "id",
    spaceRepository.id
  );
  return services.spaces.getSpaceRepository(spaceRepository.id);
}

function stubCbmSnapshots(
  services: ReturnType<typeof createServices>,
  failingRepositoryPath?: string,
  resultForRepository?: (repoPath: string) => CbmIndexRepositoryResult,
  resultForCrossRepoLinks?: (repoPath: string) => CbmCrossRepoLinksResult
): void {
  stubCbmCapabilities(services.cbm);
  const cbm = services.cbm as unknown as {
    version: () => Promise<string>;
    indexRepository: (
      repoPath: string,
      cacheDir: string,
      mode?: "fast" | "moderate" | "full",
      onOutput?: (line: string) => void
    ) => Promise<CbmIndexRepositoryResult>;
    buildCrossRepoLinks: (
      repoPath: string,
      cacheDir: string,
      onOutput?: (line: string) => void
    ) => Promise<CbmCrossRepoLinksResult>;
  };

  cbm.version = async () => "codebase-memory-mcp test";
  cbm.indexRepository = async (repoPath, cacheDir) => {
    if (failingRepositoryPath && path.basename(repoPath) === path.basename(failingRepositoryPath)) {
      throw new Error(`index failed for ${repoPath}`);
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, `${path.basename(repoPath)}.index`), "indexed\n", "utf8");
    const result = resultForRepository?.(repoPath) ?? {
      project: path.basename(repoPath),
      status: "indexed",
      reportedStatus: "indexed",
      quality: "clean",
      skippedCount: 0,
      nodes: 1,
      edges: 0
    };
    return {
      ...result,
      indexStatus: result.indexStatus ?? readyIndexStatus(
        result.project ?? path.basename(repoPath),
        result.nodes ?? 0,
        result.edges ?? 0
      )
    };
  };
  cbm.buildCrossRepoLinks = async (repoPath) => resultForCrossRepoLinks?.(repoPath) ?? {
    project: path.basename(repoPath),
    status: "linked",
    indexStatus: readyIndexStatus(path.basename(repoPath), 1, 0)
  };
}

function readyIndexStatus(project: string, nodes: number, edges: number): CbmIndexStatusResult {
  return {
    project,
    status: "ready",
    reportedStatus: "ready",
    quality: "complete",
    nodes,
    edges,
    git: { rootExists: true }
  };
}

function stubCbmCapabilities(cbm: CbmService): void {
  const descriptors: McpToolDescriptor[] = [
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
  ].map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: name === "search_graph" ? { semantic_query: {} } : {}
    }
  }));
  const runtime = cbm as unknown as {
    version: () => Promise<string>;
    capabilities: () => Promise<ReturnType<typeof assertCbmV090Compatible>>;
  };
  runtime.version = async () => "codebase-memory-mcp 0.9.0";
  runtime.capabilities = async () => assertCbmV090Compatible("codebase-memory-mcp 0.9.0", descriptors);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function supportsImmutableCbmConfiguration(): boolean {
  try {
    const output = execFileSync("codebase-memory-mcp", ["--version"], { encoding: "utf8" });
    const match = output.match(/(?:^|\s)v?(\d+)\.(\d+)(?:\.\d+)?(?:\s|$)/);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major > 0 || minor >= 9;
  } catch {
    return false;
  }
}

type TestApp = Awaited<ReturnType<typeof createApp>>;
type TestInjectOptions = Exclude<Parameters<TestApp["inject"]>[0], string>;

function injectControlApi(app: TestApp, options: TestInjectOptions) {
  const method = String(options.method).toUpperCase();
  return app.inject({
    ...options,
    headers: {
      authorization: `Bearer ${TEST_CONTROL_TOKEN}`,
      ...(!["GET", "HEAD", "OPTIONS"].includes(method) ? { "x-memorepo-csrf": "1" } : {}),
      ...(options.headers ?? {})
    }
  });
}

function assertNoInternalPathLeak(value: string, internalRoot: string): void {
  assert.doesNotMatch(value, /local_path|localPath|clone_url|cloneUrl|artifact_path|artifactPath/);
  assert.doesNotMatch(value, new RegExp(escapeRegExp(internalRoot)));
  assert.doesNotMatch(value, /file:\/\//);
}

function findFirstString(value: unknown, key: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstString(item, key);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") {
    return record[key];
  }

  for (const item of Object.values(record)) {
    const found = findFirstString(item, key);
    if (found) {
      return found;
    }
  }

  return null;
}

function cleanupTestRoot(testRoot: string): void {
  if (process.env.KEEP_MEMOREPO_TESTS === "1") {
    return;
  }

  fs.rmSync(testRoot, { recursive: true, force: true });
  if (fs.existsSync(testsRoot) && fs.readdirSync(testsRoot).length === 0) {
    fs.rmSync(testsRoot, { recursive: true, force: true });
  }
}

interface RepositoryRecordOptions {
  githubId?: number;
  owner?: string;
  name?: string;
  defaultBranch?: string;
  private?: boolean;
  archived?: boolean;
  fork?: boolean;
  description?: string;
}

function createGitRemote(testRoot: string): string {
  const sourcePath = path.join(testRoot, "source");
  const remotePath = path.join(testRoot, "remote.git");

  fs.mkdirSync(sourcePath, { recursive: true });
  runGit(["init", "--initial-branch", "main"], sourcePath);
  runGit(["config", "user.email", "memorepo@example.test"], sourcePath);
  runGit(["config", "user.name", "MemoRepo Test"], sourcePath);

  writeSourceFile(sourcePath, "main");
  runGit(["add", "."], sourcePath);
  runGit(["commit", "-m", "initial main"], sourcePath);

  runGit(["init", "--bare", remotePath], testRoot);
  runGit(["remote", "add", "origin", remotePath], sourcePath);
  runGit(["push", "-u", "origin", "main"], sourcePath);

  runGit(["checkout", "-B", "develop"], sourcePath);
  writeSourceFile(sourcePath, "develop");
  runGit(["add", "."], sourcePath);
  runGit(["commit", "-m", "develop branch"], sourcePath);
  runGit(["push", "-u", "origin", "develop"], sourcePath);

  return pathToFileURL(remotePath).href;
}

function writeSourceFile(sourcePath: string, branch: string): void {
  const srcDir = path.join(sourcePath, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourcePath, "package.json"),
    JSON.stringify({ name: "integration-repo", version: "1.0.0", type: "module" }, null, 2)
  );
  fs.writeFileSync(
    path.join(srcDir, "index.ts"),
    [
      "export function branchName(): string {",
      `  return "${branch}";`,
      "}",
      "",
      "export function routePath(): string {",
      "  return `/api/${branchName()}`;",
      "}",
      "",
      "export function callbackWorker(): string {",
      "  return branchName();",
      "}",
      "",
      "export function registerCallback(callback: () => string): string {",
      "  return callback();",
      "}",
      "",
      "export function buildFlow(): string {",
      "  return registerCallback(callbackWorker);",
      "}",
      ""
    ].join("\n")
  );
}

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function countRows(
  sqlite: ReturnType<typeof createServices>["database"]["sqlite"],
  table: "repo_indexes" | "space_snapshots"
): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function jobStatus(sqlite: ReturnType<typeof createServices>["database"]["sqlite"], jobId: string): string {
  const row = sqlite.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string } | undefined;
  return row?.status ?? "missing";
}

async function waitForJobStatus(
  sqlite: ReturnType<typeof createServices>["database"]["sqlite"],
  jobId: string,
  status: string
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (jobStatus(sqlite, jobId) === status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for job ${jobId} to reach ${status}; current status: ${jobStatus(sqlite, jobId)}`);
}

async function waitForJobs(sqlite: ReturnType<typeof createServices>["database"]["sqlite"], jobIds: string[]): Promise<void> {
  const deadline = Date.now() + 120_000;
  const placeholders = jobIds.map(() => "?").join(",");

  while (Date.now() < deadline) {
    const rows = sqlite
      .prepare(`SELECT id, status, error FROM jobs WHERE id IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...jobIds) as Array<{ id: string; status: string; error: string | null }>;

    if (rows.length === jobIds.length && rows.every((row) => ["succeeded", "failed", "skipped"].includes(row.status))) {
      const failed = rows.filter((row) => row.status !== "succeeded");
      assert.deepEqual(failed, []);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const rows = sqlite
    .prepare(`SELECT id, type, status, error FROM jobs WHERE id IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...jobIds);
  assert.fail(`Timed out waiting for jobs: ${JSON.stringify(rows, null, 2)}`);
}
