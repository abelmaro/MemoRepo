import { createHash, createHmac, randomUUID } from "node:crypto";
import { Agent, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AuthEvent,
  AuthPrompt,
  AuthResult,
  Credential,
  CredentialStore,
  Message,
  Model,
  Models,
  TSchema,
  Usage
} from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, hasApi } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentAdapterRunInput, AgentRuntimeAdapter } from "./agentRuntimeAdapter.js";
import type {
  AgentHistoryMessage,
  AgentEffort,
  AgentLoginAttempt,
  AgentModelCatalog,
  AgentProviderStatus,
  AgentRunSettings,
  AgentToolDefinition,
  AgentVerbosity,
  JsonValue
} from "./contracts.js";

const RUNTIME_VERSION = "pi-0.80.8";
const LOGIN_CHALLENGE_TIMEOUT_MS = 30_000;
const LOGIN_RETENTION_MS = 20 * 60_000;
const CONNECTION_ID_FIELD = "agentConnectionId";
const DEFAULT_EFFORT = "medium" as const satisfies AgentEffort;
const DEFAULT_VERBOSITY = "medium" as const satisfies AgentVerbosity;
const CODEX_VERBOSITY_OPTIONS: AgentVerbosity[] = ["low", "medium", "high"];
const SUPPORTED_AUTH_MESSAGE =
  "Ask this Space supports only device OAuth credentials stored by MemoRepo";
const EXTERNAL_AUTH_LOGOUT_MESSAGE =
  "Agent sign-out is blocked by an external credential. Remove it before signing out";

export interface PiAgentRuntimeConfig {
  providerId: string;
  modelId: string;
  credentialStore: CredentialStore;
  thinkingLevel?: ThinkingLevel;
}

interface LoginState {
  view: AgentLoginAttempt;
  abort: AbortController;
  phase: "authorizing" | "finalizing" | "cancelling" | "settled";
  challengeReady: Promise<void>;
  settled: Promise<void>;
  resolveChallenge(): void;
}

