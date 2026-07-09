import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { corsOrigins } from "./config.js";
import { NotFoundError } from "./domain/errors.js";
import { registerHttpBoundary } from "./httpBoundary.js";
import { decorateServices, type AppServices } from "./services/appServices.js";
import { githubRoutes } from "./routes/githubRoutes.js";
import { jobRoutes } from "./routes/jobRoutes.js";
import { mcpRoutes } from "./routes/mcpRoutes.js";
import { spaceRoutes } from "./routes/spaceRoutes.js";
import { systemRoutes } from "./routes/systemRoutes.js";

export async function createApp(services: AppServices) {
  const app = Fastify({ logger: true });
  app.setErrorHandler((error: unknown, _request, reply) => {
    const { statusCode, message } = mapRouteError(error);
    if (statusCode >= 500) {
      app.log.error({ err: error }, message);
    } else {
      app.log.warn({ err: error }, message);
    }
    reply.code(statusCode).send({ error: message });
  });

  await decorateServices(app, services);
  registerHttpBoundary(app, services.config);
  app.addHook("onClose", async () => {
    await services.cbm.close();
  });

  await app.register(cors, {
    origin: corsOrigins(services.config),
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization"]
  });

  await app.register(systemRoutes);
  await app.register(githubRoutes);
  await app.register(spaceRoutes);
  await app.register(jobRoutes);
  await app.register(mcpRoutes);

  return app;
}

function mapRouteError(error: unknown): { statusCode: number; message: string } {
  if (error instanceof ZodError) {
    const detail = error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
    return { statusCode: 400, message: `Invalid request: ${detail}` };
  }

  if (error instanceof NotFoundError) {
    return { statusCode: 404, message: error.message };
  }

  if (error instanceof Error) {
    const fastifyStatus = (error as { statusCode?: unknown }).statusCode;
    if (typeof fastifyStatus === "number" && fastifyStatus >= 400 && fastifyStatus <= 599) {
      return { statusCode: fastifyStatus, message: error.message };
    }
    if (
      error instanceof TypeError ||
      error instanceof RangeError ||
      error instanceof ReferenceError ||
      error instanceof SyntaxError
    ) {
      return { statusCode: 500, message: error.message };
    }
    return { statusCode: 400, message: error.message };
  }

  return { statusCode: 500, message: String(error) };
}
