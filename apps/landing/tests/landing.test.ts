import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import rootPackage from "../../../package.json";

const APP_ROOT = process.cwd();
const DIST_ROOT = join(APP_ROOT, "dist");
const BASE_PATH = "/MemoRepo";
const DEPLOYMENT_URL = "https://abelmaro.github.io/MemoRepo/";
const EXPECTED_TITLE = "MemoRepo — Cross-repository context for coding agents";
const EXPECTED_VERSION = rootPackage.version;
const PRIMARY_CTA = "View MemoRepo on GitHub";

type BuiltPage = {
  readonly document: Document;
  readonly html: string;
};

let indexPage: BuiltPage;
let notFoundPage: BuiltPage;

function builtPath(relativePath: string): string {
  return join(DIST_ROOT, ...relativePath.split("/"));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readBuiltFile(relativePath: string): Promise<string> {
  return readFile(builtPath(relativePath), "utf8");
}

async function loadBuiltPage(relativePath: string): Promise<BuiltPage> {
  const html = await readBuiltFile(relativePath);
  const document = new DOMParser().parseFromString(html, "text/html");
  return { document, html };
}

function normalizedText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function metaContent(document: Document, selector: string): string {
  return document.querySelector<HTMLMetaElement>(selector)?.content.trim() ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function visitJson(value: unknown, visitor: (entry: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => visitJson(entry, visitor));
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  visitor(value);
  Object.values(value).forEach((entry) => visitJson(entry, visitor));
}

function collectAssetUrls(document: Document): string[] {
  const urls: string[] = [];
  const attributes = [
    ["img[src]", "src"],
    ["script[src]", "src"],
    ["source[src]", "src"],
    ["video[poster]", "poster"],
    ["link[href]:not([rel~='canonical'])", "href"],
  ] as const;

  for (const [selector, attribute] of attributes) {
    document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      const value = element.getAttribute(attribute)?.trim();
      if (value) {
        urls.push(value);
      }
    });
  }

  document.querySelectorAll<HTMLElement>("[srcset]").forEach((element) => {
    const value = element.getAttribute("srcset") ?? "";
    value.split(",").forEach((candidate) => {
      const url = candidate.trim().split(/\s+/, 1)[0];
      if (url) {
        urls.push(url);
      }
    });
  });

  return urls;
}

function expectBaseAwareAssets(document: Document): void {
  const urls = collectAssetUrls(document);
  const localUrls = urls.filter((value) => {
    if (/^(?:data|blob):/i.test(value)) {
      return false;
    }

    if (/^https?:/i.test(value)) {
      return new URL(value).origin === new URL(DEPLOYMENT_URL).origin;
    }

    return true;
  });

  expect(localUrls.length, "Expected generated HTML to reference local assets").toBeGreaterThan(0);

  for (const value of localUrls) {
    const path = /^https?:/i.test(value) ? new URL(value).pathname : value;
    expect(path, `Asset path is not scoped to ${BASE_PATH}: ${value}`).toMatch(/^\/MemoRepo\//);
  }
}

function outputPathForUrl(url: URL): string {
  expect(url.origin, `Unexpected internal-link origin for ${url.toString()}`).toBe(
    new URL(DEPLOYMENT_URL).origin,
  );
  expect(
    url.pathname === BASE_PATH || url.pathname.startsWith(`${BASE_PATH}/`),
    `Internal link escaped ${BASE_PATH}: ${url.toString()}`,
  ).toBe(true);

  const route = decodeURIComponent(url.pathname.slice(BASE_PATH.length)).replace(/^\/+/, "");
  if (!route) {
    return builtPath("index.html");
  }

  if (route.endsWith("/")) {
    return builtPath(`${route}index.html`);
  }

  return builtPath(route);
}

async function expectResolvableInternalLinks(page: BuiltPage, pageUrl: string): Promise<void> {
  const anchors = Array.from(page.document.querySelectorAll<HTMLAnchorElement>("a[href]"));
  let internalCount = 0;

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href")?.trim() ?? "";
    expect(href, `Anchor has an empty href: ${normalizedText(anchor.textContent)}`).not.toBe("");
    expect(href.toLowerCase(), "javascript: links are not allowed").not.toMatch(/^javascript:/);

    const resolved = new URL(href, pageUrl);
    if (!['http:', 'https:'].includes(resolved.protocol)) {
      continue;
    }
    if (resolved.origin !== new URL(DEPLOYMENT_URL).origin) {
      continue;
    }

    internalCount += 1;
    const outputPath = outputPathForUrl(resolved);
    expect(
      await fileExists(outputPath),
      `Broken internal link ${href} from ${pageUrl}; expected ${outputPath}`,
    ).toBe(true);

    if (resolved.hash) {
      const targetHtml = await readFile(outputPath, "utf8");
      const targetDocument = new DOMParser().parseFromString(targetHtml, "text/html");
      const targetId = decodeURIComponent(resolved.hash.slice(1));
      expect(
        targetDocument.getElementById(targetId),
        `Missing fragment target ${resolved.hash} for ${href}`,
      ).not.toBeNull();
    }
  }

  expect(internalCount, "Expected at least one internal landing link").toBeGreaterThan(0);
}

