import { randomBytes } from "node:crypto";
import type {
  GitHubCredentialMetadata,
  GitHubCredentialWriter
} from "./githubCredentialStore.js";

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_VIEWER_URL = "https://api.github.com/user";
const GITHUB_DEVICE_VERIFICATION_URL = "https://github.com/login/device";
const REQUIRED_SCOPE = "repo";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface OAuthTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

interface GitHubViewerResponse {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

type DeviceAttemptStatus = "pending" | "connected" | "denied" | "expired" | "failed";

interface DeviceAuthorizationAttempt {
  id: string;
  deviceCode: string | null;
  userCode: string;
  verificationUri: typeof GITHUB_DEVICE_VERIFICATION_URL;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
  status: DeviceAttemptStatus;
  error?: string;
  viewer?: PublicGitHubViewer;
  scopes?: string[];
}

export interface PublicGitHubViewer {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
}

export interface DeviceAuthorizationStart {
  attemptId: string;
  userCode: string;
  verificationUri: typeof GITHUB_DEVICE_VERIFICATION_URL;
  expiresAt: string;
  intervalSeconds: number;
}

export type DeviceAuthorizationStatus =
  | { status: "pending"; expiresAt: string; nextPollAt: string }
  | { status: "connected"; viewer: PublicGitHubViewer; scopes: string[] }
  | { status: "denied" | "expired" | "failed"; error: string };

export interface GitHubOAuthConnectionStatus {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  viewer?: PublicGitHubViewer;
  scopes?: string[];
  connectedAt?: string;
  lastValidatedAt?: string | null;
}

interface GitHubOAuthServiceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  createAttemptId?: () => string;
  requestTimeoutMs?: number;
}

export class GitHubOAuthRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
  }
}

