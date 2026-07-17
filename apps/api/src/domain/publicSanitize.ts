import path from "node:path";

export function sanitizePublicMessage(value: unknown, managedRoots: string[]): string {
  let message = value instanceof Error ? value.message : String(value);
  for (const root of managedRoots) {
    if (!root) {
      continue;
    }
    const plainVariants = [root, path.resolve(root), root.replaceAll("\\", "/"), root.replaceAll("/", "\\")];
    const variants = new Set(plainVariants.flatMap((variant) => [variant, JSON.stringify(variant).slice(1, -1)]));
    for (const variant of variants) {
      message = replaceCaseInsensitive(message, variant, "[MANAGED_PATH]");
    }
  }
  return message;
}

function replaceCaseInsensitive(value: string, target: string, replacement: string): string {
  if (!target) {
    return value;
  }
  let result = value;
  let searchFrom = 0;
  while (searchFrom < result.length) {
    const index = result.toLocaleLowerCase().indexOf(target.toLocaleLowerCase(), searchFrom);
    if (index === -1) {
      break;
    }
    result = `${result.slice(0, index)}${replacement}${result.slice(index + target.length)}`;
    searchFrom = index + replacement.length;
  }
  return result;
}
