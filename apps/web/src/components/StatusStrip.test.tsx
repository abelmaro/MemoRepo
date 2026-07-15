// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StatusStrip } from "./StatusStrip";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  api: apiMock
}));

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

it("offers GitHub sign-in directly from the disconnected system alert", async () => {
  const onSignInGitHub = vi.fn();
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/system") {
      return Promise.resolve({
        github: { connected: false },
        codebaseMemory: { installed: true, version: "1.0.0" },
        jobConcurrency: 2
      });
    }
    if (path === "/api/spaces/space_1/mcp-connections") {
      return Promise.resolve({ connections: [] });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <StatusStrip
        space={{
          id: "space_1",
          name: "Demo",
          slug: "demo",
          active_snapshot_id: null,
          snapshot_status: "empty"
        }}
        repositories={[]}
        loading={false}
        snapshotSummary={{ state: "ready", excludedRepositoryCount: 0, latestSnapshotJob: null }}
        onConnectAgent={vi.fn()}
        onAddRepository={vi.fn()}
        onSignInGitHub={onSignInGitHub}
        onOpenSnapshotJob={vi.fn()}
        operationsDisabled={false}
      />
    </QueryClientProvider>
  );

  const signInButton = await screen.findByRole("button", { name: "Sign in with GitHub" });
  expect(screen.getByText("GitHub isn't connected. Sign in to sync repositories.")).toBeTruthy();
  fireEvent.click(signInButton);
  expect(onSignInGitHub).toHaveBeenCalledTimes(1);
});
