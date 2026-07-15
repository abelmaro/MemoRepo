import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

test("configuration enables GitHub OAuth by default and starts without a legacy credential", () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-oauth-config-"));
  const previous = {
    home: process.env.MEMOREPO_HOME,
    secrets: process.env.MEMOREPO_SECRETS_DIR,
    enabled: process.env.MEMOREPO_GITHUB_OAUTH_ENABLED,
    token: process.env.GH_TOKEN
  };

  try {
    process.env.MEMOREPO_HOME = path.join(testRoot, "home");
    delete process.env.MEMOREPO_SECRETS_DIR;
    delete process.env.MEMOREPO_GITHUB_OAUTH_ENABLED;
    delete process.env.GH_TOKEN;

    const config = loadConfig();

    assert.equal(config.githubOAuthEnabled, true);
    assert.equal(config.githubToken, null);
  } finally {
    restoreEnvironment("MEMOREPO_HOME", previous.home);
    restoreEnvironment("MEMOREPO_SECRETS_DIR", previous.secrets);
    restoreEnvironment("MEMOREPO_GITHUB_OAUTH_ENABLED", previous.enabled);
    restoreEnvironment("GH_TOKEN", previous.token);
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
