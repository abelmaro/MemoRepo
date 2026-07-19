import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyzeRouteRegistrations, analyzeTypeScriptCalls, analyzeTypeScriptDeclarations, applyCorpusMutation, createCbmBenchmarkCorpus,
  inventoryCorpus, readCorpusSnippet, searchCorpusLiteral } from "./cbmBenchmarkCorpus.js";

test("creates a deterministic, disposable multi-project CBM corpus", () => {
  const corpus = createCbmBenchmarkCorpus();
  try {
    assert.deepEqual(corpus.projects, ["alpha", "beta"]);
    assert.equal(inventoryCorpus(corpus.root).length, 12);
    assert.equal(fs.existsSync(path.join(corpus.root, "alpha", "docs", "guide.md")), true);
    assert.equal(fs.existsSync(path.join(corpus.root, "alpha", "assets", "pixel.bin")), true);
    assert.equal(fs.readFileSync(path.join(corpus.root, "alpha", "unicode", "mañana.ts"), "utf8"), "export const greeting = \"¡mañana será mejor!\";\n");
    assert.ok(fs.statSync(path.join(corpus.root, "alpha", "assets", "large.txt")).size > 64_000);
    if (corpus.symlinkPath) {
      assert.equal(fs.lstatSync(path.join(corpus.root, ...corpus.symlinkPath.split("/"))).isSymbolicLink(), true);
      assert.equal(inventoryCorpus(corpus.root).some((file) => file.path.startsWith(`${corpus.symlinkPath}/`)), false);
    }
  } finally {
    const root = corpus.root; corpus.dispose(); assert.equal(fs.existsSync(root), false);
  }
});

test("applies deterministic add, edit, rename, and delete mutations", () => {
  const corpus = createCbmBenchmarkCorpus();
  try {
    const before = inventoryCorpus(corpus.root).map((file) => file.path);
    const mutation = applyCorpusMutation(corpus.root);
    const after = inventoryCorpus(corpus.root).map((file) => file.path);
    assert.equal(before.includes(mutation.added), false);
    assert.equal(after.includes(mutation.added), true);
    assert.equal(after.includes(mutation.renamedFrom), false);
    assert.equal(after.includes(mutation.renamedTo), true);
    assert.equal(after.includes(mutation.deleted), false);
    assert.deepEqual(searchCorpusLiteral(corpus.root, "editedAfterIndex"), [{
      path: mutation.edited, line: 19, column: 14, text: "export const editedAfterIndex = true;"
    }]);
  } finally { corpus.dispose(); }
});

test("filesystem and literal oracles include unindexed-style files and skip binary payloads", () => {
  const corpus = createCbmBenchmarkCorpus();
  try {
    const inventory = inventoryCorpus(corpus.root);
    assert.ok(inventory.some((file) => file.path === "alpha/config/project.json"));
    assert.ok(inventory.some((file) => file.path === "alpha/assets/pixel.bin"));
    assert.deepEqual(searchCorpusLiteral(corpus.root, "ORCHID-COMPASS-731"), [{ path: "alpha/docs/guide.md", line: 1, column: 45,
      text: "The deterministic documentation sentinel is ORCHID-COMPASS-731." }]);
    assert.deepEqual(searchCorpusLiteral(corpus.root, "¡mañana será mejor!"), [{ path: "alpha/unicode/mañana.ts", line: 1, column: 26,
      text: "export const greeting = \"¡mañana será mejor!\";" }]);
    assert.deepEqual(searchCorpusLiteral(corpus.root, "\u0000"), []);
    assert.throws(() => searchCorpusLiteral(corpus.root, ""), /must not be empty/u);
  } finally { corpus.dispose(); }
});

test("TypeScript declaration oracle preserves qualified homonymous symbols", () => {
  const corpus = createCbmBenchmarkCorpus();
  try {
    const declarations = analyzeTypeScriptDeclarations(corpus.root);
    assert.equal(declarations.filter((entry) => entry.kind === "class" && entry.name === "Processor").length, 2);
    assert.deepEqual(declarations.filter((entry) => entry.kind === "method" && entry.name === "run")
      .map((entry) => `${entry.project}:${entry.qualifiedName}`), ["alpha:Processor.run", "beta:Processor.run"]);
    assert.ok(declarations.some((entry) => entry.kind === "interface" && entry.name === "Order"));
    assert.ok(declarations.some((entry) => entry.kind === "type" && entry.name === "OrderId"));
    assert.ok(declarations.some((entry) => entry.kind === "function" && entry.name === "validateOrder"));
  } finally { corpus.dispose(); }
});

test("TypeScript call and route oracles distinguish calls, production routes, client references, and tests", () => {
  const corpus = createCbmBenchmarkCorpus();
  try {
    const calls = analyzeTypeScriptCalls(corpus.root);
    assert.ok(calls.some((call) => call.project === "alpha" && call.expression === "validateOrder"));
    assert.ok(calls.some((call) => call.project === "alpha" && call.expression === "fetch"));
    assert.ok(calls.some((call) => call.project === "beta" && call.expression === "value.trim().toLowerCase"));
    const routes = analyzeRouteRegistrations(corpus.root);
    assert.deepEqual(routes.map(({ project, method, route, sourceKind }) => ({ project, method, route, sourceKind })), [
      { project: "alpha", method: "GET", route: "/orders", sourceKind: "production" },
      { project: "alpha", method: "POST", route: "/orders", sourceKind: "production" },
      { project: "alpha", method: "GET", route: "/test-only", sourceKind: "test" },
      { project: "beta", method: "PUT", route: "/profiles/:id", sourceKind: "production" }
    ]);
    assert.equal(routes.some((route) => route.path.endsWith("client.ts")), false);
  } finally { corpus.dispose(); }
});

test("snippet oracle returns exact line ranges and rejects traversal", () => {
  const corpus = createCbmBenchmarkCorpus();
  try {
    assert.equal(readCorpusSnippet(corpus.root, "alpha/src/domain.ts", 5, 8),
      "  run(order: Order): string {\n    validateOrder(order);\n    return formatOrder(order);\n  }");
    assert.throws(() => readCorpusSnippet(corpus.root, "../outside.txt", 1, 1), /escapes corpus root/u);
    assert.throws(() => readCorpusSnippet(corpus.root, "alpha/src/domain.ts", 0, 1), /Invalid snippet/u);
  } finally { corpus.dispose(); }
});
