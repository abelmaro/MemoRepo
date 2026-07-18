import type {
  AgentLoginAttempt,
  AgentProviderTurnObservation,
  AgentProviderStatus,
  AgentRunCompletionReason,
  AgentRunInput,
  AgentRuntimeEvent
} from "./contracts.js";

export interface AgentAdapterRunInput extends Omit<AgentRunInput, "onEvent"> {
  signal: AbortSignal;
  onEvent(event: Exclude<AgentRuntimeEvent, { type: "run.started" | "run.completed" }>): void | Promise<void>;
  onProviderTurn(observation: AgentProviderTurnObservation): void | Promise<void>;
  finalizationReason?(): AgentRunCompletionReason | null;
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
