import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { chromium } from "playwright";

const APP_ROOT = dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = resolve(APP_ROOT, "..", "dist");
const HOST = "127.0.0.1";
const BASE_PATH = "/MemoRepo";
const EXPECTED_HERO = "Give coding agents cross-repository context they can trust.";

/** @type {Record<string, string>} */
const CONTENT_TYPES = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
};

/** @typedef {{ impact: string | null, id: string, help: string, nodes: Array<{ target: string[], failureSummary?: string }> }} AxeViolation */
/** @typedef {{ violations: AxeViolation[] }} AxeResults */

/** @param {unknown} error */
function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

/**
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function existingFile(path) {
  try {
    const result = await stat(path);
    if (result.isDirectory()) {
      return existingFile(join(path, "index.html"));
    }
    return result.isFile() ? path : null;
  } catch {
    return null;
  }
}

/** @param {string} path */
function isInsideDist(path) {
  const fromRoot = relative(DIST_ROOT, path);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== "..");
}

/** @param {string} pathname */
async function resolveRequestPath(pathname) {
  if (pathname === BASE_PATH) {
    return { redirect: `${BASE_PATH}/` };
  }
  if (!pathname.startsWith(`${BASE_PATH}/`)) {
    return { file: null };
  }

  const decoded = decodeURIComponent(pathname.slice(BASE_PATH.length + 1));
  const segments = decoded.split("/").filter(Boolean);
  let candidate = resolve(DIST_ROOT, ...segments);
  if (pathname.endsWith("/")) {
    candidate = join(candidate, "index.html");
  }

  if (!isInsideDist(candidate)) {
    return { file: null };
  }

  return { file: await existingFile(candidate) };
}

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", `http://${HOST}`);
      const resolved = await resolveRequestPath(requestUrl.pathname);

      if (resolved.redirect) {
        response.writeHead(308, { Location: resolved.redirect });
        response.end();
        return;
      }

      let file = resolved.file;
      let statusCode = 200;
      if (!file) {
        file = await existingFile(join(DIST_ROOT, "404.html"));
        statusCode = 404;
      }

      if (!file) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      response.writeHead(statusCode, {
        "Cache-Control": "no-store",
        "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] || "application/octet-stream",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(file).pipe(response);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(formatError(error));
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    /** @param {Error} error */
    const onError = (error) => rejectPromise(error);
    server.once("error", onError);
    server.listen(0, HOST, () => {
      server.off("error", onError);
      resolvePromise(undefined);
    });
  });

  const address = server.address();
  assert(address && typeof address === "object", "Static test server did not expose a port");
  return { server, origin: `http://${HOST}:${address.port}` };
}

/** @param {import("node:http").Server} server */
async function stopServer(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise(undefined)));
  });
}

/** @param {AxeViolation[]} violations */
function formatViolations(violations) {
  return violations
    .map((violation) => {
      const targets = violation.nodes.map((node) => node.target.join(" ")).join(", ");
      return `${violation.impact}: ${violation.id} (${violation.help}) at ${targets}`;
    })
    .join("\n");
}

/**
 * @param {import("playwright").Page} page
 * @param {string} viewportName
 */
async function runAxe(page, viewportName) {
  await page.addScriptTag({ content: axe.source });
  const results = /** @type {AxeResults} */ (
    await page.evaluate(async () => {
      const axeRuntime = /** @type {any} */ (globalThis).axe;
      return axeRuntime.run(document, { resultTypes: ["violations"] });
    })
  );
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  assert.equal(
    blocking.length,
    0,
    `${viewportName} has serious or critical axe violations:\n${formatViolations(blocking)}`,
  );
}

/**
 * @param {import("playwright").Page} page
 * @param {string} viewportName
 */
async function assertNoHorizontalOverflow(page, viewportName) {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert(
    overflow.scrollWidth <= overflow.clientWidth + 1,
    `${viewportName} overflows horizontally: ${overflow.scrollWidth}px > ${overflow.clientWidth}px`,
  );
}

/** @param {import("playwright").Page} page */
async function exerciseMobileNavigation(page) {
  const menu = page.locator("details[data-mobile-nav]");
  const summary = menu.locator("summary");
  assert.equal(await menu.count(), 1, "Expected one details[data-mobile-nav] control");
  assert.equal(await summary.count(), 1, "The mobile navigation needs a summary control");
  assert.equal(await menu.evaluate((element) => element.hasAttribute("open")), false);
  assert.equal(await summary.getAttribute("aria-label"), "Open navigation");
  await summary.focus();
  await summary.press("Enter");
  await page.waitForFunction(() => {
    const menu = document.querySelector("details[data-mobile-nav]");
    const summary = menu?.querySelector("summary");
    return menu?.hasAttribute("open") && summary?.getAttribute("aria-label") === "Close navigation";
  });
  assert.equal(await summary.getAttribute("aria-label"), "Close navigation");
  await summary.press("Escape");
  await page.waitForFunction(() => {
    const menu = document.querySelector("details[data-mobile-nav]");
    const summary = menu?.querySelector("summary");
    return !menu?.hasAttribute("open") && summary?.getAttribute("aria-label") === "Open navigation";
  });
  assert.equal(await summary.getAttribute("aria-label"), "Open navigation");
  assert.equal(await summary.evaluate((element) => element === document.activeElement), true);
}

