import { insertRecord, updateRecord } from "../db/sql.js";
import { createId } from "../domain/ids.js";
import { parseGitHubRepositoryLocator, type GitHubRepositoryInput } from "../domain/github.js";
import { nowIso } from "../domain/time.js";
import type { AppDatabase } from "../db/connection.js";
import type { GitHubCredentialProvider } from "./githubCredentialProvider.js";

interface GitHubOwnerPayload {
  login: string;
  type?: string;
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
    private readonly credentials: GitHubCredentialProvider
  ) {}

  async getViewer(): Promise<GitHubUserPayload> {
    const viewer = await this.request<GitHubUserPayload>("https://api.github.com/user");
    this.credentials.markValidated();
    return viewer;
  }

  async syncRepositories(signal?: AbortSignal): Promise<GitHubSyncResult> {
    const collection = await this.collectVisibleRepositories(signal);

    for (const repository of collection.repositories) {
      this.upsertRepository(this.mapRepository(repository));
    }

    return { count: collection.repositories.length, warnings: collection.warnings };
  }

  async diagnoseAccess(): Promise<GitHubAccessDiagnostics> {
    const viewerResponse = await this.fetch("https://api.github.com/user");
    const viewer = (await viewerResponse.json()) as GitHubUserPayload;
    this.credentials.markValidated();
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

  private async collectVisibleRepositories(signal?: AbortSignal): Promise<GitHubRepositoryCollection> {
    const repositoriesById = new Map<number, GitHubRepositoryPayload>();
    const warnings: string[] = [];
    const userRepositories = await this.paginate<GitHubRepositoryPayload>(
      "https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=full_name",
      signal
    );

    for (const repository of userRepositories) {
      repositoriesById.set(repository.id, repository);
    }

    const organizationCounts = new Map<string, number>();
    for (const repository of userRepositories) {
      if (repository.owner.type === "Organization") {
        organizationCounts.set(repository.owner.login, (organizationCounts.get(repository.owner.login) ?? 0) + 1);
      }
    }
    const organizationAccess: GitHubOrganizationAccess[] = [...organizationCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([login, repositoryCount]) => ({ login, status: "visible", repositoryCount }));

    if (userRepositories.length === 0) {
      warnings.push(
        "GitHub authenticated successfully but no repositories are visible; review the repo scope, organization OAuth policy, and SAML SSO authorization."
      );
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

  private async paginate<T>(url: string, signal?: AbortSignal): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | undefined = url;

    while (nextUrl) {
      const response = await this.fetch(nextUrl, signal);
      const body = await response.json();
      if (!Array.isArray(body)) {
        throw new Error("GitHub returned an invalid paginated response");
      }
      results.push(...body);
      nextUrl = parseNextLink(response.headers.get("link"));
    }

    return results;
  }

  private async request<T>(url: string): Promise<T> {
    const response = await this.fetch(url);
    return (await response.json()) as T;
  }

  private async fetch(url: string, signal?: AbortSignal): Promise<Response> {
    const accessToken = this.credentials.getAccessToken();
    const response = await fetch(url, {
      ...(signal ? { signal } : {}),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "MemoRepo"
      }
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401) {
        this.credentials.invalidateOAuthCredential();
      }
      throw new GitHubRequestError(response.status, body);
    }

    return response;
  }
}

class GitHubRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(formatGitHubError(status, body));
    this.name = "GitHubRequestError";
    this.code = `MR-GITHUB-UPSTREAM-${status}`;
    this.statusCode = status >= 500 ? 502 : status;
  }
}

function formatGitHubError(status: number, body: string): string {
  if ([502, 503, 504].includes(status)) {
    return `GitHub is temporarily unavailable (HTTP ${status}). Try again in a few minutes.`;
  }
  const parsed = parseGitHubErrorBody(body);
  const message = friendlyGitHubMessage(parsed.message, body);
  const ssoUrl = parsed.ssoUrl;

  if (ssoUrl) {
    return `GitHub request failed ${status}: ${message} Authorize this GitHub connection for SAML SSO: ${ssoUrl}`;
  }

  if (parsed.documentationUrl) {
    return `GitHub request failed ${status}: ${message} See ${parsed.documentationUrl}`;
  }

  return `GitHub request failed ${status}: ${message}`;
}

function friendlyGitHubMessage(message: string, body: string): string {
  const candidate = message.split("\n")[0]?.trim() || body.slice(0, 240).trim();
  if (!candidate || /<!doctype|<html|<body/i.test(candidate)) return "GitHub returned an unreadable upstream response";
  return candidate.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Unknown GitHub error";
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
