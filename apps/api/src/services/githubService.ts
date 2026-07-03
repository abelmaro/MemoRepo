import type { AppConfig } from "../config.js";
import { insertRecord, updateRecord } from "../db/sql.js";
import { createId } from "../domain/ids.js";
import { parseGitHubRepositoryLocator, type GitHubRepositoryInput } from "../domain/github.js";
import { nowIso } from "../domain/time.js";
import type { AppDatabase } from "../db/connection.js";

interface GitHubOwnerPayload {
  login: string;
}

interface GitHubOrganizationPayload {
  login: string;
}

interface GitHubRepositoryPayload {
  id: number;
  owner: GitHubOwnerPayload;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  description: string | null;
  topics?: string[];
  pushed_at: string | null;
}

interface GitHubUserPayload {
  login: string;
  name: string | null;
}

interface GitHubSyncResult {
  count: number;
  warnings: string[];
}

interface GitHubOrganizationAccess {
  login: string;
  status: "visible" | "inaccessible";
  repositoryCount: number | null;
  error?: string;
}

interface GitHubRepositoryCollection {
  repositories: GitHubRepositoryPayload[];
  userRepositoryCount: number;
  organizations: GitHubOrganizationAccess[];
  warnings: string[];
}

interface GitHubAccessDiagnostics {
  connected: true;
  viewer: GitHubUserPayload;
  tokenScopes: string[];
  acceptedScopes: string[];
  visibleRepositoryCount: number;
  userRepositoryCount: number;
  visibleOrganizationCount: number;
  organizations: GitHubOrganizationAccess[];
  warnings: string[];
}

export class GitHubService {
  constructor(
    private readonly database: AppDatabase,
    private readonly config: AppConfig
  ) {}

  async getViewer(): Promise<GitHubUserPayload> {
    return this.request<GitHubUserPayload>("https://api.github.com/user");
  }

  async syncRepositories(): Promise<GitHubSyncResult> {
    const collection = await this.collectVisibleRepositories();

    for (const repository of collection.repositories) {
      this.upsertRepository(this.mapRepository(repository));
    }

    return { count: collection.repositories.length, warnings: collection.warnings };
  }

  async diagnoseAccess(): Promise<GitHubAccessDiagnostics> {
    const viewerResponse = await this.fetch("https://api.github.com/user");
    const viewer = (await viewerResponse.json()) as GitHubUserPayload;
    const collection = await this.collectVisibleRepositories();

    return {
      connected: true,
      viewer,
      tokenScopes: parseScopes(viewerResponse.headers.get("x-oauth-scopes")),
      acceptedScopes: parseScopes(viewerResponse.headers.get("x-accepted-oauth-scopes")),
      visibleRepositoryCount: collection.repositories.length,
      userRepositoryCount: collection.userRepositoryCount,
      visibleOrganizationCount: collection.organizations.filter((organization) => organization.status === "visible").length,
      organizations: collection.organizations,
      warnings: collection.warnings
    };
  }

  async resolveRepository(locator: string): Promise<{ repositoryId: string }> {
    const { owner, name } = parseGitHubRepositoryLocator(locator);
    const repository = await this.request<GitHubRepositoryPayload>(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    );
    const stored = this.upsertRepository(this.mapRepository(repository));
    return { repositoryId: stored.id };
  }

  private async collectVisibleRepositories(): Promise<GitHubRepositoryCollection> {
    const repositoriesById = new Map<number, GitHubRepositoryPayload>();
    const warnings: string[] = [];
    const userRepositories = await this.paginate<GitHubRepositoryPayload>(
      "https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=full_name"
    );

    for (const repository of userRepositories) {
      repositoriesById.set(repository.id, repository);
    }

    const organizations = await this.paginate<GitHubOrganizationPayload>("https://api.github.com/user/orgs?per_page=100");
    const organizationAccess: GitHubOrganizationAccess[] = [];
    if (userRepositories.length === 0 && organizations.length === 0) {
      warnings.push(
        "GitHub token authenticated but exposes no repositories or organizations; check repo scope, organization access, and SAML SSO authorization."
      );
    }

    for (const organization of organizations) {
      try {
        const organizationRepositories = await this.paginate<GitHubRepositoryPayload>(
          `https://api.github.com/orgs/${encodeURIComponent(organization.login)}/repos?per_page=100&type=all&sort=full_name`
        );
        for (const repository of organizationRepositories) {
          repositoriesById.set(repository.id, repository);
        }
        organizationAccess.push({
          login: organization.login,
          status: "visible",
          repositoryCount: organizationRepositories.length
        });
      } catch (error) {
        if (error instanceof GitHubRequestError && [403, 404].includes(error.status)) {
          organizationAccess.push({
            login: organization.login,
            status: "inaccessible",
            repositoryCount: null,
            error: error.message
          });
          warnings.push(`Skipped ${organization.login}: ${error.message}`);
          continue;
        }
        throw error;
      }
    }

    const repositories = [...repositoriesById.values()].sort((left, right) => left.full_name.localeCompare(right.full_name));
    return {
      repositories,
      userRepositoryCount: userRepositories.length,
      organizations: organizationAccess,
      warnings
    };
  }

