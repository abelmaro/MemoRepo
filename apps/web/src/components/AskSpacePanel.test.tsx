// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AskSpacePanel } from "./AskSpacePanel";

const apiMock = vi.hoisted(() => vi.fn());
const subscribeMock = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  api: apiMock,
  subscribeToAgentTurnEvents: subscribeMock
}));

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  subscribeMock.mockClear();
  vi.restoreAllMocks();
});

it("connects OpenAI Codex through device OAuth without asking for an API token", async () => {
  const authorizationWindow = { location: { href: "about:blank" }, close: vi.fn() } as unknown as Window;
  vi.spyOn(window, "open").mockReturnValue(authorizationWindow);
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/agent/models") return Promise.resolve(modelCatalog("openai-codex", "OpenAI Codex", "gpt-5.4", "GPT-5.4"));
    if (path === "/api/agent/status") {
      return Promise.resolve({
        configured: true,
        available: true,
        connected: false,
        providerId: "openai-codex",
        providerName: "OpenAI Codex",
        modelId: "gpt-5.4",
        modelName: "GPT-5.4",
        authSource: null,
        version: "1.0.0",
        message: "Sign in to continue"
      });
    }
    if (path === "/api/agent/spaces/space_1/chats?includeArchived=true") {
      return Promise.resolve({ chats: [] });
    }
    if (path === "/api/agent/login" && init?.method === "POST") {
      return Promise.resolve({
        login: {
          loginId: "login_1",
          status: "pending",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
          instructions: "Enter this one-time code",
          error: null
        }
      });
    }
    if (path === "/api/agent/logins/login_1") {
      return Promise.resolve({
        login: {
          loginId: "login_1",
          status: "pending",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
          instructions: "Enter this one-time code",
          error: null
        }
      });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });

  renderPanel();
  const connectButton = await screen.findByRole("button", { name: "Connect OpenAI Codex" });
  expect((connectButton as HTMLButtonElement).disabled).toBe(true);
  expect(
    screen.getByText(/questions, chat history, snapshot query results, and relevant code excerpts to OpenAI/i)
  ).toBeTruthy();
  expect(screen.getByText(/MemoRepo control token are not included in prompt or tool payloads/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /I agree to send my questions/i }));
  expect((connectButton as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(connectButton);

  expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
  expect(window.open).toHaveBeenCalledWith("about:blank", "memorepo-agent-authorization");
  expect(authorizationWindow.location.href).toBe("https://auth.openai.com/codex/device");
  expect(screen.queryByLabelText(/api token/i)).toBeNull();
});

it("supports pending provider login without a URL, code, or instructions", async () => {
  const authorizationWindow = { location: { href: "about:blank" }, close: vi.fn() } as unknown as Window;
  vi.spyOn(window, "open").mockReturnValue(authorizationWindow);
  const login = {
    loginId: "login_1",
    status: "pending",
    verificationUrl: null,
    userCode: null,
    instructions: null,
    error: null
  };
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/agent/models") return Promise.resolve(modelCatalog("openai-codex", "OpenAI Codex", "gpt-5.4", "GPT-5.4"));
    if (path === "/api/agent/status") {
      return Promise.resolve({
        configured: true,
        available: true,
        connected: false,
        providerId: "openai-codex",
        providerName: "OpenAI Codex",
        modelId: "gpt-5.4",
        modelName: "GPT-5.4",
        authSource: null,
        version: "1.0.0",
        message: "Sign in to continue"
      });
    }
    if (path === "/api/agent/spaces/space_1/chats?includeArchived=true") return Promise.resolve({ chats: [] });
    if (path === "/api/agent/login" && init?.method === "POST") return Promise.resolve({ login });
    if (path === "/api/agent/logins/login_1") return Promise.resolve({ login });
    throw new Error(`Unexpected API request: ${path}`);
  });

  renderPanel();
  fireEvent.click(await screen.findByRole("checkbox", { name: /I agree to send my questions/i }));
  fireEvent.click(screen.getByRole("button", { name: "Connect OpenAI Codex" }));

  expect(await screen.findByText("Waiting for authorization…")).toBeTruthy();
  expect(authorizationWindow.close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Copy login code" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Open sign-in" })).toBeNull();
});

