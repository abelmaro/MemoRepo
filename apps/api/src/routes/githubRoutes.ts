import type { FastifyInstance } from "fastify";
import { z } from "zod";

export async function githubRoutes(app: FastifyInstance) {
  app.get("/api/github/auth/status", async () => {
    return app.services.githubOAuth.connectionStatus();
  });

  app.post("/api/github/auth/device", async () => {
    const result = await app.services.githubOAuth.startDeviceAuthorization();
    app.services.dashboardEvents.publish({ type: "system" }, { type: "preflight" });
    return result;
  });

  app.get("/api/github/auth/device/:attemptId", async (request) => {
    const params = z.object({ attemptId: z.string().min(8).max(128) }).parse(request.params);
    const result = await app.services.githubOAuth.getDeviceAuthorizationStatus(params.attemptId);
    if (result.status !== "pending") {
      app.services.dashboardEvents.publish({ type: "system" }, { type: "preflight" });
    }
    return result;
  });

  app.delete("/api/github/auth/device/:attemptId", async (request, reply) => {
    const params = z.object({ attemptId: z.string().min(8).max(128) }).parse(request.params);
    app.services.githubOAuth.cancelDeviceAuthorization(params.attemptId);
    app.services.dashboardEvents.publish({ type: "system" }, { type: "preflight" });
    return reply.code(204).send();
  });

  app.delete("/api/github/auth", async (_request, reply) => {
    app.services.githubOAuth.disconnect();
    app.services.dashboardEvents.publish({ type: "system" }, { type: "preflight" });
    return reply.code(204).send();
  });

  app.get("/api/github/status", async () => {
    return app.services.github
      .getViewer()
      .then((viewer) => ({ connected: true, viewer }))
      .catch((error: unknown) => ({ connected: false, error: error instanceof Error ? error.message : String(error) }));
  });

  app.get("/api/github/diagnostics", async () => {
    return app.services.github
      .diagnoseAccess()
      .catch((error: unknown) => ({ connected: false, error: error instanceof Error ? error.message : String(error) }));
  });

  app.post("/api/github/sync", async () => {
    const job = app.services.operations.enqueueGitHubSync();
    return { job };
  });

  app.get("/api/github/repositories", async (request) => {
    const query = z.object({
      query: z.string().optional(),
      kind: z.enum(["all", "forks", "archived", "private"]).default("all")
    }).parse(request.query ?? {});

    return { repositories: app.services.spaces.listGitHubRepositories(query.query, query.kind) };
  });

  app.post("/api/github/repositories/resolve", async (request) => {
    const body = z.object({ locator: z.string().min(1) }).parse(request.body);
    return app.services.github.resolveRepository(body.locator);
  });
}
