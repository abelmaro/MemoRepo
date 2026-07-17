export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonValue;
}

export interface AgentHistoryMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export type AgentEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentVerbosity = "low" | "medium" | "high";

export interface AgentRunSettings {
  effort?: AgentEffort;
  verbosity?: AgentVerbosity;
}

export type AgentStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface AgentTokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface AgentProviderTurnObservation {
  stopReason: AgentStopReason;
  usage: AgentTokenUsage;
}

export interface AgentRunMetrics {
  stopReason: AgentStopReason | null;
  providerRoundCount: number;
  lengthStopCount: number;
  toolCallCount: number;
  usage: AgentTokenUsage;
}

export interface AgentToolRequest {
  runId: string;
  sessionId: string;
  requestId: string;
  name: string;
  arguments: Record<string, JsonValue>;
}

export type AgentToolResult =
  | { ok: true; value: JsonValue }
  | { ok: false; error: { code: string; message: string; retryable?: boolean } };

export type AgentRuntimeEvent =
  | { type: "run.started"; runId: string }
  | { type: "assistant.delta"; runId: string; delta: string }
  | { type: "tool.started"; runId: string; requestId: string; name: string }
  | { type: "tool.completed"; runId: string; requestId: string; name: string; success: boolean }
  | {
      type: "run.completed";
      runId: string;
      status: "completed" | "interrupted" | "failed";
      error: string | null;
      metrics: AgentRunMetrics;
    };

export interface AgentProviderStatus {
  configured: boolean;
  available: boolean;
  connected: boolean;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  authSource: string | null;
  accountKey: string | null;
  runtimeVersion: string;
  message: string | null;
}

export interface AgentModelOption {
  id: string;
  name: string;
  capabilities: {
    effort?: { options: AgentEffort[]; default: AgentEffort };
    verbosity?: { options: AgentVerbosity[]; default: AgentVerbosity };
  };
}

export interface AgentProviderOption {
  id: string;
  name: string;
  models: AgentModelOption[];
}

export interface AgentModelCatalog {
  providers: AgentProviderOption[];
  selected: {
    providerId: string;
    modelId: string;
    settings: AgentRunSettings;
  };
}

export type AgentLoginStatus = "pending" | "completed" | "failed" | "cancelled";

export interface AgentLoginAttempt {
  loginId: string;
  status: AgentLoginStatus;
  verificationUrl: string | null;
  userCode: string | null;
  instructions: string | null;
  error: string | null;
}

export interface AgentRunInput {
  runId: string;
  sessionId: string;
  systemPrompt: string;
  history: AgentHistoryMessage[];
  tools: AgentToolDefinition[];
  requestTool(request: AgentToolRequest, signal: AbortSignal): Promise<AgentToolResult>;
  onEvent(event: AgentRuntimeEvent): void | Promise<void>;
}
