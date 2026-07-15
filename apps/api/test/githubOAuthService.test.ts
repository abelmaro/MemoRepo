import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubOAuthRequestError,
  GitHubOAuthService
} from "../src/services/githubOAuthService.js";
import type {
  GitHubCredentialInput,
  GitHubCredentialMetadata,
  GitHubCredentialWriter,
  StoredGitHubCredential
} from "../src/services/githubCredentialStore.js";

test("device flow starts once and does not expose the private device code", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchStub = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return jsonResponse({
      device_code: "private-device-code",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5
    });
  };
  const service = new GitHubOAuthService("client-id", memoryStore(), {
    fetch: fetchStub as typeof fetch,
    now: () => Date.parse("2026-07-15T12:00:00.000Z"),
    createAttemptId: () => "gha_test-attempt"
  });

  const started = await service.startDeviceAuthorization();
  const repeated = await service.startDeviceAuthorization();

  assert.deepEqual(started, repeated);
  assert.equal(started.attemptId, "gha_test-attempt");
  assert.equal(started.userCode, "ABCD-1234");
  assert.equal(JSON.stringify(started).includes("private-device-code"), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://github.com/login/device/code");
  assert.match(String(requests[0]?.init.body), /scope=repo/);
  assert.equal(
    service.connectionStatus().manageAuthorizationUrl,
    "https://github.com/settings/connections/applications/client-id"
  );
});

test("device flow honors pending and slow-down intervals before storing a verified token", async () => {
  let now = Date.parse("2026-07-15T12:00:00.000Z");
  const store = memoryStore();
  const responses = [
    {
      device_code: "private-device-code",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5
    },
    { error: "authorization_pending" },
    { error: "slow_down" },
    { access_token: "gho_verified-secret", token_type: "bearer", scope: "repo" },
    { id: 42, login: "octocat", name: "The Octocat", avatar_url: "https://avatars.example/octocat" }
  ];
  const service = new GitHubOAuthService("client-id", store, {
    fetch: (async () => jsonResponse(responses.shift())) as typeof fetch,
    now: () => now,
    createAttemptId: () => "gha_test-attempt"
  });

  const started = await service.startDeviceAuthorization();
  assert.equal((await service.getDeviceAuthorizationStatus(started.attemptId)).status, "pending");

  now += 5_000;
  const pending = await service.getDeviceAuthorizationStatus(started.attemptId);
  assert.equal(pending.status, "pending");

  now += 5_000;
  const slowed = await service.getDeviceAuthorizationStatus(started.attemptId);
  assert.equal(slowed.status, "pending");
  if (slowed.status === "pending") {
    assert.equal(Date.parse(slowed.nextPollAt) - now, 10_000);
  }

  now += 10_000;
  const connected = await service.getDeviceAuthorizationStatus(started.attemptId);
  assert.equal(connected.status, "connected");
  assert.equal(store.get()?.accessToken, "gho_verified-secret");
  assert.equal(service.connectionStatus().viewer?.login, "octocat");
});

test("device flow rejects missing scope and unknown attempts", async () => {
  let now = 1_000;
  const responses = [
    {
      device_code: "private-device-code",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 6,
      interval: 5
    },
    { access_token: "gho_under-scoped", token_type: "bearer", scope: "" }
  ];
  const service = new GitHubOAuthService("client-id", memoryStore(), {
    fetch: (async () => jsonResponse(responses.shift())) as typeof fetch,
    now: () => now,
    createAttemptId: () => "gha_test-attempt"
  });

  const started = await service.startDeviceAuthorization();
  await assert.rejects(
    () => service.getDeviceAuthorizationStatus("gha_unknown"),
    (error: unknown) => error instanceof GitHubOAuthRequestError && error.statusCode === 404
  );
  now += 5_000;
  const failed = await service.getDeviceAuthorizationStatus(started.attemptId);
  assert.deepEqual(failed, {
    status: "failed",
    error: "GitHub authorization did not grant the required repo scope"
  });
  assert.equal(service.connectionStatus().connected, false);
});

test("device flow reaches terminal states for denial, local cancellation, and expiry", async () => {
  let now = 1_000;
  const deniedResponses = [
    {
      device_code: "private-device-code",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5
    },
    { error: "access_denied" }
  ];
  const deniedService = new GitHubOAuthService("client-id", memoryStore(), {
    fetch: (async () => jsonResponse(deniedResponses.shift())) as typeof fetch,
    now: () => now,
    createAttemptId: () => "gha_denied-attempt"
  });
  const deniedStart = await deniedService.startDeviceAuthorization();
  now += 5_000;
  assert.deepEqual(await deniedService.getDeviceAuthorizationStatus(deniedStart.attemptId), {
    status: "denied",
    error: "GitHub authorization was denied"
  });

  const cancelledService = new GitHubOAuthService("client-id", memoryStore(), {
    fetch: (async () =>
      jsonResponse({
        device_code: "private-device-code",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5
      })) as typeof fetch,
    now: () => now,
    createAttemptId: () => "gha_cancelled-attempt"
  });
  const cancelledStart = await cancelledService.startDeviceAuthorization();
  assert.equal(cancelledService.cancelDeviceAuthorization(cancelledStart.attemptId), true);
  assert.deepEqual(await cancelledService.getDeviceAuthorizationStatus(cancelledStart.attemptId), {
    status: "denied",
    error: "GitHub authorization was cancelled locally"
  });

  const expiredService = new GitHubOAuthService("client-id", memoryStore(), {
    fetch: (async () =>
      jsonResponse({
        device_code: "private-device-code",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 5,
        interval: 1
      })) as typeof fetch,
    now: () => now,
    createAttemptId: () => "gha_expired-attempt"
  });
  const expiredStart = await expiredService.startDeviceAuthorization();
  now += 5_000;
  assert.deepEqual(await expiredService.getDeviceAuthorizationStatus(expiredStart.attemptId), {
    status: "expired",
    error: "The GitHub authorization code expired"
  });
});

test("device flow requires a configured OAuth client", async () => {
  await assert.rejects(
    () => new GitHubOAuthService(null, memoryStore()).startDeviceAuthorization(),
    (error: unknown) => error instanceof GitHubOAuthRequestError && error.statusCode === 503
  );
});

function memoryStore(): GitHubCredentialWriter {
  let credential: StoredGitHubCredential | null = null;
  return {
    get: () => credential,
    getMetadata: () => {
      if (!credential) return null;
      const { accessToken: _accessToken, ...metadata } = credential;
      return metadata satisfies GitHubCredentialMetadata;
    },
    save: (input: GitHubCredentialInput, timestamp = new Date().toISOString()) => {
      credential = {
        ...input,
        connectedAt: timestamp,
        lastValidatedAt: timestamp,
        updatedAt: timestamp
      };
      return credential;
    },
    markValidated: (timestamp = new Date().toISOString()) => {
      if (credential) {
        credential = { ...credential, lastValidatedAt: timestamp, updatedAt: timestamp };
      }
    },
    delete: () => {
      const existed = credential !== null;
      credential = null;
      return existed;
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
