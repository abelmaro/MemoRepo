import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import {
  controlTokenStartupMessage,
  loadHttpSecurityConfig,
  registerControlAccessBoundary,
  registerRateLimiting,
  type HttpSecurityConfig
} from "../src/httpSecurity.js";

const CONTROL_TOKEN = "http-security-test-token-0123456789abcdef0123456789abcdef";

test("HTTP security configuration requires a strong control token", () => {
  assert.throws(() => loadHttpSecurityConfig({}), /MEMOREPO_CONTROL_TOKEN/);
  assert.throws(() => loadHttpSecurityConfig({ MEMOREPO_CONTROL_TOKEN: "too-short" }), /URL-safe characters/);
  assert.throws(
    () => loadHttpSecurityConfig({ MEMOREPO_CONTROL_TOKEN: `invalid token ${"x".repeat(40)}` }),
    /URL-safe characters/
  );
  assert.throws(
    () => loadHttpSecurityConfig({ MEMOREPO_CONTROL_TOKEN: `unicode-é-${"x".repeat(40)}` }),
    /URL-safe characters/
  );

  const config = loadHttpSecurityConfig({ MEMOREPO_CONTROL_TOKEN: CONTROL_TOKEN });
  assert.equal(config.controlToken, CONTROL_TOKEN);
  assert.equal(config.apiReadRateLimitMax, 300);
  assert.equal(config.apiWriteRateLimitMax, 30);
});

