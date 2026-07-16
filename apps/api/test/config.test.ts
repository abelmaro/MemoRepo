import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, MEMOREPO_GITHUB_OAUTH_CLIENT_ID } from "../src/config.js";

test("configuration ships the official public GitHub OAuth client ID and accepts a development override", () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-oauth-config-"));
  const previous = {
    home: process.env.MEMOREPO_HOME,
    secrets: process.env.MEMOREPO_SECRETS_DIR,
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
    githubToken: process.env.GH_TOKEN
  };

  try {
    process.env.MEMOREPO_HOME = path.join(testRoot, "home");
    delete process.env.MEMOREPO_SECRETS_DIR;
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GH_TOKEN;

    const officialConfig = loadConfig();

    assert.equal(officialConfig.githubOAuthClientId, MEMOREPO_GITHUB_OAUTH_CLIENT_ID);
    assert.doesNotMatch(officialConfig.githubOAuthClientId, /PENDING|PLACEHOLDER/i);
    assert.match(officialConfig.githubOAuthClientId, /^[A-Za-z0-9]{20,64}$/);
    assert.equal(officialConfig.githubToken, null);

    process.env.GITHUB_OAUTH_CLIENT_ID = "development-client-id";

    const developmentConfig = loadConfig();

    assert.equal(developmentConfig.githubOAuthClientId, "development-client-id");

    process.env.GH_TOKEN = "  github-token-from-env  ";
    assert.equal(loadConfig().githubToken, "github-token-from-env");
  } finally {
    restoreEnvironment("MEMOREPO_HOME", previous.home);
    restoreEnvironment("MEMOREPO_SECRETS_DIR", previous.secrets);
    restoreEnvironment("GITHUB_OAUTH_CLIENT_ID", previous.clientId);
    restoreEnvironment("GH_TOKEN", previous.githubToken);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
