import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpToolDescriptor } from "../src/services/cbmService.js";
import {
  assertCbmV090Compatible,
  CBM_V090_OPTIONAL_TOOLS,
  CBM_V090_REQUIRED_TOOLS,
  CbmV090CompatibilityError,
  inspectCbmV090Capabilities
} from "../src/services/cbmV090Capabilities.js";

test("CBM v0.9.0 capabilities accept the pinned runtime and detect every native field", () => {
  const capabilities = inspectCbmV090Capabilities(
    "codebase-memory-mcp 0.9.0",
    completeDescriptors()
  );

  assert.equal(capabilities.compatible, true);
  assert.equal(capabilities.adapterVersion, "0.9.0");
  assert.equal(capabilities.detectedVersion, "0.9.0");
  assert.deepEqual(capabilities.requiredTools, {
    available: [...CBM_V090_REQUIRED_TOOLS],
    missing: []
  });
  assert.deepEqual(capabilities.optionalTools, {
    available: [...CBM_V090_OPTIONAL_TOOLS],
    missing: []
  });
  assert.deepEqual(capabilities.nativeFields, {
    get_architecture: { path: true },
    search_graph: {
      semantic_query: true,
      qn_pattern: true,
      relationship: true,
      exclude_entry_points: true,
      include_connected: true
    },
    search_code: {
      file_pattern: true,
      path_filter: true,
      mode: true,
      context: true
    },
    trace_path: {
      mode: true,
      parameter_name: true,
      edge_types: true,
      risk_labels: true,
      include_tests: true
    }
  });
  assert.equal(capabilities.semanticSearch, true);
  assert.deepEqual(capabilities.diagnostics, []);
  assert.equal(capabilities.summary, "CBM 0.9.0 is compatible; all known optional tools are available.");
});

test("CBM v0.9.0 reports missing optional tools without making the runtime incompatible", () => {
  const descriptors = completeDescriptors().filter(({ name }) => !CBM_V090_OPTIONAL_TOOLS.includes(
    name as typeof CBM_V090_OPTIONAL_TOOLS[number]
  ));
  const capabilities = assertCbmV090Compatible("v0.9.0", descriptors);

  assert.equal(capabilities.compatible, true);
  assert.deepEqual(capabilities.optionalTools, {
    available: [],
    missing: ["detect_changes", "index_repository"]
  });
  assert.match(capabilities.summary, /optional tools unavailable: detect_changes, index_repository/);
});

test("CBM v0.9.0 reports every missing required tool and fails closed", () => {
  const descriptors = completeDescriptors().filter(({ name }) => name !== "query_graph" && name !== "trace_path");
  const capabilities = inspectCbmV090Capabilities("0.9.0", descriptors);

  assert.equal(capabilities.compatible, false);
  assert.deepEqual(capabilities.requiredTools.missing, ["trace_path", "query_graph"]);
  assert.deepEqual(
    capabilities.diagnostics.filter(({ severity }) => severity === "error").map(({ code }) => code),
    ["missing_required_tools"]
  );
  assert.match(capabilities.summary, /missing required tools: trace_path, query_graph/);
  assert.throws(
    () => assertCbmV090Compatible("0.9.0", descriptors),
    (error: unknown) => error instanceof CbmV090CompatibilityError
      && error.capabilities.requiredTools.missing.join(",") === "trace_path,query_graph"
      && error.message === capabilities.summary
  );
});

for (const version of [
  { reported: "codebase-memory-mcp 0.8.1", detected: "0.8.1" },
  { reported: "codebase-memory-mcp 0.9.1", detected: "0.9.1" },
  { reported: "codebase-memory-mcp 0.9.0-rc.1", detected: "0.9.0-rc.1" },
  { reported: "unknown", detected: null }
] as const) {
  test(`CBM v0.9.0 rejects unsupported version '${version.reported}'`, () => {
    const capabilities = inspectCbmV090Capabilities(version.reported, completeDescriptors());

    assert.equal(capabilities.compatible, false);
    assert.equal(capabilities.detectedVersion, version.detected);
    assert.equal(capabilities.diagnostics[0]?.code, "unsupported_version");
    assert.match(capabilities.summary, /expected version 0\.9\.0/);
  });
}