it("switches the provider and model through the runtime selection API", async () => {
  const firstCatalog = {
    providers: [
      { id: "provider-a", name: "Provider A", models: [{ id: "model-a", name: "Model A", capabilities: {} }] },
      { id: "provider-b", name: "Provider B", models: [{ id: "model-b", name: "Model B", capabilities: {} }] }
    ],
    selected: { providerId: "provider-a", modelId: "model-a", settings: {} }
  };
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/agent/models" && !init) return Promise.resolve(firstCatalog);
    if (path === "/api/agent/model" && init?.method === "PUT") {
      return Promise.resolve({ ...firstCatalog, selected: JSON.parse(String(init.body)) });
    }
    if (path === "/api/agent/status") {
      return Promise.resolve({
        configured: true,
        available: true,
        connected: true,
        providerId: "provider-a",
        providerName: "Provider A",
        modelId: "model-a",
        modelName: "Model A",
        authSource: "stored",
        version: "1.0.0",
        message: null
      });
    }
    if (path === "/api/agent/spaces/space_1/chats?includeArchived=true") return Promise.resolve({ chats: [] });
    throw new Error(`Unexpected API request: ${path}`);
  });

  renderPanel();
  fireEvent.change(await screen.findByLabelText("Provider"), { target: { value: "provider-b" } });

  await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
    "/api/agent/model",
    expect.objectContaining({ method: "PUT", body: JSON.stringify({ providerId: "provider-b", modelId: "model-b" }) })
  ));
  expect(screen.getByRole("button", { name: "Resize Ask this Space" })).toBeTruthy();
});

it("keeps advanced settings closed and updates supported verbosity and effort", async () => {
  const catalog = {
    providers: [{
      id: "provider-a",
      name: "Provider A",
      models: [{
        id: "model-a",
        name: "Model A",
        capabilities: {
          verbosity: { options: ["low", "medium", "high"], default: "medium" },
          effort: { options: ["low", "medium", "high"], default: "medium" }
        }
      }]
    }],
    selected: { providerId: "provider-a", modelId: "model-a", settings: { verbosity: "medium", effort: "medium" } }
  };
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/agent/models" && !init) return Promise.resolve(catalog);
    if (path === "/api/agent/model" && init?.method === "PUT") {
      return Promise.resolve({ ...catalog, selected: JSON.parse(String(init.body)) });
    }
    if (path === "/api/agent/status") return Promise.resolve(connectedStatus());
    if (path === "/api/agent/spaces/space_1/chats?includeArchived=true") return Promise.resolve({ chats: [] });
    throw new Error(`Unexpected API request: ${path}`);
  });

  renderPanel();
  const summary = await screen.findByText("Advanced");
  const disclosure = summary.closest("details") as HTMLDetailsElement;
  expect(disclosure.open).toBe(false);
  fireEvent.click(summary);
  expect(disclosure.open).toBe(true);
  expect(screen.getByLabelText("Verbosity")).toBeTruthy();
  expect(screen.getByLabelText("Reasoning effort")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Verbosity"), { target: { value: "high" } });
  await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
    "/api/agent/model",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({
        providerId: "provider-a",
        modelId: "model-a",
        settings: { verbosity: "high", effort: "medium" }
      })
    })
  ));
});

it("does not render unsupported advanced controls", async () => {
  const catalog = {
    providers: [{
      id: "provider-a",
      name: "Provider A",
      models: [{
        id: "model-a",
        name: "Model A",
        capabilities: { verbosity: { options: ["low", "high"], default: "low" } }
      }]
    }],
    selected: { providerId: "provider-a", modelId: "model-a", settings: { verbosity: "low" } }
  };
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/agent/models") return Promise.resolve(catalog);
    if (path === "/api/agent/status") return Promise.resolve(connectedStatus());
    if (path === "/api/agent/spaces/space_1/chats?includeArchived=true") return Promise.resolve({ chats: [] });
    throw new Error(`Unexpected API request: ${path}`);
  });

  renderPanel();
  fireEvent.click(await screen.findByText("Advanced"));
  expect(screen.getByLabelText("Verbosity")).toBeTruthy();
  expect(screen.queryByLabelText("Reasoning effort")).toBeNull();
});

