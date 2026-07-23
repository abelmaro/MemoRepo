const DEFAULT_SITE_ORIGIN = "https://abelmaro.github.io";
const DEFAULT_BASE_PATH = "/MemoRepo";

/** @param {string | undefined} value */
function normalizeOrigin(value) {
  const origin = new URL(value || DEFAULT_SITE_ORIGIN).origin;
  return origin.replace(/\/$/, "");
}

/** @param {string | undefined} value */
function normalizeBasePath(value) {
  const source = String(value || DEFAULT_BASE_PATH).trim();
  if (source === "/") {
    return "/";
  }
  return `/${source.replace(/^\/+|\/+$/g, "")}`;
}

export const SITE_ORIGIN = normalizeOrigin(process.env.SITE_ORIGIN);
export const BASE_PATH = normalizeBasePath(process.env.BASE_PATH);
export const CANONICAL_URL = new URL(BASE_PATH === "/" ? "/" : `${BASE_PATH}/`, `${SITE_ORIGIN}/`).toString();

/** @param {string} [path] */
export function withBase(path = "/") {
  if (/^(?:[a-z]+:|#)/i.test(path)) {
    return path;
  }

  const suffix = path.replace(/^\/+/, "");
  if (BASE_PATH === "/") {
    return suffix ? `/${suffix}` : "/";
  }
  return suffix ? `${BASE_PATH}/${suffix}` : `${BASE_PATH}/`;
}

/** @param {string} [path] */
export function absoluteUrl(path = "/") {
  return new URL(withBase(path), `${SITE_ORIGIN}/`).toString();
}