export class PiAgentRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly models: Models;
  private readonly credentialStore: CredentialStore;
  private readonly attempts = new Map<string, LoginState>();
  private activeLogin: LoginState | null = null;
  private activeRuns = 0;
  private authenticationEpoch = 0;
  private lifecycle: "open" | "logging-out" | "closed" = "open";
  private logoutTask: Promise<void> | null = null;
  private readonly modelSettings = new Map<string, AgentRunSettings>();

  constructor(private readonly config: PiAgentRuntimeConfig, models?: Models) {
    this.credentialStore = preserveConnectionIdentity(config.credentialStore);
    this.models = models ?? builtinModels({ credentials: this.credentialStore });
  }

  catalog(): AgentModelCatalog {
    const selectedModel = this.models.getModel(this.config.providerId, this.config.modelId);
    return {
      providers: this.models
        .getProviders()
        .filter((provider) => Boolean(provider.auth.oauth))
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          models: this.models.getModels(provider.id).map((model) => ({
            id: model.id,
            name: model.name,
            capabilities: modelCapabilities(model, this.config.thinkingLevel)
          }))
        }))
        .filter((provider) => provider.models.length > 0),
      selected: {
        providerId: this.config.providerId,
        modelId: this.config.modelId,
        settings: selectedModel ? this.settingsFor(selectedModel) : {}
      }
    };
  }

  selectModel(providerId: string, modelId: string, settings?: AgentRunSettings): void {
    if (this.lifecycle !== "open") throw conflict("Agent runtime is not ready for model changes");
    if (this.activeLogin) throw conflict("Wait for agent sign-in to finish before changing models");
    if (this.activeRuns > 0) throw conflict("Wait for active agent runs before changing models");
    const provider = this.models.getProvider(providerId);
    if (!provider?.auth.oauth) throw unavailable(`Pi provider ${providerId} is not available for device OAuth`);
    const model = this.models.getModel(providerId, modelId);
    if (!model) throw unavailable(`Pi model ${providerId}/${modelId} is not available`);
    if (settings) {
      const current = this.modelSettings.get(modelKey(providerId, modelId)) ?? defaultSettings(model, this.config.thinkingLevel);
      this.modelSettings.set(
        modelKey(providerId, modelId),
        validateSettings(model, { ...current, ...settings }, this.config.thinkingLevel)
      );
    }
    this.config.providerId = providerId;
    this.config.modelId = modelId;
  }

  async status(): Promise<AgentProviderStatus> {
    const epoch = this.authenticationEpoch;
    const provider = this.models.getProvider(this.config.providerId);
    const model = this.models.getModel(this.config.providerId, this.config.modelId);
    const base = {
      configured: Boolean(provider && model),
      available: Boolean(provider && model) && this.lifecycle !== "closed",
      connected: false,
      providerId: this.config.providerId,
      providerName: provider?.name ?? this.config.providerId,
      modelId: this.config.modelId,
      modelName: model?.name ?? this.config.modelId,
      authSource: null,
      accountKey: null,
      runtimeVersion: RUNTIME_VERSION,
      message: null
    } satisfies AgentProviderStatus;

    if (this.lifecycle === "closed") return { ...base, message: "Agent runtime is closed" };
    if (this.lifecycle === "logging-out" || this.activeLogin) return changingStatus(base);
    if (!provider) return { ...base, message: `Pi provider ${this.config.providerId} is not available` };
    if (!model) return { ...base, message: `Pi model ${this.config.modelId} is not available` };

    try {
      const credentialBeforeResolution = await this.credentialStore.read(this.config.providerId);
      const auth = await this.models.getAuth(model);
      if (!auth) return { ...base, message: `Connect ${provider.name} to ask this Space` };
      const credential = await this.credentialStore.read(this.config.providerId);
      if (credential?.type !== "oauth") {
        return { ...base, message: SUPPORTED_AUTH_MESSAGE };
      }
      const connectionId = await ensureOAuthConnectionId(
        this.credentialStore,
        this.config.providerId,
        oauthConnectionId(credentialBeforeResolution)
      );
      const credentialWithConnection = await this.credentialStore.read(this.config.providerId);
      const identity = await accountIdentity(
        this.credentialStore,
        this.config.providerId,
        credentialWithConnection,
        auth,
        connectionId
      );
      if (this.authenticationChanged(epoch)) {
        return changingStatus(base);
      }
      return {
        ...base,
        connected: true,
        authSource: auth.source ?? null,
        accountKey: createHmac("sha256", connectionId)
          .update(`${this.config.providerId}\0${identity}`)
          .digest("hex"),
        message: null
      };
    } catch {
      if (this.authenticationChanged(epoch)) {
        return changingStatus(base);
      }
      return { ...base, message: `Authentication for ${provider.name} could not be resolved` };
    }
  }

  async startLogin(): Promise<AgentLoginAttempt> {
    if (this.lifecycle === "closed") throw unavailable("Agent runtime is closed");
    if (this.lifecycle === "logging-out") throw conflict("Agent sign-out is in progress");
    if (this.activeLogin) return this.loginViewWhenReady(this.activeLogin);
    if (this.activeRuns > 0) throw conflict("Wait for active agent runs before connecting");
    const provider = this.models.getProvider(this.config.providerId);
    if (!provider) throw unavailable(`Pi provider ${this.config.providerId} is not available`);
    if (!provider.auth.oauth) {
      throw unavailable(SUPPORTED_AUTH_MESSAGE);
    }

    const loginId = randomUUID();
    let resolveChallenge = () => {};
    const challengeReady = new Promise<void>((resolve) => {
      resolveChallenge = resolve;
    });
    const state: LoginState = {
      view: {
        loginId,
        status: "pending",
        verificationUrl: null,
        userCode: null,
        instructions: null,
        error: null
      },
      abort: new AbortController(),
      phase: "authorizing",
      challengeReady,
      settled: Promise.resolve(),
      resolveChallenge
    };
    this.attempts.set(loginId, state);
    this.activeLogin = state;
    this.authenticationEpoch += 1;

    state.settled = this.performLogin(state)
      .finally(() => {
        if (this.activeLogin === state) this.activeLogin = null;
        this.authenticationEpoch += 1;
        const cleanup = setTimeout(() => this.attempts.delete(loginId), LOGIN_RETENTION_MS);
        cleanup.unref();
      });
    void state.settled;

    return this.loginViewWhenReady(state);
  }

  async loginStatus(loginId: string): Promise<AgentLoginAttempt> {
    const state = this.attempts.get(loginId);
    if (!state) throw Object.assign(new Error("Agent login attempt not found"), { statusCode: 404 });
    return cloneAttempt(state.view);
  }

  async cancelLogin(loginId: string): Promise<void> {
    const state = this.attempts.get(loginId);
    if (!state || state.phase === "settled") return;
    if (state.phase === "authorizing") this.cancelAuthorizingLogin(state, "Login cancelled");
    await state.settled;
  }

  logout(): Promise<void> {
    if (this.logoutTask) return this.logoutTask;
    if (this.lifecycle === "closed") return Promise.reject(unavailable("Agent runtime is closed"));
    if (this.activeRuns > 0) return Promise.reject(conflict("Wait for active agent runs before signing out"));
    this.lifecycle = "logging-out";
    this.authenticationEpoch += 1;
    const task = this.performLogout().finally(() => {
      if (this.logoutTask === task) this.logoutTask = null;
      if (this.lifecycle !== "closed") this.lifecycle = "open";
      this.authenticationEpoch += 1;
    });
    this.logoutTask = task;
    return task;
  }

  async run(input: AgentAdapterRunInput): Promise<void> {
    if (this.lifecycle !== "open" || this.activeLogin) {
      throw unavailable(this.lifecycle === "closed" ? "Agent runtime is closed" : "Agent authentication is changing");
    }
    const epoch = this.authenticationEpoch;
    this.activeRuns += 1;
    try {
      const model = this.resolveModel(input.providerId, input.modelId);
      const auth = await this.models.getAuth(model);
      const credential = await this.credentialStore.read(model.provider);
      if (epoch !== this.authenticationEpoch || this.lifecycle !== "open" || this.activeLogin) {
        throw conflict("Agent authentication is changing");
      }
      if (!auth) {
        throw unavailable(`Connect ${this.models.getProvider(model.provider)?.name ?? model.provider} first`);
      }
      if (credential?.type !== "oauth") throw unavailable(SUPPORTED_AUTH_MESSAGE);
      if (input.history.length === 0 || input.history.at(-1)?.role !== "user") {
        throw new Error("Agent history must end with the current user message");
      }

      const tools = input.tools.map((tool) => this.toPiTool(input, tool));
      const settings = input.settings
        ? validateSettings(model, input.settings, this.config.thinkingLevel)
        : this.settingsFor(model);
      let finalizationApplied = false;
      const agent = new Agent({
        initialState: {
          systemPrompt: input.systemPrompt,
          model,
          thinkingLevel: settings.effort ?? "off",
          tools,
          messages: input.history.map((message) => toPiMessage(message, model))
        },
        sessionId: input.sessionId,
        streamFn: (activeModel, context, options) => {
          if (hasApi(activeModel, "openai-codex-responses")) {
            const { reasoning: _reasoning, ...baseOptions } = options ?? {};
            const reasoningEffort = toProviderReasoningEffort(settings.effort);
            return this.models.stream(activeModel, context, {
              ...baseOptions,
              reasoningEffort,
              textVerbosity: settings.verbosity ?? DEFAULT_VERBOSITY
            });
          }
          return this.models.streamSimple(activeModel, context, options);
        },
        prepareNextTurnWithContext: async ({ context }) => {
          if (finalizationApplied) return undefined;
          const reason = input.finalizationReason?.() ?? null;
          if (!reason) return undefined;
          finalizationApplied = true;
          await input.onEvent({
            type: "run.phase_changed",
            runId: input.runId,
            phase: "finalizing",
            reason
          });
          return {
            context: {
              ...context,
              tools: [],
              messages: [
                ...context.messages,
                {
                  role: "user",
                  content:
                    "Research is complete. Do not call more tools. Produce the best supported final answer now, " +
                    "clearly separating direct evidence from uncertainty and mentioning material gaps only when needed.",
                  timestamp: Date.now()
                }
              ]
            }
          };
        },
        toolExecution: "parallel"
      });

      const unsubscribe = agent.subscribe(async (event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          await input.onProviderTurn({
            stopReason: event.message.stopReason,
            usage: {
              input: event.message.usage.input,
              output: event.message.usage.output,
              reasoning: event.message.usage.reasoning ?? 0,
              cacheRead: event.message.usage.cacheRead,
              cacheWrite: event.message.usage.cacheWrite,
              total: event.message.usage.totalTokens
            }
          });
          return;
        }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          await input.onEvent({ type: "assistant.delta", runId: input.runId, delta: event.assistantMessageEvent.delta });
        }
      });
      const interrupt = () => agent.abort();
      input.signal.addEventListener("abort", interrupt, { once: true });
      try {
        if (input.signal.aborted) throw input.signal.reason ?? new Error("Agent run interrupted");
        await agent.continue();
        if (input.signal.aborted) throw input.signal.reason ?? new Error("Agent run interrupted");
        if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
      } finally {
        input.signal.removeEventListener("abort", interrupt);
        unsubscribe();
      }
    } finally {
      this.activeRuns -= 1;
    }
  }

  async close(): Promise<void> {
    if (this.lifecycle === "closed") return;
    this.lifecycle = "closed";
    await this.logoutTask?.catch(() => undefined);
    await this.cancelPendingLogins("Agent runtime closed");
  }

  private authenticationChanged(epoch: number): boolean {
    return epoch !== this.authenticationEpoch || this.lifecycle !== "open" || this.activeLogin !== null;
  }

  private async cancelPendingLogins(reason: string): Promise<void> {
    const state = this.activeLogin;
    if (!state) return;
    if (state.phase === "authorizing") this.cancelAuthorizingLogin(state, reason);
    await state.settled;
  }

  private async performLogin(state: LoginState): Promise<void> {
    let previousCredential: Credential | undefined;
    let credentialCaptured = false;
    let loginStarted = false;
    let restoreFailed = false;
    try {
      previousCredential = await this.credentialStore.read(this.config.providerId);
      credentialCaptured = true;
      if (loginWasCancelled(state)) throw state.abort.signal.reason;
      loginStarted = true;
      await this.models.login(this.config.providerId, "oauth", {
        signal: state.abort.signal,
        prompt: (prompt) => loginPrompt(prompt),
        notify: (event) => this.handleLoginEvent(state, event)
      });
      if (loginWasCancelled(state)) throw state.abort.signal.reason;
      state.phase = "finalizing";
      await rotateOAuthConnectionId(this.credentialStore, this.config.providerId);
      state.view.status = "completed";
      state.view.error = null;
    } catch {
      if (credentialCaptured && loginStarted) {
        try {
          await restoreCredential(this.credentialStore, this.config.providerId, previousCredential);
        } catch {
          restoreFailed = true;
        }
      }
      if (!restoreFailed && (state.phase === "cancelling" || state.abort.signal.aborted)) {
        state.view.status = "cancelled";
        state.view.error = null;
      } else {
        state.view.status = "failed";
        state.view.error = publicAdapterError();
      }
    } finally {
      state.phase = "settled";
      state.resolveChallenge();
    }
  }

  private async performLogout(): Promise<void> {
    await this.cancelPendingLogins("Login cancelled by sign-out");
    let storedCredential: Credential | undefined;
    try {
      storedCredential = await this.credentialStore.read(this.config.providerId);
    } catch {
      throw unavailable("Agent sign-out could not be confirmed. Please try again.");
    }
    if (!storedCredential) {
      const model = this.models.getModel(this.config.providerId, this.config.modelId);
      if (!model) return;
      try {
        if (await this.models.getAuth(model)) throw unavailable(EXTERNAL_AUTH_LOGOUT_MESSAGE);
        return;
      } catch (error) {
        if (error instanceof Error && error.message === EXTERNAL_AUTH_LOGOUT_MESSAGE) throw error;
        throw unavailable("Agent sign-out could not be confirmed. Please try again.");
      }
    }

    try {
      await this.models.logout(this.config.providerId);
    } catch {
      const remaining = await this.credentialStore.read(this.config.providerId).catch(() => storedCredential);
      if (remaining) throw unavailable("Agent sign-out failed. Please try again.");
    }

    const remaining = await this.credentialStore.read(this.config.providerId).catch(() => storedCredential);
    if (remaining) {
      throw unavailable("Agent sign-out could not be confirmed. Please try again.");
    }
  }

  private cancelAuthorizingLogin(state: LoginState, reason: string): void {
    if (state.phase !== "authorizing") return;
    state.phase = "cancelling";
    state.view.status = "cancelled";
    state.view.error = null;
    state.abort.abort(new Error(reason));
    state.resolveChallenge();
  }

  private async loginViewWhenReady(state: LoginState): Promise<AgentLoginAttempt> {
    await Promise.race([
      state.challengeReady,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, LOGIN_CHALLENGE_TIMEOUT_MS);
        timer.unref();
      })
    ]);
    return cloneAttempt(state.view);
  }

  private resolveModel(providerId = this.config.providerId, modelId = this.config.modelId): Model<Api> {
    const model = this.models.getModel(providerId, modelId);
    if (!model) throw unavailable(`Pi model ${providerId}/${modelId} is not available`);
    return model;
  }

  private settingsFor(model: Model<Api>): AgentRunSettings {
    const key = modelKey(model.provider, model.id);
    const stored = this.modelSettings.get(key);
    if (stored) return stored;
    const defaults = defaultSettings(model, this.config.thinkingLevel);
    this.modelSettings.set(key, defaults);
    return defaults;
  }

  private toPiTool(input: AgentAdapterRunInput, definition: AgentToolDefinition): AgentTool<TSchema, never> {
    return {
      name: definition.name,
      label: definition.name.replaceAll("_", " "),
      description: definition.description,
      parameters: definition.inputSchema as TSchema,
      execute: async (requestId, argumentsValue, toolSignal) => {
        const signal = toolSignal ? AbortSignal.any([input.signal, toolSignal]) : input.signal;
        await input.onEvent({ type: "tool.started", runId: input.runId, requestId, name: definition.name });
        const result = await input.requestTool(
          {
            runId: input.runId,
            sessionId: input.sessionId,
            requestId,
            name: definition.name,
            arguments: jsonRecord(argumentsValue)
          },
          signal
        );
        await input.onEvent({
          type: "tool.completed",
          runId: input.runId,
          requestId,
          name: definition.name,
          success: result.ok
        });
        if (!result.ok) throw new Error(result.error.message);
        return {
          content: [{ type: "text", text: JSON.stringify(result.value) }],
          details: undefined as never
        };
      }
    };
  }

  private handleLoginEvent(state: LoginState, event: AuthEvent): void {
    if (state.phase !== "authorizing") return;
    if (event.type === "device_code") {
      state.view.verificationUrl = safeHttpsUrl(event.verificationUri);
      state.view.userCode = event.userCode;
      state.view.instructions = "Open the verification page and enter the one-time code.";
      state.resolveChallenge();
      return;
    }
    if (event.type === "auth_url") {
      state.view.verificationUrl = safeHttpsUrl(event.url);
      state.view.instructions = event.instructions ?? null;
      state.resolveChallenge();
      return;
    }
    if (event.type === "info" && !state.view.verificationUrl) {
      const link = event.links?.map((item) => safeHttpsUrl(item.url)).find((item): item is string => Boolean(item));
      if (link) {
        state.view.verificationUrl = link;
        state.view.instructions = event.message;
        state.resolveChallenge();
      }
    }
  }
}

