import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { corsOrigins } from "../config.js";
import { NotFoundError } from "../domain/errors.js";

const paramsWithJobId = z.object({ jobId: z.string().min(1) });
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export async function jobRoutes(app: FastifyInstance) {
  app.get("/api/jobs", async () => ({ jobs: app.services.spaces.latestJobs() }));

  app.get("/api/jobs/:jobId", async (request) => {
    const { jobId } = paramsWithJobId.parse(request.params);
    const job = app.services.jobs.getJob(jobId);
    if (!job) {
      throw new NotFoundError("Job not found");
    }
    return {
      job,
      dependency: app.services.jobs.getJobDependency(jobId),
      dependents: app.services.jobs.getJobDependents(jobId),
      events: app.services.jobs.getJobEvents(jobId)
    };
  });

  app.post("/api/jobs/:jobId/retry", async (request) => {
    const { jobId } = paramsWithJobId.parse(request.params);
    const job = app.services.jobs.retryJob(jobId);
    app.services.dashboardEvents.publish({ type: "jobs" }, { type: "job", jobId });
    return { job };
  });

  app.post("/api/jobs/:jobId/cancel", async (request) => {
    const { jobId } = paramsWithJobId.parse(request.params);
    const job = app.services.jobs.cancelJob(jobId);
    app.services.dashboardEvents.publish({ type: "jobs" }, { type: "job", jobId });
    return { job };
  });

  app.get("/api/jobs/:jobId/events", async (request, reply) => {
    const { jobId } = paramsWithJobId.parse(request.params);
    if (!app.services.jobs.getJob(jobId)) {
      throw new NotFoundError("Job not found");
    }

    const headers: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    };
    const origin = request.headers.origin;
    if (origin && corsOrigins(app.services.config).includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers.vary = "Origin";
    }

    reply.hijack();
    reply.raw.writeHead(200, headers);

    const write = (event: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    for (const event of app.services.jobs.getJobEvents(jobId)) {
      write(event);
    }

    const listener = (event: unknown) => write(event);
    app.services.jobs.events.on(jobId, listener);
    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, SSE_HEARTBEAT_INTERVAL_MS);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      app.services.jobs.events.off(jobId, listener);
    });
  });
}
