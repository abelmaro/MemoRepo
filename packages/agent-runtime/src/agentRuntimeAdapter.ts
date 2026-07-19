import type {
  AgentLoginAttempt,
  AgentProviderTurnObservation,
  AgentProviderStatus,
  AgentRunFailureDiagnostic,
  AgentRunCompletionReason,
  AgentRunInput,
  AgentRuntimeEvent
} from "./contracts.js";

export interface AgentAdapterRunInput extends Omit<AgentRunInput, "onEvent"> {
  signal: AbortSignal;
  onEvent(event: Exclude<AgentRuntimeEvent, { type: "run.started" | "run.completed" }>): void | Promise<void>;
  onProviderTurn(observation: AgentProviderTurnObservation): void | Promise<void>;
  onProviderActivity?(): void;
  finalizationReason?(): AgentRunCompletionReason | null;
}

export class AgentProviderFailureError extends Error {
  readonly diagnostic: AgentRunFailureDiagnostic;

  constructor(diagnostic: AgentRunFailureDiagnostic) {
    super("Agent provider run failed");
    this.name = "AgentProviderFailureError";
    this.diagnostic = safeFailureDiagnostic(diagnostic);
  }
}

const FAILURE_CATEGORIES = new Set([
  "authentication",
  "context_limit",
  "invalid_request",
  "model_unavailable",
  "provider_unavailable",
  "rate_limit",
  "timeout",
  "tool_protocol",
  "transport",
  "unknown"
]);
const FAILURE_STAGES = new Set([
  "connection",
  "request",
  "response_headers",
  "streaming",
  "tool_protocol",
  "finalization",
  "unknown"
]);

function safeFailureDiagnostic(diagnostic: AgentRunFailureDiagnostic): AgentRunFailureDiagnostic {
  const category = FAILURE_CATEGORIES.has(diagnostic.category) ? diagnostic.category : "unknown";
  const stage = FAILURE_STAGES.has(diagnostic.stage) ? diagnostic.stage : "unknown";
  return {
    category,
    stage,
    providerCode: safeCode(diagnostic.providerCode),
    httpStatus:
      Number.isInteger(diagnostic.httpStatus) && (diagnostic.httpStatus ?? 0) >= 100 && (diagnostic.httpStatus ?? 0) <= 599
        ? diagnostic.httpStatus
        : null,
    providerRequestId: safeIdentifier(diagnostic.providerRequestId),
    providerResponseId: safeIdentifier(diagnostic.providerResponseId),
    transport:
      diagnostic.transport === "sse" || diagnostic.transport === "websocket" || diagnostic.transport === "unknown"
        ? diagnostic.transport
        : null,
    retryable: diagnostic.retryable === true,
    retryAfterMs:
      Number.isInteger(diagnostic.retryAfterMs) && (diagnostic.retryAfterMs ?? -1) >= 0
        ? Math.min(diagnostic.retryAfterMs!, 24 * 60 * 60_000)
        : null,
    summary: safeSummary(category, stage)
  };
}

function safeCode(value: string | null): string | null {
  return value && value.length <= 64 && /^[a-z0-9][a-z0-9._-]*$/i.test(value) ? value : null;
}

function safeIdentifier(value: string | null): string | null {
  if (!value || value.length > 160 || !/^[a-z0-9][a-z0-9._:-]*$/i.test(value)) return null;
  if (/secret|bearer|password|refresh.?token|access.?token/i.test(value)) return null;
  if (/^eyj[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(value)) return null;
  return value;
}

function safeSummary(
  category: AgentRunFailureDiagnostic["category"],
  stage: AgentRunFailureDiagnostic["stage"]
): string {
  const subject: Record<AgentRunFailureDiagnostic["category"], string> = {
    authentication: "Provider authentication was rejected.",
    context_limit: "The provider rejected the request context size.",
    invalid_request: "The provider rejected the request.",
    model_unavailable: "The selected model was unavailable.",
    provider_unavailable: "The provider was temporarily unavailable.",
    rate_limit: "The provider rate limit was reached.",
    timeout: "The provider request timed out.",
    tool_protocol: "The provider rejected the tool protocol exchange.",
    transport: "The provider transport failed.",
    unknown: "The provider run failed for an unknown reason."
  };
  return stage === "unknown" ? subject[category] : `${subject[category].replace(/\.$/, "")} during ${stage.replace("_", " ")}.`;
}

export interface AgentRuntimeAdapter {
  status(): Promise<AgentProviderStatus>;
  startLogin(): Promise<AgentLoginAttempt>;
  loginStatus(loginId: string): Promise<AgentLoginAttempt>;
  cancelLogin(loginId: string): Promise<void>;
  logout(): Promise<void>;
  run(input: AgentAdapterRunInput): Promise<void>;
  close(): Promise<void>;
}
