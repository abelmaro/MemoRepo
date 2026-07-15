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
  constructor(private readonly store: GitHubCredentialWriter) {}

  getAccessToken(): string {
    const credential = this.store.get();
    if (!credential) {
      throw new GitHubNotConnectedError();
    }
    return credential.accessToken;
  }

  getConnectionMetadata(): GitHubCredentialMetadata | null {
    return this.store.getMetadata();
  }

  getSensitiveValues(): string[] {
    const accessToken = this.store.get()?.accessToken;
    return accessToken ? [accessToken] : [];
  }

  markValidated(timestamp = new Date().toISOString()): void {
    this.store.markValidated(timestamp);
  }

  invalidateOAuthCredential(): boolean {
    return this.store.delete();
  }
}
