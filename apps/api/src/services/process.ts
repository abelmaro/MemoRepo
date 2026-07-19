import { spawn } from "node:child_process";
import { redactSensitive } from "../domain/sanitize.js";

export interface ProcessResult {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
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
  maxCaptureBytes?: number | undefined;
  maxLineBytes?: number | undefined;
  signal?: AbortSignal | undefined;
}

const DEFAULT_KILL_GRACE_MS = 5_000;
export const DEFAULT_PROCESS_CAPTURE_MAX_BYTES = 1024 * 1024;
export const DEFAULT_PROCESS_LINE_MAX_BYTES = 16 * 1024;
const TRUNCATED_LINE_PREFIX = "[output truncated] ";
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

  if (options.signal?.aborted) {
    return Promise.reject(abortError(options.signal.reason));
  }

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
    let outputBufferTruncated = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    const maxCaptureBytes = positiveLimit(options.maxCaptureBytes, DEFAULT_PROCESS_CAPTURE_MAX_BYTES);
    const maxLineBytes = positiveLimit(options.maxLineBytes, DEFAULT_PROCESS_LINE_MAX_BYTES);

    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    };
    const handleAbort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, options.timeoutMs)
        : undefined;

    function clearTimers(): void {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      options.signal?.removeEventListener("abort", handleAbort);
    }

    function emit(chunk: Buffer, target: "stdout" | "stderr"): void {
      const raw = chunk.toString("utf8");
      const sanitized = redactSensitive(raw, sensitiveValues);

      if (target === "stdout") {
        const captured = appendRecent(stdout, sanitized, maxCaptureBytes);
        stdout = captured.value;
        stdoutTruncated ||= captured.truncated;
      } else {
        const captured = appendRecent(stderr, sanitized, maxCaptureBytes);
        stderr = captured.value;
        stderrTruncated ||= captured.truncated;
      }

      outputBuffer += sanitized;
      const lines = outputBuffer.split(/\r?\n/);
      outputBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length > 0) {
          options.onOutput?.(`${outputBufferTruncated ? TRUNCATED_LINE_PREFIX : ""}${boundedRecent(line, maxLineBytes)}`);
        }
        outputBufferTruncated = false;
      }
      if (Buffer.byteLength(outputBuffer, "utf8") > maxLineBytes) {
        outputBuffer = boundedRecent(outputBuffer, maxLineBytes);
        outputBufferTruncated = true;
      }
    }

    child.stdout.on("data", (chunk: Buffer) => emit(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => emit(chunk, "stderr"));

    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimers();
      if (outputBuffer.trim().length > 0) {
        options.onOutput?.(`${outputBufferTruncated ? TRUNCATED_LINE_PREFIX : ""}${outputBuffer}`);
      }
      if (timedOut) {
        reject(new Error(`${options.command} timed out after ${options.timeoutMs}ms`));
        return;
      }
      if (aborted) {
        reject(abortError(options.signal?.reason));
        return;
      }
      resolve({ exitCode, signal, stdout, stderr, stdoutTruncated, stderrTruncated });
    });
  });
}

function abortError(reason: unknown): Error {
  const error = new Error(reason instanceof Error ? reason.message : "Operation cancelled");
  error.name = "AbortError";
  return error;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function appendRecent(current: string, appended: string, maxBytes: number): { value: string; truncated: boolean } {
  const combined = `${current}${appended}`;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return { value: combined, truncated: false };
  }
  return { value: boundedRecent(combined, maxBytes), truncated: true };
}

function boundedRecent(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }
  return buffer.subarray(buffer.byteLength - maxBytes).toString("utf8").replace(/^\uFFFD/, "");
}
