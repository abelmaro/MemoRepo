// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Space } from "./lib/api";

vi.mock("./lib/dashboardEvents", () => ({
  useDashboardEvents: () => undefined,
}));

vi.mock("./components/AskSpacePanel", () => ({
  AskSpacePanel: ({
    space,
    open,
    onOpenChange,
  }: {
    space: Space | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div data-testid="ask-space-state">
      <span>{`${space?.id ?? "none"}:${open ? "open" : "closed"}`}</span>
      <button type="button" onClick={() => onOpenChange(true)}>Open Ask</button>
      <button type="button" onClick={() => onOpenChange(false)}>Close Ask</button>
    </div>
  ),
}));

vi.mock("./components/StatusStrip", () => ({
  StatusStrip: ({ onAddRepository }: { onAddRepository: () => void }) => (
    <button type="button" onClick={onAddRepository}>Open add repository</button>
  ),
}));

vi.mock("./components/AddRepoModal", () => ({
  AddRepoModal: ({ onBatch }: { onBatch: (batchId: string) => void }) => (
    <button type="button" onClick={() => onBatch("batch-1")}>Create repository batch</button>
  ),
}));

vi.mock("./components/RepositoryBatchProgress", () => ({
  RepositoryBatchProgress: ({ onJob }: { onJob: (jobId: string) => void }) => (
    <button type="button" onClick={() => onJob("job-1")}>Open snapshot log</button>
  ),
}));

vi.mock("./components/JobLog", () => ({
  JobLog: ({ jobId }: { jobId: string }) => <div>Job log {jobId}</div>,
}));

afterEach(() => {
  cleanup();
});

describe("App", () => {
  it("remembers whether Ask this Space is open for each Space", () => {
    const spaces: Space[] = [
      { id: "space-a", name: "Space A", slug: "space-a", active_snapshot_id: null, snapshot_status: "ready", repository_count: 0 },
      { id: "space-b", name: "Space B", slug: "space-b", active_snapshot_id: null, snapshot_status: "ready", repository_count: 0 },
    ];
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(["spaces"], { spaces });
    queryClient.setQueryData(["jobs"], { jobs: [] });
    for (const space of spaces) {
      queryClient.setQueryData(["space", space.id], { space, repositories: [], removedRepositories: [] });
    }

    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("ask-space-state").textContent).toContain("space-a:closed");
    fireEvent.click(screen.getByRole("button", { name: "Open Ask" }));
    expect(screen.getByTestId("ask-space-state").textContent).toContain("space-a:open");

    fireEvent.click(screen.getByRole("button", { name: /Space B/ }));
    expect(screen.getByTestId("ask-space-state").textContent).toContain("space-b:closed");
    fireEvent.click(screen.getByRole("button", { name: "Open Ask" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Ask" }));

    fireEvent.click(screen.getByRole("button", { name: /Space A/ }));
    expect(screen.getByTestId("ask-space-state").textContent).toContain("space-a:open");

    fireEvent.click(screen.getByRole("button", { name: /Space B/ }));
    expect(screen.getByTestId("ask-space-state").textContent).toContain("space-b:closed");
  });

  it("returns from a snapshot job log to its repository batch", () => {
    const space: Space = {
      id: "space-a",
      name: "Space A",
      slug: "space-a",
      active_snapshot_id: null,
      snapshot_status: "ready",
      repository_count: 0,
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(["spaces"], { spaces: [space] });
    queryClient.setQueryData(["jobs"], { jobs: [] });
    queryClient.setQueryData(["space", space.id], { space, repositories: [], removedRepositories: [] });

    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open add repository" }));
    fireEvent.click(screen.getByRole("button", { name: "Create repository batch" }));
    expect(screen.getByRole("dialog", { name: "Repository batch" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open snapshot log" }));
    expect(screen.getByRole("dialog", { name: "Job details" })).toBeTruthy();
    expect(screen.getByText("Job log job-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to repository batch" }));
    expect(screen.getByRole("dialog", { name: "Repository batch" })).toBeTruthy();
    queryClient.clear();
  });
});
