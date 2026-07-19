import type { McpToolDescriptor } from "./cbmService.js";

export const CBM_V090_ADAPTER_VERSION = "0.9.0" as const;

export const CBM_V090_REQUIRED_TOOLS = [
  "list_projects",
  "index_status",
  "get_architecture",
  "get_graph_schema",
  "search_graph",
  "search_code",
  "trace_path",
  "get_code_snippet",
  "query_graph"
] as const;

export const CBM_V090_OPTIONAL_TOOLS = [
  "detect_changes",
  "index_repository"
] as const;

const CBM_V090_NATIVE_FIELDS = {
  get_architecture: ["path"],
  search_graph: [
    "semantic_query",
    "qn_pattern",
    "relationship",
    "exclude_entry_points",
    "include_connected"
  ],
  search_code: ["file_pattern", "path_filter", "mode", "context"],
  trace_path: ["mode", "parameter_name", "edge_types", "risk_labels", "include_tests"]
} as const;

type RequiredTool = typeof CBM_V090_REQUIRED_TOOLS[number];
type OptionalTool = typeof CBM_V090_OPTIONAL_TOOLS[number];
type NativeFieldTool = keyof typeof CBM_V090_NATIVE_FIELDS;
type NativeField<T extends NativeFieldTool> = typeof CBM_V090_NATIVE_FIELDS[T][number];

export interface CbmCapabilityDiagnostic {
  severity: "error" | "warning";
  code: "unsupported_version" | "missing_required_tools" | "duplicate_tool" | "missing_input_schema";
  message: string;
  tool?: string | undefined;
}

export interface CbmV090Capabilities {
  adapterVersion: typeof CBM_V090_ADAPTER_VERSION;
  reportedVersion: string;
  detectedVersion: string | null;
  compatible: boolean;
  requiredTools: {
    available: RequiredTool[];
    missing: RequiredTool[];
  };
  optionalTools: {
    available: OptionalTool[];
    missing: OptionalTool[];
  };
  nativeFields: {
    [T in NativeFieldTool]: Record<NativeField<T>, boolean>;
  };
  semanticSearch: boolean;
  diagnostics: CbmCapabilityDiagnostic[];
  summary: string;
}

export function inspectCbmV090Capabilities(
  reportedVersion: string,
  descriptors: readonly McpToolDescriptor[]
): CbmV090Capabilities {
  const detectedVersion = detectCbmVersion(reportedVersion);
  const diagnostics: CbmCapabilityDiagnostic[] = [];
  const descriptorByName = new Map<string, McpToolDescriptor>();

  for (const descriptor of descriptors) {
    if (descriptorByName.has(descriptor.name)) {
      diagnostics.push({
        severity: "warning",
        code: "duplicate_tool",
        tool: descriptor.name,
        message: `CBM tools/list returned duplicate descriptor '${descriptor.name}'; the first descriptor is used.`
      });
      continue;
    }
    descriptorByName.set(descriptor.name, descriptor);
  }

  if (detectedVersion !== CBM_V090_ADAPTER_VERSION) {
    diagnostics.push({
      severity: "error",
      code: "unsupported_version",
      message: detectedVersion === null
        ? `CBM version could not be detected from '${reportedVersion}'. This adapter requires ${CBM_V090_ADAPTER_VERSION}.`
        : `CBM ${detectedVersion} is incompatible with the ${CBM_V090_ADAPTER_VERSION} adapter.`
    });
  }

  const requiredTools = partitionTools(CBM_V090_REQUIRED_TOOLS, descriptorByName);
  if (requiredTools.missing.length > 0) {
    diagnostics.push({
      severity: "error",
      code: "missing_required_tools",
      message: `CBM ${CBM_V090_ADAPTER_VERSION} is missing required tools: ${requiredTools.missing.join(", ")}.`
    });
  }
  const optionalTools = partitionTools(CBM_V090_OPTIONAL_TOOLS, descriptorByName);

  const nativeFields = {
    get_architecture: detectToolFields("get_architecture", descriptorByName, diagnostics),
    search_graph: detectToolFields("search_graph", descriptorByName, diagnostics),
    search_code: detectToolFields("search_code", descriptorByName, diagnostics),
    trace_path: detectToolFields("trace_path", descriptorByName, diagnostics)
  };
  const compatible = !diagnostics.some((diagnostic) => diagnostic.severity === "error");

  return {
    adapterVersion: CBM_V090_ADAPTER_VERSION,
    reportedVersion,
    detectedVersion,
    compatible,
    requiredTools,
    optionalTools,
    nativeFields,
    semanticSearch: nativeFields.search_graph.semantic_query,
    diagnostics,
    summary: compatibilitySummary(compatible, detectedVersion, requiredTools.missing, optionalTools.missing)
  };
}

