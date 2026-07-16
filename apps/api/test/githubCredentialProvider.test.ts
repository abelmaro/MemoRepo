import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubCredentialProvider,
  GitHubNotConnectedError
} from "../src/services/githubCredentialProvider.js";
import type {
  GitHubCredentialMetadata,
  GitHubCredentialWriter,
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

test("credential provider uses stored OAuth credentials when GH_TOKEN is absent", () => {
  const credential: StoredGitHubCredential = { ...metadata, accessToken: "gho_oauth-secret" };
  const provider = new GitHubCredentialProvider(reader(credential));

  assert.equal(provider.getAccessToken(), "gho_oauth-secret");
  assert.equal(provider.getConnectionMetadata()?.login, "octocat");
  assert.deepEqual(provider.getSensitiveValues(), ["gho_oauth-secret"]);

  provider.markValidated("2026-07-15T12:05:00.000Z");
  assert.equal(provider.getConnectionMetadata()?.lastValidatedAt, "2026-07-15T12:05:00.000Z");
  assert.equal(provider.invalidateOAuthCredential(), true);
  assert.throws(() => provider.getAccessToken(), GitHubNotConnectedError);
});

test("credential provider gives GH_TOKEN priority without mutating stored OAuth credentials", () => {
  const credential: StoredGitHubCredential = { ...metadata, accessToken: "gho_oauth-secret" };
  const provider = new GitHubCredentialProvider(reader(credential), "github-token-from-env");

  assert.equal(provider.getAccessToken(), "github-token-from-env");
  assert.equal(provider.getConnectionMetadata(), null);
  assert.deepEqual(provider.getSensitiveValues(), ["github-token-from-env", "gho_oauth-secret"]);
  assert.equal(provider.usesEnvironmentToken(), true);
  assert.equal(provider.invalidateOAuthCredential(), false);
});

test("credential provider fails with an actionable conflict when disconnected", () => {
  const provider = new GitHubCredentialProvider(reader(null));

  assert.throws(
    () => provider.getAccessToken(),
    (error: unknown) => error instanceof GitHubNotConnectedError && error.statusCode === 409
  );
});

function reader(credential: StoredGitHubCredential | null): GitHubCredentialWriter {
  return {
    get: () => credential,
    getMetadata: () => {
      if (!credential) {
        return null;
      }
      const { accessToken: _accessToken, ...currentMetadata } = credential;
      return currentMetadata;
    },
    save: (input, timestamp = new Date().toISOString()) => {
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
