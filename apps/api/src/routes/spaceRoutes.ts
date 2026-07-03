import type { FastifyInstance } from "fastify";
import { z } from "zod";

const paramsWithSpaceId = z.object({ spaceId: z.string().min(1) });
const paramsWithSpaceRepositoryId = z.object({ spaceRepositoryId: z.string().min(1) });
const paramsWithConnectionId = z.object({ connectionId: z.string().min(1) });

export async function spaceRoutes(app: FastifyInstance) {
  app.get("/api/spaces", async () => ({ spaces: app.services.spaces.listSpaces().map(toPublicSpace) }));

  app.post("/api/spaces", async (request) => {
    const body = z.object({ name: z.string().min(1) }).parse(request.body);
    return { space: app.services.spaces.createSpace(body.name) };
  });

  app.get("/api/spaces/:spaceId", async (request) => {
    const { spaceId } = paramsWithSpaceId.parse(request.params);
    const reconciliation = app.services.spaces.reconcileSpaceFilesystem(spaceId);
    return {
      space: toPublicSpace(app.services.spaces.getSpaceById(spaceId)),
      repositories: app.services.spaces.listSpaceRepositories(spaceId).map(toPublicSpaceRepository),
      removedRepositories: app.services.spaces.listRemovedSpaceRepositories(spaceId).map(toPublicSpaceRepository),
      reconciliation,
      connections: app.services.mcp.listConnections(spaceId)
    };
  });

  app.patch("/api/spaces/:spaceId", async (request) => {
    const { spaceId } = paramsWithSpaceId.parse(request.params);
    const body = z.object({ name: z.string().min(1) }).parse(request.body);
    return { space: app.services.spaces.renameSpace(spaceId, body.name) };
  });

  app.delete("/api/spaces/:spaceId", async (request) => {
    const { spaceId } = paramsWithSpaceId.parse(request.params);
    return app.services.spaces.deleteSpace(spaceId);
  });

  app.delete("/api/spaces/:spaceId/managed-data", async (request) => {
    const { spaceId } = paramsWithSpaceId.parse(request.params);
    return app.services.spaces.deleteSpaceWithManagedData(spaceId);
  });

  app.get("/api/spaces/:spaceId/snapshots", async (request) => {
    const { spaceId } = paramsWithSpaceId.parse(request.params);
    return app.services.snapshots.listSpaceSnapshots(spaceId);
  });

  app.post("/api/spaces/:spaceId/snapshots/prune", async (request) => {
    const { spaceId } = paramsWithSpaceId.parse(request.params);
    const body = z.object({ keepLatest: z.number().int().min(1).max(100).optional() }).parse(request.body ?? {});
    return app.services.snapshots.pruneSpaceSnapshots(spaceId, body.keepLatest);
  });

  app.get("/api/spaces/:spaceId/repositories", async (request) => {
    const { spaceId } = paramsWithSpaceId.parse(request.params);
    return { repositories: app.services.spaces.listSpaceRepositories(spaceId).map(toPublicSpaceRepository) };
  });

  app.post("/api/spaces/:spaceId/repositories", async (request) => {
    const { spaceId } = paramsWithSpaceId.parse(request.params);
    const body = z.object({
      repositoryId: z.string().optional(),
      locator: z.string().optional()
    }).refine((value) => value.repositoryId || value.locator, "repositoryId or locator is required").parse(request.body);

    const repositoryId = body.repositoryId ?? (await app.services.github.resolveRepository(body.locator!)).repositoryId;
    return app.services.operations.enqueueAddRepository(spaceId, repositoryId);
  });

  app.post("/api/spaces/:spaceId/reindex", async (request) => {
    const { spaceId } = paramsWithSpaceId.parse(request.params);
    return { job: app.services.operations.enqueueReindexSpace(spaceId) };
  });

  app.post("/api/spaces/:spaceId/reconcile", async (request) => {
    const { spaceId } = paramsWithSpaceId.parse(request.params);
    return { reconciliation: app.services.spaces.reconcileSpaceFilesystem(spaceId) };
  });

  app.delete("/api/space-repositories/:spaceRepositoryId", async (request) => {
    const { spaceRepositoryId } = paramsWithSpaceRepositoryId.parse(request.params);
    return app.services.spaces.softRemoveSpaceRepository(spaceRepositoryId);
  });

  app.delete("/api/space-repositories/:spaceRepositoryId/files", async (request) => {
    const { spaceRepositoryId } = paramsWithSpaceRepositoryId.parse(request.params);
    return app.services.spaces.cleanupSpaceRepositoryFiles(spaceRepositoryId);
  });

  app.post("/api/space-repositories/:spaceRepositoryId/checkout", async (request) => {
    const { spaceRepositoryId } = paramsWithSpaceRepositoryId.parse(request.params);
    const body = z.object({ branch: z.string().min(1) }).parse(request.body);
    return { jobs: app.services.operations.enqueueCheckout(spaceRepositoryId, body.branch) };
  });

  app.post("/api/space-repositories/:spaceRepositoryId/reindex", async (request) => {
    const { spaceRepositoryId } = paramsWithSpaceRepositoryId.parse(request.params);
    return { jobs: app.services.operations.enqueueReindexRepository(spaceRepositoryId) };
  });

  app.post("/api/space-repositories/:spaceRepositoryId/refresh-branches", async (request) => {
    const { spaceRepositoryId } = paramsWithSpaceRepositoryId.parse(request.params);
    return { job: app.services.operations.enqueueRefreshBranches(spaceRepositoryId) };
  });

  app.get("/api/spaces/:spaceId/mcp-connections", async (request) => {
    const { spaceId } = paramsWithSpaceId.parse(request.params);
    return { connections: app.services.mcp.listConnections(spaceId) };
  });

  app.get("/api/spaces/:spaceId/mcp-tool-stats", async (request) => {
    const { spaceId } = paramsWithSpaceId.parse(request.params);
    return { stats: app.services.mcp.listToolStats(spaceId) };
  });

  app.post("/api/spaces/:spaceId/mcp-connections", async (request) => {
    const { spaceId } = paramsWithSpaceId.parse(request.params);
    const body = z.object({
      name: z.string().min(1).default("Local agent"),
      client: z.string().min(1).default("generic")
    }).parse(request.body ?? {});
    return app.services.mcp.createConnection(spaceId, body.name, body.client);
  });

  app.delete("/api/mcp-connections/:connectionId", async (request) => {
    const { connectionId } = paramsWithConnectionId.parse(request.params);
    return app.services.mcp.deleteConnection(connectionId);
  });
}

function toPublicSpace(space: unknown): Record<string, unknown> {
  const { root_path: _rootPathSnake, rootPath: _rootPathCamel, ...publicSpace } = toRecord(space);
  return publicSpace;
}

function toPublicSpaceRepository(repository: unknown): Record<string, unknown> {
  const {
    local_path: _localPathSnake,
    localPath: _localPathCamel,
    clone_url: _cloneUrlSnake,
    cloneUrl: _cloneUrlCamel,
    ...publicRepository
  } = toRecord(repository);
  return publicRepository;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Expected database row object");
  }

  return value as Record<string, unknown>;
}
