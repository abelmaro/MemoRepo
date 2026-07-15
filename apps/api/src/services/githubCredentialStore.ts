import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppDatabase } from "../db/connection.js";
import { ensurePrivateDir, restrictPrivateFile } from "../domain/permissions.js";

const CREDENTIAL_ID = "github";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ENVELOPE_VERSION = "v1";
const ENVELOPE_SEPARATOR = ".";
const CREDENTIAL_AAD = Buffer.from("memorepo:github-oauth-credential:v1", "utf8");

export interface GitHubCredentialInput {
  githubUserId: number;
  login: string;
  name: string | null;
  avatarUrl: string;
  accessToken: string;
  tokenType: string;
  scopes: string[];
}

export interface StoredGitHubCredential extends GitHubCredentialInput {
  connectedAt: string;
  lastValidatedAt: string | null;
  updatedAt: string;
}

export interface GitHubCredentialMetadata extends Omit<StoredGitHubCredential, "accessToken"> {}

interface GitHubCredentialRow {
  github_user_id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  token_ciphertext: string;
  token_type: string;
  scopes_json: string;
  connected_at: string;
  last_validated_at: string | null;
  updated_at: string;
}

export class CredentialCipher {
  private readonly key: Buffer;

  constructor(keyPath: string) {
    this.key = loadOrCreateKey(keyPath);
  }

  encrypt(value: string): string {
    if (!value) {
      throw new Error("Cannot encrypt an empty GitHub credential");
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(CREDENTIAL_AAD);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();

    return [
      ENVELOPE_VERSION,
      iv.toString("base64url"),
      ciphertext.toString("base64url"),
      authenticationTag.toString("base64url")
    ].join(ENVELOPE_SEPARATOR);
  }

  decrypt(envelope: string): string {
    try {
      const [version, encodedIv, encodedCiphertext, encodedAuthenticationTag, ...extra] = envelope.split(
        ENVELOPE_SEPARATOR
      );
      if (
        version !== ENVELOPE_VERSION ||
        !encodedIv ||
        !encodedCiphertext ||
        !encodedAuthenticationTag ||
        extra.length > 0
      ) {
        throw new Error("Unsupported credential envelope");
      }

      const iv = Buffer.from(encodedIv, "base64url");
      const ciphertext = Buffer.from(encodedCiphertext, "base64url");
      const authenticationTag = Buffer.from(encodedAuthenticationTag, "base64url");
      if (iv.length !== IV_BYTES || authenticationTag.length !== 16 || ciphertext.length === 0) {
        throw new Error("Invalid credential envelope");
      }

      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(CREDENTIAL_AAD);
      decipher.setAuthTag(authenticationTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Stored GitHub credential cannot be decrypted");
    }
  }
}

export class GitHubCredentialStore {
  constructor(
    private readonly database: AppDatabase,
    private readonly cipher: CredentialCipher
  ) {}

  save(input: GitHubCredentialInput, timestamp = new Date().toISOString()): StoredGitHubCredential {
    const tokenCiphertext = this.cipher.encrypt(input.accessToken);
    const scopes = normalizeScopes(input.scopes);

    this.database.sqlite
      .prepare(
        `
          INSERT INTO github_oauth_credentials (
            id, github_user_id, login, name, avatar_url, token_ciphertext, token_type,
            scopes_json, connected_at, last_validated_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            github_user_id = excluded.github_user_id,
            login = excluded.login,
            name = excluded.name,
            avatar_url = excluded.avatar_url,
            token_ciphertext = excluded.token_ciphertext,
            token_type = excluded.token_type,
            scopes_json = excluded.scopes_json,
            connected_at = excluded.connected_at,
            last_validated_at = excluded.last_validated_at,
            updated_at = excluded.updated_at
        `
      )
      .run(
        CREDENTIAL_ID,
        input.githubUserId,
        input.login,
        input.name,
        input.avatarUrl,
        tokenCiphertext,
        input.tokenType,
        JSON.stringify(scopes),
        timestamp,
        timestamp,
        timestamp
      );

    return {
      ...input,
      scopes,
      connectedAt: timestamp,
      lastValidatedAt: timestamp,
      updatedAt: timestamp
    };
  }

  get(): StoredGitHubCredential | null {
    const row = this.readRow();
    return row ? this.mapRow(row, true) : null;
  }

  getMetadata(): GitHubCredentialMetadata | null {
    const row = this.readRow();
    if (!row) {
      return null;
    }
    const { accessToken: _accessToken, ...metadata } = this.mapRow(row, false);
    return metadata;
  }

  markValidated(timestamp = new Date().toISOString()): void {
    this.database.sqlite
      .prepare("UPDATE github_oauth_credentials SET last_validated_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, CREDENTIAL_ID);
  }

  delete(): boolean {
    return this.database.sqlite.prepare("DELETE FROM github_oauth_credentials WHERE id = ?").run(CREDENTIAL_ID).changes > 0;
  }

  private readRow(): GitHubCredentialRow | undefined {
    return this.database.sqlite
      .prepare(
        `
          SELECT github_user_id, login, name, avatar_url, token_ciphertext, token_type,
                 scopes_json, connected_at, last_validated_at, updated_at
          FROM github_oauth_credentials
          WHERE id = ?
        `
      )
      .get(CREDENTIAL_ID) as GitHubCredentialRow | undefined;
  }

  private mapRow(row: GitHubCredentialRow, decryptToken: boolean): StoredGitHubCredential {
    const scopes = parseScopes(row.scopes_json);
    return {
      githubUserId: row.github_user_id,
      login: row.login,
      name: row.name,
      avatarUrl: row.avatar_url,
      accessToken: decryptToken ? this.cipher.decrypt(row.token_ciphertext) : "",
      tokenType: row.token_type,
      scopes,
      connectedAt: row.connected_at,
      lastValidatedAt: row.last_validated_at,
      updatedAt: row.updated_at
    };
  }
}

function loadOrCreateKey(keyPath: string): Buffer {
  ensurePrivateDir(path.dirname(keyPath));

  try {
    const descriptor = fs.openSync(keyPath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, randomBytes(KEY_BYTES));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  restrictPrivateFile(keyPath);
  const key = fs.readFileSync(keyPath);
  if (key.length !== KEY_BYTES) {
    throw new Error("GitHub credential encryption key must contain exactly 32 bytes");
  }
  return key;
}

function normalizeScopes(scopes: string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function parseScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((scope) => typeof scope === "string")) {
      throw new Error("Invalid scopes");
    }
    return normalizeScopes(parsed);
  } catch {
    throw new Error("Stored GitHub credential scopes are invalid");
  }
}
