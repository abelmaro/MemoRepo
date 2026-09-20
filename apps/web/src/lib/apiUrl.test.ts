import { describe, expect, it } from "vitest";
import { resolveApiUrl } from "./apiUrl";

describe("local API URL", () => {
  it.each([
    [undefined, "localhost", "http://localhost:8787"],
    [undefined, "127.0.0.1", "http://127.0.0.1:8787"],
    ["http://127.0.0.1:9876", "localhost", "http://localhost:9876"],
    ["http://localhost:9876", "127.0.0.1", "http://127.0.0.1:9876"],
    ["https://127.0.0.1:9876/control", "localhost", "https://localhost:9876/control"],
  ])("keeps %s same-site with %s", (configuredUrl, hostname, expected) => {
    expect(resolveApiUrl(configuredUrl, hostname)).toBe(expected);
  });

  it.each([
    ["https://api.example.com", "localhost"],
    ["http://127.0.0.1:8787", "dashboard.example.com"],
    ["http://127.0.0.1:8787", "localhost.example.com"],
    ["http://localhost.example.com:8787", "localhost"],
    ["", "localhost"],
    ["/control", "localhost"],
  ])("preserves %s when the dashboard is %s", (configuredUrl, hostname) => {
    expect(resolveApiUrl(configuredUrl, hostname)).toBe(configuredUrl);
  });
});