/** @param {import("playwright").Page} page */
async function exerciseCopyButton(page) {
  const copyButton = page.locator("button[data-copy-button]").first();
  assert((await copyButton.count()) > 0, "Expected at least one keyboard-accessible copy button");
  await copyButton.focus();
  await copyButton.press("Enter");
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll("[data-copy-status]")).some(
      (element) => element.textContent?.trim() === "Copied",
    ),
  );
}

/**
 * @param {import("playwright").Browser} browser
 * @param {string} origin
 * @param {{ name: string, width: number, height: number }} viewport
 */
async function auditViewport(browser, origin, viewport) {
  const context = await browser.newContext({
    bypassCSP: true,
    viewport: { width: viewport.width, height: viewport.height },
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
  /** @type {string[]} */
  const consoleErrors = [];
  /** @type {string[]} */
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(formatError(error)));

  try {
    await page.goto(`${origin}${BASE_PATH}/`, { waitUntil: "networkidle" });
    assert.equal(await page.locator("h1").count(), 1, `${viewport.name} should render one H1`);
    assert.equal(
      (await page.locator("h1").innerText()).replace(/\s+/g, " ").trim(),
      EXPECTED_HERO,
      `${viewport.name} rendered unexpected core content`,
    );
    await assertNoHorizontalOverflow(page, viewport.name);
    if (viewport.width <= 390) {
      const headingLines = await page.locator("h1").evaluate((element) => {
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        return Math.round(element.getBoundingClientRect().height / lineHeight);
      });
      assert(
        headingLines >= 3 && headingLines <= 5,
        `${viewport.name} hero heading uses ${headingLines} lines; expected 3–5`,
      );
    }
    await runAxe(page, viewport.name);

    if (viewport.width === 390 && viewport.height === 844) {
      await exerciseMobileNavigation(page);
      await exerciseCopyButton(page);
    }

    await page.waitForTimeout(50);
    assert.deepEqual(consoleErrors, [], `${viewport.name} console errors:\n${consoleErrors.join("\n")}`);
    assert.deepEqual(pageErrors, [], `${viewport.name} page errors:\n${pageErrors.join("\n")}`);
  } finally {
    await context.close();
  }
}

/**
 * @param {import("playwright").Browser} browser
 * @param {string} origin
 */
async function auditNotFound(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  try {
    const response = await page.goto(`${origin}${BASE_PATH}/missing-page`, { waitUntil: "networkidle" });
    assert.equal(response?.status(), 404, "Missing routes should return the branded 404 page");
    assert.match((await page.locator("h1").innerText()).trim(), /no record of that page/i);
    await exerciseMobileNavigation(page);
    await runAxe(page, "Mobile 404");
    await assertNoHorizontalOverflow(page, "Mobile 404");
  } finally {
    await context.close();
  }
}

/**
 * @param {import("playwright").Browser} browser
 * @param {string} origin
 */
async function auditWithoutJavaScript(browser, origin) {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto(`${origin}${BASE_PATH}/`, { waitUntil: "load" });
    assert(await page.locator("main").isVisible(), "Main content is hidden without JavaScript");
    assert(await page.locator("h1").isVisible(), "The hero heading is hidden without JavaScript");
    assert(await page.locator("#how-it-works").isVisible(), "Workflow content is hidden without JavaScript");
    assert(await page.locator("#security").isVisible(), "Security content is hidden without JavaScript");
    assert(await page.locator("#quickstart").isVisible(), "Quickstart content is hidden without JavaScript");
    assert.match(await page.locator("body").innerText(), /View MemoRepo on GitHub/);
    const visuallyHidden = await page.evaluate((selectors) =>
      selectors.filter((selector) => {
        const element = document.querySelector(selector);
        if (!element) {
          return true;
        }
        const style = getComputedStyle(element);
        return style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;
      }), ["main", "h1", "#how-it-works", "#security", "#quickstart"]);
    assert.deepEqual(
      visuallyHidden,
      [],
      `Core content is visually hidden without JavaScript: ${visuallyHidden.join(", ")}`,
    );
    await assertNoHorizontalOverflow(page, "JavaScript-disabled desktop");
  } finally {
    await context.close();
  }
}

async function main() {
  const { server, origin } = await startServer();
  /** @type {import("playwright").Browser | undefined} */
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    for (const viewport of [
      { name: "320 × 568", width: 320, height: 568 },
      { name: "375 × 667", width: 375, height: 667 },
      { name: "390 × 844", width: 390, height: 844 },
      { name: "768 × 1024", width: 768, height: 1024 },
      { name: "1024 × 768", width: 1024, height: 768 },
      { name: "1280 × 800", width: 1280, height: 800 },
      { name: "1440 × 900", width: 1440, height: 900 },
      { name: "1920 × 1080", width: 1920, height: 1080 },
    ]) {
      await auditViewport(browser, origin, viewport);
    }
    await auditNotFound(browser, origin);
    await auditWithoutJavaScript(browser, origin);
    console.log("Landing accessibility and interaction smoke checks passed.");
  } finally {
    try {
      await browser?.close();
    } finally {
      await stopServer(server);
    }
  }
}

main().catch((error) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
