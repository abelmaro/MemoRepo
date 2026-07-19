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

export interface AgentRunLimits {
  maxRunMs: number;
  maxToolCalls: number;
  maxProviderRounds: number;
  finalizationReserveMs: number;
  finalizationReserveToolCalls: number;
  finalizationReserveProviderRounds: number;
  maxNoProgressRounds: number;
  maxRepeatedToolCalls: number;
  maxConsecutiveToolErrors: number;
}

export type AgentRunPhase = "researching" | "finalizing" | "recovering";
export type AgentRunCompletionReason = "natural" | "budget" | "no_progress" | "cancelled" | "provider_failure";
export type AgentAnswerQuality = "complete" | "best_effort";

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

export type AgentRunFailureCategory =
  | "authentication"
  | "context_limit"
  | "invalid_request"
  | "model_unavailable"
  | "provider_unavailable"
  | "rate_limit"
  | "timeout"
  | "tool_protocol"
  | "transport"
  | "unknown";

export type AgentRunFailureStage =
  | "connection"
  | "request"
  | "response_headers"
  | "streaming"
  | "tool_protocol"
  | "finalization"
  | "unknown";

export type AgentProviderTransport = "sse" | "websocket" | "unknown";

export interface AgentRunFailureDiagnostic {
  category: AgentRunFailureCategory;
  stage: AgentRunFailureStage;
  providerCode: string | null;
  httpStatus: number | null;
  providerRequestId: string | null;
  providerResponseId: string | null;
  transport: AgentProviderTransport | null;
  retryable: boolean;
  retryAfterMs: number | null;
  summary: string;
}

export interface AgentRunMetrics {
  stopReason: AgentStopReason | null;
  providerRoundCount: number;
  lengthStopCount: number;
  toolCallCount: number;
  attemptDurationMs: number;
  timeToFirstProviderEventMs: number | null;
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
  | {
      type: "run.phase_changed";
      runId: string;
      phase: AgentRunPhase;
      reason: AgentRunCompletionReason | null;
    }
  | { type: "assistant.delta"; runId: string; delta: string }
  | { type: "tool.started"; runId: string; requestId: string; name: string }
  | { type: "tool.completed"; runId: string; requestId: string; name: string; success: boolean }
  | {
      type: "run.completed";
      runId: string;
      status: "completed" | "interrupted" | "failed";
      error: string | null;
      failureDiagnostic: AgentRunFailureDiagnostic | null;
      metrics: AgentRunMetrics;
      completionReason: AgentRunCompletionReason;
      answerQuality: AgentAnswerQuality;
      resumable: boolean;
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
  providerId?: string;
  modelId?: string;
  systemPrompt: string;
  history: AgentHistoryMessage[];
  tools: AgentToolDefinition[];
  settings?: AgentRunSettings;
  limits?: Partial<AgentRunLimits>;
  requestTool(request: AgentToolRequest, signal: AbortSignal): Promise<AgentToolResult>;
  onEvent(event: AgentRuntimeEvent): void | Promise<void>;
}
