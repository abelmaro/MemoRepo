import path from "node:path";
import { ensurePrivateDir, initializePrivateFileCreation } from "./domain/permissions.js";

export interface AppConfig {
  apiHost: string;
  apiPort: number;
  publicApiUrl: string;
  frontendOrigin: string;
  githubToken: string;
  githubOAuthClientId: string | null;
  githubOAuthEnabled: boolean;
  memorepoHome: string;
  secretsDir: string;
  githubCredentialKeyPath: string;
  dataDir: string;
  spacesDir: string;
  indexesDir: string;
  repoIndexesDir: string;
  snapshotIndexesDir: string;
  logsDir: string;
  tmpDir: string;
  binDir: string;
  databasePath: string;
  mcpContainerName: string;
  snapshotRetentionDefault: number;
  jobRetentionDaysDefault: number;
  jobConcurrency: number;
}

function absolutePath(input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
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

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  throw new Error(`${name} must be a boolean value`);
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
    githubToken: requiredEnv("GH_TOKEN"),
    githubOAuthClientId: process.env.GITHUB_OAUTH_CLIENT_ID?.trim() || null,
    githubOAuthEnabled: booleanEnv("MEMOREPO_GITHUB_OAUTH_ENABLED", false),
    memorepoHome,
    secretsDir,
    githubCredentialKeyPath: path.join(secretsDir, "github-credentials.key"),
    dataDir,
    spacesDir,
    indexesDir,
    repoIndexesDir,
    snapshotIndexesDir,
    logsDir,
    tmpDir,
    binDir,
    databasePath: path.join(dataDir, "memorepo.sqlite"),
    mcpContainerName: process.env.MEMOREPO_API_CONTAINER_NAME ?? "memorepo-api",
    snapshotRetentionDefault: positiveIntEnv("MEMOREPO_SNAPSHOT_RETENTION", 3),
    jobRetentionDaysDefault: positiveIntEnv("MEMOREPO_JOB_RETENTION_DAYS", 30),
    jobConcurrency: positiveIntEnv("MEMOREPO_JOB_CONCURRENCY", 2)
  };
}
