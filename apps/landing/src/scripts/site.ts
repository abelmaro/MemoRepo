type AnalyticsEvent =
  | "github_primary_click"
  | "quickstart_click"
  | "copy_install_command"
  | "docs_mcp_click"
  | "operating_contract_click"
  | "security_policy_click";

export {};

declare global {
  interface Window {
    dispatchMemoRepoEvent?: (event: AnalyticsEvent, detail?: Record<string, string>) => void;
  }
}

window.dispatchMemoRepoEvent ??= () => undefined;

const heroVideo = document.querySelector<HTMLVideoElement>("[data-hero-video]");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function syncHeroVideo() {
  if (!heroVideo) return;
  heroVideo.playbackRate = 0.55;
  if (reducedMotion.matches) {
    heroVideo.pause();
    return;
  }
  void heroVideo.play().catch(() => undefined);
}

reducedMotion.addEventListener("change", syncHeroVideo);
syncHeroVideo();

async function copyText(value: string) {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable");
  }
  await navigator.clipboard.writeText(value);
}

document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const analyticsTarget = target?.closest<HTMLElement>("[data-analytics]");
  const analyticsEvent = analyticsTarget?.dataset.analytics as AnalyticsEvent | undefined;
  if (analyticsEvent) {
    const href = analyticsTarget instanceof HTMLAnchorElement ? analyticsTarget.href : undefined;
    window.dispatchMemoRepoEvent?.(analyticsEvent, href ? { href } : undefined);
  }

  const button = target?.closest<HTMLButtonElement>("[data-copy-button]");
  if (!button) return;

  const code = button.dataset.copyTarget ? document.getElementById(button.dataset.copyTarget) : null;
  const label = button.querySelector<HTMLElement>("[data-copy-button-label]");
  const status = document.querySelector<HTMLElement>("[data-copy-status]");
  if (!code || !label) return;

  const defaultLabel = button.dataset.copyLabel ?? "Copy";
  try {
    await copyText(code.textContent ?? "");
    label.textContent = button.dataset.copiedLabel ?? "Copied";
    if (status) status.textContent = label.textContent;
  } catch {
    label.textContent = button.dataset.copyFailedLabel ?? "Could not copy";
    if (status) status.textContent = label.textContent;
  }

  window.setTimeout(() => {
    label.textContent = defaultLabel;
  }, 1800);
});

for (const details of document.querySelectorAll<HTMLDetailsElement>("[data-mobile-nav]")) {
  const summary = details.querySelector<HTMLElement>("summary");
  const syncNavigationLabel = () => {
    if (!summary) return;
    summary.setAttribute(
      "aria-label",
      details.open
        ? (summary.dataset.closeLabel ?? "Close navigation")
        : (summary.dataset.openLabel ?? "Open navigation"),
    );
  };
  details.addEventListener("toggle", syncNavigationLabel);
  syncNavigationLabel();
  details.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && details.open) {
      details.open = false;
      summary?.focus();
    }
  });
  details.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      details.open = false;
    });
  });
}