function modelCapabilities(model: Model<Api>, configuredEffort?: ThinkingLevel) {
  const effortOptions = getSupportedThinkingLevels(model) as AgentEffort[];
  const effortDefault = preferredEffort(effortOptions, configuredEffort);
  return {
    ...(effortOptions.length > 1 && effortDefault
      ? { effort: { options: [...effortOptions], default: effortDefault } }
      : {}),
    ...(hasApi(model, "openai-codex-responses")
      ? { verbosity: { options: [...CODEX_VERBOSITY_OPTIONS], default: DEFAULT_VERBOSITY } }
      : {})
  };
}

function defaultSettings(model: Model<Api>, configuredEffort?: ThinkingLevel): AgentRunSettings {
  const capabilities = modelCapabilities(model, configuredEffort);
  return {
    ...(capabilities.effort ? { effort: capabilities.effort.default } : {}),
    ...(capabilities.verbosity ? { verbosity: capabilities.verbosity.default } : {})
  };
}

function validateSettings(
  model: Model<Api>,
  settings: AgentRunSettings,
  configuredEffort?: ThinkingLevel
): AgentRunSettings {
  const capabilities = modelCapabilities(model, configuredEffort);
  if (settings.effort !== undefined && !capabilities.effort?.options.includes(settings.effort)) {
    throw invalidSetting(`Effort ${settings.effort} is not supported by ${model.name}`);
  }
  if (settings.verbosity !== undefined && !capabilities.verbosity?.options.includes(settings.verbosity)) {
    throw invalidSetting(`Verbosity ${settings.verbosity} is not supported by ${model.name}`);
  }
  return {
    ...(settings.effort !== undefined ? { effort: settings.effort } : {}),
    ...(settings.verbosity !== undefined ? { verbosity: settings.verbosity } : {})
  };
}