it("keeps a disconnected provider's pruned snapshot transcript readable and clearly non-continuable", async () => {
  const chat = {
    id: "chat_1",
    spaceId: "space_1",
    title: "Where is indexing handled?",
    status: "active",
    snapshot: { id: null, version: 1, repositories: [] },
    activeSnapshot: { id: "snapshot_2", version: 2 },
    usesLatestSnapshot: false,
    continuable: false,
    continuationReason: "Its pinned snapshot was pruned",
    messageCount: 2,
    activeTurnId: null,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:01:00.000Z",
    archivedAt: null
  };
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/agent/models") return Promise.resolve(modelCatalog("example", "Example AI", "example-model", "Example Model"));
    if (path === "/api/agent/status") {
      return Promise.resolve({
        configured: true,
        available: true,
        connected: false,
        providerId: "example",
        providerName: "Example AI",
        modelId: "example-model",
        modelName: "Example Model",
        authSource: null,
        version: "1.0.0",
        message: "Sign in to continue"
      });
    }
    if (path === "/api/agent/spaces/space_1/chats?includeArchived=true") {
      return Promise.resolve({ chats: [chat] });
    }
    if (path === "/api/agent/spaces/space_1/chats/chat_1") {
      return Promise.resolve({
        chat,
        messages: [
          {
            id: "message_1",
            sequence: 1,
            role: "user",
            status: "completed",
            content: "Where is indexing handled?",
            sources: [],
            error: null,
            createdAt: chat.createdAt,
            completedAt: chat.createdAt
          },
          {
            id: "message_2",
            sequence: 2,
            role: "assistant",
            status: "completed",
            content: "The snapshot service coordinates indexing.",
            sources: [{ tool: "search_code", project: "memo", path: "src/services/snapshot.ts" }],
            error: null,
            createdAt: chat.createdAt,
            completedAt: chat.updatedAt
          }
        ]
      });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });

  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: /Where is indexing handled/i }));

  expect(await screen.findByText("The snapshot service coordinates indexing.")).toBeTruthy();
  expect(screen.getByText("Its pinned snapshot was pruned")).toBeTruthy();
  expect(screen.getByText("1 source consulted")).toBeTruthy();
  expect(screen.queryByLabelText("Message to agent")).toBeNull();
});

