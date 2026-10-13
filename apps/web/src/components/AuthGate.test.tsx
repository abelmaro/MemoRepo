// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearControlToken, getControlToken, setControlToken } from "../lib/api";
import { AuthGate } from "./AuthGate";

afterEach(() => {
  cleanup();
  clearControlToken();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("AuthGate", () => {
  it("unlocks with the unlock link token and removes it from the address bar", async () => {
    window.history.replaceState(null, "", "/?view=spaces#token=link-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    renderGate();

    expect(await screen.findByText("Dashboard")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/auth\/status$/), {
      headers: { authorization: "Bearer link-token" },
    });
    expect(getControlToken()).toBe("link-token");
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?view=spaces");
  });

  it("unlocks when the unlock link is opened in an already loaded tab", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    renderGate();
    expect(await screen.findByText("Unlock MemoRepo")).toBeTruthy();

    window.history.replaceState(null, "", "/#token=link-token");
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(await screen.findByText("Dashboard")).toBeTruthy();
    expect(getControlToken()).toBe("link-token");
    expect(window.location.hash).toBe("");
  });

  it("switches to a new unlock link token while already unlocked", async () => {
    setControlToken("old-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    renderGate();
    expect(await screen.findByText("Dashboard")).toBeTruthy();

    window.history.replaceState(null, "", "/#token=new-token");
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(await screen.findByText("Dashboard")).toBeTruthy();
    expect(getControlToken()).toBe("new-token");
    expect(window.location.hash).toBe("");
  });

  it("rejects an invalid unlock link token without keeping it", async () => {
    window.history.replaceState(null, "", "/#token=stale-token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    renderGate();

    expect(await screen.findByText("The control token is no longer valid.")).toBeTruthy();
    expect(screen.queryByText("Dashboard")).toBeNull();
    expect(getControlToken()).toBeNull();
    expect(window.location.hash).toBe("");
  });
});

function renderGate() {
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <AuthGate>
          <p>Dashboard</p>
        </AuthGate>
      </QueryClientProvider>
    </StrictMode>,
  );
}
