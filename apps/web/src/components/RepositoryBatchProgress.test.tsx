// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryBatch } from "../lib/api";
import { RepositoryBatchProgress } from "./RepositoryBatchProgress";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  api: apiMock
}));

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("RepositoryBatchProgress", () => {
  it("shows grouped repository progress and retries failed work", async () => {
    const failedBatch = batchFixture("failed");
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/repository-batches/bat-1" && !init) return Promise.resolve({ batch: failedBatch });
      if (path === "/api/repository-batches/bat-1/retry" && init?.method === "POST") {
        return Promise.resolve({ batch: { ...failedBatch, status: "running", phase: "preparing" }, jobs: [], spaceRepositories: [], snapshotJob: null });
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <RepositoryBatchProgress batchId="bat-1" onJob={vi.fn()} />
      </QueryClientProvider>
    );

    expect(await screen.findByText("demo/alpha")).toBeTruthy();
    expect(screen.getByText("demo/beta")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry failed work" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      "/api/repository-batches/bat-1/retry",
      expect.objectContaining({ method: "POST" })
    ));
    queryClient.clear();
  });

  it("uses distinct indicators for queued and running repositories", async () => {
    const runningBatch: RepositoryBatch = {
      ...batchFixture("running"),
      phase: "preparing",
      failedCount: 0,
      items: [
        { spaceRepositoryId: "spr-a", githubRepositoryId: "repo-a", fullName: "demo/alpha", cloneStatus: "pending", indexStatus: "not_indexed", status: "pending" },
        { spaceRepositoryId: "spr-b", githubRepositoryId: "repo-b", fullName: "demo/beta", cloneStatus: "cloning", indexStatus: "not_indexed", status: "running" }
      ]
    };
    apiMock.mockResolvedValue({ batch: runningBatch });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <RepositoryBatchProgress batchId="bat-1" onJob={vi.fn()} />
      </QueryClientProvider>
    );

    const queued = await screen.findByLabelText("Queued");
    const running = screen.getByLabelText("Running");
    expect(queued.classList.contains("spin")).toBe(false);
    expect(running.classList.contains("spin")).toBe(true);
    queryClient.clear();
  });
});

function batchFixture(status: RepositoryBatch["status"]): RepositoryBatch {
  return {
    id: "bat-1",
    spaceId: "space-1",
    requestId: "request-1",
    status,
    phase: status,
    repositoryCount: 2,
    preparedCount: 1,
    indexedCount: 0,
    failedCount: 1,
    snapshotJobId: "job-snapshot",
    items: [
      { spaceRepositoryId: "spr-a", githubRepositoryId: "repo-a", fullName: "demo/alpha", cloneStatus: "cloned", indexStatus: "stale", status: "succeeded" },
      { spaceRepositoryId: "spr-b", githubRepositoryId: "repo-b", fullName: "demo/beta", cloneStatus: "failed", indexStatus: "not_indexed", status: "failed" }
    ],
    jobs: [],
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:01:00.000Z"
  };
}
