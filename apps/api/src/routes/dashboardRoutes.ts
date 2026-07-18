import type { FastifyInstance } from "fastify";
import { corsOrigins } from "../config.js";
import type { DashboardInvalidationEvent } from "../services/dashboardEventBus.js";

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/api/dashboard/events", async (request, reply) => {
    const headers: Record<string, string> = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-store, no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff"
    };
    const origin = request.headers.origin;
    if (origin && corsOrigins(app.services.config).includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers.vary = "Origin";
    }

    reply.hijack();
    reply.raw.writeHead(200, headers);
    let closed = false;
    const write = (event: object) => {
      if (!closed && !reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = app.services.dashboardEvents.subscribe((event: DashboardInvalidationEvent) => write(event));
    const heartbeat = setInterval(() => {
      if (!closed && !reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
    }, SSE_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.once("close", close);
    reply.raw.once("close", close);
    write({ type: "ready", eventId: app.services.dashboardEvents.nextEventId(), occurredAt: new Date().toISOString() });
  });
}
