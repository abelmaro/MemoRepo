import type {
  GitHubCredentialMetadata,
  GitHubCredentialReader
} from "./githubCredentialStore.js";

export class GitHubNotConnectedError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("Connect a GitHub account before using repository operations");
  }
}

export class GitHubCredentialProvider {
  constructor(
    private readonly store: GitHubCredentialReader,
    private readonly oauthEnabled: boolean,
    private readonly legacyToken: string
  ) {}

  getAccessToken(): string {
    if (this.oauthEnabled) {
      const credential = this.store.get();
      if (!credential) {
        throw new GitHubNotConnectedError();
      }
      return credential.accessToken;
    }

    return this.legacyToken;
  }

  getConnectionMetadata(): GitHubCredentialMetadata | null {
    return this.oauthEnabled ? this.store.getMetadata() : null;
  }

  getSensitiveValues(): string[] {
    const values = [this.legacyToken];
    if (this.oauthEnabled) {
      const accessToken = this.store.get()?.accessToken;
      if (accessToken) {
        values.push(accessToken);
      }
    }
    return [...new Set(values.filter(Boolean))];
  }

  usesOAuth(): boolean {
    return this.oauthEnabled;
  }
}
