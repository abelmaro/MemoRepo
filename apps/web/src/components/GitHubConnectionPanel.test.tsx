// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubConnectionPanel } from "./GitHubConnectionPanel";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  api: apiMock
}));

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("GitHubConnectionPanel", () => {
  it("starts device authorization without exposing the private device code", async () => {
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/github/auth/status") {
        return Promise.resolve({ configured: true, connected: false });
      }
      if (path === "/api/github/auth/device" && init?.method === "POST") {
        return Promise.resolve({
          attemptId: "gha_attempt",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          expiresAt: "2026-07-15T12:15:00.000Z",
          intervalSeconds: 60
        });
      }
      if (path === "/api/github/auth/device/gha_attempt") {
        return Promise.resolve({
          status: "pending",
          expiresAt: "2026-07-15T12:15:00.000Z",
          nextPollAt: "2026-07-15T12:00:05.000Z"
        });
      }
      throw new Error(`Unexpected API request: ${path}`);
    });

    renderPanel();
    const connectButton = await screen.findByRole("button", { name: "Connect GitHub" });
    await waitFor(() => expect((connectButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(connectButton);

    expect(await screen.findByText("ABCD-1234")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open github.com/login/device" });
    expect(link.getAttribute("href")).toBe("https://github.com/login/device");
    expect(document.body.textContent).not.toContain("private-device-code");
  });

  it("shows a connected account and confirms local disconnection", async () => {
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/github/auth/status") {
        return Promise.resolve({
          configured: true,
          connected: true,
          viewer: {
            id: 42,
            login: "octocat",
            name: "The Octocat",
            avatarUrl: "https://avatars.example/octocat"
          },
          scopes: ["repo"],
          manageAuthorizationUrl: "https://github.com/settings/connections/applications/client-id"
        });
      }
      if (path === "/api/github/diagnostics") {
        return Promise.resolve({ connected: true, visibleRepositoryCount: 3, visibleOrganizationCount: 1 });
      }
      if (path === "/api/github/auth" && init?.method === "DELETE") {
        return Promise.resolve(undefined);
      }
      throw new Error(`Unexpected API request: ${path}`);
    });

    renderPanel();
    expect(await screen.findByText("@octocat")).toBeTruthy();
    expect(await screen.findByText("3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.getByRole("dialog", { name: "Disconnect GitHub" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect locally" }));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/github/auth", { method: "DELETE" })
    );
  });
});

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <GitHubConnectionPanel />
    </QueryClientProvider>
  );
}
