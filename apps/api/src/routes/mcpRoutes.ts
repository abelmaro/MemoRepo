import type { FastifyInstance } from "fastify";
import { z } from "zod";

export async function mcpRoutes(app: FastifyInstance) {
  app.post("/mcp/:spaceSlug", async (request, reply) => {
    const { spaceSlug } = z.object({ spaceSlug: z.string().min(1) }).parse(request.params);
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    const response = await app.services.mcp.handleJsonRpc(spaceSlug, token, request.body as never);
    if (!response) {
      reply.code(202);
      return {};
    }
    return response;
  });
}
