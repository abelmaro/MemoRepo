import { spawn } from "node:child_process";
import { redactSensitive } from "../domain/sanitize.js";

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  inheritEnv?: boolean | undefined;
  timeoutMs?: number | undefined;
  killGraceMs?: number | undefined;
  sensitiveValues?: string[] | undefined;
  onOutput?: ((line: string) => void) | undefined;
}

const DEFAULT_KILL_GRACE_MS = 5_000;
const SAFE_PROCESS_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ"
] as const;

export function createSafeProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const sourceEntries = Object.entries(source);

  for (const allowedName of SAFE_PROCESS_ENVIRONMENT_ALLOWLIST) {
    const entry = sourceEntries.find(([name]) => name.toUpperCase() === allowedName);
    if (entry?.[1] !== undefined) {
      environment[allowedName] = entry[1];
    }
  }

  return environment;
}

export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const sensitiveValues = options.sensitiveValues ?? [];

  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env:
        options.inheritEnv === false
          ? { ...(options.env ?? {}) }
          : {
              ...process.env,
              ...options.env
            },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let outputBuffer = "";
    let timedOut = false;

    let killTimer: NodeJS.Timeout | undefined;
    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
              child.kill("SIGKILL");
            }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
          }, options.timeoutMs)
        : undefined;

    function clearTimers(): void {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
    }

    function emit(chunk: Buffer, target: "stdout" | "stderr"): void {
      const raw = chunk.toString("utf8");
      const sanitized = redactSensitive(raw, sensitiveValues);

      if (target === "stdout") {
        stdout += sanitized;
      } else {
        stderr += sanitized;
      }

      outputBuffer += sanitized;
      const lines = outputBuffer.split(/\r?\n/);
      outputBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length > 0) {
          options.onOutput?.(line);
        }
      }
    }

    child.stdout.on("data", (chunk: Buffer) => emit(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => emit(chunk, "stderr"));

    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });

    child.on("close", (exitCode) => {
      clearTimers();
      if (outputBuffer.trim().length > 0) {
        options.onOutput?.(outputBuffer);
      }
      if (timedOut) {
        reject(new Error(`${options.command} timed out after ${options.timeoutMs}ms`));
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
}
