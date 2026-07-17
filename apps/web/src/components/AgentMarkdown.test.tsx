// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AgentMarkdown } from "./AgentMarkdown";

afterEach(cleanup);

it("renders GFM responses and keeps model-provided markup inert", () => {
  render(
    <AgentMarkdown
      content={[
        "## Login flow",
        "",
        "1. **Validate** the request.",
        "2. Call `AuthService.login`.",
        "",
        "| Stage | Result |",
        "| --- | --- |",
        "| Session | Ready |",
        "",
        "[Documentation](https://example.com/docs)",
        "",
        "[Unsafe](javascript:alert(1))",
        "",
        "![Remote image](https://example.com/tracker.png)",
        "",
        "<script>window.markdownWasExecuted = true</script>"
      ].join("\n")}
    />
  );

  expect(screen.getByRole("heading", { name: "Login flow", level: 2 })).toBeTruthy();
  expect(screen.getByText("Validate").tagName).toBe("STRONG");
  expect(screen.getByText("AuthService.login").tagName).toBe("CODE");
  expect(screen.getByRole("table")).toBeTruthy();
  const link = screen.getByRole("link", { name: "Documentation" });
  expect(link.getAttribute("href")).toBe("https://example.com/docs");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(screen.getByText("Unsafe").closest("a")?.getAttribute("href")).toBe("");
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.queryByText(/markdownWasExecuted/)).toBeNull();
});
