import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { dashboardRoutes } from "../src/routes/dashboardRoutes.js";
import { DashboardEventBus } from "../src/services/dashboardEventBus.js";
import { registerControlAccessBoundary } from "../src/httpSecurity.js";

const CONTROL_TOKEN = "dashboard-events-test-token-0123456789abcdef0123456789abcdef";

test("dashboard invalidations coalesce duplicate resources without carrying state", async () => {
  const bus = new DashboardEventBus(5);
  const received = new Promise<unknown>((resolve) => bus.subscribe(resolve));
  bus.publish(
    { type: "jobs" },
    { type: "job", jobId: "job_1" },
    { type: "job", jobId: "job_1" },
    { type: "space", spaceId: "space_1" }
  );

  const event = await received as {
    type: string;
    eventId: string;
    occurredAt: string;
    resources: Array<Record<string, string>>;
  };
  assert.equal(event.type, "invalidate");
  assert.match(event.eventId, /^[0-9a-f-]+:1$/);
  assert.ok(Number.isFinite(Date.parse(event.occurredAt)));
  assert.deepEqual(event.resources, [
    { type: "jobs" },
    { type: "job", jobId: "job_1" },
    { type: "space", spaceId: "space_1" }
  ]);
  assert.equal(JSON.stringify(event).includes("payload"), false);
  bus.close();
});

test("dashboard subscriptions can be removed and close drops pending events", async () => {
  const bus = new DashboardEventBus(5);
  let calls = 0;
  const unsubscribe = bus.subscribe(() => calls += 1);
  assert.equal(bus.subscriberCount(), 1);
  unsubscribe();
  assert.equal(bus.subscriberCount(), 0);
  bus.publish({ type: "system" });
  bus.close();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, 0);
});

test("dashboard stream is authenticated, sends ready and invalidations, and cleans up", async () => {
  const app = Fastify({ logger: false });
  const bus = new DashboardEventBus(5);
  app.decorate("services", {
    config: { frontendOrigin: "http://localhost:5173" },
    dashboardEvents: bus
  } as never);
  registerControlAccessBoundary(app, {
    controlToken: CONTROL_TOKEN,
    rateLimitWindowMs: 60_000,
    authRateLimitMax: 10,
    apiReadRateLimitMax: 300,
    apiWriteRateLimitMax: 30,
    apiSseRateLimitMax: 30,
    mcpRateLimitMax: 120
  });
  await app.register(dashboardRoutes);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/api/dashboard/events`;

  try {
    assert.equal((await fetch(endpoint)).status, 401);
    const controller = new AbortController();
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${CONTROL_TOKEN}` },
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(bus.subscriberCount(), 1);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const ready = decoder.decode((await reader.read()).value);
    assert.match(ready, /"type":"ready"/);
    assert.match(ready, /"eventId":"[^"]+"/);

    bus.publish({ type: "job", jobId: "job_public_id" });
    const invalidation = decoder.decode((await reader.read()).value);
    assert.match(invalidation, /"type":"invalidate"/);
    assert.match(invalidation, /"jobId":"job_public_id"/);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(bus.subscriberCount(), 0);
  } finally {
    bus.close();
    await app.close();
  }
});
