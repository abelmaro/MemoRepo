import path from "node:path";
import { ensurePrivateDir, initializePrivateFileCreation } from "./domain/permissions.js";

// GitHub OAuth Client IDs are public identifiers. Official MemoRepo builds ship this value so
// end users can authorize GitHub without registering an application or editing their environment.
export const MEMOREPO_GITHUB_OAUTH_CLIENT_ID = "Ov23libToTurEq9tXh9c";

export interface AppConfig {
  apiHost: string;
  apiPort: number;
  publicApiUrl: string;
  frontendOrigin: string;
  githubToken: string | null;
  githubOAuthClientId: string;
  memorepoHome: string;
  secretsDir: string;
  githubCredentialKeyPath: string;
  dataDir: string;
  spacesDir: string;
  indexesDir: string;
  repoIndexesDir: string;
  snapshotIndexesDir: string;
  revisionSourcesDir: string;
  logsDir: string;
  tmpDir: string;
  binDir: string;
  databasePath: string;
  mcpContainerName: string;
  agentProvider: string;
  agentModel: string;
  agentCredentialPath: string;
  agentMaxRunSeconds: number;
  agentMaxToolCalls: number;
  agentMaxProviderRounds: number;
  agentMaxActiveTurns: number;
  agentMaxQueuedTurns: number;
  snapshotRetentionDefault: number;
  jobRetentionDaysDefault: number;
  jobConcurrency: number;
  cbmIndexConcurrency: number;
  cbmInteractiveConcurrency: number;
}

function absolutePath(input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return fallback;
  }
  return value;
}

export function corsOrigins(config: AppConfig): string[] {
  return Array.from(new Set([config.frontendOrigin, "http://127.0.0.1:5173", "http://localhost:5173"]));
}

export function loadConfig(): AppConfig {
  initializePrivateFileCreation();
  const memorepoHome = absolutePath(process.env.MEMOREPO_HOME ?? ".memorepo");
  const secretsDir = absolutePath(process.env.MEMOREPO_SECRETS_DIR ?? path.join(memorepoHome, "secrets"));
  const dataDir = path.join(memorepoHome, "data");
  const spacesDir = path.join(memorepoHome, "spaces");
  const indexesDir = path.join(memorepoHome, "indexes");
  const repoIndexesDir = path.join(indexesDir, "r");
  const snapshotIndexesDir = path.join(indexesDir, "s");
  const revisionSourcesDir = path.join(indexesDir, "c");
  const logsDir = path.join(memorepoHome, "logs");
  const tmpDir = path.join(memorepoHome, "tmp");
  const binDir = path.join(memorepoHome, "bin");

  for (const dir of [
    memorepoHome,
    secretsDir,
    dataDir,
    spacesDir,
    indexesDir,
    repoIndexesDir,
    snapshotIndexesDir,
    revisionSourcesDir,
    logsDir,
    tmpDir,
    binDir
  ]) {
    ensurePrivateDir(dir);
  }

  const apiPort = Number(process.env.API_PORT ?? 8787);

  return {
    apiHost: process.env.API_HOST ?? "127.0.0.1",
    apiPort,
    publicApiUrl: (process.env.MEMOREPO_PUBLIC_API_URL ?? `http://127.0.0.1:${apiPort}`).replace(/\/+$/, ""),
    frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://127.0.0.1:5173",
    githubToken: process.env.GH_TOKEN?.trim() || null,
    githubOAuthClientId: process.env.GITHUB_OAUTH_CLIENT_ID?.trim() || MEMOREPO_GITHUB_OAUTH_CLIENT_ID,
    memorepoHome,
    secretsDir,
    githubCredentialKeyPath: path.join(secretsDir, "github-credentials.key"),
    dataDir,
    spacesDir,
    indexesDir,
    repoIndexesDir,
    snapshotIndexesDir,
    revisionSourcesDir,
    logsDir,
    tmpDir,
    binDir,
    databasePath: path.join(dataDir, "memorepo.sqlite"),
    mcpContainerName: process.env.MEMOREPO_API_CONTAINER_NAME ?? "memorepo-api",
    agentProvider: process.env.MEMOREPO_AGENT_PROVIDER_ID?.trim() ?? "",
    agentModel: process.env.MEMOREPO_AGENT_MODEL_ID?.trim() ?? "",
    agentCredentialPath: absolutePath(
      process.env.MEMOREPO_AGENT_CREDENTIAL_FILE ?? path.join(secretsDir, "agent-credentials.json")
    ),
    agentMaxRunSeconds: positiveIntEnv("MEMOREPO_AGENT_MAX_RUN_SECONDS", 1_800),
    agentMaxToolCalls: positiveIntEnv("MEMOREPO_AGENT_MAX_TOOL_CALLS", 200),
    agentMaxProviderRounds: positiveIntEnv("MEMOREPO_AGENT_MAX_PROVIDER_ROUNDS", 50),
    agentMaxActiveTurns: positiveIntEnv("MEMOREPO_AGENT_MAX_ACTIVE_TURNS", 2),
    agentMaxQueuedTurns: positiveIntEnv("MEMOREPO_AGENT_MAX_QUEUED_TURNS", 20),
    snapshotRetentionDefault: positiveIntEnv("MEMOREPO_SNAPSHOT_RETENTION", 3),
    jobRetentionDaysDefault: positiveIntEnv("MEMOREPO_JOB_RETENTION_DAYS", 30),
    jobConcurrency: positiveIntEnv("MEMOREPO_JOB_CONCURRENCY", 2),
    cbmIndexConcurrency: positiveIntEnv("MEMOREPO_CBM_INDEX_CONCURRENCY", 1),
    cbmInteractiveConcurrency: positiveIntEnv("MEMOREPO_CBM_INTERACTIVE_CONCURRENCY", 2)
  };
}
