// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Space } from "../lib/api";
import { AddRepoModal } from "./AddRepoModal";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  api: apiMock
}));

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("AddRepoModal", () => {
  it("keeps the picker open while a GitHub catalog refresh runs", async () => {
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/github/sync" && init?.method === "POST") {
        return Promise.resolve({ job: { id: "job-sync", status: "pending" } });
      }
      if (path === "/api/jobs/job-sync") {
        return Promise.resolve({ job: { id: "job-sync", status: "running" } });
      }
      throw new Error(`Unexpected API request: ${path}`);
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();
    const onJob = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <AddRepoModal space={{ id: "space-1", name: "Demo Space" } as Space} onClose={onClose} onJob={onJob} />
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh GitHub catalog" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/api/github/sync", expect.objectContaining({ method: "POST" })));
    expect(screen.getByRole("dialog", { name: "Add repository" })).toBeTruthy();
    expect(await screen.findByText("Refreshing GitHub catalog…")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(onJob).not.toHaveBeenCalled();

    queryClient.clear();
  });
});
