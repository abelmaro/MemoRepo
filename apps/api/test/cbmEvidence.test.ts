import assert from "node:assert/strict";
import test from "node:test";
import {
  annotateTraceEdge,
  classifyRouteEvidence,
  compactCbmValue,
  evidencePrecisionRecall,
  partitionTraceEdges,
  serializedBytes
} from "../src/services/cbmEvidence.js";
import { analyzeRouteRegistrations, createCbmBenchmarkCorpus } from "./cbmBenchmarkCorpus.js";

test("route evidence classification reaches deterministic production precision and recall gates", () => {
  const corpus = createCbmBenchmarkCorpus();
  try {
    const registrations = analyzeRouteRegistrations(corpus.root);
    const expected = registrations
      .filter(({ sourceKind }) => sourceKind === "production")
      .map(routeKey);
    const candidates = [
      ...registrations.map((route) => ({ ...route, kind: classifyRouteEvidence(route.path, route.receiver) })),
      {
        project: "alpha",
        path: "alpha/src/client.ts",
        line: 3,
        receiver: "client",
        method: "GET",
        route: "/orders",
        sourceKind: "production" as const,
        kind: classifyRouteEvidence("alpha/src/client.ts", "client")
      }
    ];
    const actual = candidates.filter(({ kind }) => kind === "server_route").map(routeKey);
    const metrics = evidencePrecisionRecall(expected, actual);

    assert.deepEqual(metrics, {
      expected: 3,
      actual: 3,
      truePositive: 3,
      precision: 1,
      recall: 1
    });
    assert.equal(candidates.find(({ receiver }) => receiver === "client")?.kind, "client_reference");
    assert.equal(candidates.find(({ sourceKind }) => sourceKind === "test")?.kind, "test_fixture");
  } finally {
    corpus.dispose();
  }
});

test("trace evidence partitions verified and inferred edges without promoting unknown evidence", () => {
  const edges = [
    annotateTraceEdge({ qualified_name: "alpha.validateOrder" }, true),
    annotateTraceEdge({ qualified_name: "alpha.formatOrder" }, undefined),
    annotateTraceEdge({ qualified_name: "alpha.callback", relation: "USAGE" }, undefined, "USAGE")
  ];
  const partition = partitionTraceEdges(edges);

  assert.equal(partition.verifiedEdges.length, 1);
  assert.equal(partition.inferredEdges.length, 2);
  assert.equal((partition.verifiedEdges[0] as Record<string, unknown>).evidence, "indexed_source");
  assert.ok(partition.inferredEdges.every((edge) => (edge as Record<string, unknown>).evidence === "static_graph"));
  assert.deepEqual(
    evidencePrecisionRecall(
      ["alpha.validateOrder"],
      partition.verifiedEdges.map((edge) => String((edge as Record<string, unknown>).qualified_name))
    ),
    { expected: 1, actual: 1, truePositive: 1, precision: 1, recall: 1 }
  );
});

test("compact CBM responses reduce deterministic response bytes by at least forty percent", () => {
  const full = {
    results: Array.from({ length: 20 }, (_, index) => ({
      name: `symbol-${index}`,
      qualified_name: `project.symbol-${index}`,
      file_path: `src/symbol-${index}.ts`,
      fp: "f".repeat(160),
      sp: "s".repeat(160),
      bt: ["internal", "profile", index],
      fingerprint: "x".repeat(160),
      internal_metrics: { scanned: 1000, elapsed: index }
    })),
    total: 20
  };
  const compact = compactCbmValue(full);
  const fullBytes = serializedBytes(full);
  const compactBytes = serializedBytes(compact);

  assert.ok(compactBytes <= fullBytes * 0.6, `expected compact ${compactBytes} bytes <= 60% of full ${fullBytes}`);
  assert.equal((compact as { results: Array<{ name: string }> }).results[0]?.name, "symbol-0");
  assert.deepEqual(compactCbmValue(full, "full"), full);
});

function routeKey(route: { project: string; method: string; route: string }): string {
  return `${route.project}:${route.method.toUpperCase()}:${route.route}`;
}
