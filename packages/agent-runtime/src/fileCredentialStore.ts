import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type CredentialMap = Record<string, Credential>;

export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.readAll())[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const credentials = await this.readAll();
    return Object.entries(credentials).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    return this.serialized(async () => {
      const credentials = await this.readAll();
      const next = await fn(credentials[providerId]);
      if (next === undefined) return credentials[providerId];
      credentials[providerId] = next;
      await this.writeAll(credentials);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.serialized(async () => {
      const credentials = await this.readAll();
      if (!(providerId in credentials)) return;
      delete credentials[providerId];
      await this.writeAll(credentials);
    });
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task);
    this.chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async readAll(): Promise<CredentialMap> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    const parsed = JSON.parse(contents) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Agent credential store is invalid");
    }
    const result: CredentialMap = {};
    for (const [providerId, value] of Object.entries(parsed)) {
      if (isCredential(value)) result[providerId] = value;
    }
    return result;
  }

  private async writeAll(credentials: CredentialMap): Promise<void> {
    const directory = path.dirname(this.filePath);
    const createdDirectory = await mkdir(directory, { recursive: true, mode: 0o700 });
    if (createdDirectory) await chmod(directory, 0o700).catch(() => undefined);
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    let renamed = false;
    try {
      await writeFile(temporary, `${JSON.stringify(credentials)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.filePath);
      renamed = true;
    } finally {
      if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
    }
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }
}

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === "api_key" || type === "oauth";
}
