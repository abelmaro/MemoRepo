import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { CONTENT_SECURITY_POLICY, registerDefensiveResponseHeaders } from "../src/httpResponseHeaders.js";

test("API responses include defensive no-store headers", async () => {
  const app = Fastify({ logger: false });
  registerDefensiveResponseHeaders(app);
  app.get("/token-bearing-response", async () => ({ token: "sensitive" }));

  try {
    const response = await app.inject({ method: "GET", url: "/token-bearing-response" });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["content-security-policy"], CONTENT_SECURITY_POLICY);
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["x-frame-options"], "DENY");
  } finally {
    await app.close();
  }
});
