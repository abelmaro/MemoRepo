import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubCredentialProvider,
  GitHubNotConnectedError
} from "../src/services/githubCredentialProvider.js";
import type {
  GitHubCredentialMetadata,
  GitHubCredentialReader,
  StoredGitHubCredential
} from "../src/services/githubCredentialStore.js";

const metadata: GitHubCredentialMetadata = {
  githubUserId: 42,
  login: "octocat",
  name: "The Octocat",
  avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
  tokenType: "bearer",
  scopes: ["repo"],
  connectedAt: "2026-07-15T12:00:00.000Z",
  lastValidatedAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z"
};

test("credential provider preserves the existing token while compatibility mode is disabled", () => {
  const provider = new GitHubCredentialProvider(reader(null), false, "legacy-secret");

  assert.equal(provider.getAccessToken(), "legacy-secret");
  assert.equal(provider.getConnectionMetadata(), null);
  assert.deepEqual(provider.getSensitiveValues(), ["legacy-secret"]);
  assert.equal(provider.usesOAuth(), false);
});

test("credential provider exclusively uses stored OAuth credentials when enabled", () => {
  const credential: StoredGitHubCredential = { ...metadata, accessToken: "gho_oauth-secret" };
  const provider = new GitHubCredentialProvider(reader(credential), true, "legacy-secret");

  assert.equal(provider.getAccessToken(), "gho_oauth-secret");
  assert.equal(provider.getConnectionMetadata()?.login, "octocat");
  assert.deepEqual(provider.getSensitiveValues(), ["legacy-secret", "gho_oauth-secret"]);
  assert.equal(provider.usesOAuth(), true);
});

test("credential provider fails with an actionable conflict when OAuth is enabled but disconnected", () => {
  const provider = new GitHubCredentialProvider(reader(null), true, "legacy-secret");

  assert.throws(
    () => provider.getAccessToken(),
    (error: unknown) => error instanceof GitHubNotConnectedError && error.statusCode === 409
  );
});

function reader(credential: StoredGitHubCredential | null): GitHubCredentialReader {
  return {
    get: () => credential,
    getMetadata: () => (credential ? metadata : null)
  };
}
