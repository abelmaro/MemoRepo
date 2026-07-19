export type EvidenceConfidence = "verified" | "inferred";
export type RouteKind = "server_route" | "client_reference" | "test_fixture";
export type CbmResponseDetail = "compact" | "full";

const COMPACT_OMITTED_KEYS = new Set([
  "fp",
  "sp",
  "bt",
  "fingerprint",
  "internal_metrics",
  "query_plan",
  "query_profile"
]);

export function annotateTraceEdge(
  value: unknown,
  compatible: boolean | undefined,
  relation: "CALLS" | "USAGE" = "CALLS"
): unknown {
  if (!isRecord(value)) return value;
  const verified = compatible === true;
  return {
    ...value,
    relation: typeof value.relation === "string" ? value.relation : relation,
    confidence: verified ? "verified" : "inferred",
    evidence: verified ? "indexed_source" : "static_graph",
    source_kind: verified ? "exact_source" : "static_analysis"
  };
}

export function partitionTraceEdges(values: readonly unknown[]): {
  verifiedEdges: unknown[];
  inferredEdges: unknown[];
} {
  return {
    verifiedEdges: values.filter((value) => isRecord(value) && value.confidence === "verified"),
    inferredEdges: values.filter((value) => !isRecord(value) || value.confidence !== "verified")
  };
}

export function classifyRouteEvidence(filePath: string | undefined, receiver: string | undefined): RouteKind {
  if (filePath && /(?:^|[\\/])(?:test|tests|__tests__|spec|specs)(?:[\\/]|$)|\.(?:test|spec)\.[^\\/]+$/i.test(filePath)) {
    return "test_fixture";
  }
  return receiver && /^(?:app|api|router|route|server|fastify)$/i.test(receiver)
    ? "server_route"
    : "client_reference";
}

export function compactCbmValue(value: unknown, detail: CbmResponseDetail = "compact"): unknown {
  if (detail === "full") return value;
  if (Array.isArray(value)) return value.map((item) => compactCbmValue(item, detail));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) =>
    COMPACT_OMITTED_KEYS.has(key) ? [] : [[key, compactCbmValue(entry, detail)]]
  ));
}

export function evidencePrecisionRecall(expected: readonly string[], actual: readonly string[]): {
  expected: number;
  actual: number;
  truePositive: number;
  precision: number;
  recall: number;
} {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const truePositive = [...actualSet].filter((value) => expectedSet.has(value)).length;
  return {
    expected: expectedSet.size,
    actual: actualSet.size,
    truePositive,
    precision: actualSet.size === 0 ? (expectedSet.size === 0 ? 1 : 0) : truePositive / actualSet.size,
    recall: expectedSet.size === 0 ? 1 : truePositive / expectedSet.size
  };
}

export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
