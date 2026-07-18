import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { corsOrigins } from "../config.js";
import type { AgentClientEvent } from "../services/agentService.js";

const id = z.string().min(1).max(200);
const loginParams = z.object({ loginId: id });
const spaceParams = z.object({ spaceId: id });
const chatParams = z.object({ spaceId: id, chatId: id });
const turnParams = z.object({ spaceId: id, chatId: id, turnId: id });
const globalTurnParams = z.object({ turnId: id });
const messageBody = z.object({
  message: z.string().trim().min(1).max(16_000),
  mode: z.enum(["quick", "standard", "deep"]).default("standard")
});
const modelSelectionBody = z.object({
  providerId: id,
  modelId: id,
  settings: z
    .object({
      effort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
      verbosity: z.enum(["low", "medium", "high"]).optional()
    })
    .optional()
});
const listQuery = z.object({
  includeArchived: z.enum(["true", "false"]).default("false").transform((value) => value === "true")
});
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export async function agentRoutes(app: FastifyInstance) {
  app.get("/api/agent/status", async () => app.services.agent.status());

  app.get("/api/agent/models", async () => app.services.agent.modelCatalog());

  app.put("/api/agent/model", async (request) => {
    const { providerId, modelId, settings } = modelSelectionBody.parse(request.body);
    return app.services.agent.selectModel(
      providerId,
      modelId,
      settings
        ? {
            ...(settings.effort !== undefined ? { effort: settings.effort } : {}),
            ...(settings.verbosity !== undefined ? { verbosity: settings.verbosity } : {})
          }
        : undefined
    );
  });

  app.post("/api/agent/login", async (_request, reply) => {
    const login = await app.services.agent.startLogin();
    return reply.code(201).send({ login });
  });

  app.get("/api/agent/logins/:loginId", async (request) => {
    const { loginId } = loginParams.parse(request.params);
    return { login: await app.services.agent.loginStatus(loginId) };
  });

  app.delete("/api/agent/logins/:loginId", async (request, reply) => {
    const { loginId } = loginParams.parse(request.params);
    await app.services.agent.cancelLogin(loginId);
    return reply.code(204).send();
  });

  app.post("/api/agent/logout", async (_request, reply) => {
    await app.services.agent.logout();
    return reply.code(204).send();
  });

  app.get("/api/agent/spaces/:spaceId/chats", async (request) => {
    const { spaceId } = spaceParams.parse(request.params);
    const { includeArchived } = listQuery.parse(request.query);
    return app.services.agent.listChats(spaceId, includeArchived);
  });

  app.post("/api/agent/spaces/:spaceId/chats", async (request, reply) => {
    const { spaceId } = spaceParams.parse(request.params);
    return reply.code(201).send(await app.services.agent.createChat(spaceId));
  });

  app.get("/api/agent/spaces/:spaceId/chats/:chatId", async (request) => {
    const { spaceId, chatId } = chatParams.parse(request.params);
    return app.services.agent.getChat(spaceId, chatId);
  });

  app.post("/api/agent/spaces/:spaceId/chats/:chatId/messages", async (request, reply) => {
    const { spaceId, chatId } = chatParams.parse(request.params);
    const { message, mode } = messageBody.parse(request.body);
    return reply.code(202).send(await app.services.agent.sendMessage(spaceId, chatId, message, mode));
  });

  app.post("/api/agent/spaces/:spaceId/chats/:chatId/archive", async (request) => {
    const { spaceId, chatId } = chatParams.parse(request.params);
    return app.services.agent.archiveChat(spaceId, chatId);
  });

  app.delete("/api/agent/spaces/:spaceId/chats/:chatId", async (request, reply) => {
    const { spaceId, chatId } = chatParams.parse(request.params);
    await app.services.agent.deleteChat(spaceId, chatId);
    return reply.code(204).send();
  });

  app.post("/api/agent/spaces/:spaceId/chats/:chatId/turns/:turnId/interrupt", async (request, reply) => {
    const { spaceId, chatId, turnId } = turnParams.parse(request.params);
    await app.services.agent.interruptTurn(spaceId, chatId, turnId);
    return reply.code(204).send();
  });

  app.post("/api/agent/spaces/:spaceId/chats/:chatId/turns/:turnId/retry", async (request, reply) => {
    const { spaceId, chatId, turnId } = turnParams.parse(request.params);
    return reply.code(202).send(await app.services.agent.retryTurn(spaceId, chatId, turnId));
  });

  app.get("/api/agent/turns/:turnId/events", async (request, reply) => {
    const { turnId } = globalTurnParams.parse(request.params);
    const initialState = app.services.agent.getTurnStreamState(turnId);
    const headers: Record<string, string> = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-store, no-cache, no-transform",
      connection: "keep-alive",
      "x-content-type-options": "nosniff"
    };
    const origin = request.headers.origin;
    if (origin && corsOrigins(app.services.config).includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers.vary = "Origin";
    }

    const write = (event: unknown) => reply.raw.write("data: " + JSON.stringify(event) + "\n\n");
    let heartbeat: NodeJS.Timeout | null = null;
    let unsubscribe = () => {};
    let live = false;
    let ended = false;
    const buffered: AgentClientEvent[] = [];
    const close = () => {
      if (ended) return;
      ended = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      unsubscribe();
      unsubscribe = () => {};
    };
    const listener = (event: AgentClientEvent) => {
      if (!live) {
        buffered.push(event);
        return;
      }
      write(event);
      if (event.type === "turn.completed") {
        close();
        reply.raw.end();
      }
    };

    if (isActive(initialState.turn.status)) unsubscribe = app.services.agent.onTurnEvent(turnId, listener);
    const state = isActive(initialState.turn.status) ? app.services.agent.getTurnStreamState(turnId) : initialState;
    reply.hijack();
    reply.raw.writeHead(200, headers);
    request.raw.on("close", close);
    write({ type: "state", ...state });
    live = true;
    for (const event of buffered.splice(0)) {
      if (ended) break;
      listener(event);
    }

    if (ended) return;
    if (!isActive(state.turn.status)) {
      write({
        type: "turn.completed",
        turnId,
        status: state.turn.status,
        error: state.turn.error,
        metrics: state.turn.metrics
      });
      close();
      reply.raw.end();
      return;
    }
    heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), SSE_HEARTBEAT_INTERVAL_MS);
  });
}

function isActive(status: string): boolean {
  return status === "queued" || status === "pending" || status === "running";
}
