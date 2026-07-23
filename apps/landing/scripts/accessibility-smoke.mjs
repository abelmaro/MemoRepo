import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { chromium, firefox, webkit } from "playwright";

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
async function assertHeroWires(page) {
  const wireState = await page.locator("[data-motion-wire]").evaluateAll((paths) =>
    paths.map((path) => {
      const geometry = /** @type {SVGGeometryElement} */ (path);
      return {
        d: geometry.getAttribute("d") || "",
        length: typeof geometry.getTotalLength === "function" ? geometry.getTotalLength() : 0,
      };
    }),
  );
  assert(wireState.length > 0, "Expected animated hero wires");
  wireState.forEach((wire, index) => {
    assert(wire.d.length > 0 && !wire.d.includes("NaN"), `Hero wire ${index + 1} has invalid geometry`);
    assert(wire.length > 0, `Hero wire ${index + 1} has no measurable length`);
  });

  const verticalWireState = await page.locator('[data-wire-from="space"][data-wire-to="gateway"]').evaluate((path) => {
    const svg = path.closest("svg");
    const gradient = svg?.querySelector("#wire-gradient-vertical");
    const glow = svg?.querySelector("#wire-glow");
    return {
      axis: path.getAttribute("data-wire-axis"),
      gradientUnits: gradient?.getAttribute("gradientUnits"),
      gradientHeight: Number(gradient?.getAttribute("y2")),
      filterUnits: glow?.getAttribute("filterUnits"),
      filterWidth: Number(glow?.getAttribute("width")),
      viewBoxHeight: svg instanceof SVGSVGElement ? svg.viewBox.baseVal.height : 0,
      viewBoxWidth: svg instanceof SVGSVGElement ? svg.viewBox.baseVal.width : 0,
      stroke: getComputedStyle(path).stroke,
    };
  });
  assert.equal(verticalWireState.axis, "vertical", "Space-to-gateway wire needs an explicit vertical axis");
  assert.equal(verticalWireState.gradientUnits, "userSpaceOnUse", "Vertical wire gradient uses a zero-width box");
  assert.equal(verticalWireState.filterUnits, "userSpaceOnUse", "Vertical wire glow uses a zero-width box");
  assert(
    Math.abs(verticalWireState.gradientHeight - verticalWireState.viewBoxHeight) <= 1,
    "Vertical wire gradient does not cover the responsive map height",
  );
  assert(
    verticalWireState.filterWidth > verticalWireState.viewBoxWidth,
    "Vertical wire glow does not cover the responsive map width",
  );
  assert.notEqual(verticalWireState.stroke, "none", "Space-to-gateway wire has no visible stroke");
}

/**
 * @param {import("playwright").Locator} group
 * @param {string} viewportName
 * @param {number} groupIndex
 */
async function assertCalmReveal(group, viewportName, groupIndex) {
  const minimumOpacity = await group.evaluate((element) => {
    const animatedElements = element.querySelectorAll("[data-motion-item], [data-motion-stage]");
    if (animatedElements.length === 0) return 1;
    return Math.min(...Array.from(animatedElements, (item) => Number(getComputedStyle(item).opacity)));
  });
  assert(
    minimumOpacity >= 0.76,
    `${viewportName} motion group ${groupIndex + 1} drops opacity too aggressively: ${minimumOpacity}`,
  );
}

/**
 * @param {import("playwright").Page} page
 * @param {{ name: string, width: number }} viewport
 */
