import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { corsOrigins } from "./config.js";
import { NotFoundError } from "./domain/errors.js";
import { sanitizePublicMessage } from "./domain/publicSanitize.js";
import { registerHttpBoundary, registerHttpContentBoundary } from "./httpBoundary.js";
import { registerDefensiveResponseHeaders } from "./httpResponseHeaders.js";
import {
  loadHttpSecurityConfig,
  registerControlAccessBoundary,
  registerRateLimiting,
  type HttpSecurityConfig
} from "./httpSecurity.js";
import { decorateServices, type AppServices } from "./services/appServices.js";
import { githubRoutes } from "./routes/githubRoutes.js";
import { agentRoutes } from "./routes/agentRoutes.js";
import { jobRoutes } from "./routes/jobRoutes.js";
import { mcpRoutes } from "./routes/mcpRoutes.js";
import { spaceRoutes } from "./routes/spaceRoutes.js";
import { systemRoutes } from "./routes/systemRoutes.js";

export async function createApp(services: AppServices, securityConfig: HttpSecurityConfig = loadHttpSecurityConfig()) {
  const app = Fastify({
    trustProxy: false,
    logger: {
      redact: ["req.headers.authorization", "req.headers.x-memorepo-csrf"]
    }
  });
  app.setErrorHandler((error: unknown, request, reply) => {
    const { statusCode, message, code } = mapRouteError(error, services.config.memorepoHome);
    if (statusCode >= 500) {
      app.log.error({ err: error, errorCode: code, requestId: request.id }, message);
    } else if (statusCode !== 429) {
      app.log.warn({ err: error, errorCode: code, requestId: request.id }, message);
    }
    reply.code(statusCode).send({ error: message, code, requestId: request.id });
  });

  await decorateServices(app, services);
  registerDefensiveResponseHeaders(app);
  // Reject hostile browser and Host traffic before shared per-IP budgets so another origin cannot exhaust the local quota.
  registerHttpBoundary(app, services.config);
  app.addHook("onClose", async () => {
    await services.agent.close();
    await services.cbm.close();
  });

  await app.register(cors, {
    origin: corsOrigins(services.config),
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-memorepo-csrf"],
    exposedHeaders: ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]
  });

  await registerRateLimiting(app, securityConfig);
  registerControlAccessBoundary(app, securityConfig);
  registerHttpContentBoundary(app);

  await app.register(systemRoutes);
  await app.register(githubRoutes);
  await app.register(agentRoutes);
  await app.register(spaceRoutes);
  await app.register(jobRoutes);
  await app.register(mcpRoutes);

  return app;
}

function mapRouteError(error: unknown, memorepoHome: string): { statusCode: number; message: string; code: string } {
  if (error instanceof ZodError) {
    const detail = error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
    return { statusCode: 400, message: `Invalid request: ${detail}`, code: "MR-API-VALIDATION" };
  }

  if (error instanceof NotFoundError) {
    return { statusCode: 404, message: sanitizePublicMessage(error, [memorepoHome]), code: "MR-API-NOT-FOUND" };
  }

  if (error instanceof Error) {
    const fastifyStatus = (error as { statusCode?: unknown }).statusCode;
    if (typeof fastifyStatus === "number" && fastifyStatus >= 400 && fastifyStatus <= 599) {
      return {
        statusCode: fastifyStatus,
        message: sanitizePublicMessage(error, [memorepoHome]),
        code: explicitErrorCode(error) ?? statusErrorCode(fastifyStatus)
      };
    }
    if (
      error instanceof TypeError ||
      error instanceof RangeError ||
      error instanceof ReferenceError ||
      error instanceof SyntaxError
    ) {
      return { statusCode: 500, message: "Internal server error", code: "MR-API-INTERNAL" };
    }
    return {
      statusCode: 400,
      message: sanitizePublicMessage(error, [memorepoHome]),
      code: explicitErrorCode(error) ?? "MR-API-REQUEST"
    };
  }

  return { statusCode: 500, message: "Internal server error", code: "MR-API-INTERNAL" };
}

function explicitErrorCode(error: Error): string | null {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^MR-[A-Z0-9-]{3,80}$/.test(code) ? code : null;
}

function statusErrorCode(statusCode: number): string {
  if (statusCode === 429) return "MR-API-RATE-LIMIT";
  if (statusCode >= 500) return "MR-API-UPSTREAM";
  return "MR-API-REQUEST";
}