it("streams an answer into the persistent assistant message", async () => {
  const chat = {
    id: "chat_1",
    spaceId: "space_1",
    title: "New chat",
    status: "active",
    snapshot: { id: "snapshot_1", version: 1, repositories: [] },
    activeSnapshot: { id: "snapshot_1", version: 1 },
    usesLatestSnapshot: true,
    continuable: true,
    continuationReason: null,
    messageCount: 0,
    activeTurnId: null,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    archivedAt: null
  };
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/agent/models") return Promise.resolve(modelCatalog("example", "Example AI", "example-model", "Example Model"));
    if (path === "/api/agent/status") {
      return Promise.resolve({
        configured: true,
        available: true,
        connected: true,
        providerId: "example",
        providerName: "Example AI",
        modelId: "example-model",
        modelName: "Example Model",
        authSource: "stored",
        version: "1.0.0",
        message: null
      });
    }
    if (path === "/api/agent/spaces/space_1/chats?includeArchived=true") {
      return Promise.resolve({ chats: [chat] });
    }
    if (path === "/api/agent/spaces/space_1/chats/chat_1" && !init) {
      return Promise.resolve({ chat, messages: [] });
    }
    if (path === "/api/agent/spaces/space_1/chats/chat_1/messages" && init?.method === "POST") {
      return Promise.resolve({
        turn: {
          id: "turn_1",
          chatId: chat.id,
          userMessageId: "message_user",
          assistantMessageId: "message_assistant",
          status: "running",
          error: null,
          createdAt: chat.createdAt,
          startedAt: chat.createdAt,
          finishedAt: null
        },
        userMessage: {
          id: "message_user", sequence: 1, role: "user", status: "completed", content: "Explain the flow",
          sources: [], error: null, createdAt: chat.createdAt, completedAt: chat.createdAt
        },
        assistantMessage: {
          id: "message_assistant", sequence: 2, role: "assistant", status: "running", content: "",
          sources: [], error: null, createdAt: chat.createdAt, completedAt: null
        }
      });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });

  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: /New chat/i }));
  expect(screen.queryByLabelText("Answer mode")).toBeNull();
  const textarea = await screen.findByLabelText("Message to agent");
  fireEvent.change(textarea, { target: { value: "Explain the flow" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() =>
    expect(apiMock).toHaveBeenCalledWith(
      "/api/agent/spaces/space_1/chats/chat_1/messages",
      { method: "POST", body: JSON.stringify({ message: "Explain the flow" }) }
    )
  );

  await waitFor(() => expect(subscribeMock).toHaveBeenCalled());
  const onEvent = (subscribeMock.mock.calls as unknown as Array<[string, (event: unknown) => void]>)[0]?.[1];
  if (!onEvent) throw new Error("Agent stream callback was not registered");
  const messageList = document.querySelector<HTMLElement>(".ask-space-messages");
  if (!messageList) throw new Error("Message list was not rendered");
  Object.defineProperties(messageList, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 200 }
  });
  messageList.scrollTop = 100;
  fireEvent.scroll(messageList);
  onEvent({ type: "turn.started", turnId: "turn_1", turn: {
    id: "turn_1", chatId: chat.id, userMessageId: "message_user", assistantMessageId: "message_assistant",
    status: "running", error: null, createdAt: chat.createdAt, startedAt: chat.createdAt, finishedAt: null
  } });
  expect(await screen.findByText("Planning the investigation…")).toBeTruthy();
  onEvent({ type: "tool.started", turnId: "turn_1", tool: "search_code" });
  expect(await screen.findByText("Searching the snapshot…")).toBeTruthy();
  onEvent({ type: "tool.completed", turnId: "turn_1", tool: "search_code", success: true, sources: [] });
  expect(await screen.findByText("Snapshot search completed; reviewing the results…")).toBeTruthy();
  const partial = "The flow starts";
  onEvent({
    type: "state",
    turn: {
      id: "turn_1", chatId: chat.id, userMessageId: "message_user", assistantMessageId: "message_assistant",
      status: "running", error: null, createdAt: chat.createdAt, startedAt: chat.createdAt, finishedAt: null
    },
    assistantMessage: {
      id: "message_assistant", sequence: 2, role: "assistant", status: "running", content: partial,
      sources: [], error: null, createdAt: chat.createdAt, completedAt: null
    }
  });
  expect(await screen.findByRole("button", { name: "Latest answer" })).toBeTruthy();
  onEvent({ type: "assistant.delta", turnId: "turn_1", messageId: "message_assistant", offset: partial.length, delta: " here." });
  onEvent({ type: "assistant.delta", turnId: "turn_1", messageId: "message_assistant", offset: 0, delta: partial });
  expect(await screen.findByText("The flow starts here.")).toBeTruthy();
  expect(screen.getByText("Writing the answer…")).toBeTruthy();
});

it("copies completed assistant answers as plain text or Markdown", async () => {
  const chat = { ...chatFixture("chat_copy", "Copyable answer"), messageCount: 2 };
  const markdown = "## Result\n\nUse **the snapshot** and `[source](https://example.com)`.";
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/agent/models") return Promise.resolve(modelCatalog("provider-a", "Provider A", "model-a", "Model A"));
    if (path === "/api/agent/status") return Promise.resolve(connectedStatus());
    if (path === "/api/agent/spaces/space_1/chats?includeArchived=true") return Promise.resolve({ chats: [chat] });
    if (path === "/api/agent/spaces/space_1/chats/chat_copy") {
      return Promise.resolve({
        chat,
        messages: [
          { id: "user", sequence: 1, role: "user", status: "completed", content: "Explain", sources: [], error: null, createdAt: chat.createdAt, completedAt: chat.createdAt },
          { id: "assistant", sequence: 2, role: "assistant", status: "completed", content: markdown, sources: [], error: null, createdAt: chat.createdAt, completedAt: chat.createdAt }
        ],
        turns: []
      });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });

  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: /Copyable answer/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Copy answer as plain text" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("Result\n\nUse the snapshot and source."));

  fireEvent.click(screen.getByLabelText("Copy options"));
  fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(markdown));
});

