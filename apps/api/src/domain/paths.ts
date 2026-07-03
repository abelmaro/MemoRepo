import fs from "node:fs";
import path from "node:path";

export function assertInside(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }

  throw new Error(`Path escapes MEMOREPO_HOME: ${target}`);
}

export function ensureInsideDir(root: string, target: string): string {
  const resolved = assertInside(root, target);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function repoPathName(owner: string, name: string, suffix?: string): string {
  const safe = `${owner}__${name}`
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return suffix ? `${safe}__${suffix}` : safe;
}
