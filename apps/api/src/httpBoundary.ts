import type { FastifyInstance } from "fastify";
import { corsOrigins, type AppConfig } from "./config.js";

const JSON_METHODS = new Set(["POST", "PUT", "PATCH"]);
const LOCAL_HOSTNAMES = ["127.0.0.1", "localhost", "::1"];
const WILDCARD_HOSTNAMES = new Set(["0.0.0.0", "::"]);

export function registerHttpBoundary(app: FastifyInstance, config: AppConfig): void {
  const allowedHostnames = httpHostnames(config);
  const allowedOrigins = new Set(corsOrigins(config).map(normalizedOrigin).filter((origin): origin is string => Boolean(origin)));

  app.addHook("onRequest", async (request, reply) => {
    const hostname = hostnameFromHeader(request.headers.host);
    if (!hostname || !allowedHostnames.has(hostname)) {
      return reply.code(403).send({ error: "Request host is not allowed" });
    }

    const origin = singleHeader(request.headers.origin);
    if (origin && !allowedOrigins.has(normalizedOrigin(origin) ?? "")) {
      return reply.code(403).send({ error: "Request origin is not allowed" });
    }

    if (singleHeader(request.headers["sec-fetch-site"])?.toLowerCase() === "cross-site") {
      return reply.code(403).send({ error: "Cross-site requests are not allowed" });
    }

    if (
      JSON_METHODS.has(request.method) &&
      isMemoRepoRoute(request.url) &&
      !isJsonContentType(singleHeader(request.headers["content-type"]))
    ) {
      return reply.code(415).send({ error: "State-changing requests require application/json" });
    }
  });
}

function httpHostnames(config: AppConfig): Set<string> {
  const hostnames = new Set(LOCAL_HOSTNAMES);
  const configuredHost = normalizeHostname(config.apiHost);
  if (configuredHost && !WILDCARD_HOSTNAMES.has(configuredHost)) {
    hostnames.add(configuredHost);
  }

  try {
    hostnames.add(normalizeHostname(new URL(config.publicApiUrl).hostname));
  } catch {
    // The generated HTTP config will surface malformed public URLs when used.
  }

  return hostnames;
}

function hostnameFromHeader(value: string | string[] | undefined): string | null {
  const header = singleHeader(value);
  if (!header) {
    return null;
  }

  try {
    return normalizeHostname(new URL(`http://${header}`).hostname);
  } catch {
    return null;
  }
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isMemoRepoRoute(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    return false;
  }
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/mcp" || pathname.startsWith("/mcp/");
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType);
}
