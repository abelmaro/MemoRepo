import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ts from "typescript";

export interface BenchmarkCorpus {
  root: string;
  projects: readonly [string, string];
  symlinkPath: string | null;
  dispose(): void;
}
export interface CorpusMutation {
  added: string;
  edited: string;
  renamedFrom: string;
  renamedTo: string;
  deleted: string;
}
export interface CorpusFile { path: string; bytes: number }
export interface LiteralMatch { path: string; line: number; column: number; text: string }
export interface TypeScriptDeclaration {
  project: string; path: string; line: number;
  kind: "class" | "function" | "interface" | "method" | "type";
  name: string; qualifiedName: string;
}
export interface TypeScriptCall { project: string; path: string; line: number; expression: string; callee: string }
export interface RouteRegistration {
  project: string; path: string; line: number; receiver: string; method: string; route: string;
  sourceKind: "production" | "test";
}

const FILES: Readonly<Record<string, string | Buffer>> = {
  "alpha/src/domain.ts": `
export interface Order { id: string; total: number }
export type OrderId = string;

export class Processor {
  run(order: Order): string {
    validateOrder(order);
    return formatOrder(order);
  }
}

export function validateOrder(order: Order): void {
  if (order.total < 0) throw new Error("invalid order");
}

export function formatOrder(order: Order): string {
  return order.id;
}
`.trimStart(),
  "alpha/src/routes.ts": `
import type { Order } from "./domain.js";

declare const app: {
  get(path: string, handler: () => unknown): void;
  post(path: string, handler: () => unknown): void;
};

app.get("/orders", () => [] as Order[]);
app.post("/orders", () => ({ created: true }));
`.trimStart(),
  "alpha/src/client.ts": `
export async function loadOrders(): Promise<unknown> {
  return fetch("/orders");
}
`.trimStart(),
  "alpha/test/routes.test.ts": `
declare const app: { get(path: string, handler: () => unknown): void };
app.get("/test-only", () => "fixture");
`.trimStart(),
  "alpha/docs/guide.md": "The deterministic documentation sentinel is ORCHID-COMPASS-731.\n",
  "alpha/config/project.json": "{\"feature\":\"benchmark\",\"enabled\":true}\n",
  "alpha/assets/pixel.bin": Buffer.from([0, 1, 2, 0, 255, 10]),
  "alpha/assets/large.txt": "benchmark-line\n".repeat(5_000),
  "alpha/unicode/mañana.ts": "export const greeting = \"¡mañana será mejor!\";\n",
  "beta/src/domain.ts": `
export class Processor {
  run(value: string): string {
    return normalize(value);
  }
}

export function normalize(value: string): string {
  return value.trim().toLowerCase();
}
`.trimStart(),
  "beta/src/routes.ts": `
declare const router: { put(path: string, handler: () => unknown): void };
router.put("/profiles/:id", () => ({ updated: true }));
`.trimStart(),
  "beta/README.md": "A second project intentionally contains homonymous symbols.\n"
};

