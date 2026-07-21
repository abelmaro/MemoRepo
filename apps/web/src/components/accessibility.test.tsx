// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";
import { QueryErrorState } from "./QueryErrorState";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("shared accessible UI", () => {
  it("traps modal focus, closes on Escape, and restores the trigger", () => {
    const appShell = document.createElement("div");
    appShell.className = "app-shell";
    const trigger = document.createElement("button");
    trigger.textContent = "Open dialog";
    appShell.append(trigger);
    document.body.append(appShell);
    trigger.focus();

    const onClose = vi.fn();
    const view = render(
      <Modal title="Accessible dialog" onClose={onClose}>
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </Modal>,
    );

    const dialog = screen.getByRole("dialog", { name: "Accessible dialog" });
    const closeButton = screen.getByRole("button", { name: "Close" });
    const lastButton = screen.getByRole("button", { name: "Last action" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(closeButton);
    expect(appShell.inert).toBe(true);

    lastButton.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    view.unmount();
    expect(document.activeElement).toBe(trigger);
    expect(appShell.inert).toBe(false);
  });

  it("exposes an optional modal back action without changing close behavior", () => {
    const onBack = vi.fn();
    const onClose = vi.fn();
    render(
      <Modal title="Job details" onClose={onClose} onBack={onBack} backLabel="Back to repository batch">
        <span>Job output</span>
      </Modal>
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to repository batch" }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("has no detectable axe violations in shared modal and error states", async () => {
    render(
      <>
        <QueryErrorState title="Connection failed" error={new Error("API unavailable")} onRetry={() => undefined} />
        <Modal title="Accessible dialog" onClose={() => undefined}>
          <button type="button">Continue</button>
        </Modal>
      </>,
    );

    const result = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