export class CbmV090CompatibilityError extends Error {
  constructor(readonly capabilities: CbmV090Capabilities) {
    super(capabilities.summary);
    this.name = "CbmV090CompatibilityError";
  }
}

export function assertCbmV090Compatible(
  reportedVersion: string,
  descriptors: readonly McpToolDescriptor[]
): CbmV090Capabilities {
  const capabilities = inspectCbmV090Capabilities(reportedVersion, descriptors);
  if (!capabilities.compatible) throw new CbmV090CompatibilityError(capabilities);
  return capabilities;
}

function detectCbmVersion(reportedVersion: string): string | null {
  const match = /(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![0-9.])/.exec(reportedVersion);
  return match?.[1] ?? null;
}

function partitionTools<T extends string>(
  expected: readonly T[],
  descriptorByName: ReadonlyMap<string, McpToolDescriptor>
): { available: T[]; missing: T[] } {
  const available: T[] = [];
  const missing: T[] = [];
  for (const tool of expected) {
    (descriptorByName.has(tool) ? available : missing).push(tool);
  }
  return { available, missing };
}

function detectToolFields<T extends NativeFieldTool>(
  tool: T,
  descriptorByName: ReadonlyMap<string, McpToolDescriptor>,
  diagnostics: CbmCapabilityDiagnostic[]
): Record<NativeField<T>, boolean> {
  const descriptor = descriptorByName.get(tool);
  const properties = schemaProperties(descriptor?.inputSchema);
  if (descriptor && properties === null) {
    diagnostics.push({
      severity: "warning",
      code: "missing_input_schema",
      tool,
      message: `CBM tool '${tool}' does not expose an object inputSchema.properties contract; optional fields are disabled.`
    });
  }

  return Object.fromEntries(
    CBM_V090_NATIVE_FIELDS[tool].map((field) => [field, properties !== null && Object.hasOwn(properties, field)])
  ) as Record<NativeField<T>, boolean>;
}

function schemaProperties(inputSchema: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!inputSchema) return null;
  const properties = inputSchema.properties;
  return properties !== null && typeof properties === "object" && !Array.isArray(properties)
    ? properties as Record<string, unknown>
    : null;
}

function compatibilitySummary(
  compatible: boolean,
  detectedVersion: string | null,
  missingRequired: readonly string[],
  missingOptional: readonly string[]
): string {
  if (!compatible) {
    const reasons = [
      detectedVersion === CBM_V090_ADAPTER_VERSION
        ? null
        : `expected version ${CBM_V090_ADAPTER_VERSION}, detected ${detectedVersion ?? "unknown"}`,
      missingRequired.length > 0 ? `missing required tools: ${missingRequired.join(", ")}` : null
    ].filter((reason): reason is string => reason !== null);
    return `CBM is incompatible with the ${CBM_V090_ADAPTER_VERSION} adapter (${reasons.join("; ")}).`;
  }
  return missingOptional.length === 0
    ? `CBM ${CBM_V090_ADAPTER_VERSION} is compatible; all known optional tools are available.`
    : `CBM ${CBM_V090_ADAPTER_VERSION} is compatible; optional tools unavailable: ${missingOptional.join(", ")}.`;
}
