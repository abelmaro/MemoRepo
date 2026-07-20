// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SpaceRepository } from "../lib/api";
import { RepositoryRow } from "./RepositoryRow";

afterEach(cleanup);

it("shows a cloned snapshot-only repository as ready", () => {
  const repository: SpaceRepository = {
    id: "repository_1",
    space_id: "space_1",
    github_repository_id: "github_repository_1",
    selected_branch: "main",
    selected_commit: "1234567890abcdef",
    clone_status: "cloned",
    index_status: "stale",
    snapshot_included: 1,
    branches_json: '["main"]',
    last_fetched_at: null,
    last_indexed_at: null,
    last_error: null,
    removed_at: null,
    full_name: "example/repository",
    html_url: "https://github.com/example/repository",
    default_branch: "main",
    private: 1,
    archived: 0,
    fork: 0,
    description: null
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <RepositoryRow
        repository={repository}
        snapshotState="ready"
        onJob={vi.fn()}
        onChanged={vi.fn()}
        operationsDisabled={false}
      />
    </QueryClientProvider>
  );

  expect(screen.getByText("Ready")).toBeTruthy();
  expect(screen.getByText("Available to agents")).toBeTruthy();
  expect(screen.getByText("Included in active snapshot")).toBeTruthy();
  expect(screen.queryByText("Clone or index is incomplete")).toBeNull();
  expect(screen.queryByText("Not indexed yet")).toBeNull();
});
