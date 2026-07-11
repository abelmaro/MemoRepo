import type { FastifyInstance } from "fastify";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

export function registerDefensiveResponseHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (_request, reply) => {
    reply.headers({
      "cache-control": "no-store",
      "content-security-policy": CONTENT_SECURITY_POLICY,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY"
    });
  });
}