  private mapRepository(payload: GitHubRepositoryPayload): GitHubRepositoryInput {
    return {
      githubId: payload.id,
      owner: payload.owner.login,
      name: payload.name,
      fullName: payload.full_name,
      htmlUrl: payload.html_url,
      cloneUrl: `https://github.com/${payload.full_name}.git`,
      defaultBranch: payload.default_branch,
      private: payload.private,
      archived: payload.archived,
      fork: payload.fork,
      description: payload.description,
      topics: payload.topics ?? [],
      pushedAt: payload.pushed_at
    };
  }

  private upsertRepository(input: GitHubRepositoryInput) {
    const existing = this.database.sqlite
      .prepare("SELECT * FROM github_repositories WHERE github_id = ?")
      .get(input.githubId) as { id: string } | undefined;

    const timestamp = nowIso();
    if (!existing) {
      const record = {
        id: createId("ghr"),
        githubId: input.githubId,
        owner: input.owner,
        name: input.name,
        fullName: input.fullName,
        htmlUrl: input.htmlUrl,
        cloneUrl: input.cloneUrl,
        defaultBranch: input.defaultBranch,
        private: input.private,
        archived: input.archived,
        fork: input.fork,
        description: input.description,
        topicsJson: JSON.stringify(input.topics),
        pushedAt: input.pushedAt,
        lastSeenAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      insertRecord(this.database, "github_repositories", record);
      return record;
    }

    updateRecord(
      this.database,
      "github_repositories",
      {
        owner: input.owner,
        name: input.name,
        fullName: input.fullName,
        htmlUrl: input.htmlUrl,
        cloneUrl: input.cloneUrl,
        defaultBranch: input.defaultBranch,
        private: input.private,
        archived: input.archived,
        fork: input.fork,
        description: input.description,
        topicsJson: JSON.stringify(input.topics),
        pushedAt: input.pushedAt,
        lastSeenAt: timestamp,
        updatedAt: timestamp
      },
      "id",
      existing.id
    );

    return { ...existing, ...input, topicsJson: JSON.stringify(input.topics), lastSeenAt: timestamp, updatedAt: timestamp };
  }

  private async paginate<T>(url: string): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | undefined = url;

    while (nextUrl) {
      const response = await this.fetch(nextUrl);
      const body = (await response.json()) as T[];
      results.push(...body);
      nextUrl = parseNextLink(response.headers.get("link"));
    }

    return results;
  }

  private async request<T>(url: string): Promise<T> {
    const response = await this.fetch(url);
    return (await response.json()) as T;
  }

  private async fetch(url: string): Promise<Response> {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.config.githubToken}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "MemoRepo"
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new GitHubRequestError(response.status, body);
    }

    return response;
  }
}

class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(formatGitHubError(status, body));
  }
}

function formatGitHubError(status: number, body: string): string {
  const parsed = parseGitHubErrorBody(body);
  const message = parsed.message.split("\n")[0]?.trim() || body.slice(0, 240).trim() || "Unknown GitHub error";
  const ssoUrl = parsed.ssoUrl;

  if (ssoUrl) {
    return `GitHub request failed ${status}: ${message} Authorize this PAT for SAML SSO: ${ssoUrl}`;
  }

  if (parsed.documentationUrl) {
    return `GitHub request failed ${status}: ${message} See ${parsed.documentationUrl}`;
  }

  return `GitHub request failed ${status}: ${message}`;
}

function parseGitHubErrorBody(body: string): { message: string; documentationUrl?: string; ssoUrl?: string } {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; documentation_url?: unknown };
    const message = typeof parsed.message === "string" ? parsed.message : body;
    const documentationUrl = typeof parsed.documentation_url === "string" ? parsed.documentation_url : undefined;
    return definedErrorDetails(message, documentationUrl, extractSsoUrl(message));
  } catch {
    return definedErrorDetails(body, undefined, extractSsoUrl(body));
  }
}

function extractSsoUrl(message: string): string | undefined {
  return message.match(/https:\/\/github\.com\/enterprises\/[^\s"]+/)?.[0];
}

function parseScopes(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function definedErrorDetails(
  message: string,
  documentationUrl: string | undefined,
  ssoUrl: string | undefined
): { message: string; documentationUrl?: string; ssoUrl?: string } {
  return {
    message,
    ...(documentationUrl ? { documentationUrl } : {}),
    ...(ssoUrl ? { ssoUrl } : {})
  };
}

function parseNextLink(link: string | null): string | undefined {
  if (!link) {
    return undefined;
  }

  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") {
      return match[1];
    }
  }

  return undefined;
}
