import type {
  AssistantMessage,
  AuthEvent,
  AuthResult,
  Credential,
  CredentialInfo,
  CredentialStore,
  Models
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import test from "node:test";
import { AgentProviderFailureError } from "../src/agentRuntimeAdapter.js";
import { PiAgentRuntimeAdapter } from "../src/piAgentRuntimeAdapter.js";

test("keeps the account key stable when OAuth tokens rotate for the same stored account", async () => {
  const store = new MutableCredentialStore(
    oauthCredential("access-one", "refresh-one", { accountId: "account-one" })
  );
  const adapter = createAdapter(store, () => oauthAuth(store));

  try {
    const first = await adapter.status();
    replaceOAuthCredential(store, oauthCredential("access-two", "refresh-two", { accountId: "account-one" }));
    const rotated = await adapter.status();
    replaceOAuthCredential(store, oauthCredential("access-three", "refresh-three", { accountId: "account-two" }));
    const different = await adapter.status();

    assert.equal(first.connected, true);
    assert.match(first.accountKey ?? "", /^[a-f0-9]{64}$/);
    assert.equal(rotated.accountKey, first.accountKey);
    assert.notEqual(different.accountKey, first.accountKey);
    assert.equal(first.accountKey?.includes("account-one"), false);
    assert.equal(first.accountKey?.includes("access-one"), false);
    assert.equal(first.accountKey?.includes("refresh-one"), false);
  } finally {
    await adapter.close();
  }
});

test("uses stable JWT subject and email claims when stored account fields are absent", async () => {
  const store = new MutableCredentialStore(
    oauthCredential("access-one", "refresh-one", {
      id_token: jwt({ sub: "subject-one", email: "first@example.test", iat: 1 })
    })
  );
  const adapter = createAdapter(store, () => oauthAuth(store));

  try {
    const subject = await adapter.status();
    replaceOAuthCredential(store, oauthCredential("access-two", "refresh-two", {
      id_token: jwt({ sub: "subject-one", email: "changed@example.test", iat: 2 })
    }));
    const sameSubject = await adapter.status();
    assert.equal(sameSubject.accountKey, subject.accountKey);

    replaceOAuthCredential(store, oauthCredential("access-three", "refresh-three", {
      idToken: jwt({ email: "Reader@One.Example", iat: 3 })
    }));
    const email = await adapter.status();
    replaceOAuthCredential(store, oauthCredential("access-four", "refresh-four", {
      idToken: jwt({ email: "reader@one.example", iat: 4 })
    }));
    const sameEmail = await adapter.status();
    replaceOAuthCredential(store, oauthCredential("access-five", "refresh-five", {
      idToken: jwt({ email: "reader@two.example", iat: 5 })
    }));
    const differentEmail = await adapter.status();

    assert.equal(sameEmail.accountKey, email.accountKey);
    assert.notEqual(differentEmail.accountKey, email.accountKey);
    assert.notEqual(email.accountKey, subject.accountKey);
  } finally {
    await adapter.close();
  }
});

test("persists an opaque OAuth connection identity across access and refresh token rotation", async () => {
  const store = new MutableCredentialStore(oauthCredential("opaque-access-one", "opaque-refresh-one"));
  let authResolutions = 0;
  const adapter = createAdapter(store, () => {
    authResolutions += 1;
    if (authResolutions === 2) {
      replaceOAuthCredential(store, oauthCredential("opaque-access-two", "opaque-refresh-two"));
    }
    return oauthAuth(store);
  });

  try {
    const first = await adapter.status();
    const rotated = await adapter.status();

    assert.equal(rotated.accountKey, first.accountKey);
    assert.equal(first.accountKey?.includes("opaque-access-one"), false);
    assert.equal(first.accountKey?.includes("opaque-refresh-one"), false);

    await adapter.close();
    const restarted = createAdapter(store, () => oauthAuth(store));
    try {
      const restored = await restarted.status();
      assert.equal(restored.accountKey, first.accountKey);
    } finally {
      await restarted.close();
    }
  } finally {
    await adapter.close();
  }
});

test("rotates opaque OAuth connection identity after an explicit replacement login", async () => {
  const store = new MutableCredentialStore(oauthCredential("opaque-access-one", "opaque-refresh-one"));
  const adapter = createAdapter(store, () => oauthAuth(store), async () => {
    store.credential = oauthCredential("opaque-access-two", "opaque-refresh-two");
  });

  try {
    const first = await adapter.status();
    const login = await adapter.startLogin();
    const replacement = await adapter.status();

    assert.equal(login.status, "completed");
    assert.notEqual(replacement.accountKey, first.accountKey);
    assert.equal(replacement.accountKey?.includes("opaque-access-two"), false);
    assert.equal(replacement.accountKey?.includes("opaque-refresh-two"), false);
  } finally {
    await adapter.close();
  }
});

test("coalesces concurrent device OAuth login requests", async () => {
  const store = new MutableCredentialStore(undefined);
  let loginCalls = 0;
  const adapter = createAdapter(store, () => oauthAuth(store), async (options) => {
    loginCalls += 1;
    options.notify({
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.example.test/device",
      intervalSeconds: 5,
      expiresInSeconds: 900
    });
    return new Promise<never>((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  });

  try {
    const [first, second] = await Promise.all([adapter.startLogin(), adapter.startLogin()]);
    assert.equal(loginCalls, 1);
    assert.equal(first.loginId, second.loginId);
    assert.equal(first.status, "pending");
    const changing = await adapter.status();
    assert.equal(changing.connected, false);
    assert.equal(changing.accountKey, null);
    assert.equal(changing.message, "Agent authentication is changing");
    await assert.rejects(
      () => adapter.run({} as Parameters<PiAgentRuntimeAdapter["run"]>[0]),
      (error: unknown) =>
        (error as { statusCode?: number }).statusCode === 503 &&
        (error as Error).message === "Agent authentication is changing"
    );
    await adapter.cancelLogin(first.loginId);
    assert.equal((await adapter.loginStatus(first.loginId)).status, "cancelled");
  } finally {
    await adapter.close();
  }
});

test("treats credential finalization as the point of no return for cancellation", async () => {
  const store = new MutableCredentialStore(oauthCredential("access-one", "refresh-one"));
  const rotationStarted = deferred<void>();
  const finishRotation = deferred<void>();
  store.beforeModify = async () => {
    rotationStarted.resolve();
    await finishRotation.promise;
  };
  let loginSignal: AbortSignal | null = null;
  const adapter = createAdapter(store, () => oauthAuth(store), async (options) => {
    loginSignal = options.signal;
    options.notify({
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.example.test/device",
      intervalSeconds: 5,
      expiresInSeconds: 900
    });
    store.credential = oauthCredential("access-two", "refresh-two");
  });

  try {
    const attempt = await adapter.startLogin();
    await rotationStarted.promise;
    const cancellation = adapter.cancelLogin(attempt.loginId);
    await Promise.resolve();
    assert.equal(loginSignal?.aborted, false);

    finishRotation.resolve();
    await cancellation;
    assert.equal((await adapter.loginStatus(attempt.loginId)).status, "completed");
    assert.equal((store.credential as { access?: string } | undefined)?.access, "access-two");
  } finally {
    finishRotation.resolve();
    await adapter.close();
  }
});

test("coalesces sign-out and blocks a new login until credential removal finishes", async () => {
  const store = new MutableCredentialStore(oauthCredential("access-one", "refresh-one"));
  const logoutStarted = deferred<void>();
  const finishLogout = deferred<void>();
  let logoutCalls = 0;
  const adapter = createAdapter(
    store,
    () => oauthAuth(store),
    async () => undefined,
    async () => {
      logoutCalls += 1;
      logoutStarted.resolve();
      await finishLogout.promise;
      await store.delete();
    }
  );

  try {
    const first = adapter.logout();
    const second = adapter.logout();
    await logoutStarted.promise;
    await assert.rejects(
      () => adapter.startLogin(),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409
    );

    finishLogout.resolve();
    await Promise.all([first, second]);
    assert.equal(logoutCalls, 1);
    assert.equal((await adapter.status()).connected, false);
  } finally {
    finishLogout.resolve();
    await adapter.close();
  }
});

test("rejects ambient API-key authentication without exposing the key", async () => {
  const store = new MutableCredentialStore(undefined);
  const adapter = createAdapter(store, () => ({ auth: { apiKey: "ambient-key-one" }, source: "TEST_API_KEY" }));

  try {
    const status = await adapter.status();
    assert.equal(status.available, true);
    assert.equal(status.connected, false);
    assert.equal(status.authSource, null);
    assert.equal(status.accountKey, null);
    assert.equal(status.message, "Ask this Space supports only device OAuth credentials stored by MemoRepo");
    assert.equal(JSON.stringify(status).includes("ambient-key-one"), false);

    await assert.rejects(
      () => adapter.logout(),
      (error: unknown) =>
        (error as { statusCode?: number }).statusCode === 503 &&
        (error as Error).message ===
          "Agent sign-out is blocked by an external credential. Remove it before signing out"
    );
  } finally {
    await adapter.close();
  }
});

test("completes managed sign-out when ambient authentication remains after credential deletion", async () => {
  const store = new MutableCredentialStore(oauthCredential("access-one", "refresh-one"));
  const adapter = createAdapter(
    store,
    () => ({ auth: { apiKey: "ambient-key-one" }, source: "TEST_API_KEY" }),
    undefined,
    async () => store.delete()
  );

  try {
    assert.equal((await adapter.status()).connected, true);

    await adapter.logout();

    assert.equal(store.credential, undefined);
    const status = await adapter.status();
    assert.equal(status.connected, false);
    assert.equal(status.accountKey, null);
    assert.equal(JSON.stringify(status).includes("ambient-key-one"), false);
  } finally {
    await adapter.close();
  }
});

test("cancels pending device OAuth before deleting the stored credential", async () => {
  const store = new MutableCredentialStore(oauthCredential("access-one", "refresh-one"));
  let loginSignal: AbortSignal | null = null;
  let abortedBeforeDelete = false;
  const adapter = createAdapter(
    store,
    () => oauthAuth(store),
    async (options) => {
      loginSignal = options.signal;
      options.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.example.test/device",
        intervalSeconds: 5,
        expiresInSeconds: 900
      });
      return new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
    async () => {
      abortedBeforeDelete = loginSignal?.aborted ?? false;
      await store.delete();
    }
  );

  try {
    const attempt = await adapter.startLogin();
    assert.equal(attempt.status, "pending");

    await adapter.logout();

    assert.equal(abortedBeforeDelete, true);
    assert.equal((await adapter.loginStatus(attempt.loginId)).status, "cancelled");
    assert.equal(store.credential, undefined);
  } finally {
    await adapter.close();
  }
});

test("does not expose OAuth or transport secrets from Pi login errors", async (t) => {
  const token = jwt({ sub: "secret-subject", email: "secret@example.test" });
  const cases = [
    {
      name: "access and refresh tokens",
      error: new Error("OAuth rejected access_token=access-secret&refresh_token=refresh-secret")
    },
    {
      name: "authorization bearer header",
      error: new Error("Authorization: Bearer bearer-secret")
    },
    {
      name: "JWT",
      error: new Error(`Identity token ${token}`)
    },
    {
      name: "URL query parameters",
      error: new Error("POST https://auth.example.test/token?code=query-secret&client_secret=client-secret returned 400")
    },
    {
      name: "response body",
      error: new Error('Response body: {"access_token":"body-secret","refresh_token":"body-refresh"}')
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const store = new MutableCredentialStore(undefined);
      const adapter = createAdapter(store, () => undefined, async () => {
        throw testCase.error;
      });

      try {
        const attempt = await adapter.startLogin();

        assert.equal(attempt.status, "failed");
        assert.equal(attempt.error, "Agent login failed. Please try again.");
        assert.ok((attempt.error?.length ?? 0) < 100);
        assert.doesNotMatch(
          attempt.error ?? "",
          /access-secret|refresh-secret|bearer-secret|secret-subject|secret@example|query-secret|client-secret|body-secret|body-refresh|access_token|refresh_token|authorization|bearer|https?:|response body|eyJ/i
        );
      } finally {
        await adapter.close();
      }
    });
  }
});

test("lists selectable OAuth models and applies a valid selection", async () => {
  const store = new MutableCredentialStore(undefined);
  const adapter = createAdapter(store, () => undefined);
  try {
    assert.deepEqual(adapter.catalog(), {
      providers: [{
        id: "test-provider",
        name: "Test Provider",
        models: [{ id: "test-model", name: "Test Model", capabilities: {} }]
      }],
      selected: { providerId: "test-provider", modelId: "test-model", settings: {} }
    });
    adapter.selectModel("test-provider", "test-model");
    await assert.rejects(
      async () => adapter.selectModel("missing-provider", "missing-model"),
      /not available for device OAuth/
    );
  } finally {
    await adapter.close();
  }
});

test("advertises and validates only model-supported effort and verbosity settings", async () => {
  const store = new MutableCredentialStore(undefined);
  const adapter = createAdapter(store, () => undefined, undefined, undefined, true);
  try {
    assert.deepEqual(adapter.catalog().providers[0]?.models[0]?.capabilities, {
      effort: { options: ["off", "minimal", "low", "medium", "high"], default: "medium" },
      verbosity: { options: ["low", "medium", "high"], default: "medium" }
    });
    adapter.selectModel("test-provider", "test-model", { effort: "high", verbosity: "high" });
    assert.deepEqual(adapter.catalog().selected.settings, { effort: "high", verbosity: "high" });
    assert.throws(
      () => adapter.selectModel("test-provider", "test-model", { effort: "max" }),
      /Effort max is not supported/
    );
  } finally {
    await adapter.close();
  }
});

test("forwards persisted per-run Codex settings to the provider stream", async () => {
  const store = new MutableCredentialStore(oauthCredential("access-one", "refresh-one", { accountId: "account-one" }));
  const streamOptions: Array<Record<string, unknown>> = [];
  const adapter = createAdapter(
    store,
    () => oauthAuth(store),
    undefined,
    undefined,
    true,
    (options) => streamOptions.push(options)
  );
  const observations: unknown[] = [];
  try {
    adapter.selectModel("test-provider", "test-model", { effort: "high", verbosity: "high" });
    await adapter.run({
      runId: "run-1",
      sessionId: "session-1",
      providerId: "test-provider",
      modelId: "test-model",
      settings: { effort: "low", verbosity: "low" },
      systemPrompt: "Investigate the snapshot.",
      history: [{ role: "user", content: "Explain the flow", timestamp: 1 }],
      tools: [],
      requestTool: async () => ({ ok: true, value: null }),
      signal: new AbortController().signal,
      onEvent: async () => undefined,
      onProviderTurn: (observation) => observations.push(observation)
    });

    assert.equal(streamOptions.length, 1);
    assert.equal(streamOptions[0]?.reasoningEffort, "low");
    assert.equal(streamOptions[0]?.textVerbosity, "low");
    assert.equal(streamOptions[0]?.sessionId, "session-1");
    assert.deepEqual(observations, [{
      stopReason: "stop",
      usage: { input: 12, output: 8, reasoning: 3, cacheRead: 2, cacheWrite: 0, total: 20 }
    }]);
  } finally {
    await adapter.close();
  }
});

test("classifies Pi provider failures from allowlisted response metadata without exposing secrets", async () => {
  const store = new MutableCredentialStore(oauthCredential("access-one", "refresh-one"));
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "test-model",
    responseId: "resp-safe-1",
    diagnostics: [{
      type: "provider_transport_failure",
      timestamp: 2,
      error: {
        message: "Authorization: Bearer bearer-secret failed with refresh_token=refresh-secret",
        code: "ECONNRESET"
      },
      details: {
        configuredTransport: "auto",
        fallbackTransport: "sse",
        phase: "before_message_stream_start",
        rawBody: "body-secret"
      }
    }],
    usage: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "error",
    errorMessage: "Rate limit reached for access_token=access-secret",
    timestamp: 2
  };
  const adapter = createAdapter(
    store,
    () => oauthAuth(store),
    undefined,
    undefined,
    true,
    () => undefined,
    {
      message,
      response: {
        status: 429,
        headers: {
          "x-request-id": "req-safe-1",
          "retry-after": "1.5",
          authorization: "Bearer header-secret"
        }
      }
    }
  );

  try {
    let failure: unknown;
    try {
      await adapter.run({
        runId: "run-failure",
        sessionId: "session-failure",
        systemPrompt: "Private prompt content",
        history: [{ role: "user", content: "Private question", timestamp: 1 }],
        tools: [],
        requestTool: async () => ({ ok: true, value: null }),
        signal: new AbortController().signal,
        onEvent: async () => undefined,
        onProviderTurn: async () => undefined
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof AgentProviderFailureError);
    assert.deepEqual(failure.diagnostic, {
      category: "rate_limit",
      stage: "response_headers",
      providerCode: "ECONNRESET",
      httpStatus: 429,
      providerRequestId: "req-safe-1",
      providerResponseId: "resp-safe-1",
      transport: "sse",
      retryable: true,
      retryAfterMs: 1_500,
      summary: "The provider rate limit was reached during response headers."
    });
    assert.doesNotMatch(
      JSON.stringify(failure),
      /bearer-secret|refresh-secret|body-secret|access-secret|header-secret|private prompt|private question/i
    );
  } finally {
    await adapter.close();
  }
});

class MutableCredentialStore implements CredentialStore {
  beforeModify: ((next: Credential | undefined) => Promise<void>) | null = null;

  constructor(public credential: Credential | undefined) {}

  async read(): Promise<Credential | undefined> {
    return this.credential;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.credential ? [{ providerId: "test-provider", type: this.credential.type }] : [];
  }

  async modify(
    _providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    const next = await update(this.credential);
    if (next !== undefined) {
      await this.beforeModify?.(next);
      this.credential = next;
    }
    return this.credential;
  }

  async delete(): Promise<void> {
    this.credential = undefined;
  }
}

function createAdapter(
  store: CredentialStore,
  resolveAuth: () => AuthResult | undefined,
  login?: (options: FakeLoginOptions) => Promise<unknown>,
  logout?: () => Promise<void>,
  capableModel = false,
  observeStreamOptions?: (options: Record<string, unknown>) => void,
  streamScenario?: {
    message: AssistantMessage;
    response?: { status: number; headers: Record<string, string> };
  }
) {
  const model = {
    id: "test-model",
    name: "Test Model",
    provider: "test-provider",
    api: capableModel ? "openai-codex-responses" : "test-api",
    reasoning: capableModel
  };
  const provider = { id: "test-provider", name: "Test Provider", auth: { oauth: {} } };
  const models = {
    getProviders() {
      return [provider];
    },
    getModels(providerId?: string) {
      return !providerId || providerId === provider.id ? [model] : [];
    },
    getProvider(id: string) {
      return id === provider.id ? provider : undefined;
    },
    getModel(providerId: string, modelId: string) {
      return providerId === provider.id && modelId === model.id ? model : undefined;
    },
    async getAuth() {
      return resolveAuth();
    },
    async login(_providerId: string, _method: string, options: FakeLoginOptions) {
      if (!login) throw new Error("Unexpected login request");
      return login(options);
    },
    async logout() {
      if (logout) return logout();
      await store.delete(provider.id);
    },
    stream(_model: unknown, _context: unknown, options: Record<string, unknown>) {
      if (!observeStreamOptions) throw new Error("Unexpected provider stream request");
      observeStreamOptions(options);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = streamScenario?.message ?? {
        role: "assistant",
        content: [{ type: "text", text: "A detailed answer." }],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "test-model",
        usage: {
          input: 12,
          output: 8,
          reasoning: 3,
          cacheRead: 2,
          cacheWrite: 0,
          totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: "stop",
        timestamp: 2
      };
      queueMicrotask(() => {
        void (async () => {
          if (streamScenario?.response) {
            const onResponse = options.onResponse as
              | ((response: { status: number; headers: Record<string, string> }, model: unknown) => void | Promise<void>)
              | undefined;
            await onResponse?.(streamScenario.response, model);
          }
          stream.push({ type: "start", partial: message });
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            stream.push({ type: "error", reason: message.stopReason, error: message });
          } else {
            stream.push({ type: "done", reason: message.stopReason, message });
          }
        })();
      });
      return stream;
    }
  } as unknown as Models;
  return new PiAgentRuntimeAdapter(
    {
      providerId: provider.id,
      modelId: model.id,
      credentialStore: store,
      thinkingLevel: capableModel ? "medium" : "off"
    },
    models
  );
}

interface FakeLoginOptions {
  signal: AbortSignal;
  notify(event: AuthEvent): void;
}

function oauthAuth(store: MutableCredentialStore): AuthResult | undefined {
  const credential = store.credential;
  if (!credential || credential.type !== "oauth") return undefined;
  return { auth: { apiKey: credential.access }, source: "OAuth" };
}

function oauthCredential(access: string, refresh: string, fields: Record<string, unknown> = {}): Credential {
  return {
    ...fields,
    type: "oauth",
    access,
    refresh,
    expires: Date.now() + 60_000
  };
}

function replaceOAuthCredential(store: MutableCredentialStore, credential: Credential): void {
  const connectionId = (store.credential as Record<string, unknown> | undefined)?.agentConnectionId;
  store.credential = connectionId ? ({ ...credential, agentConnectionId: connectionId } as Credential) : credential;
}

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
