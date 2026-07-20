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
    const onBatch = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <AddRepoModal
          space={{ id: "space-1", name: "Demo Space" } as Space}
          existingRepositoryIds={[]}
          onClose={onClose}
          onJob={onJob}
          onBatch={onBatch}
        />
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh GitHub catalog" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/api/github/sync", expect.objectContaining({ method: "POST" })));
    expect(screen.getByRole("dialog", { name: "Add repositories" })).toBeTruthy();
    expect(await screen.findByText("Refreshing GitHub catalog…")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(onJob).not.toHaveBeenCalled();
    expect(onBatch).not.toHaveBeenCalled();

    queryClient.clear();
  });

  it("keeps multiple selections across the catalog and submits one idempotent batch request", async () => {
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith("/api/github/repositories?")) {
        return Promise.resolve({
          repositories: [
            { id: "repo-b", owner: "demo", name: "beta", full_name: "demo/beta", private: false, archived: false, fork: false },
            { id: "repo-a", owner: "demo", name: "alpha", full_name: "demo/alpha", private: false, archived: false, fork: false },
            { id: "repo-existing", owner: "demo", name: "existing", full_name: "demo/existing", private: false, archived: false, fork: false }
          ]
        });
      }
      if (path === "/api/spaces/space-1/repositories/batch" && init?.method === "POST") {
        return Promise.resolve({ batch: { id: "batch-1" }, jobs: [], spaceRepositories: [], snapshotJob: null });
      }
      throw new Error(`Unexpected API request: ${path}`);
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();
    const onBatch = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <AddRepoModal
          space={{ id: "space-1", name: "Demo Space" } as Space}
          existingRepositoryIds={["repo-existing"]}
          onClose={onClose}
          onJob={vi.fn()}
          onBatch={onBatch}
        />
      </QueryClientProvider>
    );

    fireEvent.change(screen.getByPlaceholderText("Owner or repository name"), { target: { value: "demo" } });
    fireEvent.click(await screen.findByLabelText("Select demo/beta"));
    fireEvent.click(screen.getByLabelText("Select demo/alpha"));
    expect((screen.getByLabelText("Select demo/existing") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add 2" }));

    await waitFor(() => expect(onBatch).toHaveBeenCalledWith("batch-1"));
    const submission = apiMock.mock.calls.find(([path]) => path === "/api/spaces/space-1/repositories/batch");
    expect(submission).toBeTruthy();
    const body = JSON.parse(String((submission?.[1] as RequestInit).body)) as { repositoryIds: string[]; requestId: string };
    expect(body.repositoryIds).toEqual(["repo-a", "repo-b"]);
    expect(body.requestId.length).toBeGreaterThanOrEqual(8);
    expect(onClose).toHaveBeenCalledOnce();
    queryClient.clear();
  });
});