async function assertRequestedVisualAlignment(page, viewport) {
  const editorialAlignment = await page.locator(".problem-item, .feature-item").evaluateAll((items) =>
    items.map((item) => {
      const icon = item.querySelector(".item-icon .icon");
      const heading = item.querySelector("h3");
      return {
        iconLeft: icon?.getBoundingClientRect().left ?? 0,
        headingLeft: heading?.getBoundingClientRect().left ?? 0,
      };
    }),
  );
  editorialAlignment.forEach((alignment, index) => {
    assert(
      Math.abs(alignment.iconLeft - alignment.headingLeft) <= 2,
      `${viewport.name} editorial card ${index + 1} icon is not aligned with its title`,
    );
  });

  const documentationAlignment = await page.locator(".doc-link").evaluateAll((links) =>
    links.map((link) => {
      const icon = link.querySelector(".doc-link__icon .icon");
      const title = link.querySelector("strong");
      return {
        iconTop: icon?.getBoundingClientRect().top ?? 0,
        titleTop: title?.getBoundingClientRect().top ?? 0,
      };
    }),
  );
  documentationAlignment.forEach((alignment, index) => {
    assert(
      Math.abs(alignment.iconTop - alignment.titleTop) <= 3,
      `${viewport.name} documentation item ${index + 1} icon is not aligned with its title: ${JSON.stringify(alignment)}`,
    );
  });

  const coloredLeftBorders = await page
    .locator(".architecture-figure figcaption p, .quickstart__note, .after-start")
    .evaluateAll((elements) => elements.map((element) => Number.parseFloat(getComputedStyle(element).borderLeftWidth)));
  coloredLeftBorders.forEach((width, index) => {
    assert.equal(width, 0, `${viewport.name} left accent ${index + 1} is still visible`);
  });

  const architectureSpacing = await page.locator(".architecture-flow li").evaluateAll((items) =>
    items.map((item) => {
      const indexRect = item.querySelector(".architecture-flow__index")?.getBoundingClientRect();
      const iconRect = item.querySelector(".architecture-flow__icon")?.getBoundingClientRect();
      return {
        horizontalGap: (iconRect?.left ?? 0) - (indexRect?.right ?? 0),
        verticalGap: (iconRect?.top ?? 0) - (indexRect?.bottom ?? 0),
      };
    }),
  );
  architectureSpacing.forEach((spacing, index) => {
    const gap = viewport.width <= 900 ? spacing.horizontalGap : spacing.verticalGap;
    assert(gap >= 4, `${viewport.name} architecture index ${index + 1} is too close to its icon: ${gap}px`);
  });

  if (viewport.width <= 700) {
    const dashboardRadii = await page.locator(".product-shot").evaluate((figure) => {
      const image = figure.querySelector("img");
      return {
        figure: Number.parseFloat(getComputedStyle(figure).borderTopLeftRadius),
        image: image ? Number.parseFloat(getComputedStyle(image).borderTopLeftRadius) : 0,
      };
    });
    assert.deepEqual(dashboardRadii, { figure: 0, image: 0 }, `${viewport.name} dashboard is still rounded`);
  }
}

/**
 * @param {import("playwright").Page} page
 * @param {string} viewportName
 */
async function exerciseMotionJourney(page, viewportName) {
  await page.waitForFunction(() => document.documentElement.dataset.motionRuntime === "ready");
  const groups = page.locator("[data-motion-group]");
  const groupCount = await groups.count();
  assert(groupCount >= 15, `${viewportName} should expose the complete motion choreography`);

  for (let index = 0; index < groupCount; index += 1) {
    await groups.nth(index).evaluate((element) =>
      element.scrollIntoView({ behavior: "instant", block: "center" }),
    );
    await page.waitForFunction(
      (groupIndex) => {
        const group = document.querySelectorAll("[data-motion-group]")[groupIndex];
        return group?.getAttribute("data-motion-state") !== "armed";
      },
      index,
      { timeout: 4_000 },
    );
    await assertCalmReveal(groups.nth(index), viewportName, index);
    await assertNoHorizontalOverflow(page, `${viewportName} motion group ${index + 1}`);
  }

  try {
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("[data-motion-group]")).every(
          (group) => group.getAttribute("data-motion-state") === "complete",
        ),
      undefined,
      { timeout: 10_000 },
    );
  } catch (error) {
    const incomplete = await page.locator('[data-motion-group]:not([data-motion-state="complete"])').evaluateAll(
      (groups) => groups.map((group) => ({
        className: group.className,
        kind: group.getAttribute("data-motion-kind"),
        state: group.getAttribute("data-motion-state"),
      })),
    );
    throw new Error(`${viewportName} left incomplete motion groups: ${JSON.stringify(incomplete)}`, { cause: error });
  }

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(100);
  const replayedGroups = await page.locator('[data-motion-group]:not([data-motion-state="complete"])').count();
  assert.equal(replayedGroups, 0, `${viewportName} replayed completed scroll animations`);
  await assertHeroWires(page);
}

/**
 * @param {import("playwright").Page} page
 * @param {{ name: string, width: number, height: number }} viewport
 */