export function createCbmBenchmarkCorpus(parent = os.tmpdir()): BenchmarkCorpus {
  const root = fs.mkdtempSync(path.join(parent, "memorepo-cbm-corpus-"));
  for (const [relativePath, contents] of Object.entries(FILES)) {
    const target = path.join(root, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  const symlinkPath = path.join(root, "alpha", "linked-beta-src");
  let portableSymlinkPath: string | null = null;
  try {
    fs.symlinkSync(path.join(root, "beta", "src"), symlinkPath, process.platform === "win32" ? "junction" : "dir");
    portableSymlinkPath = portableRelative(root, symlinkPath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "EPERM" && code !== "EACCES" && code !== "ENOSYS") throw error;
  }
  return { root, projects: ["alpha", "beta"], symlinkPath: portableSymlinkPath,
    dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function applyCorpusMutation(root: string): CorpusMutation {
  const mutation: CorpusMutation = {
    added: "alpha/src/added.ts",
    edited: "alpha/src/domain.ts",
    renamedFrom: "alpha/config/project.json",
    renamedTo: "alpha/config/benchmark.json",
    deleted: "beta/README.md"
  };
  fs.writeFileSync(path.join(root, ...mutation.added.split("/")), "export const addedAfterIndex = true;\n");
  fs.appendFileSync(path.join(root, ...mutation.edited.split("/")), "\nexport const editedAfterIndex = true;\n");
  fs.renameSync(path.join(root, ...mutation.renamedFrom.split("/")), path.join(root, ...mutation.renamedTo.split("/")));
  fs.rmSync(path.join(root, ...mutation.deleted.split("/")));
  return mutation;
}

export function inventoryCorpus(root: string): CorpusFile[] {
  const files: CorpusFile[] = [];
  walkRegularFiles(root, (absolutePath) => files.push({
    path: portableRelative(root, absolutePath), bytes: fs.statSync(absolutePath).size
  }));
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

export function searchCorpusLiteral(root: string, query: string): LiteralMatch[] {
  if (query.length === 0) throw new Error("Literal query must not be empty");
  const matches: LiteralMatch[] = [];
  walkRegularFiles(root, (absolutePath) => {
    const payload = fs.readFileSync(absolutePath);
    if (payload.includes(0)) return;
    for (const [lineIndex, line] of payload.toString("utf8").split(/\r?\n/u).entries()) {
      let offset = line.indexOf(query);
      while (offset >= 0) {
        matches.push({ path: portableRelative(root, absolutePath), line: lineIndex + 1, column: offset + 1, text: line });
        offset = line.indexOf(query, offset + query.length);
      }
    }
  });
  return matches.sort(compareLocatedRecords);
}

export function analyzeTypeScriptDeclarations(root: string): TypeScriptDeclaration[] {
  const declarations: TypeScriptDeclaration[] = [];
  for (const sourceFile of createCorpusProgram(root).getSourceFiles()) {
    if (!isWithin(root, sourceFile.fileName)) continue;
    const classes: string[] = [];
    const visit = (node: ts.Node): void => {
      let declaration: Omit<TypeScriptDeclaration, "project" | "path" | "line"> | undefined;
      if (ts.isClassDeclaration(node) && node.name) {
        declaration = namedDeclaration("class", node.name.text, classes);
        classes.push(node.name.text);
        record(declaration, node, sourceFile, root, declarations);
        ts.forEachChild(node, visit);
        classes.pop();
        return;
      }
      if (ts.isFunctionDeclaration(node) && node.name) declaration = namedDeclaration("function", node.name.text, classes);
      if (ts.isInterfaceDeclaration(node)) declaration = namedDeclaration("interface", node.name.text, classes);
      if (ts.isTypeAliasDeclaration(node)) declaration = namedDeclaration("type", node.name.text, classes);
      if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) declaration = namedDeclaration("method", node.name.text, classes);
      if (declaration) record(declaration, node, sourceFile, root, declarations);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return declarations.sort(compareLocatedRecords);
}

export function analyzeTypeScriptCalls(root: string): TypeScriptCall[] {
  const calls: TypeScriptCall[] = [];
  for (const sourceFile of createCorpusProgram(root).getSourceFiles()) {
    if (!isWithin(root, sourceFile.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(sourceFile);
        const callee = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : expression;
        calls.push({ ...location(root, sourceFile, node), expression, callee });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return calls.sort(compareLocatedRecords);
}

export function analyzeRouteRegistrations(root: string): RouteRegistration[] {
  const routes: RouteRegistration[] = [];
  const routeMethods = new Set(["delete", "get", "patch", "post", "put"]);
  for (const sourceFile of createCorpusProgram(root).getSourceFiles()) {
    if (!isWithin(root, sourceFile.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && routeMethods.has(node.expression.name.text) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const base = location(root, sourceFile, node);
        routes.push({ ...base, receiver: node.expression.expression.getText(sourceFile),
          method: node.expression.name.text.toUpperCase(), route: node.arguments[0].text,
          sourceKind: /(^|\/)test(s)?\//u.test(base.path) || /\.test\.[cm]?[jt]sx?$/u.test(base.path) ? "test" : "production" });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return routes.sort(compareLocatedRecords);
}

export function readCorpusSnippet(root: string, relativePath: string, startLine: number, endLine: number): string {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) throw new Error("Invalid snippet line range");
  const absolutePath = path.resolve(root, ...relativePath.split("/"));
  if (!isWithin(root, absolutePath)) throw new Error("Snippet path escapes corpus root");
  return fs.readFileSync(absolutePath, "utf8").split(/\r?\n/u).slice(startLine - 1, endLine).join("\n");
}

function createCorpusProgram(root: string): ts.Program {
  const roots = inventoryCorpus(root).filter((file) => /\.[cm]?tsx?$/u.test(file.path)).map((file) => path.join(root, ...file.path.split("/")));
  return ts.createProgram(roots, { allowJs: false, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
}

function namedDeclaration(kind: TypeScriptDeclaration["kind"], name: string, parents: readonly string[]) {
  return { kind, name, qualifiedName: [...parents, name].join(".") };
}

function record(declaration: Omit<TypeScriptDeclaration, "project" | "path" | "line">, node: ts.Node,
  sourceFile: ts.SourceFile, root: string, declarations: TypeScriptDeclaration[]): void {
  declarations.push({ ...location(root, sourceFile, node), ...declaration });
}

function location(root: string, sourceFile: ts.SourceFile, node: ts.Node) {
  const relativePath = portableRelative(root, sourceFile.fileName);
  return { project: relativePath.split("/", 1)[0] ?? "", path: relativePath,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 };
}

function walkRegularFiles(root: string, visitor: (absolutePath: string) => void): void {
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => right.name.localeCompare(left.name, "en"));
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target); else if (entry.isFile()) visitor(target);
    }
  }
}

function portableRelative(root: string, target: string): string { return path.relative(root, target).split(path.sep).join("/") }
function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function compareLocatedRecords(left: { path: string; line?: number; column?: number }, right: { path: string; line?: number; column?: number }): number {
  return left.path.localeCompare(right.path, "en") || (left.line ?? 0) - (right.line ?? 0) || (left.column ?? 0) - (right.column ?? 0);
}
