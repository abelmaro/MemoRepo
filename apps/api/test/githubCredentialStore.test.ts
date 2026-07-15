import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { schema } from "../src/db/schema.js";
import { CredentialCipher, GitHubCredentialStore } from "../src/services/githubCredentialStore.js";

test("credential cipher persists a private key and authenticates ciphertext", () => {
  withTempDir((directory) => {
    const keyPath = path.join(directory, "secrets", "github-credentials.key");
    const firstCipher = new CredentialCipher(keyPath);
    const firstEnvelope = firstCipher.encrypt("gho_first-secret");
    const secondEnvelope = firstCipher.encrypt("gho_first-secret");

    assert.notEqual(firstEnvelope, secondEnvelope);
    assert.equal(new CredentialCipher(keyPath).decrypt(firstEnvelope), "gho_first-secret");
    assert.equal(fs.readFileSync(keyPath).length, 32);

    const envelopeParts = firstEnvelope.split(".");
    const encodedCiphertext = envelopeParts[2] ?? "";
    envelopeParts[2] = `${encodedCiphertext.startsWith("a") ? "b" : "a"}${encodedCiphertext.slice(1)}`;
    const tampered = envelopeParts.join(".");
    assert.throws(() => firstCipher.decrypt(tampered), /cannot be decrypted/);
  });
});

test("credential store round-trips one encrypted GitHub account without plaintext in SQLite", () => {
  withTempDir((directory) => {
    const database = createTestDatabase();
    try {
      const store = new GitHubCredentialStore(
        database,
        new CredentialCipher(path.join(directory, "github-credentials.key"))
      );
      const saved = store.save(
        {
          githubUserId: 42,
          login: "octocat",
          name: "The Octocat",
          avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
          accessToken: "gho_production-secret",
          tokenType: "bearer",
          scopes: ["repo", "repo", ""]
        },
        "2026-07-15T12:00:00.000Z"
      );

      assert.equal(saved.login, "octocat");
      assert.deepEqual(saved.scopes, ["repo"]);
      assert.equal(store.get()?.accessToken, "gho_production-secret");
      assert.equal(store.getMetadata()?.login, "octocat");
      assert.equal(JSON.stringify(store.getMetadata()).includes("gho_production-secret"), false);

      const raw = database.sqlite
        .prepare("SELECT token_ciphertext FROM github_oauth_credentials WHERE id = 'github'")
        .pluck()
        .get() as string;
      assert.equal(raw.includes("gho_production-secret"), false);

      store.markValidated("2026-07-15T12:05:00.000Z");
      assert.equal(store.getMetadata()?.lastValidatedAt, "2026-07-15T12:05:00.000Z");
      assert.equal(store.delete(), true);
      assert.equal(store.get(), null);
      assert.equal(store.delete(), false);
    } finally {
      database.sqlite.close();
    }
  });
});

test("credential store fails closed when the encryption key changes", () => {
  withTempDir((directory) => {
    const database = createTestDatabase();
    try {
      const firstStore = new GitHubCredentialStore(
        database,
        new CredentialCipher(path.join(directory, "first.key"))
      );
      firstStore.save({
        githubUserId: 7,
        login: "hubot",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/7?v=4",
        accessToken: "gho_unrecoverable",
        tokenType: "bearer",
        scopes: ["repo"]
      });

      const secondStore = new GitHubCredentialStore(
        database,
        new CredentialCipher(path.join(directory, "second.key"))
      );
      assert.throws(() => secondStore.get(), /cannot be decrypted/);
      assert.equal(secondStore.getMetadata()?.login, "hubot");
    } finally {
      database.sqlite.close();
    }
  });
});

function createTestDatabase(): AppDatabase {
  const sqlite = new Database(":memory:");
  migrate(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function withTempDir(run: (directory: string) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memorepo-credentials-"));
  try {
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
