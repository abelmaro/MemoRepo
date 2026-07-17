import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AppDatabase } from "../db/connection.js";
import { publicJobSelectColumns } from "../db/jobProjection.js";
import { insertRecord, updateRecord, type SqlValue } from "../db/sql.js";
import { NotFoundError } from "../domain/errors.js";
import { createId } from "../domain/ids.js";
import { nowIso } from "../domain/time.js";

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export interface EnqueueJobInput {
  type: string;
  payload?: Record<string, unknown>;
  spaceId?: string | null;
  spaceRepositoryId?: string | null;
  dependsOnJobId?: string | null;
}

export interface JobContext {
  jobId: string;
  log: (message: string) => void;
  signal: AbortSignal;
}

export type JobHandler = (payload: Record<string, unknown>, context: JobContext) => Promise<void>;

export const JOB_EVENT_MESSAGE_MAX_BYTES = 16 * 1024;
export const JOB_LOG_EVENT_MAX_COUNT = 500;
const JOB_LOG_TRUNCATED_EVENT_TYPE = "log_truncated";
const JOB_LOG_FLUSH_INTERVAL_MS = 100;

export class JobRunner {
  readonly events = new EventEmitter();
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private activeJobs = 0;
  private recoveredRunningJobs = false;
  private logEventCounts = new Map<string, number>();
  private saturatedLogJobs = new Set<string>();
  private activeControllers = new Map<string, AbortController>();
  private pendingLogEvents = new Map<string, JobEventRecord[]>();
  private logFlushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly database: AppDatabase,
    private readonly concurrency = 2
  ) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  getConcurrency(): number {
    return this.concurrency;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.recoverRunningJobs();
    this.timer = setInterval(() => {
      void this.tick();
    }, 1_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer);
      this.logFlushTimer = null;
    }
    this.flushAllLogEvents();
  }

  enqueue(input: EnqueueJobInput) {
    const timestamp = nowIso();
    const payloadJson = stableJsonStringify(input.payload ?? {});
    const record: JobRecord = {
      id: createId("job"),
      type: input.type,
      status: "pending",
      spaceId: input.spaceId ?? null,
      spaceRepositoryId: input.spaceRepositoryId ?? null,
      dependsOnJobId: input.dependsOnJobId ?? null,
      payloadJson,
      error: null,
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null
    };

    const deduplicationKey = createJobDeduplicationKey(record);
    const enqueueTransaction = this.database.sqlite.transaction(() => {
      const existing = this.findActiveDuplicate(record);
      if (existing) {
        return { created: false, job: toEnqueuedJob(existing) };
      }

      insertRecord(this.database, "jobs", { ...record, deduplicationKey });
      return { created: true, job: record };
    });
    const result = enqueueTransaction.immediate();

    if (result.created) {
      this.writeEvent(result.job.id, "status", "pending");
    }
    void this.tick();
    return result.job;
  }

  private findActiveDuplicate(record: JobRecord): JobRow | null {
    const candidates = this.database.sqlite
      .prepare(
        `
        SELECT *
        FROM jobs
        WHERE status IN ('pending', 'running')
          AND type = @type
          AND space_id IS @spaceId
          AND space_repository_id IS @spaceRepositoryId
          AND depends_on_job_id IS @dependsOnJobId
        ORDER BY created_at ASC, id ASC
      `
      )
      .all(record) as JobRow[];

    return candidates.find((candidate) => payloadsMatch(candidate.payload_json, record.payloadJson)) ?? null;
  }

  getJob(jobId: string) {
    return this.database.sqlite
      .prepare(
        `
        SELECT
          ${publicJobSelectColumns()}
        FROM jobs
        WHERE id = ?
      `
      )
      .get(jobId);
  }

  getJobDependency(jobId: string) {
    return this.database.sqlite
      .prepare(
        `
        SELECT
          ${publicJobSelectColumns("d")}
        FROM jobs j
        JOIN jobs d ON d.id = j.depends_on_job_id
        WHERE j.id = ?
      `
      )
      .get(jobId);
  }

  getJobDependents(jobId: string) {
    return this.database.sqlite
      .prepare(
        `
        SELECT
          ${publicJobSelectColumns()}
        FROM jobs
        WHERE depends_on_job_id = ?
        ORDER BY created_at ASC
      `
      )
      .all(jobId);
  }

  getJobEvents(jobId: string) {
    this.flushLogEvents(jobId);
    return this.database.sqlite.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC").all(jobId);
  }

  retryJob(jobId: string) {
    const job = this.requireJob(jobId);
    if (!["failed", "skipped", "cancelled"].includes(job.status)) {
      throw new Error("Only failed, skipped, or cancelled jobs can be retried");
    }

    const retry = this.enqueue({
      type: job.type,
      spaceId: job.space_id,
      spaceRepositoryId: job.space_repository_id,
      payload: JSON.parse(job.payload_json) as Record<string, unknown>
    });
    this.writeEvent(job.id, "retry", `Retry enqueued as ${retry.id}`);
    return retry;
  }

  cancelJob(jobId: string) {
    const job = this.requireJob(jobId);
    if (job.status === "running") {
      const controller = this.activeControllers.get(job.id);
      if (!controller) throw new Error("The running job can no longer be cancelled safely");
      if (!controller.signal.aborted) {
        this.writeEvent(job.id, "cancellation_requested", "Cancellation requested; stopping the active operation");
        controller.abort(new Error("Cancelled by user"));
      }
      return this.getJob(job.id);
    }
    if (job.status !== "pending") {
      throw new Error("Only pending jobs can be cancelled");
    }

    const finishedAt = nowIso();
    updateRecord(this.database, "jobs", { status: "cancelled", error: "[MR-JOB-CANCELLED] Cancelled before start", finishedAt }, "id", job.id);
    this.writeEvent(job.id, "status", "cancelled");
    this.skipBlockedDependents();
    return this.getJob(job.id);
  }

  recoverRunningJobs(): number {
    if (this.recoveredRunningJobs) {
      return 0;
    }
    this.recoveredRunningJobs = true;

    const running = this.database.sqlite.prepare("SELECT id FROM jobs WHERE status = 'running'").all() as Array<{ id: string }>;
    const finishedAt = nowIso();
    for (const row of running) {
      updateRecord(
        this.database,
        "jobs",
        {
          status: "failed",
          error: "MemoRepo restarted before this job finished",
          finishedAt
        },
        "id",
        row.id
      );
      this.writeEvent(row.id, "error", "MemoRepo restarted before this job finished");
      this.writeEvent(row.id, "status", "failed");
    }
    return running.length;
  }

  private async tick(): Promise<void> {
    this.skipBlockedDependents();

    while (this.activeJobs < this.concurrency) {
      const next = this.nextRunnableJob();
      if (!next) {
        return;
      }
      this.activeJobs += 1;
      void this.run(next).finally(() => {
        this.activeJobs = Math.max(0, this.activeJobs - 1);
        void this.tick();
      });
    }
  }

  private nextRunnableJob(): JobRow | null {
    const candidates = this.database.sqlite
      .prepare(
        `
        SELECT j.*
        FROM jobs j
        LEFT JOIN jobs d ON d.id = j.depends_on_job_id
        WHERE j.status = 'pending'
          AND (j.depends_on_job_id IS NULL OR d.status = 'succeeded')
        ORDER BY j.created_at ASC
        LIMIT 20
      `
      )
      .all() as JobRow[];

    for (const candidate of candidates) {
      if (!this.isBlocked(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private isBlocked(candidate: JobRow): boolean {
    if (candidate.space_repository_id && this.countRunning("space_repository_id = ?", candidate.space_repository_id) > 0) {
      return true;
    }

    if (!candidate.space_id) {
      return false;
    }

    if (candidate.space_repository_id) {
      return this.countRunning("space_id = ? AND space_repository_id IS NULL", candidate.space_id) > 0;
    }

    return this.countRunning("space_id = ?", candidate.space_id) > 0;
  }

  private countRunning(condition: string, value: string): number {
    const row = this.database.sqlite
      .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status = 'running' AND ${condition}`)
      .get(value) as { count: number };
    return row.count;
  }

  private async run(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type);
    const startedAt = nowIso();

    if (!handler) {
      this.fail(job.id, `No handler registered for job type ${job.type}`, job.type);
      return;
    }

    const controller = new AbortController();
    this.activeControllers.set(job.id, controller);
    updateRecord(this.database, "jobs", { status: "running", startedAt }, "id", job.id);
    this.writeEvent(job.id, "status", "running");

    try {
      await handler(JSON.parse(job.payload_json) as Record<string, unknown>, {
        jobId: job.id,
        log: (message) => this.writeEvent(job.id, "log", message),
        signal: controller.signal
      });
      const finishedAt = nowIso();
      if (this.isRunning(job.id)) {
        if (controller.signal.aborted) {
          this.cancelRunning(job.id);
        } else {
          updateRecord(this.database, "jobs", { status: "succeeded", finishedAt }, "id", job.id);
          this.writeEvent(job.id, "status", "succeeded");
        }
      }
    } catch (error) {
      if (this.isRunning(job.id)) {
        if (controller.signal.aborted || isAbortError(error)) {
          this.cancelRunning(job.id);
        } else {
          this.fail(job.id, error instanceof Error ? error.message : String(error), job.type);
        }
      }
    } finally {
      this.activeControllers.delete(job.id);
    }
  }

  private fail(jobId: string, message: string, jobType = "unknown"): void {
    const finishedAt = nowIso();
    const boundedMessage = truncateEventMessage(`[${jobErrorCode(jobType)}] ${message}`);
    updateRecord(this.database, "jobs", { status: "failed", error: boundedMessage, finishedAt }, "id", jobId);
    this.writeEvent(jobId, "error", boundedMessage);
    this.writeEvent(jobId, "status", "failed");
  }

  private cancelRunning(jobId: string): void {
    const finishedAt = nowIso();
    const message = "[MR-JOB-CANCELLED] Cancelled by user";
    updateRecord(this.database, "jobs", { status: "cancelled", error: message, finishedAt }, "id", jobId);
    this.writeEvent(jobId, "status", "cancelled");
    this.skipBlockedDependents();
  }

  private skipBlockedDependents(): void {
    const blocked = this.database.sqlite
      .prepare(
        `
        SELECT j.id
        FROM jobs j
        JOIN jobs d ON d.id = j.depends_on_job_id
        WHERE j.status = 'pending'
          AND d.status IN ('failed', 'skipped', 'cancelled')
      `
      )
      .all() as Array<{ id: string }>;

    for (const row of blocked) {
      const timestamp = nowIso();
      updateRecord(this.database, "jobs", { status: "skipped", finishedAt: timestamp, error: "Dependency did not succeed" }, "id", row.id);
      this.writeEvent(row.id, "status", "skipped");
    }
  }

  private writeEvent(jobId: string, eventType: string, message: string): void {
    if (eventType === "log" && !this.acceptLogEvent(jobId)) {
      return;
    }
    const boundedMessage = truncateEventMessage(message);
    const record: JobEventRecord = {
      id: createId("evt"),
      jobId,
      eventType,
      message: boundedMessage,
      createdAt: nowIso()
    };
    if (eventType === "log") {
      const pending = this.pendingLogEvents.get(jobId) ?? [];
      pending.push(record);
      this.pendingLogEvents.set(jobId, pending);
      this.events.emit(jobId, record);
      this.scheduleLogFlush();
      return;
    }
    this.flushLogEvents(jobId);
    insertRecord(this.database, "job_events", record);
    this.events.emit(jobId, record);
  }

  private acceptLogEvent(jobId: string): boolean {
    if (this.saturatedLogJobs.has(jobId)) {
      return false;
    }
    const current = this.logEventCounts.get(jobId) ?? this.countLogEvents(jobId);
    if (current < JOB_LOG_EVENT_MAX_COUNT) {
      this.logEventCounts.set(jobId, current + 1);
      return true;
    }

    this.saturatedLogJobs.add(jobId);
    this.flushLogEvents(jobId);
    const record = {
      id: createId("evt"),
      jobId,
      eventType: JOB_LOG_TRUNCATED_EVENT_TYPE,
      message: `Additional job output was discarded after ${JOB_LOG_EVENT_MAX_COUNT} log events.`,
      createdAt: nowIso()
    };
    insertRecord(this.database, "job_events", record);
    this.events.emit(jobId, record);
    return false;
  }

  private countLogEvents(jobId: string): number {
    const row = this.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id = ? AND event_type = 'log'")
      .get(jobId) as { count: number };
    return row.count;
  }

  private scheduleLogFlush(): void {
    if (this.logFlushTimer) return;
    this.logFlushTimer = setTimeout(() => {
      this.logFlushTimer = null;
      try {
        this.flushAllLogEvents();
      } catch {
        this.scheduleLogFlush();
      }
    }, JOB_LOG_FLUSH_INTERVAL_MS);
    this.logFlushTimer.unref();
  }

  private flushAllLogEvents(): void {
    for (const jobId of Array.from(this.pendingLogEvents.keys())) {
      this.flushLogEvents(jobId);
    }
  }

  private flushLogEvents(jobId: string): void {
    const pending = this.pendingLogEvents.get(jobId);
    if (!pending || pending.length === 0) return;
    this.pendingLogEvents.delete(jobId);
    try {
      this.database.sqlite.transaction(() => {
        for (const record of pending) insertRecord(this.database, "job_events", record);
      })();
    } catch (error) {
      this.pendingLogEvents.set(jobId, [...pending, ...(this.pendingLogEvents.get(jobId) ?? [])]);
      throw error;
    }
  }

  private requireJob(jobId: string): JobRow {
    const job = this.getJob(jobId) as JobRow | undefined;
    if (!job) {
      throw new NotFoundError("Job not found");
    }
    return job;
  }

  private isRunning(jobId: string): boolean {
    const row = this.database.sqlite.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string } | undefined;
    return row?.status === "running";
  }
}

function truncateEventMessage(message: string): string {
  if (Buffer.byteLength(message, "utf8") <= JOB_EVENT_MESSAGE_MAX_BYTES) {
    return message;
  }
  const suffix = "\n[message truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const buffer = Buffer.from(message, "utf8");
  const prefix = buffer.subarray(0, JOB_EVENT_MESSAGE_MAX_BYTES - suffixBytes).toString("utf8").replace(/\uFFFD$/, "");
  return `${prefix}${suffix}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && /abort|cancel/i.test(`${error.name} ${error.message}`);
}

function jobErrorCode(jobType: string): string {
  const normalized = jobType.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `MR-JOB-${normalized || "UNKNOWN"}`;
}

interface JobRow {
  id: string;
  type: string;
  status: JobStatus;
  space_id: string | null;
  space_repository_id: string | null;
  depends_on_job_id: string | null;
  payload_json: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface JobRecord {
  id: string;
  type: string;
  status: JobStatus;
  spaceId: string | null;
  spaceRepositoryId: string | null;
  dependsOnJobId: string | null;
  payloadJson: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface JobEventRecord extends Record<string, SqlValue> {
  id: string;
  jobId: string;
  eventType: string;
  message: string;
  createdAt: string;
}

function createJobDeduplicationKey(job: JobRecord): string {
  return createHash("sha256")
    .update(JSON.stringify([job.type, job.spaceId, job.spaceRepositoryId, job.dependsOnJobId, job.payloadJson]))
    .digest("hex");
}

function payloadsMatch(storedPayloadJson: string, canonicalPayloadJson: string): boolean {
  if (storedPayloadJson === canonicalPayloadJson) {
    return true;
  }

  try {
    return stableJsonStringify(JSON.parse(storedPayloadJson)) === canonicalPayloadJson;
  } catch {
    return false;
  }
}

function stableJsonStringify(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Job payload must be JSON serializable");
  }
  return JSON.stringify(sortJsonValue(JSON.parse(serialized)));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, sortJsonValue(item)])
  );
}

function toEnqueuedJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    spaceId: row.space_id,
    spaceRepositoryId: row.space_repository_id,
    dependsOnJobId: row.depends_on_job_id,
    payloadJson: row.payload_json,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}
