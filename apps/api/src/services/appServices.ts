import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config.js";
import { createDatabase } from "../db/connection.js";
import { CbmService } from "./cbmService.js";
import { GitService } from "./gitService.js";
import { GitHubCredentialProvider } from "./githubCredentialProvider.js";
import { CredentialCipher, GitHubCredentialStore } from "./githubCredentialStore.js";
import { GitHubOAuthService } from "./githubOAuthService.js";
import { GitHubService } from "./githubService.js";
import { JobRunner } from "./jobRunner.js";
import { McpGateway } from "./mcpGateway.js";
import { MaintenanceService } from "./maintenanceService.js";
import { OperationsService } from "./operationsService.js";
import { SnapshotService } from "./snapshotService.js";
import { SpaceService } from "./spaceService.js";

export type AppServices = ReturnType<typeof createServices>;

export function createServices() {
  const config = loadConfig();
  const database = createDatabase(config);
  const githubCredentialStore = new GitHubCredentialStore(
    database,
    new CredentialCipher(config.githubCredentialKeyPath)
  );
  const githubCredentials = new GitHubCredentialProvider(
    githubCredentialStore,
    config.githubOAuthEnabled,
    config.githubToken
  );
  const githubOAuth = new GitHubOAuthService(
    config.githubOAuthClientId,
    config.githubOAuthEnabled,
    githubCredentialStore
  );
  const github = new GitHubService(database, config);
  const git = new GitService(config);
  const cbm = new CbmService(config);
  const spaces = new SpaceService(database, config, cbm);
  const snapshots = new SnapshotService(database, config, cbm);
  const jobs = new JobRunner(database, config.jobConcurrency);
  const operations = new OperationsService(database, config, spaces, github, git, cbm, snapshots, jobs);
  const mcp = new McpGateway(database, config, spaces, cbm);
  const maintenance = new MaintenanceService(database, config);

  operations.registerJobHandlers();

  return {
    config,
    database,
    githubCredentialStore,
    githubCredentials,
    githubOAuth,
    github,
    git,
    cbm,
    spaces,
    snapshots,
    jobs,
    operations,
    mcp,
    maintenance
  };
}

declare module "fastify" {
  interface FastifyInstance {
    services: AppServices;
  }
}

export async function decorateServices(app: FastifyInstance, services: AppServices) {
  app.decorate("services", services);
}