async function firstExistingFile(candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    if (await fileExists(builtPath(candidate))) {
      return candidate;
    }
  }

  throw new Error(`None of the expected files exist: ${candidates.join(", ")}`);
}

beforeAll(async () => {
  [indexPage, notFoundPage] = await Promise.all([
    loadBuiltPage("index.html"),
    loadBuiltPage("404.html"),
  ]);
});

describe("landing build output", () => {
  it("keeps the visual system on a compact token scale", async () => {
    const [tokens, globalStyles, heroMap, iconComponent] = await Promise.all([
      readFile(join(APP_ROOT, "src/styles/tokens.css"), "utf8"),
      readFile(join(APP_ROOT, "src/styles/global.css"), "utf8"),
      readFile(join(APP_ROOT, "src/components/HeroMap.astro"), "utf8"),
      readFile(join(APP_ROOT, "src/components/Icon.astro"), "utf8"),
    ]);

    expect(tokens.match(/^\s*--text-[\w-]+:/gm) ?? []).toHaveLength(4);
    expect(tokens.match(/^\s*--color-[\w-]+:/gm) ?? []).toHaveLength(12);
    expect(globalStyles).not.toMatch(/#[\da-f]{3,8}\b/i);
    expect(globalStyles).not.toMatch(/rgb\(/i);
    expect(heroMap).not.toMatch(/#[\da-f]{3,8}\b/i);
    expect(iconComponent).toContain('from "react-icons/lu"');
    expect(iconComponent).not.toMatch(/<svg\b/i);

    const fontSizes = globalStyles.match(/font-size:\s*[^;]+;/g) ?? [];
    expect(fontSizes.length).toBeGreaterThan(0);
    fontSizes.forEach((declaration) => {
      expect(declaration).toMatch(/^font-size:\s*var\(--text-(?:sm|body|title|display)\);$/);
    });
  });

  it("emits the index and branded 404 documents", () => {
    expect(indexPage.html).toMatch(/^<!doctype html>/i);
    expect(notFoundPage.html).toMatch(/^<!doctype html>/i);
    expect(notFoundPage.document.querySelector("title")?.textContent).toContain("MemoRepo");
    expect(notFoundPage.document.querySelectorAll("h1")).toHaveLength(1);
  });

  it("contains complete metadata and structured data", () => {
    const { document } = indexPage;
    const description = metaContent(document, 'meta[name="description"]');
    const canonical = document.querySelector<HTMLLinkElement>('link[rel~="canonical"]')?.href ?? "";
    const ogTitle = metaContent(document, 'meta[property="og:title"]');
    const ogDescription = metaContent(document, 'meta[property="og:description"]');
    const ogUrl = metaContent(document, 'meta[property="og:url"]');
    const ogImage = metaContent(document, 'meta[property="og:image"]');

    expect(normalizedText(document.querySelector("title")?.textContent)).toBe(EXPECTED_TITLE);
    expect(description.length, "Meta description should be substantive").toBeGreaterThan(50);
    expect(canonical).toBe(DEPLOYMENT_URL);
    expect(ogTitle).toBe(EXPECTED_TITLE);
    expect(ogDescription.length, "Open Graph description should be substantive").toBeGreaterThan(50);
    expect(metaContent(document, 'meta[property="og:type"]')).toBe("website");
    expect(ogUrl).toBe(DEPLOYMENT_URL);
    expect(new URL(ogImage).pathname).toMatch(/^\/MemoRepo\//);

    const blocks = Array.from(
      document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
    );
    expect(blocks.length, "Expected JSON-LD metadata").toBeGreaterThan(0);

    const records: Record<string, unknown>[] = [];
    for (const block of blocks) {
      const parsed: unknown = JSON.parse(block.textContent || "null");
      visitJson(parsed, (entry) => records.push(entry));
    }

    expect(records.some((entry) => entry["@context"] === "https://schema.org")).toBe(true);
    for (const expectedType of ["WebSite", "WebPage", "SoftwareApplication"]) {
      expect(
        records.some((entry) => {
          const type = entry["@type"];
          return Array.isArray(type) ? type.includes(expectedType) : type === expectedType;
        }),
        `Missing ${expectedType} structured data`,
      ).toBe(true);
    }

    const application = records.find((entry) => entry["@type"] === "SoftwareApplication");
    expect(application?.["softwareVersion"]).toBe(EXPECTED_VERSION);
  });

  it("renders one H1, the primary CTA, and the repository version", () => {
    const { document } = indexPage;
    const bodyText = normalizedText(document.body.textContent);
    expect(document.querySelectorAll("h1")).toHaveLength(1);

    const primaryCta = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).find(
      (anchor) => normalizedText(anchor.textContent) === PRIMARY_CTA,
    );
    expect(primaryCta, `Missing primary CTA: ${PRIMARY_CTA}`).toBeDefined();
    expect(primaryCta?.href).toBe("https://github.com/abelmaro/MemoRepo");
    expect(bodyText).toMatch(
      new RegExp(`\\b(?:v)?${EXPECTED_VERSION.replaceAll(".", "\\.")}\\b`),
    );
    expect(bodyText).toContain("Free and open source under the MIT License.");
    const generateTokenIndex = bodyText.indexOf("Generate the control token");
    const setTokenIndex = bodyText.indexOf("Set the generated value in .env");
    const startIndex = bodyText.indexOf("Start MemoRepo");
    expect(generateTokenIndex).toBeGreaterThanOrEqual(0);
    expect(setTokenIndex).toBeGreaterThan(generateTokenIndex);
    expect(startIndex).toBeGreaterThan(setTokenIndex);
  });

  it("ships motion as progressive enhancement over complete static content", async () => {
    const groups = indexPage.document.querySelectorAll<HTMLElement>("[data-motion-group]");
    const items = indexPage.document.querySelectorAll<HTMLElement>("[data-motion-item]");
    const wires = indexPage.document.querySelectorAll<SVGPathElement>("[data-motion-wire]");
    const motionSource = await readFile(join(APP_ROOT, "src/scripts/motion.ts"), "utf8");
    const hiddenInitialItems = Array.from(items).filter((item) => {
      const style = item.getAttribute("style") ?? "";
      return /(?:opacity\s*:\s*0|visibility\s*:\s*hidden|display\s*:\s*none)/i.test(style);
    });

    expect(groups.length).toBeGreaterThanOrEqual(15);
    expect(items.length).toBeGreaterThanOrEqual(40);
    expect(wires).toHaveLength(9);
    expect(hiddenInitialItems).toHaveLength(0);
    expect(motionSource).not.toMatch(/strokeDash(?:array|offset)/);
    expect(motionSource).toContain("opacity: [0.8, 1]");
    expect(indexPage.document.querySelector('[data-wire-from="space"][data-wire-to="gateway"]')?.getAttribute("data-wire-axis")).toBe("vertical");
    expect(indexPage.document.querySelector("#wire-gradient-vertical")?.getAttribute("gradientUnits")).toBe("userSpaceOnUse");
    expect(indexPage.document.querySelector("#wire-glow")?.getAttribute("filterUnits")).toBe("userSpaceOnUse");
    expect(indexPage.document.querySelector('script[type="module"][src^="/MemoRepo/assets/"]')).not.toBeNull();
    expect(notFoundPage.document.querySelector('script[type="module"][src]')).toBeNull();
  });

  it("keeps generated asset and internal-link URLs under the Pages base path", async () => {
    expectBaseAwareAssets(indexPage.document);
    expectBaseAwareAssets(notFoundPage.document);
    await expectResolvableInternalLinks(indexPage, DEPLOYMENT_URL);
    await expectResolvableInternalLinks(notFoundPage, `${DEPLOYMENT_URL}404.html`);
  });

  it("emits sitemap, manifest, security, and crawler metadata", async () => {
    const sitemapName = await firstExistingFile(["sitemap.xml", "sitemap-index.xml"]);
    const [sitemap, manifestSource, security, robots] = await Promise.all([
      readBuiltFile(sitemapName),
      readBuiltFile("site.webmanifest"),
      readBuiltFile(".well-known/security.txt"),
      readBuiltFile("robots.txt"),
    ]);

    expect(sitemap).toMatch(/<(?:urlset|sitemapindex)\b/i);
    const sitemapDocument = new DOMParser().parseFromString(sitemap, "application/xml");
    expect(sitemapDocument.querySelector("parsererror")).toBeNull();
    const sitemapLocations = Array.from(sitemapDocument.querySelectorAll("loc"), (element) =>
      normalizedText(element.textContent),
    );
    if (sitemapDocument.documentElement.localName === "sitemapindex") {
      expect(sitemapLocations.length, "Sitemap index should reference a child sitemap").toBeGreaterThan(0);
      const childUrl = new URL(sitemapLocations[0] ?? "", DEPLOYMENT_URL);
      const childSitemap = await readFile(outputPathForUrl(childUrl), "utf8");
      const childDocument = new DOMParser().parseFromString(childSitemap, "application/xml");
      const childLocations = Array.from(childDocument.querySelectorAll("loc"), (element) =>
        normalizedText(element.textContent),
      );
      expect(childLocations).toContain(DEPLOYMENT_URL);
    } else {
      expect(sitemapLocations).toContain(DEPLOYMENT_URL);
    }

    const manifest: unknown = JSON.parse(manifestSource);
    expect(isRecord(manifest)).toBe(true);
    if (!isRecord(manifest)) {
      throw new Error("site.webmanifest must contain a JSON object");
    }

    expect(String(manifest["name"])).toContain("MemoRepo");
    expect(String(manifest["start_url"])).toMatch(/^\/MemoRepo\//);
    const icons = manifest["icons"];
    expect(Array.isArray(icons) && icons.length > 0).toBe(true);
    if (Array.isArray(icons)) {
      icons.forEach((icon) => {
        expect(isRecord(icon)).toBe(true);
        if (isRecord(icon)) {
          expect(String(icon["src"])).toMatch(/^\/MemoRepo\//);
        }
      });
    }

    expect(security).toMatch(/^Contact:\s*https:\/\//im);
    expect(security).toMatch(/^Expires:\s*\S+/im);
    expect(security).toMatch(/^Canonical:\s*https:\/\/abelmaro\.github\.io\/MemoRepo\//im);

    expect(robots).toMatch(/^User-agent:\s*\*/im);
    expect(robots).toContain(`Sitemap: ${DEPLOYMENT_URL}${sitemapName}`);
  });
});