function preferredEffort(options: AgentEffort[], configured?: ThinkingLevel): AgentEffort | undefined {
  const preferred = (configured ?? DEFAULT_EFFORT) as AgentEffort;
  if (options.includes(preferred)) return preferred;
  if (options.includes(DEFAULT_EFFORT)) return DEFAULT_EFFORT;
  return options.find((option) => option !== "off") ?? options[0];
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`;
}

function invalidSetting(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function toProviderReasoningEffort(
  effort: AgentEffort | undefined
): "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "none" {
  if (effort === undefined) return DEFAULT_EFFORT;
  const providerEffort: Record<
    AgentEffort,
    "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "none"
  > = {
    off: "none",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max"
  };
  return providerEffort[effort];
}

async function loginPrompt(prompt: AuthPrompt): Promise<string> {
  if (prompt.signal?.aborted) throw prompt.signal.reason ?? new Error("Login cancelled");
  if (prompt.type === "select") {
    const device = prompt.options.find(
      (option) => option.id.toLocaleLowerCase().includes("device") || option.label.toLocaleLowerCase().includes("device")
    );
    if (device) return device.id;
  }
  throw new Error("This provider requires an interactive login step that the dashboard cannot complete");
}

function toPiMessage(message: AgentHistoryMessage, model: Model<Api>): Message {
  if (message.role === "user") {
    return { role: "user", content: message.content, timestamp: message.timestamp };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: message.timestamp
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  const normalized = JSON.parse(JSON.stringify(value ?? {})) as JsonValue;
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new Error("Agent tool arguments must be an object");
  }
  return normalized;
}

function cloneAttempt(value: AgentLoginAttempt): AgentLoginAttempt {
  return { ...value };
}

function loginWasCancelled(state: LoginState): boolean {
  return state.phase === "cancelling" || state.abort.signal.aborted;
}

function safeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function unavailable(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 503 });
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function publicAdapterError(): string {
  return "Agent login failed. Please try again.";
}

function changingStatus(status: AgentProviderStatus): AgentProviderStatus {
  return {
    ...status,
    connected: false,
    authSource: null,
    accountKey: null,
    message: "Agent authentication is changing"
  };
}

interface IdentityClaim {
  kind: string;
  value: string;
}

const IDENTITY_FIELDS: ReadonlyArray<{ kind: string; names: ReadonlySet<string> }> = [
  {
    kind: "account",
    names: new Set(["accountid", "chatgptaccountid"])
  },
  {
    kind: "subject",
    names: new Set(["sub", "subject", "userid", "uid", "memberid"])
  },
  {
    kind: "email",
    names: new Set(["email", "emailaddress", "preferredusername", "username", "login"])
  }
];

async function accountIdentity(
  credentialStore: CredentialStore,
  providerId: string,
  credential: Credential | undefined,
  auth: AuthResult,
  previousConnectionId: string | null
): Promise<string> {
  const storedClaim = findIdentityClaim(credential);
  if (storedClaim) return claimIdentity("credential", storedClaim);

  if (credential?.type === "oauth") {
    for (const token of oauthIdentityTokens(credential)) {
      const tokenClaim = findIdentityClaim(decodeJwtPayload(token));
      if (tokenClaim) return claimIdentity("token", tokenClaim);
    }
  }

  const resolvedClaim = findIdentityClaim({ env: auth.env, headers: auth.auth.headers });
  if (resolvedClaim) return claimIdentity("resolved", resolvedClaim);

  if (credential?.type === "oauth") {
    return `oauth-connection:${await ensureOAuthConnectionId(
      credentialStore,
      providerId,
      previousConnectionId
    )}`;
  }
  if (credential?.type === "api_key") {
    const storedKey = nonEmptyString(credential.key);
    if (storedKey) return `api-key:${fingerprint(storedKey)}`;
  }

  const resolvedKey = nonEmptyString(auth.auth.apiKey);
  if (resolvedKey) return `api-key:${fingerprint(resolvedKey)}`;

  return `resolved:${fingerprint(
    JSON.stringify({
      source: auth.source ?? null,
      baseUrl: auth.auth.baseUrl ?? null,
      env: sortedEntries(auth.env),
      headers: sortedEntries(auth.auth.headers)
    })
  )}`;
}

function preserveConnectionIdentity(store: CredentialStore): CredentialStore {
  return {
    read: (providerId) => store.read(providerId),
    list: () => store.list(),
    delete: (providerId) => store.delete(providerId),
    modify: (providerId, update) =>
      store.modify(providerId, async (current) => {
        const next = await update(current);
        if (!next || next.type !== "oauth" || current?.type !== "oauth" || oauthConnectionId(next)) {
          return next;
        }
        const connectionId = oauthConnectionId(current);
        return connectionId ? withOAuthConnectionId(next, connectionId) : next;
      })
  };
}

async function ensureOAuthConnectionId(
  store: CredentialStore,
  providerId: string,
  previousConnectionId: string | null
): Promise<string> {
  const candidate = previousConnectionId ?? randomUUID();
  const persisted = await store.modify(providerId, async (current) => {
    if (current?.type !== "oauth" || oauthConnectionId(current)) return undefined;
    return withOAuthConnectionId(current, candidate);
  });
  const connectionId = oauthConnectionId(persisted);
  if (!connectionId) throw new Error("OAuth connection identity could not be persisted");
  return connectionId;
}

async function rotateOAuthConnectionId(store: CredentialStore, providerId: string): Promise<void> {
  await store.modify(providerId, async (current) => {
    if (current?.type !== "oauth") return undefined;
    return withOAuthConnectionId(current, randomUUID());
  });
}

async function restoreCredential(
  store: CredentialStore,
  providerId: string,
  credential: Credential | undefined
): Promise<void> {
  if (!credential) {
    await store.delete(providerId);
    return;
  }
  await store.modify(providerId, async () => credential);
}

function oauthConnectionId(credential: Credential | undefined): string | null {
  if (credential?.type !== "oauth") return null;
  const value = nonEmptyString((credential as Record<string, unknown>)[CONNECTION_ID_FIELD]);
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLocaleLowerCase("en-US")
    : null;
}

function withOAuthConnectionId(credential: Credential & { type: "oauth" }, connectionId: string): Credential {
  return { ...credential, [CONNECTION_ID_FIELD]: connectionId };
}

function claimIdentity(source: string, claim: IdentityClaim): string {
  const value = claim.kind === "email" ? claim.value.toLocaleLowerCase("en-US") : claim.value;
  return `${source}:${claim.kind}:${value}`;
}

function findIdentityClaim(value: unknown): IdentityClaim | null {
  const records = identityRecords(value);
  for (const field of IDENTITY_FIELDS) {
    for (const record of records) {
      for (const [name, candidate] of Object.entries(record)) {
        if (!field.names.has(normalizeIdentityField(name))) continue;
        const normalized = identityValue(candidate);
        if (normalized) return { kind: field.kind, value: normalized };
      }
    }
  }
  return null;
}

function identityRecords(value: unknown): Array<Record<string, unknown>> {
  const root = objectRecord(value);
  if (!root) return [];
  const records: Array<Record<string, unknown>> = [];
  const queue: Array<{ record: Record<string, unknown>; depth: number }> = [{ record: root, depth: 0 }];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current.record)) continue;
    seen.add(current.record);
    records.push(current.record);
    if (current.depth >= 2) continue;
    for (const nested of Object.values(current.record)) {
      const record = objectRecord(nested);
      if (record) queue.push({ record, depth: current.depth + 1 });
    }
  }
  return records;
}

function oauthIdentityTokens(credential: Credential & { type: "oauth" }): string[] {
  const record = credential as Record<string, unknown>;
  const tokens = [record.idToken, record.id_token, record.identityToken, credential.access, credential.refresh];
  return tokens.map(nonEmptyString).filter((token): token is string => Boolean(token));
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length < 2 || !payload || payload.length > 32_768) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return objectRecord(parsed);
  } catch {
    return null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function identityValue(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized && normalized.length <= 2_048 ? normalized : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeIdentityField(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}

function sortedEntries(value: unknown): Array<[string, unknown]> {
  const record = objectRecord(value);
  return record ? Object.entries(record).sort(([left], [right]) => left.localeCompare(right)) : [];
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
