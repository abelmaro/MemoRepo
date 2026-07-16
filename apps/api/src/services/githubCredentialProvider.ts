import type {
  GitHubCredentialMetadata,
  GitHubCredentialWriter
} from "./githubCredentialStore.js";

export class GitHubNotConnectedError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("Connect a GitHub account before using repository operations");
  }
}

export class GitHubCredentialProvider {
  constructor(
    private readonly store: GitHubCredentialWriter,
    private readonly environmentToken: string | null = null
  ) {}

  getAccessToken(): string {
    if (this.environmentToken) {
      return this.environmentToken;
    }
    const credential = this.store.get();
    if (!credential) {
      throw new GitHubNotConnectedError();
    }
    return credential.accessToken;
  }

  getConnectionMetadata(): GitHubCredentialMetadata | null {
    return this.environmentToken ? null : this.store.getMetadata();
  }

  getSensitiveValues(): string[] {
    return [
      ...new Set(
        [this.environmentToken, this.store.get()?.accessToken].filter((value): value is string => Boolean(value))
      )
    ];
  }

  usesEnvironmentToken(): boolean {
    return Boolean(this.environmentToken);
  }

  markValidated(timestamp = new Date().toISOString()): void {
    if (!this.environmentToken) {
      this.store.markValidated(timestamp);
    }
  }

  invalidateOAuthCredential(): boolean {
    return this.environmentToken ? false : this.store.delete();
  }
}
