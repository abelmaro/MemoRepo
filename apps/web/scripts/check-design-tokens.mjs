import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(webRoot, "src");
const stylesRoot = path.join(webRoot, "src", "styles");
const foundationFiles = [
  "tokens.css",
  "typography.css",
  "spacing.css",
  "shape.css",
  "effects.css",
  "motion.css",
  "layers.css",
].map((file) => path.join(stylesRoot, file));
const directColorPattern =
  /#[0-9a-f]{3,8}\b|(?:rgb|rgba|hsl|hsla|lab|lch|oklab|oklch|color)\(/gi;
const tokenizedDeclarationPattern = /^\s*(font-(?:family|size|weight)|line-height|letter-spacing|border(?:-(?:top|right|bottom|left))?|border-radius|outline|outline-offset|box-shadow|z-index|opacity|animation(?:-(?:duration|iteration-count))?|(?:row-|column-)?gap|padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?)\s*:\s*([^;]+);/i;

const sourceFiles = await collectThemeSourceFiles(sourceRoot);
const violations = [];
const tokenSource = foundationFiles
  .map(async (file) => readFile(file, "utf8"));
const combinedTokenSource = (await Promise.all(tokenSource)).join("\n");
const tokenDefinitions = [
  ...combinedTokenSource.matchAll(/(--[a-z0-9-]+)\s*:/gi),
].map((match) => match[1]);
const definedTokens = new Set(
  tokenDefinitions
);
const referencedTokens = new Set();

for (const token of tokenDefinitions) {
  if (tokenDefinitions.indexOf(token) !== tokenDefinitions.lastIndexOf(token)) {
    violations.push(`duplicate token definition ${token}`);
  }
}

for (const file of sourceFiles) {
  const source = await readFile(file, "utf8");
  const isFoundation = foundationFiles.includes(file);
  source.split(/\r?\n/).forEach((line, index) => {
    if (!isFoundation) {
      const matches = line.match(directColorPattern);
      if (matches) {
        violations.push(`${path.relative(webRoot, file)}:${index + 1} ${matches.join(", ")}`);
      }

      const declaration = path.extname(file) === ".css"
        ? line.match(tokenizedDeclarationPattern)
        : null;
      if (declaration && !declaration[2].includes("var(")) {
        violations.push(
          `${path.relative(webRoot, file)}:${index + 1} direct ${declaration[1]} value ${declaration[2]}`
        );
      }
    }

    for (const tokenReference of line.matchAll(/var\((--[a-z0-9-]+)\)/gi)) {
      referencedTokens.add(tokenReference[1]);
      if (!definedTokens.has(tokenReference[1])) {
        violations.push(
          `${path.relative(webRoot, file)}:${index + 1} undefined token ${tokenReference[1]}`
        );
      }
    }
  });
}

for (const token of definedTokens) {
  if (!referencedTokens.has(token)) {
    violations.push(`unused token ${token}`);
  }
}

if (violations.length > 0) {
  console.error("Component styles must use their centralized design tokens:");
  violations.forEach((violation) => console.error(`- ${violation}`));
  process.exitCode = 1;
} else {
  console.log("Design token check passed.");
}

async function collectThemeSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectThemeSourceFiles(fullPath);
      }
      return entry.isFile() && /\.(?:css|ts|tsx)$/.test(entry.name) ? [fullPath] : [];
    })
  );
  return files.flat();
}