async function exerciseAnchorNavigation(page, viewport) {
  const usesMobileNavigation = viewport.width <= 900;
  const navigation = usesMobileNavigation ? ".mobile-nav nav" : ".desktop-nav";
  const links = page.locator(`${navigation} a[href*="#"]`);
  const linkCount = await links.count();
  assert.equal(linkCount, 5, `${viewport.name} should expose five section links`);

  for (let index = 0; index < linkCount; index += 1) {
    if (usesMobileNavigation) {
      const menu = page.locator("details[data-mobile-nav]");
      if (!(await menu.evaluate((element) => element.hasAttribute("open")))) {
        await menu.locator("summary").click();
      }
    }

    const href = await links.nth(index).getAttribute("href");
    assert(href, `${viewport.name} navigation link ${index + 1} has no href`);
    const targetId = new URL(href, "http://localhost").hash.slice(1);
    assert(targetId, `${viewport.name} navigation link ${index + 1} has no hash target`);

    const expectedAlignment = await page.evaluate((id) => {
      const header = document.querySelector(".site-header");
      const target = document.getElementById(id);
      const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
      const targetDocumentTop = (target?.getBoundingClientRect().top ?? 0) + window.scrollY;
      const maximumScroll = document.documentElement.scrollHeight - window.innerHeight;
      const expectedScrollY = Math.min(Math.max(targetDocumentTop - headerBottom, 0), maximumScroll);
      return {
        expectedScrollY,
        expectedTargetTop: targetDocumentTop - expectedScrollY,
      };
    }, targetId);

    await links.nth(index).click();
    try {
      await page.waitForFunction(
        (expectedScrollY) => {
          return Math.abs(window.scrollY - expectedScrollY) <= 2;
        },
        expectedAlignment.expectedScrollY,
        { timeout: 4_000 },
      );
    } catch (error) {
      const failedAlignment = await page.evaluate((id) => {
        const header = document.querySelector(".site-header");
        const target = document.getElementById(id);
        return {
          headerBottom: header?.getBoundingClientRect().bottom ?? 0,
          targetTop: target?.getBoundingClientRect().top ?? 0,
          scrollY: window.scrollY,
        };
      }, targetId);
      throw new Error(
        `${viewport.name} #${targetId} did not settle below the header: ${JSON.stringify({ ...failedAlignment, expected: expectedAlignment })}`,
        { cause: error },
      );
    }

    const alignment = await page.evaluate((id) => {
      const header = document.querySelector(".site-header");
      const target = document.getElementById(id);
      return {
        headerBottom: header?.getBoundingClientRect().bottom ?? 0,
        targetTop: target?.getBoundingClientRect().top ?? 0,
      };
    }, targetId);
    assert(
      alignment.targetTop >= alignment.headerBottom - 2,
      `${viewport.name} #${targetId} is hidden by the header: target ${alignment.targetTop}px, header ${alignment.headerBottom}px`,
    );
    assert(
      Math.abs(alignment.targetTop - expectedAlignment.expectedTargetTop) <= 2,
      `${viewport.name} #${targetId} is not at its closest valid position: target ${alignment.targetTop}px, expected ${expectedAlignment.expectedTargetTop}px`,
    );

    if (usesMobileNavigation) {
      assert.equal(
        await page.locator("details[data-mobile-nav]").evaluate((element) => element.hasAttribute("open")),
        false,
        `${viewport.name} mobile navigation stayed open after selecting #${targetId}`,
      );
    }
  }
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

/** @param {import("playwright").Page} page */
async function exerciseDisclosureControls(page) {
  for (const selector of [".platform-details", ".faq-list details"]) {
    const details = page.locator(selector).first();
    const summary = details.locator("summary");
    await summary.scrollIntoViewIfNeeded();
    await summary.focus();
    await summary.press("Enter");
    await page.waitForFunction(
      (targetSelector) => document.querySelector(targetSelector)?.hasAttribute("open") === true,
      selector,
    );
    assert.equal(await details.evaluate((element) => element.hasAttribute("open")), true);
    await summary.press("Enter");
    await page.waitForFunction(
      (targetSelector) => document.querySelector(targetSelector)?.hasAttribute("open") === false,
      selector,
    );
  }
}

/**
 * @param {import("playwright").Browser} browser
 * @param {string} origin
 * @param {{ name: string, width: number, height: number }} viewport
 */
async function auditViewport(browser, origin, viewport) {
  const context = await browser.newContext({
    bypassCSP: true,
    hasTouch: viewport.width <= 844,
    viewport: { width: viewport.width, height: viewport.height },
  });
  const clipboardPermissionsGranted = browser.browserType().name() === "chromium";
  if (clipboardPermissionsGranted) {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  }
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
    await exerciseMotionJourney(page, viewport.name);
    await assertRequestedVisualAlignment(page, viewport);
    await exerciseAnchorNavigation(page, viewport);
    await runAxe(page, viewport.name);

    if (viewport.width <= 900) {
      await exerciseMobileNavigation(page);
    }

    if (viewport.width === 390 && viewport.height === 844 && clipboardPermissionsGranted) {
      await exerciseCopyButton(page);
    }

    if (viewport.width === 390 && viewport.height === 844) {
      await exerciseDisclosureControls(page);
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

/**
 * @param {import("playwright").Browser} browser
 * @param {string} origin
 * @param {{ name: string, width: number, height: number }} viewport
 */
async function auditReducedMotion(browser, origin, viewport) {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();

  try {
    await page.goto(`${origin}${BASE_PATH}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.documentElement.dataset.motionRuntime === "reduced");
    const incompleteGroups = await page.locator('[data-motion-group]:not([data-motion-state="complete"])').count();
    assert.equal(incompleteGroups, 0, `${viewport.name} reduced motion left incomplete groups`);

    const videoState = await page.locator("[data-hero-video]").evaluate((video) => ({
      display: getComputedStyle(video).display,
      paused: /** @type {HTMLVideoElement} */ (video).paused,
    }));
    assert.equal(videoState.display, "none", `${viewport.name} reduced motion should hide the hero video`);
    assert.equal(videoState.paused, true, `${viewport.name} reduced motion should pause the hero video`);

    const runningMotion = await page.evaluate(() =>
      document.getAnimations().filter((animation) => {
        const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        return animation.playState === "running" && target instanceof Element && target.closest("[data-motion-group]");
      }).length,
    );
    assert.equal(runningMotion, 0, `${viewport.name} reduced motion has active group animations`);

    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
    await assertNoHorizontalOverflow(page, `${viewport.name} reduced motion`);
    await runAxe(page, `${viewport.name} reduced motion`);
  } finally {
    await context.close();
  }
}

/**
 * @param {import("playwright").Browser} browser
 * @param {string} origin
 */
async function auditMotionPreferenceChange(browser, origin) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${origin}${BASE_PATH}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.documentElement.dataset.motionRuntime === "ready");
    const workflow = page.locator('[data-motion-kind="workflow"]');
    await workflow.evaluate((element) => element.scrollIntoView({ behavior: "instant", block: "center" }));
    await page.waitForFunction(() =>
      document.querySelector('[data-motion-kind="workflow"]')?.getAttribute("data-motion-state") === "running",
    );

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() =>
      document.documentElement.dataset.motionRuntime === "reduced" &&
      Array.from(document.querySelectorAll("[data-motion-group]")).every(
        (group) => group.getAttribute("data-motion-state") === "complete",
      ),
    );
    const videoState = await page.locator("[data-hero-video]").evaluate((video) => ({
      display: getComputedStyle(video).display,
      paused: /** @type {HTMLVideoElement} */ (video).paused,
    }));
    assert.equal(videoState.display, "none");
    assert.equal(videoState.paused, true);

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(() => document.documentElement.dataset.motionRuntime === "ready");
    await assertNoHorizontalOverflow(page, "Live reduced-motion preference change");
  } finally {
    await context.close();
  }
}

/**
 * @param {import("playwright").Browser} browser
 * @param {string} origin
 * @param {{ name: string, width: number, height: number }} viewport
 */
async function auditBreakpoint(browser, origin, viewport) {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();
  try {
    await page.goto(`${origin}${BASE_PATH}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.documentElement.dataset.motionRuntime === "reduced");
    for (const position of [0, 0.33, 0.66, 1]) {
      await page.evaluate((progress) => {
        const maximum = document.documentElement.scrollHeight - document.documentElement.clientHeight;
        window.scrollTo({ top: maximum * progress, behavior: "instant" });
      }, position);
      await assertNoHorizontalOverflow(page, viewport.name);
    }
  } finally {
    await context.close();
  }
}

/**
 * @param {import("playwright").Browser} browser
 * @param {string} origin
 * @param {{ name: string, from: { width: number, height: number }, to: { width: number, height: number } }} scenario
 */
async function auditOrientationChange(browser, origin, scenario) {
  const context = await browser.newContext({ viewport: scenario.from });
  const page = await context.newPage();
  try {
    await page.goto(`${origin}${BASE_PATH}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.documentElement.dataset.motionRuntime === "ready");
    await assertHeroWires(page);
    await page.setViewportSize(scenario.to);
    await page.waitForTimeout(150);
    await assertNoHorizontalOverflow(page, `${scenario.name} after rotation`);
    await assertHeroWires(page);
    await page.setViewportSize(scenario.from);
    await page.waitForTimeout(150);
    await assertNoHorizontalOverflow(page, `${scenario.name} after restoring orientation`);
    await assertHeroWires(page);
  } finally {
    await context.close();
  }
}

async function main() {
  const { server, origin } = await startServer();
  /** @type {import("playwright").Browser[]} */
  const openBrowsers = [];

  const primaryViewports = [
    { name: "Mobile portrait 320 × 568", width: 320, height: 568 },
    { name: "Mobile portrait 390 × 844", width: 390, height: 844 },
    { name: "Mobile landscape 568 × 320", width: 568, height: 320 },
    { name: "Mobile landscape 844 × 390", width: 844, height: 390 },
    { name: "Tablet portrait 768 × 1024", width: 768, height: 1024 },
    { name: "Tablet portrait 820 × 1180", width: 820, height: 1180 },
    { name: "Tablet landscape 1024 × 768", width: 1024, height: 768 },
    { name: "Tablet landscape 1180 × 820", width: 1180, height: 820 },
    { name: "Desktop portrait 1080 × 1920", width: 1080, height: 1920 },
    { name: "Desktop 1280 × 800", width: 1280, height: 800 },
    { name: "Desktop 1440 × 900", width: 1440, height: 900 },
    { name: "Desktop 1920 × 1080", width: 1920, height: 1080 },
  ];
  const representativeViewports = [
    { name: "Mobile portrait 390 × 844", width: 390, height: 844 },
    { name: "Mobile landscape 844 × 390", width: 844, height: 390 },
    { name: "Tablet portrait 768 × 1024", width: 768, height: 1024 },
    { name: "Tablet landscape 1024 × 768", width: 1024, height: 768 },
    { name: "Desktop portrait 1080 × 1920", width: 1080, height: 1920 },
    { name: "Desktop 1440 × 900", width: 1440, height: 900 },
  ];
  const breakpointViewports = [383, 384, 385, 699, 700, 701, 899, 900, 901, 1151, 1152, 1153].map((width) => ({
    name: `Breakpoint ${width} × 900`,
    width,
    height: 900,
  }));

  try {
    const chromiumBrowser = await chromium.launch({ headless: true });
    openBrowsers.push(chromiumBrowser);
    for (const viewport of primaryViewports) {
      await auditViewport(chromiumBrowser, origin, { ...viewport, name: `Chromium ${viewport.name}` });
    }
    for (const viewport of representativeViewports) {
      await auditReducedMotion(chromiumBrowser, origin, { ...viewport, name: `Chromium ${viewport.name}` });
    }
    await auditMotionPreferenceChange(chromiumBrowser, origin);
    for (const viewport of breakpointViewports) {
      await auditBreakpoint(chromiumBrowser, origin, viewport);
    }
    for (const scenario of [
      {
        name: "Mobile orientation",
        from: { width: 390, height: 844 },
        to: { width: 844, height: 390 },
      },
      {
        name: "Tablet orientation",
        from: { width: 768, height: 1024 },
        to: { width: 1024, height: 768 },
      },
    ]) {
      await auditOrientationChange(chromiumBrowser, origin, scenario);
    }
    await auditNotFound(chromiumBrowser, origin);
    await auditWithoutJavaScript(chromiumBrowser, origin);
    await chromiumBrowser.close();
    openBrowsers.splice(openBrowsers.indexOf(chromiumBrowser), 1);

    const crossBrowserTypes = /** @type {Array<[string, import("playwright").BrowserType]>} */ ([
      ["Firefox", firefox],
      ["WebKit", webkit],
    ]);
    for (const [browserName, browserType] of crossBrowserTypes) {
      const browser = await browserType.launch({ headless: true });
      openBrowsers.push(browser);
      for (const viewport of representativeViewports) {
        await auditViewport(browser, origin, { ...viewport, name: `${browserName} ${viewport.name}` });
      }
      await browser.close();
      openBrowsers.splice(openBrowsers.indexOf(browser), 1);
    }
    console.log("Landing motion, accessibility, responsive, and interaction checks passed.");
  } finally {
    try {
      await Promise.all(openBrowsers.map((browser) => browser.close()));
    } finally {
      await stopServer(server);
    }
  }
}

main().catch((error) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
