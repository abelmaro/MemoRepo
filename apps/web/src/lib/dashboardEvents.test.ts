// @vitest-environment jsdom

import { createElement, type PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import appSource from "../App.tsx?raw";
import addRepoSource from "../components/AddRepoModal.tsx?raw";
import askSpaceSource from "../components/AskSpacePanel.tsx?raw";
import githubConnectionSource from "../components/GitHubConnectionPanel.tsx?raw";
import jobLogSource from "../components/JobLog.tsx?raw";
import jobsSource from "../components/JobsPanel.tsx?raw";
import lifecycleSource from "../components/LifecyclePanel.tsx?raw";
import mcpSource from "../components/McpModal.tsx?raw";
import preflightSource from "../components/PreflightPanel.tsx?raw";
import statusStripSource from "../components/StatusStrip.tsx?raw";
import { clearControlToken, setControlToken, subscribeToDashboardEvents } from "./api";
import { handleDashboardEvent, queryKeysForResource, useDashboardEvents } from "./dashboardEvents";

afterEach(() => {
  clearControlToken();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("dashboard invalidations", () => {
  it("maps scoped invalidations to the narrow React Query keys", () => {
    expect(queryKeysForResource({ type: "job", jobId: "job_1" })).toEqual([["job", "job_1"], ["jobs"]]);
    expect(queryKeysForResource({ type: "space", spaceId: "space_1" })).toEqual([["space", "space_1"], ["spaces"]]);
    expect(queryKeysForResource({ type: "spaces" })).toEqual([["spaces"], ["space"]]);
    expect(queryKeysForResource({ type: "connections" })).toEqual([["mcp-connections"], ["space"]]);
    expect(queryKeysForResource({ type: "system" })).toEqual([
      ["system"],
      ["github-auth-status"],
      ["github-diagnostics"]
    ]);
    expect(queryKeysForResource({ type: "agent", spaceId: "space_1", chatId: "chat_1" })).toEqual([
      ["agent", "status"],
      ["agent", "chats", "space_1"],
      ["agent", "chat"],
      ["agent", "chat", "space_1", "chat_1"]
    ]);
  });

  it("invalidates active queries on ready and de-duplicates overlapping resource keys", () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    handleDashboardEvent(queryClient, { type: "ready", eventId: "ready_1", occurredAt: "2026-07-18T00:00:00Z" });
    expect(invalidate).toHaveBeenCalledWith({ refetchType: "active" });

    invalidate.mockClear();
    handleDashboardEvent(queryClient, {
      type: "invalidate",
      eventId: "event_1",
      occurredAt: "2026-07-18T00:00:01Z",
      resources: [{ type: "jobs" }, { type: "job", jobId: "job_1" }]
    });
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: ["jobs"] },
      { queryKey: ["job", "job_1"] }
    ]);
  });

  it("reconciles observed queries when the browser comes back online or becomes visible", () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client: queryClient }, children);
    const { unmount } = renderHook(() => useDashboardEvents(), { wrapper });

    window.dispatchEvent(new Event("online"));
    expect(invalidate).toHaveBeenCalledWith({ refetchType: "active" });
    invalidate.mockClear();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(invalidate).toHaveBeenCalledWith({ refetchType: "active" });
    unmount();
  });

  it("keeps core dashboard views free of periodic reads", () => {
    const files: Array<[string, string, number]> = [
      ["App", appSource, 0],
      ["AddRepoModal", addRepoSource, 0],
      ["AskSpacePanel", askSpaceSource, 1],
      ["GitHubConnectionPanel", githubConnectionSource, 1],
      ["JobLog", jobLogSource, 0],
      ["JobsPanel", jobsSource, 0],
      ["LifecyclePanel", lifecycleSource, 0],
      ["McpModal", mcpSource, 0],
      ["PreflightPanel", preflightSource, 0],
      ["StatusStrip", statusStripSource, 0]
    ];
    for (const [name, source, allowedAuthorizationReads] of files) {
      const periodicReads = [...source.matchAll(/refetchInterval/g)].length;
      expect(periodicReads, String(name)).toBe(allowedAuthorizationReads);
    }
  });
});

describe("dashboard event stream", () => {
  it("uses the control token and parses SSE data frames", async () => {
    setControlToken("control-secret");
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": heartbeat\n\ndata: {\"type\":\"ready\",\"eventId\":\"ready_1\",\"occurredAt\":\"2026-07-18T00:00:00Z\"}\n\n"));
      }
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { status: 200 }));
    const onEvent = vi.fn();

    const unsubscribe = subscribeToDashboardEvents(onEvent);
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "ready", eventId: "ready_1" })));
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/dashboard/events",
      expect.objectContaining({ headers: { accept: "text/event-stream", authorization: "Bearer control-secret" } })
    );
    unsubscribe();
  });

  it("reconnects with exponential backoff when no stream is established", async () => {
    vi.useFakeTimers();
    setControlToken("control-secret");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const unsubscribe = subscribeToDashboardEvents(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
});
