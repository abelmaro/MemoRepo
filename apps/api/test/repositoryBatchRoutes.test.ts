import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { spaceRoutes } from "../src/routes/spaceRoutes.js";

test("repository batch routes preserve the request ID and expose grouped actions", async () => {
  const calls: Array<{ name: string; values: unknown[] }> = [];
  const batch = { id: "bat_test", spaceId: "spc_test", status: "running" };
  const operations = {
    enqueueAddRepositories: (spaceId: string, repositoryIds: string[], requestId?: string) => {
      calls.push({ name: "enqueue", values: [spaceId, repositoryIds, requestId] });
      return { batch, jobs: [], spaceRepositories: [], snapshotJob: null };
    },
    getRepositoryBatch: (batchId: string) => {
      calls.push({ name: "get", values: [batchId] });
      return batch;
    },
    cancelRepositoryBatch: (batchId: string) => {
      calls.push({ name: "cancel", values: [batchId] });
      return { ...batch, status: "cancelled" };
    },
    retryRepositoryBatch: (batchId: string) => {
      calls.push({ name: "retry", values: [batchId] });
      return { batch: { ...batch, status: "running" }, jobs: [], spaceRepositories: [], snapshotJob: null };
    }
  };
  const dashboardEvents = { publish: (...values: unknown[]) => calls.push({ name: "publish", values }) };
  const app = Fastify({ logger: false });
  app.decorate("services", { config: { batchRepositoryOperations: true }, operations, dashboardEvents } as never);
  await app.register(spaceRoutes);

  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/spaces/spc_test/repositories/batch",
      payload: { repositoryIds: ["repo_b", "repo_a"], requestId: "request-123" }
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.deepEqual(calls[0], { name: "enqueue", values: ["spc_test", ["repo_b", "repo_a"], "request-123"] });

    assert.equal((await app.inject({ method: "GET", url: "/api/repository-batches/bat_test" })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/repository-batches/bat_test/cancel" })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/repository-batches/bat_test/retry" })).statusCode, 200);
    assert.ok(calls.some((call) => call.name === "get"));
    assert.ok(calls.some((call) => call.name === "cancel"));
    assert.ok(calls.some((call) => call.name === "retry"));
  } finally {
    await app.close();
  }
});

test("repository batch endpoint can be disabled independently", async () => {
  const app = Fastify({ logger: false });
  app.decorate("services", { config: { batchRepositoryOperations: false } } as never);
  await app.register(spaceRoutes);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/spaces/spc_test/repositories/batch",
      payload: { repositoryIds: ["repo_a"], requestId: "request-123" }
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
  }
});
