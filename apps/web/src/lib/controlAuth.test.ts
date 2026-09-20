// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("control authentication", () => {
  it("authenticates against localhost when the dashboard is opened on localhost", async () => {
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:8787");
    vi.stubGlobal("location", new URL("http://localhost:5173"));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { validateControlToken } = await import("./api");

    await expect(validateControlToken("test-control-token")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:8787/api/auth/status", {
      headers: { authorization: "Bearer test-control-token" },
    });
  });

  it("reports an invalid token only when the API rejects the credential", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const { validateControlToken } = await import("./api");

    await expect(validateControlToken("invalid-token")).resolves.toBe(false);
  });

  it("explains connection failures without exposing the supplied token", async () => {
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:8787");
    vi.stubGlobal("location", new URL("http://localhost:5173"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { validateControlToken } = await import("./api");

    await expect(validateControlToken("test-control-secret")).rejects.toThrow(
      "Cannot reach the MemoRepo API at http://localhost:8787. Check that the API is running and that the dashboard and API use the same local hostname (localhost or 127.0.0.1).",
    );
  });
});
