import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

test("configuration accepts the public GitHub OAuth client ID without an application secret", () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-oauth-config-"));
  const previous = {
    home: process.env.MEMOREPO_HOME,
    secrets: process.env.MEMOREPO_SECRETS_DIR,
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID
  };

  try {
    process.env.MEMOREPO_HOME = path.join(testRoot, "home");
    delete process.env.MEMOREPO_SECRETS_DIR;
    process.env.GITHUB_OAUTH_CLIENT_ID = "public-client-id";

    const config = loadConfig();

    assert.equal(config.githubOAuthClientId, "public-client-id");
  } finally {
    restoreEnvironment("MEMOREPO_HOME", previous.home);
    restoreEnvironment("MEMOREPO_SECRETS_DIR", previous.secrets);
    restoreEnvironment("GITHUB_OAUTH_CLIENT_ID", previous.clientId);
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
