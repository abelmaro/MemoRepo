import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCbmV0110Result } from "../src/services/cbmV0110Results.js";

test("compact graph rows preserve identity, paths, ranges and pagination", () => {
  assert.deepEqual(normalizeCbmV0110Result("search_graph", {
    cols: ["qn", "label", "file", "lines", "rank"],
    rows: [["sample.src.validate", "Function", "src/domain.ts", "11-13", -14]],
    total: 2, has_more: true
  }), {
    results: [{ name: "validate", qualified_name: "sample.src.validate", label: "Function", file_path: "src/domain.ts", start_line: 11, end_line: 13, rank: -14 }],
    total: 2, has_more: true
  });
});

test("grouped graph and trace rows expand without losing resolver evidence", () => {
  const table = { cols: ["name", "hop", "strategy", "confidence"], groups: [
    { qn_prefix: "sample.src.Processor", file: "src/domain.ts", rows: [["run", 1, "lsp", 0.95]] }
  ] };
  assert.deepEqual(normalizeCbmV0110Result("trace_path", { callers: table }), {
    callers: [{ name: "run", hop: 1, strategy: "lsp", confidence: 0.95, qualified_name: "sample.src.Processor.run", file_path: "src/domain.ts" }]
  });
});

test("code search expands raw matches and rejects malformed rows", () => {
  assert.deepEqual(normalizeCbmV0110Result("search_code", {
    cols: ["qn"], rows: [], raw_matches: { cols: ["file", "line", "content"], rows: [["notes.md", 3, "needle"]] }
  }), { results: [], raw_matches: [{ file_path: "notes.md", line: 3, content: "needle" }] });
  assert.throws(() => normalizeCbmV0110Result("search_graph", { cols: ["qn"], rows: [[]] }), /invalid table row/u);
});

test("graph query columns remain compatible without rewriting user projections", () => {
  assert.deepEqual(normalizeCbmV0110Result("query_graph", { cols: ["qn"], rows: [["value"]] }), {
    columns: ["qn"], rows: [["value"]]
  });
});
