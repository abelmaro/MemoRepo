// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Space } from "../lib/api";
import { LifecyclePanel } from "./LifecyclePanel";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  api: apiMock,
}));

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("LifecyclePanel layout", () => {
  it("keeps feedback outside the lifecycle grid after pruning", async () => {
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path.endsWith("/snapshots/prune") && init?.method === "POST") {
        return Promise.resolve({ deletedCount: 3, deletedBytes: 1024 });
      }
      if (path.endsWith("/snapshots")) {
        return Promise.resolve({ snapshots: [], totalSizeBytes: 0, defaultRetention: 3 });
      }
      if (path === "/api/maintenance/summary") {
        return Promise.resolve({
          defaults: { jobRetentionDays: 30 },
          candidates: {
            failedSnapshots: 0,
            removedClones: 0,
            oldJobs: 0,
            oldRepoIndexRecords: 0,
            removedRepositoryIndexes: 0,
          },
          estimatedBytes: {},
        });
      }
      throw new Error(`Unexpected API request: ${path}`);
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const space = { id: "space-1", name: "Demo Space" } as Space;
    const view = render(
      <QueryClientProvider client={queryClient}>
        <LifecyclePanel
          space={space}
          operationsDisabled={false}
          onChanged={() => undefined}
          onDeleted={() => undefined}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("0 total · 0 B")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Prune" }));

    const feedback = await screen.findByText("Deleted 3 snapshots and freed 1.0 KB.");
    expect(feedback.classList.contains("lifecycle-feedback")).toBe(true);
    expect(feedback.closest(".lifecycle-grid")).toBeNull();
    expect(view.container.querySelector(".lifecycle-card-wide")).toBeTruthy();
    expect(view.container.querySelector(".garbage-collection-card")).toBeTruthy();
    expect(view.container.querySelector(".danger-zone")).toBeTruthy();

    queryClient.clear();
  });
});
