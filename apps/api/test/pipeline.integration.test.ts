import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createServices } from "../src/services/appServices.js";
import { insertRecord, updateRecord } from "../src/db/sql.js";
import { spaces } from "../src/db/schema.js";
import { nowIso } from "../src/domain/time.js";
import { createId } from "../src/domain/ids.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const testsRoot = path.join(repoRoot, ".tmp-memorepo-tests");

test("database exposes a Drizzle client over the SQLite source of truth", () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "drizzle-db-"));
  process.env.GH_TOKEN = "test-token";
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

test("managed repository pipeline clones, checks out, indexes, snapshots, and serves MCP tools", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "pipeline-"));
  const memorepoHome = path.join(testRoot, "memorepo-home");

  process.env.GH_TOKEN = "test-token";
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

    const connection = services.mcp.createConnection(space.id, "Integration Agent", "generic");
    const listResponse = await services.mcp.callTool(space.slug, connection.token, "list_space_repositories", {});
    const listResponseJson = JSON.stringify(listResponse);
    assert.match(listResponseJson, /integration-owner\/integration-repo/);
    const projectName = findFirstString(listResponse, "project");
    assert.ok(projectName);
    assert.doesNotMatch(listResponseJson, /branches|githubRepositoryId|htmlUrl|remoteRef/);
    assert.doesNotMatch(listResponseJson, /local_path|localPath|clone_url|cloneUrl/);
    assert.doesNotMatch(listResponseJson, new RegExp(escapeRegExp(testRoot)));
    assert.doesNotMatch(listResponseJson, /file:\/\//);

    const expandedListResponse = await services.mcp.callTool(space.slug, connection.token, "list_space_repositories", {
      include_branches: true,
      include_details: true
    });
    const expandedListResponseJson = JSON.stringify(expandedListResponse);
    assert.match(expandedListResponseJson, /branches/);
    assert.match(expandedListResponseJson, /htmlUrl/);
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
      query: "MATCH (n) RETURN n LIMIT 5",
      max_rows: 5
    });
    const graphResponseJson = JSON.stringify(graphResponse);
    assert.match(graphResponseJson, /snapshot/);
    assertNoInternalPathLeak(graphResponseJson, testRoot);

    const originalCbmTool = services.cbm.tool.bind(services.cbm);
    (services.cbm as unknown as { tool: typeof services.cbm.tool }).tool = async () => ({ payload: "x".repeat(300_000) });
    try {
      const largeResponse = await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        query: "MATCH (n) RETURN n LIMIT 1",
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
  process.env.GH_TOKEN = "test-token";
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
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
        "access-control-request-headers": "content-type"
      }
    });
    assert.equal(deletePreflightResponse.statusCode, 204);
    assert.equal(deletePreflightResponse.headers["access-control-allow-origin"], "http://127.0.0.1:5173");
    assert.match(String(deletePreflightResponse.headers["access-control-allow-methods"]), /DELETE/);
    assert.match(String(deletePreflightResponse.headers["access-control-allow-headers"]), /content-type/i);

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

    const statsResponse = await app.inject({
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

    const deleteRevokedResponse = await app.inject({
      method: "DELETE",
      url: `/api/mcp-connections/${connection.connection.id}`
    });
    assert.equal(deleteRevokedResponse.statusCode, 200);

    const activeConnection = services.mcp.createConnection(space.id, "Delete Active Agent", "generic");
    const deleteActiveResponse = await app.inject({
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
  process.env.GH_TOKEN = "test-token";
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
  process.env.GH_TOKEN = "test-token";
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

test("GitHub sync includes visible organization repositories and reports protected orgs", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "github-org-sync-"));
  process.env.GH_TOKEN = "test-token";
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    await withGitHubFetch(
      {
        "https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=full_name": [],
        "https://api.github.com/user/orgs?per_page=100": [{ login: "VisibleOrg" }, { login: "LockedOrg" }],
        "https://api.github.com/orgs/VisibleOrg/repos?per_page=100&type=all&sort=full_name": [
          githubRepositoryPayload(8101, "VisibleOrg", "catalog-app", { private: true }),
          githubRepositoryPayload(8102, "VisibleOrg", "catalog-api", { archived: true })
        ],
        "https://api.github.com/orgs/LockedOrg/repos?per_page=100&type=all&sort=full_name": githubErrorResponse(
          403,
          "Resource protected by organization SAML enforcement.\nTo access this repository, visit https://github.com/enterprises/example-enterprise/sso?authorization_request=test and try your request again."
        )
      },
      async () => {
        const result = await services.github.syncRepositories();
        assert.equal(result.count, 2);
        assert.equal(result.warnings.length, 1);
        assert.match(result.warnings[0]!, /LockedOrg/);
        assert.match(result.warnings[0]!, /Authorize this PAT for SAML SSO/);
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
  process.env.GH_TOKEN = "test-token";
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    await withGitHubFetch(
      {
        "https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=full_name": [],
        "https://api.github.com/user/orgs?per_page=100": []
      },
      async () => {
        const result = await services.github.syncRepositories();
        assert.equal(result.count, 0);
        assert.equal(result.warnings.length, 1);
        assert.match(result.warnings[0]!, /exposes no repositories or organizations/);
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
  process.env.GH_TOKEN = "test-token";
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
          githubRepositoryPayload(8201, "diagnostic-user", "personal-repo")
        ],
        "https://api.github.com/user/orgs?per_page=100": [{ login: "VisibleOrg" }, { login: "LockedOrg" }],
        "https://api.github.com/orgs/VisibleOrg/repos?per_page=100&type=all&sort=full_name": [
          githubRepositoryPayload(8202, "VisibleOrg", "catalog-app")
        ],
        "https://api.github.com/orgs/LockedOrg/repos?per_page=100&type=all&sort=full_name": githubErrorResponse(
          403,
          "Resource protected by organization SAML enforcement.\nTo access this repository, visit https://github.com/enterprises/example-enterprise/sso?authorization_request=test and try your request again."
        )
      },
      async () => {
        const response = await app.inject({ method: "GET", url: "/api/github/diagnostics" });
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
        assert.equal(payload.userRepositoryCount, 1);
        assert.equal(payload.visibleOrganizationCount, 1);
        assert.deepEqual(
          payload.organizations.map((organization) => ({
            login: organization.login,
            status: organization.status,
            repositoryCount: organization.repositoryCount
          })),
          [
            { login: "VisibleOrg", status: "visible", repositoryCount: 1 },
            { login: "LockedOrg", status: "inaccessible", repositoryCount: null }
          ]
        );
        assert.match(payload.warnings[0]!, /LockedOrg/);
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
  process.env.GH_TOKEN = "test-token";
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";
  process.env.MEMOREPO_API_CONTAINER_NAME = "memorepo-api";

  const services = createServices();
  (services.cbm as unknown as { version: () => Promise<string> }).version = async () => "codebase-memory-mcp test";
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
        const response = await app.inject({ method: "GET", url: "/api/preflight" });
        assert.equal(response.statusCode, 200);
        assert.doesNotMatch(response.body, /test-token/);

        const payload = response.json<{
          status: string;
          checks: Array<{ id: string; status: string; message: string }>;
          mcpContainerName: string;
        }>();
        const checkIds = payload.checks.map((check) => check.id);

        assert.equal(payload.mcpContainerName, "memorepo-api");
        assert.ok(["ready", "warning"].includes(payload.status));
        assert.ok(checkIds.includes("github-token"));
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

test("job controls cancel pending jobs, retry terminal jobs, and reject running cancellation", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "job-controls-"));
  process.env.GH_TOKEN = "test-token";
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

    const cancelResponse = await app.inject({ method: "POST", url: `/api/jobs/${parentId}/cancel` });
    assert.equal(cancelResponse.statusCode, 200);
    assert.equal((services.jobs.getJob(parentId) as { status: string }).status, "cancelled");
    const child = services.jobs.getJob(childId) as { status: string; error: string };
    assert.equal(child.status, "skipped");
    assert.match(child.error, /Dependency did not succeed/);

    const retryResponse = await app.inject({ method: "POST", url: `/api/jobs/${parentId}/retry` });
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
    const runningCancel = await app.inject({ method: "POST", url: `/api/jobs/${runningId}/cancel` });
    assert.equal(runningCancel.statusCode, 400);
    assert.match(runningCancel.json<{ error: string }>().error, /Running jobs cannot be cancelled/);
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
  process.env.GH_TOKEN = "test-token";
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
  process.env.GH_TOKEN = "test-token";
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
  process.env.GH_TOKEN = "test-token";
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
            assert.match(message, /Authorize this PAT for SAML SSO/);
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
  process.env.GH_TOKEN = "test-token";
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
  process.env.GH_TOKEN = "test-token";
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
    assert.equal(snapshots[0]!.activated_at, null);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("failed replacement snapshot keeps the previous active snapshot", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-replacement-failure-"));
  process.env.GH_TOKEN = "test-token";
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

test("space snapshots can be listed and pruned by retention", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "snapshot-prune-"));
  process.env.GH_TOKEN = "test-token";
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

    const snapshotRows = services.database.sqlite
      .prepare("SELECT id, artifact_path AS artifactPath FROM space_snapshots WHERE space_id = ? ORDER BY version ASC")
      .all(space.id) as Array<{ id: string; artifactPath: string }>;
    for (const row of snapshotRows) {
      fs.writeFileSync(path.join(row.artifactPath, "marker.txt"), row.id);
    }

    const listResponse = await app.inject({ method: "GET", url: `/api/spaces/${space.id}/snapshots` });
    assert.equal(listResponse.statusCode, 200);
    const listPayload = listResponse.json<{ snapshots: Array<{ active: boolean; sizeBytes: number }>; defaultRetention: number }>();
    assert.equal(listPayload.snapshots.length, 3);
    assert.equal(listPayload.defaultRetention, 2);
    assert.equal(listPayload.snapshots.filter((snapshot) => snapshot.active).length, 1);
    assert.ok(listPayload.snapshots.every((snapshot) => snapshot.sizeBytes > 0));

    const pruneResponse = await app.inject({
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
  process.env.GH_TOKEN = "test-token";
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
    insertRecord(services.database, "space_snapshots", {
      id: snapshotId,
      spaceId: space.id,
      version: 1,
      status: "active",
      artifactPath: snapshotPath,
      manifestJson: JSON.stringify({ snapshotId, version: 1, createdAt: timestamp, repositories: [] }),
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
    services.mcp.createConnection(space.id, "Delete Agent", "generic");

    const result = await services.spaces.deleteSpaceWithManagedData(space.id);
    assert.equal(result.repositoriesDeleted, 1);
    assert.equal(result.snapshotsDeleted, 1);
    assert.equal(result.jobsDeleted, 1);
    assert.equal(fs.existsSync(spaceRepository.localPath), false);
    assert.equal(fs.existsSync(repoIndexPath), false);
    assert.equal(fs.existsSync(snapshotPath), false);
    assert.throws(() => services.spaces.getSpaceById(space.id), /Space not found/);
    assert.equal((services.database.sqlite.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count, 0);
    assert.equal((services.database.sqlite.prepare("SELECT COUNT(*) AS count FROM mcp_connections").get() as { count: number }).count, 0);
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("garbage collection removes failed snapshots, old jobs, stale indexes, and removed clone files", () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "maintenance-gc-"));
  process.env.GH_TOKEN = "test-token";
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

    const summary = services.maintenance.summary(1);
    assert.equal(summary.candidates.failedSnapshots, 1);
    assert.equal(summary.candidates.removedClones, 1);
    assert.equal(summary.candidates.oldJobs, 1);
    assert.equal(summary.candidates.orphanRepoIndexDirectories, 1);

    const result = services.maintenance.runGarbageCollection(1);
    assert.equal(result.failedSnapshots.count, 1);
    assert.equal(result.removedClones.count, 1);
    assert.equal(result.oldJobs.count, 1);
    assert.equal(result.orphanRepoIndexDirectories.count, 1);
    assert.equal(fs.existsSync(removedRepository.local_path), false);
    assert.equal(fs.existsSync(removedIndexPath), false);
    assert.equal(fs.existsSync(orphanIndexPath), false);
    assert.equal(fs.existsSync(failedSnapshotPath), false);

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

test("MCP graph tools route multi-repo spaces through the CBM snapshot store", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "mcp-multi-repo-scope-"));
  process.env.GH_TOKEN = "test-token";
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
        return { rows: [{ project: input.project, query: input.query, maxRows: input.max_rows }] };
      }
      return { results: [{ name: "target", project: input.project ?? "cross-repo", qualified_name: `${input.project ?? "cross"}.target` }] };
    };

    try {
      toolCalls.length = 0;
      await services.mcp.callTool(space.slug, connection.token, "search_graph", {
        query: "target",
        limit: 10
      });
      assert.equal(toolCalls.length, 1);
      assert.equal(toolCalls[0]!.tool, "search_graph");
      assert.equal(toolCalls[0]!.input.project, undefined);
      assert.equal(toolCalls[0]!.input.limit, 10);

      toolCalls.length = 0;
      await services.mcp.callTool(space.slug, connection.token, "search_graph", {
        query: "target",
        limit: 10
      });
      assert.equal(toolCalls.length, 0);

      toolCalls.length = 0;
      await services.mcp.callTool(space.slug, connection.token, "search_graph", {
        query: "target",
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
      assert.equal(toolCalls.length, 1);
      assert.equal(toolCalls[0]!.tool, "query_graph");
      assert.equal(toolCalls[0]!.input.project, undefined);
      assert.equal(toolCalls[0]!.input.max_rows, 10);
      assert.equal(toolCalls[0]!.input.query, "MATCH (n) RETURN n LIMIT 10");
      assert.equal((graph as { snapshot: { version: number; stale?: boolean } }).snapshot.version, 1);
      assert.equal((graph as { snapshot: { stale?: boolean } }).snapshot.stale, undefined);
      assert.equal((graph as { limits?: unknown }).limits, undefined);
      assert.equal((graph as { space?: unknown }).space, undefined);

      toolCalls.length = 0;
      await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        query: "MATCH (n) RETURN n"
      });
      assert.equal(toolCalls.length, 1);
      assert.equal(toolCalls[0]!.input.max_rows, 25);
      assert.equal(toolCalls[0]!.input.query, "MATCH (n) RETURN n LIMIT 25");

      toolCalls.length = 0;
      await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        query: "MATCH (n) RETURN n",
        project: betaProject,
        max_rows: 5
      });
      assert.equal(toolCalls.length, 1);
      assert.equal(toolCalls[0]!.input.project, betaProject);
      assert.equal(toolCalls[0]!.input.query, "MATCH (n) RETURN n LIMIT 5");

      toolCalls.length = 0;
      await services.mcp.callTool(space.slug, connection.token, "query_graph", {
        query: "MATCH (n) WHERE n.name = 'DELETE ME' RETURN n",
        max_rows: 5
      });
      assert.equal(toolCalls.length, 1);
      assert.equal(toolCalls[0]!.input.query, "MATCH (n) WHERE n.name = 'DELETE ME' RETURN n LIMIT 5");

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "query_graph", { query: "MATCH (n) DELETE n", max_rows: 5 }),
        /read-only Cypher/
      );

      await assert.rejects(
        () => services.mcp.callTool(space.slug, connection.token, "detect_changes", { repo_path: testRoot }),
        /cannot receive filesystem path arguments/
      );

      for (const legacyTool of ["get_space_architecture", "search_symbols", "trace_symbol", "get_snippet"]) {
        await assert.rejects(() => services.mcp.callTool(space.slug, connection.token, legacyTool, {}), /Unknown MCP tool/);
      }

      (services.cbm as unknown as { tool: typeof services.cbm.tool }).tool = async () => ({
        results: Array.from({ length: 400 }, (_, index) => ({ name: `node-${index}`, detail: "y".repeat(200) }))
      });
      const truncatedResponse = (await services.mcp.callTool(space.slug, connection.token, "query_graph", {
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

test("empty spaces can be deleted with local MCP connections", () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "delete-space-"));
  process.env.GH_TOKEN = "test-token";
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();

  try {
    const emptySpace = services.spaces.createSpace("Delete Me");
    services.mcp.createConnection(emptySpace.id, "Local agent", "generic");
    assert.equal(fs.existsSync(emptySpace.rootPath), true);

    const deleted = services.spaces.deleteSpace(emptySpace.id);
    assert.equal(deleted.connectionsDeleted, 1);
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
  } finally {
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("space API responses do not expose managed filesystem paths", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "public-space-contract-"));
  process.env.GH_TOKEN = "test-token";
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

    const spacesResponse = await app.inject({ method: "GET", url: "/api/spaces" });
    assert.equal(spacesResponse.statusCode, 200);
    assertNoInternalPathLeak(spacesResponse.body, testRoot);

    const detailResponse = await app.inject({ method: "GET", url: `/api/spaces/${space.id}` });
    assert.equal(detailResponse.statusCode, 200);
    assertNoInternalPathLeak(detailResponse.body, testRoot);
  } finally {
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("route errors return actionable messages", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "route-errors-"));
  process.env.GH_TOKEN = "test-token";
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

    const response = await app.inject({ method: "DELETE", url: `/api/spaces/${space.id}` });
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
  process.env.GH_TOKEN = "test-token";
  process.env.MEMOREPO_HOME = path.join(testRoot, "memorepo-home");
  process.env.API_PORT = "8787";

  const services = createServices();
  const app = await createApp(services);

  try {
    const missingSpace = await app.inject({ method: "GET", url: "/api/spaces/spc_missing" });
    assert.equal(missingSpace.statusCode, 404);
    assert.match(missingSpace.json<{ error: string }>().error, /Space not found/);

    const missingJob = await app.inject({ method: "GET", url: "/api/jobs/job_missing" });
    assert.equal(missingJob.statusCode, 404);
    assert.match(missingJob.json<{ error: string }>().error, /Job not found/);

    const missingJobRetry = await app.inject({ method: "POST", url: "/api/jobs/job_missing/retry" });
    assert.equal(missingJobRetry.statusCode, 404);

    const missingJobEvents = await app.inject({ method: "GET", url: "/api/jobs/job_missing/events" });
    assert.equal(missingJobEvents.statusCode, 404);

    const missingConnection = await app.inject({ method: "DELETE", url: "/api/mcp-connections/mcp_missing" });
    assert.equal(missingConnection.statusCode, 404);
    assert.match(missingConnection.json<{ error: string }>().error, /MCP connection not found/);

    const invalidBody = await app.inject({ method: "POST", url: "/api/spaces", payload: {} });
    assert.equal(invalidBody.statusCode, 400);
    const invalidMessage = invalidBody.json<{ error: string }>().error;
    assert.match(invalidMessage, /Invalid request: name/);
    assert.doesNotMatch(invalidMessage, /[[{]/);
  } finally {
    await app.close();
    services.database.sqlite.close();
    cleanupTestRoot(testRoot);
  }
});

test("job event stream replays events over SSE with CORS headers for the dashboard origin", async () => {
  fs.mkdirSync(testsRoot, { recursive: true });
  const testRoot = fs.mkdtempSync(path.join(testsRoot, "job-events-sse-"));
  process.env.GH_TOKEN = "test-token";
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
      headers: { origin, accept: "text/event-stream" },
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
  process.env.GH_TOKEN = "test-token";
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
        const response = await app.inject({ method: "GET", url: "/api/github/status" });
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
  options: { private?: boolean; archived?: boolean; fork?: boolean } = {}
) {
  return {
    id,
    owner: { login: owner },
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
  fs.mkdirSync(path.join(spaceRepository.localPath, ".git"), { recursive: true });
  updateRecord(
    services.database,
    "space_repositories",
    {
      cloneStatus: "cloned",
      indexStatus: "indexed",
      selectedBranch: "main",
      selectedCommit: `${options.name}-commit`,
      remoteRef: "refs/remotes/origin/main",
      snapshotIncluded: false,
      lastError: null
    },
    "id",
    spaceRepository.id
  );
  return services.spaces.getSpaceRepository(spaceRepository.id);
}

function stubCbmSnapshots(services: ReturnType<typeof createServices>, failingRepositoryPath?: string): void {
  const cbm = services.cbm as unknown as {
    indexRepository: (
      repoPath: string,
      cacheDir: string,
      mode?: "fast" | "moderate" | "full",
      onOutput?: (line: string) => void
    ) => Promise<{ project?: string; status?: string; nodes?: number; edges?: number }>;
    buildCrossRepoLinks: (
      repoPath: string,
      cacheDir: string,
      onOutput?: (line: string) => void
    ) => Promise<{ status: string }>;
  };

  cbm.indexRepository = async (repoPath) => {
    if (repoPath === failingRepositoryPath) {
      throw new Error(`index failed for ${path.basename(repoPath)}`);
    }
    return { project: path.basename(repoPath), status: "indexed", nodes: 1, edges: 0 };
  };
  cbm.buildCrossRepoLinks = async () => ({ status: "linked" });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      ""
    ].join("\n")
  );
}

function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
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
