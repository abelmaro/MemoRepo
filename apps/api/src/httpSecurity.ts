import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { loadOrCreatePrivateFile } from "./domain/permissions.js";
import { normalizedRequestPathname } from "./httpPath.js";

const API_PREFIX = "/api";
const MCP_PREFIX = "/mcp";
const HEALTH_PATH = "/api/health";
const CSRF_HEADER = "x-memorepo-csrf";
const CSRF_VALUE = "1";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CONTROL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export type ControlTokenSource = "environment" | "created" | "stored";

export interface HttpSecurityConfig {
  controlToken: string;
  controlTokenSource: ControlTokenSource;
  rateLimitWindowMs: number;
  authRateLimitMax: number;
  apiReadRateLimitMax: number;
  apiWriteRateLimitMax: number;
  apiSseRateLimitMax: number;
  mcpRateLimitMax: number;
}

export function loadHttpSecurityConfig(
  environment: NodeJS.ProcessEnv = process.env,
  generatedTokenPath?: string
): HttpSecurityConfig {
  const { controlToken, controlTokenSource } = resolveControlToken(environment.MEMOREPO_CONTROL_TOKEN, generatedTokenPath);

  return {
    controlToken,
    controlTokenSource,
    rateLimitWindowMs: positiveInt(environment.MEMOREPO_RATE_LIMIT_WINDOW_MS, 60_000),
    authRateLimitMax: positiveInt(environment.MEMOREPO_AUTH_RATE_LIMIT_MAX, 10),
    apiReadRateLimitMax: positiveInt(environment.MEMOREPO_API_READ_RATE_LIMIT_MAX, 300),
    apiWriteRateLimitMax: positiveInt(environment.MEMOREPO_API_WRITE_RATE_LIMIT_MAX, 30),
    apiSseRateLimitMax: positiveInt(environment.MEMOREPO_API_SSE_RATE_LIMIT_MAX, 30),
    mcpRateLimitMax: positiveInt(environment.MEMOREPO_MCP_RATE_LIMIT_MAX, 120)
  };
}

export async function registerRateLimiting(app: FastifyInstance, config: HttpSecurityConfig): Promise<void> {
  const expectedDigest = digest(config.controlToken);
  const bucketFor = (request: FastifyRequest) => rateLimitBucket(request, expectedDigest);

  await app.register(rateLimit, {
    global: false,
    timeWindow: config.rateLimitWindowMs,
    max: (request) => limitForBucket(bucketFor(request), config),
    keyGenerator: (request) => `${bucketFor(request)}:${request.ip}`,
    allowList: (request) => isRateLimitExempt(request),
    skipOnError: false,
    errorResponseBuilder: () => Object.assign(new Error("Rate limit exceeded; retry later"), { statusCode: 429 })
  });

  app.addHook("onRequest", app.rateLimit());
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: "Route not found" }));
}

export function registerControlAccessBoundary(app: FastifyInstance, config: HttpSecurityConfig): void {
  const expectedDigest = digest(config.controlToken);

  app.addHook("onRequest", async (request, reply) => {
    const pathname = normalizedRequestPathname(request.url);
    if (!pathname) {
      return reply.code(400).send({ error: "Request path is malformed" });
    }
    if (!isApiPath(pathname) || request.method === "OPTIONS" || isHealthCheck(request, pathname)) {
      return;
    }

    if (!hasValidControlCredential(request, expectedDigest)) {
      reply.header("www-authenticate", 'Bearer realm="MemoRepo control API"');
      return reply.code(401).send({ error: "Control authentication required" });
    }

    if (!SAFE_METHODS.has(request.method) && singleHeader(request.headers[CSRF_HEADER]) !== CSRF_VALUE) {
      return reply.code(403).send({ error: `State-changing API requests require ${CSRF_HEADER}: ${CSRF_VALUE}` });
    }
  });
}

