import fs from "node:fs";

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
