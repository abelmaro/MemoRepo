// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Space } from "./lib/api";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("./lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/api")>()),
  api: apiMock,
}));

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
  AddRepoModal: ({ space, onBatch }: { space: Space; onBatch: (batchId: string) => void }) => (
    <button type="button" data-space-id={space.id} onClick={() => onBatch("batch-1")}>Create repository batch</button>
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

beforeEach(() => {
  apiMock.mockImplementation(() => new Promise(() => undefined));
});

afterEach(() => {
  cleanup();
  apiMock.mockReset();
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
  it.each([
    { connected: true, repositoryPickerOpen: true },
    { connected: false, repositoryPickerOpen: false },
  ])("selects the first created Space and opens the repository picker only when GitHub is connected ($connected)", async ({
    connected,
    repositoryPickerOpen,
  }) => {
    let spaces: Space[] = [];
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/spaces" && init?.method === "POST") {
        spaces = [CREATED_SPACE];
        return Promise.resolve({ space: CREATED_SPACE });
      }
      if (path === "/api/spaces") {
        return Promise.resolve({ spaces });
      }
      return new Promise(() => undefined);
    });
    const queryClient = createSpaceQueryClient([], connected);

    renderApp(queryClient);
    submitSpaceName(screen.getByRole("textbox", { name: "Space name" }), "Analytics");

    expect(await screen.findByRole("heading", { level: 1, name: "Analytics" })).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith("/api/spaces", { method: "POST", body: JSON.stringify({ name: "Analytics" }) });
    expect(Boolean(screen.queryByRole("button", { name: "Create repository batch" }))).toBe(repositoryPickerOpen);
    queryClient.clear();
  });

  it("opens the repository picker for a Space created from the modal even when refreshing Spaces fails", async () => {
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/spaces" && init?.method === "POST") {
        return Promise.resolve({ space: CREATED_SPACE });
      }
      if (path === "/api/spaces") {
        return Promise.reject(new Error("Spaces are unavailable"));
      }
      return new Promise(() => undefined);
    });
    const queryClient = createSpaceQueryClient([EXISTING_SPACE], true);

    renderApp(queryClient);
    fireEvent.click(screen.getByRole("button", { name: "Create Space" }));
    const dialog = screen.getByRole("dialog", { name: "New Space" });
    submitSpaceName(within(dialog).getByRole("textbox", { name: "Space name" }), "Analytics");

    expect(await screen.findByRole("heading", { level: 1, name: "Analytics" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "New Space" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create repository batch" }).getAttribute("data-space-id")).toBe(CREATED_SPACE.id);
    queryClient.clear();
  });

  it("keeps the first Space form and reports the error when creation fails", async () => {
    apiMock.mockImplementation((path: string, init?: RequestInit) =>
      path === "/api/spaces" && init?.method === "POST"
        ? Promise.reject(new Error("A Space with this name already exists"))
        : new Promise(() => undefined),
    );
    const queryClient = createSpaceQueryClient([], true);

    renderApp(queryClient);
    const nameInput = screen.getByRole("textbox", { name: "Space name" });
    submitSpaceName(nameInput, "Analytics");

    expect((await screen.findByRole("alert")).textContent).toBe("A Space with this name already exists");
    expect((nameInput as HTMLInputElement).value).toBe("Analytics");
    expect(screen.getByRole("heading", { level: 1, name: "MemoRepo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create repository batch" })).toBeNull();
    queryClient.clear();
  });
});

const EXISTING_SPACE: Space = {
  id: "space-existing",
  name: "Billing",
  slug: "billing",
  active_snapshot_id: null,
  snapshot_status: "ready",
  repository_count: 0,
};

const CREATED_SPACE: Space = {
  id: "space-new",
  name: "Analytics",
  slug: "analytics",
  active_snapshot_id: null,
  snapshot_status: "ready",
  repository_count: 0,
};

function createSpaceQueryClient(spaces: Space[], githubConnected: boolean): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(["spaces"], { spaces });
  queryClient.setQueryData(["jobs"], { jobs: [] });
  queryClient.setQueryData(["github-auth-status"], { authenticationMode: "oauth", connected: githubConnected });
  for (const space of [...spaces, CREATED_SPACE]) {
    queryClient.setQueryData(["space", space.id], { space, repositories: [], removedRepositories: [] });
  }
  return queryClient;
}

function renderApp(queryClient: QueryClient) {
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

function submitSpaceName(input: HTMLElement, name: string) {
  fireEvent.change(input, { target: { value: name } });
  fireEvent.submit(input.closest("form")!);
}
