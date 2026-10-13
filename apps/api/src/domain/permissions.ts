import fs from "node:fs";
import path from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function initializePrivateFileCreation(): void {
  if (process.platform !== "win32") {
    process.umask(0o077);
  }
}

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (process.platform !== "win32") {
    applyModeWhenSupported(dir, PRIVATE_DIRECTORY_MODE);
  }
}

export function restrictPrivateFile(file: string): void {
  if (process.platform !== "win32" && fs.existsSync(file)) {
    applyModeWhenSupported(file, PRIVATE_FILE_MODE);
  }
}

export function loadOrCreatePrivateFile(file: string, createContent: () => Buffer): { content: Buffer; created: boolean } {
  ensurePrivateDir(path.dirname(file));

  const descriptor = openNewFile(file);
  if (descriptor !== null) {
    let written = false;
    try {
      fs.writeFileSync(descriptor, createContent());
      fs.fsyncSync(descriptor);
      written = true;
    } finally {
      fs.closeSync(descriptor);
      if (!written) {
        fs.rmSync(file, { force: true });
      }
    }
  }

  restrictPrivateFile(file);
  return { content: fs.readFileSync(file), created: descriptor !== null };
}

function openNewFile(file: string): number | null {
  try {
    return fs.openSync(file, "wx", PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return null;
    }
    throw error;
  }
}

function applyModeWhenSupported(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "ENOTSUP" || code === "EROFS") {
      return;
    }
    throw error;
  }
}