it("shows queue capacity and lets a queued answer be cancelled", async () => {
  const chat = { ...chatFixture("chat_queued", "Queued chat"), activeTurnId: "turn_queued", messageCount: 2 };
  const createdAt = chat.createdAt;
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/agent/models") return Promise.resolve(modelCatalog("example", "Example AI", "example-model", "Example Model"));
    if (path === "/api/agent/status") {
      return Promise.resolve({
        ...connectedStatus(),
        capacity: { active: 2, maxActive: 2, queued: 2, maxQueued: 20 }
      });
    }
    if (path === "/api/agent/spaces/space_1/chats?includeArchived=true") return Promise.resolve({ chats: [chat] });
    if (path === "/api/agent/spaces/space_1/chats/chat_queued" && !init) {
      return Promise.resolve({
        chat,
        messages: [
          {
            id: "message_user", sequence: 1, role: "user", status: "completed", content: "Queued question",
            sources: [], error: null, createdAt, completedAt: createdAt
          },
          {
            id: "message_assistant", sequence: 2, role: "assistant", status: "pending", content: "",
            sources: [], error: null, createdAt, completedAt: null
          }
        ],
        turns: [{
          id: "turn_queued", chatId: chat.id, userMessageId: "message_user", assistantMessageId: "message_assistant",
          status: "queued", error: null, providerId: "example", modelId: "example-model",
          executionPolicy: "adaptive", phase: "queued", completionReason: null, answerQuality: null,
          resumable: false, attemptCount: 0, queuePosition: 2, settings: {},
          limits: { maxRunSeconds: 1800, maxToolCalls: 200, maxProviderRounds: 50 },
          metrics: null, createdAt, startedAt: null, finishedAt: null
        }]
      });
    }
    if (path.endsWith("/turns/turn_queued/interrupt") && init?.method === "POST") return Promise.resolve(undefined);
    throw new Error(`Unexpected API request: ${path}`);
  });

  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: /Queued chat/i }));

  expect(await screen.findByText("Queued · position 2 · 2/2 running")).toBeTruthy();
  const cancel = screen.getByRole("button", { name: "Cancel queued answer" });
  fireEvent.click(cancel);
  await waitFor(() =>
    expect(apiMock).toHaveBeenCalledWith(
      "/api/agent/spaces/space_1/chats/chat_queued/turns/turn_queued/interrupt",
      { method: "POST", body: "{}" }
    )
  );
});