test("CBM v0.9.0 detects native fields independently from inputSchema.properties", () => {
  const descriptors = completeDescriptors().map((descriptor) => descriptor.name === "search_graph"
    ? tool("search_graph", ["semantic_query", "relationship", "unrelated_field"])
    : descriptor.name === "trace_path"
      ? tool("trace_path", ["include_tests"])
      : descriptor);
  const capabilities = inspectCbmV090Capabilities("0.9.0", descriptors);

  assert.deepEqual(capabilities.nativeFields.search_graph, {
    semantic_query: true,
    qn_pattern: false,
    relationship: true,
    exclude_entry_points: false,
    include_connected: false
  });
  assert.deepEqual(capabilities.nativeFields.trace_path, {
    mode: false,
    parameter_name: false,
    edge_types: false,
    risk_labels: false,
    include_tests: true
  });
  assert.equal(capabilities.semanticSearch, true);
});

test("CBM v0.9.0 disables optional fields and emits diagnostics for absent or malformed schemas", () => {
  const descriptors = completeDescriptors().map((descriptor) => {
    if (descriptor.name === "search_graph") return { name: descriptor.name };
    if (descriptor.name === "search_code") {
      return { name: descriptor.name, inputSchema: { type: "object", properties: [] } };
    }
    return descriptor;
  });
  const capabilities = inspectCbmV090Capabilities("0.9.0", descriptors);

  assert.equal(capabilities.compatible, true);
  assert.equal(capabilities.semanticSearch, false);
  assert.ok(Object.values(capabilities.nativeFields.search_graph).every((available) => !available));
  assert.ok(Object.values(capabilities.nativeFields.search_code).every((available) => !available));
  assert.deepEqual(
    capabilities.diagnostics.filter(({ code }) => code === "missing_input_schema").map(({ tool }) => tool),
    ["search_graph", "search_code"]
  );
});

test("CBM v0.9.0 reports duplicate descriptors and uses the first schema deterministically", () => {
  const descriptors = [
    ...completeDescriptors(),
    tool("search_graph", [])
  ];
  const capabilities = inspectCbmV090Capabilities("0.9.0", descriptors);

  assert.equal(capabilities.compatible, true);
  assert.equal(capabilities.semanticSearch, true);
  assert.deepEqual(
    capabilities.diagnostics.filter(({ code }) => code === "duplicate_tool"),
    [{
      severity: "warning",
      code: "duplicate_tool",
      tool: "search_graph",
      message: "CBM tools/list returned duplicate descriptor 'search_graph'; the first descriptor is used."
    }]
  );
});

function completeDescriptors(): McpToolDescriptor[] {
  const descriptors = [...CBM_V090_REQUIRED_TOOLS, ...CBM_V090_OPTIONAL_TOOLS].map((name) => tool(name, []));
  return descriptors.map((descriptor) => {
    switch (descriptor.name) {
      case "get_architecture":
        return tool(descriptor.name, ["path"]);
      case "search_graph":
        return tool(descriptor.name, [
          "semantic_query",
          "qn_pattern",
          "relationship",
          "exclude_entry_points",
          "include_connected"
        ]);
      case "search_code":
        return tool(descriptor.name, ["file_pattern", "path_filter", "mode", "context"]);
      case "trace_path":
        return tool(descriptor.name, ["mode", "parameter_name", "edge_types", "risk_labels", "include_tests"]);
      default:
        return descriptor;
    }
  });
}

function tool(name: string, fields: readonly string[]): McpToolDescriptor {
  return {
    name,
    description: `${name} description`,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(fields.map((field) => [field, { type: "string" }]))
    }
  };
}