export class GitHubOAuthService {
  private activeAttempt: DeviceAuthorizationAttempt | null = null;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly createAttemptId: () => string;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly clientId: string | null,
    private readonly enabled: boolean,
    private readonly credentialStore: GitHubCredentialWriter,
    options: GitHubOAuthServiceOptions = {}
  ) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.createAttemptId = options.createAttemptId ?? (() => `gha_${randomBytes(24).toString("base64url")}`);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async startDeviceAuthorization(): Promise<DeviceAuthorizationStart> {
    this.assertAvailable();
    const now = this.now();
    if (this.activeAttempt?.status === "pending" && this.activeAttempt.expiresAt > now) {
      return this.publicStart(this.activeAttempt);
    }

    const body = new URLSearchParams({ client_id: this.clientId!, scope: REQUIRED_SCOPE });
    const response = await this.requestJson(GITHUB_DEVICE_CODE_URL, {
      method: "POST",
      headers: oauthHeaders(),
      body
    });
    const payload = parseDeviceCodeResponse(response);
    if (payload.verification_uri !== GITHUB_DEVICE_VERIFICATION_URL) {
      throw new GitHubOAuthRequestError("GitHub returned an unexpected device verification URL", 502);
    }

    const intervalMs = payload.interval * 1_000;
    this.activeAttempt = {
      id: this.createAttemptId(),
      deviceCode: payload.device_code,
      userCode: payload.user_code,
      verificationUri: GITHUB_DEVICE_VERIFICATION_URL,
      expiresAt: now + payload.expires_in * 1_000,
      intervalMs,
      nextPollAt: now + intervalMs,
      status: "pending"
    };
    return this.publicStart(this.activeAttempt);
  }

  async getDeviceAuthorizationStatus(attemptId: string): Promise<DeviceAuthorizationStatus> {
    const attempt = this.requireAttempt(attemptId);
    if (attempt.status !== "pending") {
      return publicStatus(attempt);
    }

    const now = this.now();
    if (attempt.expiresAt <= now) {
      return this.finishAttempt(attempt, "expired", "The GitHub authorization code expired");
    }
    if (now < attempt.nextPollAt) {
      return publicStatus(attempt);
    }

    const body = new URLSearchParams({
      client_id: this.clientId!,
      device_code: attempt.deviceCode!,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    });
    attempt.nextPollAt = now + attempt.intervalMs;
    const payload = (await this.requestJson(GITHUB_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: oauthHeaders(),
      body
    })) as OAuthTokenResponse;

    if (payload.error) {
      return this.handleTokenError(attempt, payload, now);
    }
    if (!payload.access_token || !payload.token_type) {
      return this.finishAttempt(attempt, "failed", "GitHub returned an invalid OAuth token response");
    }

    const scopes = parseScopes(payload.scope ?? "");
    if (!scopes.includes(REQUIRED_SCOPE)) {
      return this.finishAttempt(attempt, "failed", "GitHub authorization did not grant the required repo scope");
    }

    let viewer: PublicGitHubViewer;
    try {
      const viewerPayload = await this.fetchViewer(payload.access_token);
      viewer = mapViewer(viewerPayload);
      const timestamp = new Date(now).toISOString();
      this.credentialStore.save(
        {
          githubUserId: viewer.id,
          login: viewer.login,
          name: viewer.name,
          avatarUrl: viewer.avatarUrl,
          accessToken: payload.access_token,
          tokenType: payload.token_type,
          scopes
        },
        timestamp
      );
    } catch (error) {
      this.finishAttempt(attempt, "failed", "GitHub authorized the device but the account could not be validated");
      throw error;
    }

    attempt.deviceCode = null;
    attempt.status = "connected";
    attempt.viewer = viewer;
    attempt.scopes = scopes;
    return publicStatus(attempt);
  }

  cancelDeviceAuthorization(attemptId: string): boolean {
    const attempt = this.requireAttempt(attemptId);
    if (attempt.status !== "pending") {
      return false;
    }
    this.finishAttempt(attempt, "denied", "GitHub authorization was cancelled locally");
    return true;
  }

  connectionStatus(): GitHubOAuthConnectionStatus {
    const metadata = this.credentialStore.getMetadata();
    return {
      enabled: this.enabled,
      configured: Boolean(this.clientId),
      connected: Boolean(metadata),
      ...(metadata ? connectionDetails(metadata) : {})
    };
  }

  disconnect(): boolean {
    this.activeAttempt = null;
    return this.credentialStore.delete();
  }

  private assertAvailable(): void {
    if (!this.enabled) {
      throw new GitHubOAuthRequestError("GitHub OAuth authentication is not enabled", 409);
    }
    if (!this.clientId) {
      throw new GitHubOAuthRequestError("GitHub OAuth client ID is not configured", 503);
    }
  }

  private requireAttempt(attemptId: string): DeviceAuthorizationAttempt {
    if (!this.activeAttempt || this.activeAttempt.id !== attemptId) {
      throw new GitHubOAuthRequestError("GitHub authorization attempt was not found", 404);
    }
    return this.activeAttempt;
  }

  private publicStart(attempt: DeviceAuthorizationAttempt): DeviceAuthorizationStart {
    return {
      attemptId: attempt.id,
      userCode: attempt.userCode,
      verificationUri: attempt.verificationUri,
      expiresAt: new Date(attempt.expiresAt).toISOString(),
      intervalSeconds: attempt.intervalMs / 1_000
    };
  }

  private handleTokenError(
    attempt: DeviceAuthorizationAttempt,
    payload: OAuthTokenResponse,
    now: number
  ): DeviceAuthorizationStatus {
    switch (payload.error) {
      case "authorization_pending":
        attempt.nextPollAt = now + attempt.intervalMs;
        return publicStatus(attempt);
      case "slow_down":
        attempt.intervalMs = Math.max(attempt.intervalMs + SLOW_DOWN_INCREMENT_MS, (payload.interval ?? 0) * 1_000);
        attempt.nextPollAt = now + attempt.intervalMs;
        return publicStatus(attempt);
      case "access_denied":
        return this.finishAttempt(attempt, "denied", "GitHub authorization was denied");
      case "expired_token":
        return this.finishAttempt(attempt, "expired", "The GitHub authorization code expired");
      default:
        return this.finishAttempt(
          attempt,
          "failed",
          safeOAuthError(payload.error_description) ?? "GitHub could not complete OAuth authorization"
        );
    }
  }

  private finishAttempt(
    attempt: DeviceAuthorizationAttempt,
    status: Exclude<DeviceAttemptStatus, "pending" | "connected">,
    error: string
  ): DeviceAuthorizationStatus {
    attempt.deviceCode = null;
    attempt.status = status;
    attempt.error = error;
    return publicStatus(attempt);
  }

  private async fetchViewer(accessToken: string): Promise<GitHubViewerResponse> {
    const response = await this.requestJson(GITHUB_VIEWER_URL, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "MemoRepo",
        "x-github-api-version": "2022-11-28"
      }
    });
    return parseViewerResponse(response);
  }

  private async requestJson(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        ...init,
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch {
      throw new GitHubOAuthRequestError("GitHub OAuth request could not be completed", 502);
    }

    if (!response.ok) {
      throw new GitHubOAuthRequestError(`GitHub OAuth request failed with status ${response.status}`, 502);
    }
    try {
      return await response.json();
    } catch {
      throw new GitHubOAuthRequestError("GitHub OAuth returned an invalid JSON response", 502);
    }
  }
}

function oauthHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": "MemoRepo"
  };
}

function parseDeviceCodeResponse(value: unknown): DeviceCodeResponse {
  if (!isRecord(value)) {
    throw new GitHubOAuthRequestError("GitHub returned an invalid device authorization response", 502);
  }
  const deviceCode = stringValue(value.device_code);
  const userCode = stringValue(value.user_code);
  const verificationUri = stringValue(value.verification_uri);
  const expiresIn = positiveNumber(value.expires_in);
  const interval = positiveNumber(value.interval);
  if (!deviceCode || !userCode || !verificationUri || !expiresIn || !interval) {
    throw new GitHubOAuthRequestError("GitHub returned an incomplete device authorization response", 502);
  }
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    expires_in: expiresIn,
    interval
  };
}

function parseViewerResponse(value: unknown): GitHubViewerResponse {
  if (!isRecord(value)) {
    throw new GitHubOAuthRequestError("GitHub returned an invalid user profile", 502);
  }
  const id = positiveNumber(value.id);
  const login = stringValue(value.login);
  const avatarUrl = stringValue(value.avatar_url);
  const parsedName = value.name === null ? null : stringValue(value.name);
  if (!id || !login || !avatarUrl || parsedName === undefined) {
    throw new GitHubOAuthRequestError("GitHub returned an incomplete user profile", 502);
  }
  const name: string | null = parsedName;
  return { id, login, name, avatar_url: avatarUrl };
}

function mapViewer(viewer: GitHubViewerResponse): PublicGitHubViewer {
  return {
    id: viewer.id,
    login: viewer.login,
    name: viewer.name,
    avatarUrl: viewer.avatar_url
  };
}

function publicStatus(attempt: DeviceAuthorizationAttempt): DeviceAuthorizationStatus {
  if (attempt.status === "pending") {
    return {
      status: "pending",
      expiresAt: new Date(attempt.expiresAt).toISOString(),
      nextPollAt: new Date(attempt.nextPollAt).toISOString()
    };
  }
  if (attempt.status === "connected" && attempt.viewer && attempt.scopes) {
    return { status: "connected", viewer: attempt.viewer, scopes: attempt.scopes };
  }
  return {
    status: attempt.status === "connected" ? "failed" : attempt.status,
    error: attempt.error ?? "GitHub authorization did not complete"
  };
}

function connectionDetails(metadata: GitHubCredentialMetadata): Omit<GitHubOAuthConnectionStatus, "enabled" | "configured" | "connected"> {
  return {
    viewer: {
      id: metadata.githubUserId,
      login: metadata.login,
      name: metadata.name,
      avatarUrl: metadata.avatarUrl
    },
    scopes: metadata.scopes,
    connectedAt: metadata.connectedAt,
    lastValidatedAt: metadata.lastValidatedAt
  };
}

function parseScopes(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function safeOAuthError(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const singleLine = value.replace(/[\r\n\t]+/g, " ").trim();
  return singleLine.slice(0, 240) || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