it("continues a best-effort answer on the same turn", async () => {
  const chat = { ...chatFixture("chat_best_effort", "Broad investigation"), messageCount: 2 };
  const createdAt = chat.createdAt;
  const turn = {
    id: "turn_best_effort", chatId: chat.id, userMessageId: "message_user", assistantMessageId: "message_assistant",
    status: "completed", error: null, providerId: "example", modelId: "example-model",
    executionPolicy: "adaptive", phase: "completed", completionReason: "budget", answerQuality: "best_effort",
    resumable: false, attemptCount: 1, queuePosition: null, settings: {},
    limits: { maxRunSeconds: 1800, maxToolCalls: 200, maxProviderRounds: 50 },
    metrics: null, createdAt, startedAt: createdAt, finishedAt: createdAt
  };
  const userMessage = {
    id: "message_user", sequence: 1, role: "user", status: "completed", content: "Investigate broadly",
    sources: [], error: null, createdAt, completedAt: createdAt
  };
  const assistantMessage = {
    id: "message_assistant", sequence: 2, role: "assistant", status: "completed", content: "Supported so far.",
    sources: [], error: null, createdAt, completedAt: createdAt
  };
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/agent/models") return Promise.resolve(modelCatalog("example", "Example AI", "example-model", "Example Model"));
    if (path === "/api/agent/status") return Promise.resolve(connectedStatus());
    if (path === "/api/agent/spaces/space_1/chats?includeArchived=true") return Promise.resolve({ chats: [chat] });
    if (path === "/api/agent/spaces/space_1/chats/chat_best_effort" && !init) {
      return Promise.resolve({ chat, messages: [userMessage, assistantMessage], turns: [turn] });
    }
    if (path.endsWith("/turns/turn_best_effort/resume") && init?.method === "POST") {
      return Promise.resolve({
        turn: { ...turn, status: "queued", phase: "recovering", completionReason: null, answerQuality: null, finishedAt: null },
        userMessage,
        assistantMessage: { ...assistantMessage, status: "pending", content: "", completedAt: null }
      });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });

  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: /Broad investigation/i }));
  fireEvent.click(await screen.findByRole("button", { name: "Continue investigating" }));

  await waitFor(() =>
    expect(apiMock).toHaveBeenCalledWith(
      "/api/agent/spaces/space_1/chats/chat_best_effort/turns/turn_best_effort/resume",
      { method: "POST", body: "{}" }
    )
  );
});

it("clears the draft when switching chats", async () => {
  const firstChat = chatFixture("chat_1", "First chat");
  const secondChat = chatFixture("chat_2", "Second chat");
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/agent/models") return Promise.resolve(modelCatalog("example", "Example AI", "example-model", "Example Model"));
    if (path === "/api/agent/status") {
      return Promise.resolve({
        configured: true,
        available: true,
        connected: true,
        providerId: "example",
        providerName: "Example AI",
        modelId: "example-model",
        modelName: "Example Model",
        authSource: "stored",
        version: "1.0.0",
        message: null
      });
    }
    if (path === "/api/agent/spaces/space_1/chats?includeArchived=true") {
      return Promise.resolve({ chats: [firstChat, secondChat] });
    }
    if (path === "/api/agent/spaces/space_1/chats/chat_1") return Promise.resolve({ chat: firstChat, messages: [] });
    if (path === "/api/agent/spaces/space_1/chats/chat_2") return Promise.resolve({ chat: secondChat, messages: [] });
    throw new Error(`Unexpected API request: ${path}`);
  });

  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: /First chat/i }));
  const firstDraft = await screen.findByLabelText("Message to agent");
  fireEvent.change(firstDraft, { target: { value: "Draft for the first chat" } });
  fireEvent.click(screen.getByRole("button", { name: "Back to chat history" }));
  fireEvent.click(await screen.findByRole("button", { name: /Second chat/i }));

  await waitFor(() => expect((screen.getByLabelText("Message to agent") as HTMLTextAreaElement).value).toBe(""));
});

function chatFixture(id: string, title: string) {
  return {
    id,
    spaceId: "space_1",
    title,
    status: "active",
    snapshot: { id: "snapshot_1", version: 1, repositories: [] },
    activeSnapshot: { id: "snapshot_1", version: 1 },
    usesLatestSnapshot: true,
    continuable: true,
    continuationReason: null,
    messageCount: 0,
    activeTurnId: null,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    archivedAt: null
  };
}

function modelCatalog(providerId: string, providerName: string, modelId: string, modelName: string) {
  return {
    providers: [{ id: providerId, name: providerName, models: [{ id: modelId, name: modelName, capabilities: {} }] }],
    selected: { providerId, modelId, settings: {} }
  };
}

function connectedStatus() {
  return {
    configured: true,
    available: true,
    connected: true,
    providerId: "provider-a",
    providerName: "Provider A",
    modelId: "model-a",
    modelName: "Model A",
    authSource: "stored",
    version: "1.0.0",
    message: null
  };
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AskSpacePanel
        space={{
          id: "space_1",
          name: "Demo",
          slug: "demo",
          active_snapshot_id: "snapshot_1",
          snapshot_status: "active"
        }}
        open
        onOpenChange={vi.fn()}
      />
    </QueryClientProvider>
  );
}
