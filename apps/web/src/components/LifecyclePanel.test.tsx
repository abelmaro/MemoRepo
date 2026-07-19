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

  it("shows snapshot quality diagnostics and indexing cost", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path.endsWith("/snapshots")) {
        return Promise.resolve({
          snapshots: [{
            id: "snapshot-1", version: 7, status: "active", active: true, quality: "partial",
            repositoryCount: 2, engineVersions: ["0.9.0"], indexModes: ["fast"], sourceFileCount: 200,
            skippedCount: 4, excludedDirectoryCount: 3, coveragePercent: 98, skipReasons: [{ reason: "syntax", count: 4 }],
            indexDurationMs: 2_500, sizeBytes: 2048, createdAt: "2026-07-19T12:00:00.000Z", activatedAt: null,
            error: null, reason: "4 source files were skipped during indexing"
          }],
          totalSizeBytes: 2048,
          defaultRetention: 3
        });
      }
      if (path === "/api/maintenance/summary") {
        return Promise.resolve({ defaults: {}, candidates: {}, estimatedBytes: {} });
      }
      throw new Error(`Unexpected API request: ${path}`);
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <LifecyclePanel space={{ id: "space-1", name: "Demo Space" } as Space} operationsDisabled={false} onChanged={() => undefined} onDeleted={() => undefined} />
      </QueryClientProvider>
    );

    expect(await screen.findByText(/CBM 0\.9\.0 · fast mode · 98% source coverage · 2\.5 s/)).toBeTruthy();
    expect(screen.getByText("200 source files · 4 skipped · 3 excluded directories")).toBeTruthy();
    expect(screen.getByText("4 source files were skipped during indexing")).toBeTruthy();
    queryClient.clear();
  });
});
