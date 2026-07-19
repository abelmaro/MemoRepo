import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  loadConfig,
  MEMOREPO_GITHUB_OAUTH_CLIENT_ID
} from "../src/config.js";

test("configuration ships the official public GitHub OAuth client ID and accepts a development override", () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-oauth-config-"));
  const previous = {
    home: process.env.MEMOREPO_HOME,
    secrets: process.env.MEMOREPO_SECRETS_DIR,
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
    githubToken: process.env.GH_TOKEN,
    agentCredentialFile: process.env.MEMOREPO_AGENT_CREDENTIAL_FILE,
    agentProvider: process.env.MEMOREPO_AGENT_PROVIDER_ID,
    agentModel: process.env.MEMOREPO_AGENT_MODEL_ID,
    agentMaxRunSeconds: process.env.MEMOREPO_AGENT_MAX_RUN_SECONDS,
    agentMaxToolCalls: process.env.MEMOREPO_AGENT_MAX_TOOL_CALLS,
    agentMaxProviderRounds: process.env.MEMOREPO_AGENT_MAX_PROVIDER_ROUNDS,
    agentMaxActiveTurns: process.env.MEMOREPO_AGENT_MAX_ACTIVE_TURNS,
    agentMaxQueuedTurns: process.env.MEMOREPO_AGENT_MAX_QUEUED_TURNS,
    cbmIndexConcurrency: process.env.MEMOREPO_CBM_INDEX_CONCURRENCY,
    cbmInteractiveConcurrency: process.env.MEMOREPO_CBM_INTERACTIVE_CONCURRENCY,
    cbmIndexMode: process.env.MEMOREPO_CBM_INDEX_MODE,
    enforceSnapshotQuality: process.env.MEMOREPO_ENFORCE_SNAPSHOT_QUALITY,
    compactCbmResponses: process.env.MEMOREPO_COMPACT_CBM_RESPONSES,
    batchRepositoryOperations: process.env.MEMOREPO_BATCH_REPOSITORY_OPERATIONS,
    snapshotOnlyIndexing: process.env.MEMOREPO_SNAPSHOT_ONLY_INDEXING
  };

  try {
    process.env.MEMOREPO_HOME = path.join(testRoot, "home");
    delete process.env.MEMOREPO_SECRETS_DIR;
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GH_TOKEN;
    delete process.env.MEMOREPO_AGENT_CREDENTIAL_FILE;
    delete process.env.MEMOREPO_AGENT_PROVIDER_ID;
    delete process.env.MEMOREPO_AGENT_MODEL_ID;
    delete process.env.MEMOREPO_AGENT_MAX_RUN_SECONDS;
    delete process.env.MEMOREPO_AGENT_MAX_TOOL_CALLS;
    delete process.env.MEMOREPO_AGENT_MAX_PROVIDER_ROUNDS;
    delete process.env.MEMOREPO_AGENT_MAX_ACTIVE_TURNS;
    delete process.env.MEMOREPO_AGENT_MAX_QUEUED_TURNS;
    delete process.env.MEMOREPO_CBM_INDEX_CONCURRENCY;
    delete process.env.MEMOREPO_CBM_INTERACTIVE_CONCURRENCY;
    delete process.env.MEMOREPO_CBM_INDEX_MODE;
    delete process.env.MEMOREPO_ENFORCE_SNAPSHOT_QUALITY;
    delete process.env.MEMOREPO_COMPACT_CBM_RESPONSES;
    delete process.env.MEMOREPO_BATCH_REPOSITORY_OPERATIONS;
    delete process.env.MEMOREPO_SNAPSHOT_ONLY_INDEXING;

    const unconfiguredAgent = loadConfig();
    assert.equal(unconfiguredAgent.agentProvider, "");
    assert.equal(unconfiguredAgent.agentModel, "");
    assert.equal(unconfiguredAgent.agentMaxRunSeconds, 1_800);
    assert.equal(unconfiguredAgent.agentMaxToolCalls, 200);
    assert.equal(unconfiguredAgent.agentMaxProviderRounds, 50);
    assert.equal(unconfiguredAgent.agentMaxActiveTurns, 2);
    assert.equal(unconfiguredAgent.agentMaxQueuedTurns, 20);
    assert.equal(unconfiguredAgent.cbmIndexConcurrency, 1);
    assert.equal(unconfiguredAgent.cbmIndexMode, "fast");
    assert.equal(unconfiguredAgent.snapshotOnlyIndexing, false);
    assert.equal(unconfiguredAgent.enforceSnapshotQuality, true);
    assert.equal(unconfiguredAgent.compactCbmResponses, true);
    assert.equal(unconfiguredAgent.batchRepositoryOperations, true);
    assert.equal(unconfiguredAgent.cbmInteractiveConcurrency, 2);

    process.env.MEMOREPO_AGENT_PROVIDER_ID = "test-provider";
    process.env.MEMOREPO_AGENT_MODEL_ID = "test-model";
    process.env.MEMOREPO_AGENT_MAX_RUN_SECONDS = "720";
    process.env.MEMOREPO_AGENT_MAX_TOOL_CALLS = "120";
    process.env.MEMOREPO_AGENT_MAX_PROVIDER_ROUNDS = "14";
    process.env.MEMOREPO_AGENT_MAX_ACTIVE_TURNS = "3";
    process.env.MEMOREPO_AGENT_MAX_QUEUED_TURNS = "30";
    process.env.MEMOREPO_CBM_INDEX_CONCURRENCY = "3";
    process.env.MEMOREPO_CBM_INTERACTIVE_CONCURRENCY = "4";
    process.env.MEMOREPO_CBM_INDEX_MODE = "full";
    process.env.MEMOREPO_ENFORCE_SNAPSHOT_QUALITY = "off";
    process.env.MEMOREPO_COMPACT_CBM_RESPONSES = "no";
    process.env.MEMOREPO_BATCH_REPOSITORY_OPERATIONS = "0";
    process.env.MEMOREPO_SNAPSHOT_ONLY_INDEXING = "yes";

    const officialConfig = loadConfig();

    assert.equal(officialConfig.githubOAuthClientId, MEMOREPO_GITHUB_OAUTH_CLIENT_ID);
    assert.doesNotMatch(officialConfig.githubOAuthClientId, /PENDING|PLACEHOLDER/i);
    assert.match(officialConfig.githubOAuthClientId, /^[A-Za-z0-9]{20,64}$/);
    assert.equal(officialConfig.githubToken, null);
    assert.equal(officialConfig.agentProvider, "test-provider");
    assert.equal(officialConfig.agentModel, "test-model");
    assert.equal(officialConfig.agentMaxRunSeconds, 720);
    assert.equal(officialConfig.agentMaxToolCalls, 120);
    assert.equal(officialConfig.agentMaxProviderRounds, 14);
    assert.equal(officialConfig.agentMaxActiveTurns, 3);
    assert.equal(officialConfig.agentMaxQueuedTurns, 30);
    assert.equal(officialConfig.cbmIndexConcurrency, 3);
    assert.equal(officialConfig.cbmInteractiveConcurrency, 4);
    assert.equal(officialConfig.cbmIndexMode, "full");
    assert.equal(officialConfig.enforceSnapshotQuality, false);
    assert.equal(officialConfig.compactCbmResponses, false);
    assert.equal(officialConfig.batchRepositoryOperations, false);
    assert.equal(officialConfig.snapshotOnlyIndexing, true);
    assert.equal(officialConfig.agentCredentialPath, path.join(officialConfig.secretsDir, "agent-credentials.json"));

    process.env.GITHUB_OAUTH_CLIENT_ID = "development-client-id";

    const developmentConfig = loadConfig();

    assert.equal(developmentConfig.githubOAuthClientId, "development-client-id");

    process.env.GH_TOKEN = "  github-token-from-env  ";
    assert.equal(loadConfig().githubToken, "github-token-from-env");

    process.env.MEMOREPO_CBM_INDEX_MODE = "unsupported";
    assert.throws(() => loadConfig(), /MEMOREPO_CBM_INDEX_MODE must be fast, moderate, or full/);
    process.env.MEMOREPO_CBM_INDEX_MODE = "full";

    process.env.MEMOREPO_AGENT_CREDENTIAL_FILE = path.join(testRoot, "agent-auth.json");
    const agentConfig = loadConfig();
    assert.equal(agentConfig.agentCredentialPath, path.join(testRoot, "agent-auth.json"));
  } finally {
    restoreEnvironment("MEMOREPO_HOME", previous.home);
    restoreEnvironment("MEMOREPO_SECRETS_DIR", previous.secrets);
    restoreEnvironment("GITHUB_OAUTH_CLIENT_ID", previous.clientId);
    restoreEnvironment("GH_TOKEN", previous.githubToken);
    restoreEnvironment("MEMOREPO_AGENT_CREDENTIAL_FILE", previous.agentCredentialFile);
    restoreEnvironment("MEMOREPO_AGENT_PROVIDER_ID", previous.agentProvider);
    restoreEnvironment("MEMOREPO_AGENT_MODEL_ID", previous.agentModel);
    restoreEnvironment("MEMOREPO_AGENT_MAX_RUN_SECONDS", previous.agentMaxRunSeconds);
    restoreEnvironment("MEMOREPO_AGENT_MAX_TOOL_CALLS", previous.agentMaxToolCalls);
    restoreEnvironment("MEMOREPO_AGENT_MAX_PROVIDER_ROUNDS", previous.agentMaxProviderRounds);
    restoreEnvironment("MEMOREPO_AGENT_MAX_ACTIVE_TURNS", previous.agentMaxActiveTurns);
    restoreEnvironment("MEMOREPO_AGENT_MAX_QUEUED_TURNS", previous.agentMaxQueuedTurns);
    restoreEnvironment("MEMOREPO_CBM_INDEX_CONCURRENCY", previous.cbmIndexConcurrency);
    restoreEnvironment("MEMOREPO_CBM_INTERACTIVE_CONCURRENCY", previous.cbmInteractiveConcurrency);
    restoreEnvironment("MEMOREPO_CBM_INDEX_MODE", previous.cbmIndexMode);
    restoreEnvironment("MEMOREPO_ENFORCE_SNAPSHOT_QUALITY", previous.enforceSnapshotQuality);
    restoreEnvironment("MEMOREPO_COMPACT_CBM_RESPONSES", previous.compactCbmResponses);
    restoreEnvironment("MEMOREPO_BATCH_REPOSITORY_OPERATIONS", previous.batchRepositoryOperations);
    restoreEnvironment("MEMOREPO_SNAPSHOT_ONLY_INDEXING", previous.snapshotOnlyIndexing);
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