test("HTTP security configuration generates, reuses, and rotates a control token when none is configured", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memorepo-control-token-"));
  const tokenPath = path.join(root, "secrets", "control-token");
  const origin = "http://127.0.0.1:5173";
  try {
    const created = loadHttpSecurityConfig({}, tokenPath);
    assert.match(created.controlToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(created.controlTokenSource, "created");
    assert.equal(await readFile(tokenPath, "utf8"), created.controlToken);
    assert.equal(controlTokenStartupMessage(created, origin, tokenPath), `Unlock the MemoRepo dashboard: ${origin}/#token=${created.controlToken}`);
    if (process.platform !== "win32") {
      assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    }

    const stored = loadHttpSecurityConfig({ MEMOREPO_CONTROL_TOKEN: "" }, tokenPath);
    assert.equal(stored.controlToken, created.controlToken);
    assert.equal(stored.controlTokenSource, "stored");
    const storedMessage = controlTokenStartupMessage(stored, origin, tokenPath);
    assert.ok(storedMessage?.includes(tokenPath));
    assert.ok(!storedMessage?.includes(created.controlToken));

    const configured = loadHttpSecurityConfig({ MEMOREPO_CONTROL_TOKEN: CONTROL_TOKEN }, tokenPath);
    assert.equal(configured.controlToken, CONTROL_TOKEN);
    assert.equal(configured.controlTokenSource, "environment");
    assert.equal(controlTokenStartupMessage(configured, origin, tokenPath), null);
    assert.throws(() => loadHttpSecurityConfig({ MEMOREPO_CONTROL_TOKEN: "too-short" }, tokenPath), /URL-safe characters/);

    await rm(tokenPath);
    const rotated = loadHttpSecurityConfig({}, tokenPath);
    assert.equal(rotated.controlTokenSource, "created");
    assert.notEqual(rotated.controlToken, created.controlToken);

    await writeFile(tokenPath, "corrupted");
    assert.throws(() => loadHttpSecurityConfig({}, tokenPath), /delete the file and restart/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("control API requires bearer authentication and CSRF without changing MCP authentication", async () => {
  const app = Fastify({ logger: false });
  const config = securityConfig();
  let mutations = 0;

  await registerRateLimiting(app, config);
  registerControlAccessBoundary(app, config);
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/auth/status", async (_request, reply) => reply.code(204).send());
  app.get("/api/secret", async () => ({ secret: true }));
  app.post("/api/mutate", async () => ({ mutations: ++mutations }));
  app.post("/mcp/example", async () => ({ transport: "mcp" }));

  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/health", payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/status" })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/auth/status", headers: controlHeaders() })).statusCode,
      204
    );
    assert.equal((await app.inject({ method: "GET", url: "/%61pi/secret" })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: "GET", url: "/%61pi/secret", headers: controlHeaders() })).statusCode,
      200
    );

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/%61pi/mutate",
      headers: controlHeaders(),
      payload: {}
    });
    assert.equal(missingCsrf.statusCode, 403);
    assert.equal(mutations, 0);

    const allowedMutation = await app.inject({
      method: "POST",
      url: "/%61pi/mutate",
      headers: controlHeaders(true),
      payload: {}
    });
    assert.equal(allowedMutation.statusCode, 200);
    assert.equal(mutations, 1);

    const mcp = await app.inject({ method: "POST", url: "/mcp/example", payload: {} });
    assert.equal(mcp.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("rate limiting isolates request classes and ignores spoofed forwarding headers", async () => {
  const app = Fastify({ logger: false });
  const config = securityConfig({
    authRateLimitMax: 2,
    apiReadRateLimitMax: 2,
    apiWriteRateLimitMax: 1,
    apiSseRateLimitMax: 1,
    mcpRateLimitMax: 1
  });

  await registerRateLimiting(app, config);
  registerControlAccessBoundary(app, config);
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/auth/status", async (_request, reply) => reply.code(204).send());
  app.get("/api/known", async () => ({ ok: true }));
  app.post("/api/mutate", async () => ({ ok: true }));
  app.get("/api/agent/turns/turn_1/events", async () => ({ ok: true }));
  app.get("/api/dashboard/events", async () => ({ ok: true }));
  app.post("/mcp/example", async () => ({ ok: true }));
  app.options("/api/mutate", async (_request, reply) => reply.code(204).send());

  try {
    for (const [index, forwardedFor] of ["203.0.113.10", "203.0.113.11"].entries()) {
      const response = await app.inject({
        method: "GET",
        url: index === 0 ? "/api/known" : "/%61pi/known",
        headers: { "x-forwarded-for": forwardedFor, ...(index === 1 ? { authorization: "Bearer wrong-token" } : {}) }
      });
      assert.equal(response.statusCode, 401);
    }
    const limitedAuth = await app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { "x-forwarded-for": "203.0.113.12" }
    });
    assert.equal(limitedAuth.statusCode, 429);
    assert.ok(limitedAuth.headers["retry-after"]);

    const validAfterFailedAttempts = await app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: controlHeaders()
    });
    assert.equal(validAfterFailedAttempts.statusCode, 204);

    const mutation = await app.inject({
      method: "POST",
      url: "/api/mutate",
      headers: controlHeaders(true),
      payload: {}
    });
    assert.equal(mutation.statusCode, 200);
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/mutate", headers: controlHeaders(true), payload: {} })).statusCode,
      429
    );

    assert.equal(
      (await app.inject({ method: "GET", url: "/api/agent/turns/turn_1/events", headers: controlHeaders() })).statusCode,
      200
    );
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/agent/turns/turn_1/events", headers: controlHeaders() })).statusCode,
      429
    );

    assert.equal((await app.inject({ method: "POST", url: "/m%63p/example", payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/mcp/example", payload: {} })).statusCode, 429);

    for (let index = 0; index < 3; index += 1) {
      assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
      assert.equal((await app.inject({ method: "OPTIONS", url: "/api/mutate" })).statusCode, 204);
    }

    assert.equal(
      (await app.inject({ method: "GET", url: "/api/unknown", headers: controlHeaders() })).statusCode,
      404
    );
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/unknown", headers: controlHeaders() })).statusCode,
      429
    );
  } finally {
    await app.close();
  }
});

function securityConfig(overrides: Partial<HttpSecurityConfig> = {}): HttpSecurityConfig {
  return {
    controlToken: CONTROL_TOKEN,
    controlTokenSource: "environment",
    rateLimitWindowMs: 60_000,
    authRateLimitMax: 10,
    apiReadRateLimitMax: 300,
    apiWriteRateLimitMax: 30,
    apiSseRateLimitMax: 30,
    mcpRateLimitMax: 120,
    ...overrides
  };
}

function controlHeaders(csrf = false): Record<string, string> {
  return {
    authorization: `Bearer ${CONTROL_TOKEN}`,
    ...(csrf ? { "x-memorepo-csrf": "1" } : {})
  };
}