export function controlTokenStartupMessage(
  config: HttpSecurityConfig,
  frontendOrigin: string,
  generatedTokenPath: string
): string | null {
  switch (config.controlTokenSource) {
    case "created":
      return `Unlock the MemoRepo dashboard: ${frontendOrigin}/#token=${config.controlToken}`;
    case "stored":
      return `The MemoRepo control token is stored in ${generatedTokenPath}. Paste it into the dashboard unlock screen.`;
    case "environment":
      return null;
  }
}

function resolveControlToken(
  configuredToken: string | undefined,
  generatedTokenPath: string | undefined
): { controlToken: string; controlTokenSource: ControlTokenSource } {
  if (configuredToken || !generatedTokenPath) {
    if (!configuredToken || !CONTROL_TOKEN_PATTERN.test(configuredToken)) {
      throw new Error("MEMOREPO_CONTROL_TOKEN must contain 43 to 128 URL-safe characters");
    }
    return { controlToken: configuredToken, controlTokenSource: "environment" };
  }

  const { content, created } = loadOrCreatePrivateFile(generatedTokenPath, () =>
    Buffer.from(randomBytes(32).toString("base64url"), "utf8")
  );
  const controlToken = content.toString("utf8").trim();
  if (!CONTROL_TOKEN_PATTERN.test(controlToken)) {
    throw new Error(`The generated control token in ${generatedTokenPath} is invalid; delete the file and restart MemoRepo`);
  }
  return { controlToken, controlTokenSource: created ? "created" : "stored" };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

type RateLimitBucket = "auth" | "api-read" | "api-write" | "api-sse" | "mcp" | "unprotected";

function rateLimitBucket(request: FastifyRequest, expectedDigest: Buffer): RateLimitBucket {
  const pathname = normalizedRequestPathname(request.url);
  if (!pathname) {
    return "auth";
  }
  if (isApiPath(pathname) && !isHealthCheck(request, pathname) && !hasValidControlCredential(request, expectedDigest)) {
    return "auth";
  }
  if (isEventStreamPath(pathname) && request.method === "GET") {
    return "api-sse";
  }
  if (isApiPath(pathname)) {
    return SAFE_METHODS.has(request.method) ? "api-read" : "api-write";
  }
  if (isMcpPath(pathname)) {
    return "mcp";
  }
  return "unprotected";
}

function limitForBucket(bucket: RateLimitBucket, config: HttpSecurityConfig): number {
  switch (bucket) {
    case "auth":
      return config.authRateLimitMax;
    case "api-read":
      return config.apiReadRateLimitMax;
    case "api-write":
      return config.apiWriteRateLimitMax;
    case "api-sse":
      return config.apiSseRateLimitMax;
    case "mcp":
      return config.mcpRateLimitMax;
    case "unprotected":
      return config.apiReadRateLimitMax;
  }
}

function isRateLimitExempt(request: FastifyRequest): boolean {
  const pathname = normalizedRequestPathname(request.url);
  if (!pathname) {
    return false;
  }
  return request.method === "OPTIONS" || isHealthCheck(request, pathname) || (!isApiPath(pathname) && !isMcpPath(pathname));
}

function isHealthCheck(request: FastifyRequest, pathname: string): boolean {
  return pathname === HEALTH_PATH && (request.method === "GET" || request.method === "HEAD");
}

function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

function isMcpPath(pathname: string): boolean {
  return pathname === MCP_PREFIX || pathname.startsWith(`${MCP_PREFIX}/`);
}

function isJobEventPath(pathname: string): boolean {
  return /^\/api\/jobs\/[^/]+\/events$/.test(pathname);
}

function isEventStreamPath(pathname: string): boolean {
  return pathname === "/api/dashboard/events" || isJobEventPath(pathname) || /^\/api\/agent\/turns\/[^/]+\/events$/.test(pathname);
}

function bearerCredential(value: string | undefined): string | null {
  const match = value?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1] ?? null;
}

function hasValidControlCredential(request: FastifyRequest, expectedDigest: Buffer): boolean {
  const credential = bearerCredential(singleHeader(request.headers.authorization));
  return Boolean(credential && timingSafeEqual(expectedDigest, digest(credential)));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
