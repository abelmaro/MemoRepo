import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AppDatabase } from "../db/connection.js";
import { publicJobSelectColumns } from "../db/jobProjection.js";
import { insertRecord, updateRecord, type SqlValue } from "../db/sql.js";
import { NotFoundError } from "../domain/errors.js";
import { createId } from "../domain/ids.js";
import { nowIso } from "../domain/time.js";
import type { DashboardEventBus } from "./dashboardEventBus.js";

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export interface EnqueueJobInput {
  type: string;
  payload?: Record<string, unknown>;
  spaceId?: string | null;
  spaceRepositoryId?: string | null;
  dependsOnJobId?: string | null;
  dependsOnJobIds?: string[];
}

export interface EnqueueCoalescedJobInput extends EnqueueJobInput {
  spaceId: string;
  fingerprint: string;
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
  private atomicNotifications: Array<() => void> | null = null;
  private deferTickDepth = 0;
  private tickRequested = false;

  constructor(
    private readonly database: AppDatabase,
    private readonly concurrency = 2,
    private readonly dashboardEvents?: DashboardEventBus
  ) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  getConcurrency(): number {
    return this.concurrency;
  }

  runAtomically<T>(operation: () => T): T {
    if (this.database.sqlite.inTransaction) return operation();

    const previousNotifications = this.atomicNotifications;
    const notifications: Array<() => void> = [];
    this.atomicNotifications = notifications;
    this.deferTickDepth += 1;
    try {
      const transaction = this.database.sqlite.transaction(operation);
      const result = transaction.immediate();
      this.atomicNotifications = previousNotifications;
      for (const notify of notifications) notify();
      return result;
    } finally {
      this.atomicNotifications = previousNotifications;
      this.deferTickDepth = Math.max(0, this.deferTickDepth - 1);
      if (this.deferTickDepth === 0 && this.tickRequested) {
        this.tickRequested = false;
        void this.tick();
      }
    }
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
    const dependencyJobIds = normalizeDependencyJobIds(input);
    const record: JobRecord = {
      id: createId("job"),
      type: input.type,
      status: "pending",
      spaceId: input.spaceId ?? null,
      spaceRepositoryId: input.spaceRepositoryId ?? null,
      dependsOnJobId: dependencyJobIds[0] ?? null,
      payloadJson,
      error: null,
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null
    };

    const deduplicationKey = createJobDeduplicationKey(record, dependencyJobIds);
    const enqueueTransaction = this.database.sqlite.transaction(() => {
      const existing = this.findActiveDuplicate(deduplicationKey);
      if (existing) {
        return { created: false, job: toEnqueuedJob(existing) };
      }

      insertRecord(this.database, "jobs", { ...record, deduplicationKey });
      const dependencyInsert = this.database.sqlite.prepare(
        "INSERT INTO job_dependencies (job_id, dependency_job_id, created_at) VALUES (?, ?, ?)"
      );
      for (const dependencyJobId of dependencyJobIds) dependencyInsert.run(record.id, dependencyJobId, timestamp);
      return { created: true, job: record };
    });
    const result = this.database.sqlite.inTransaction ? enqueueTransaction() : enqueueTransaction.immediate();

    if (result.created) {
      this.writeEvent(result.job.id, "status", "pending");
    }
    this.requestTick();
    return result.job;
  }

  /** Keep one active execution and at most one durable pending follow-up per space/type. */
  enqueueCoalesced(input: EnqueueCoalescedJobInput) {
    if (!input.fingerprint.trim()) throw new Error("Coalesced job fingerprint must not be empty");
    const dependencyJobIds = normalizeDependencyJobIds(input);
    const timestamp = nowIso();
    const payloadJson = stableJsonStringify({ ...(input.payload ?? {}), inputFingerprint: input.fingerprint });
    const record: JobRecord = {
      id: createId("job"), type: input.type, status: "pending", spaceId: input.spaceId,
      spaceRepositoryId: input.spaceRepositoryId ?? null, dependsOnJobId: dependencyJobIds[0] ?? null,
      payloadJson, error: null, createdAt: timestamp, startedAt: null, finishedAt: null
    };
    const deduplicationKey = createJobDeduplicationKey(record, dependencyJobIds);
    const transaction = this.database.sqlite.transaction(() => {
      const active = this.database.sqlite.prepare(
        `SELECT * FROM jobs
         WHERE type = ? AND space_id = ? AND status IN ('pending', 'running')
         ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at ASC, id ASC`
      ).all(input.type, input.spaceId) as JobRow[];
      for (const candidate of active) {
        if (candidate.payload_json === payloadJson && sameStringSet(this.dependencyIds(candidate.id), dependencyJobIds)) {
          const obsoletePending = candidate.status === "running"
            ? active.find((job) => job.status === "pending" && job.id !== candidate.id)
            : undefined;
          if (obsoletePending) {
            this.database.sqlite.prepare(
              "UPDATE jobs SET status = 'cancelled', error = ?, finished_at = ? WHERE id = ?"
            ).run("Superseded because the active job already matches the latest requested inputs", timestamp, obsoletePending.id);
          }
          return { created: false, updated: false, supersededId: obsoletePending?.id ?? null, job: toEnqueuedJob(candidate) };
        }
      }
      const pending = active.find((candidate) => candidate.status === "pending");
      if (pending) {
        this.database.sqlite.prepare(
          "UPDATE jobs SET payload_json = ?, depends_on_job_id = ?, deduplication_key = ?, error = NULL WHERE id = ?"
        ).run(payloadJson, dependencyJobIds[0] ?? null, deduplicationKey, pending.id);
        this.replaceDependencies(pending.id, dependencyJobIds, timestamp);
        return { created: false, updated: true, supersededId: null, job: { ...record, id: pending.id, createdAt: pending.created_at } };
      }
      insertRecord(this.database, "jobs", { ...record, deduplicationKey });
      this.insertDependencies(record.id, dependencyJobIds, timestamp);
      return { created: true, updated: false, supersededId: null, job: record };
    });
    const result = this.database.sqlite.inTransaction ? transaction() : transaction.immediate();
    if (result.created) this.writeEvent(result.job.id, "status", "pending");
    else if (result.updated) this.writeEvent(result.job.id, "coalesced", "Pending job updated to the latest requested inputs");
    if (result.supersededId) this.writeEvent(result.supersededId, "status", "cancelled");
    this.requestTick();
    return result.job;
  }

  private dependencyIds(jobId: string): string[] {
    return (this.database.sqlite.prepare(
      "SELECT dependency_job_id AS id FROM job_dependencies WHERE job_id = ? ORDER BY dependency_job_id"
    ).all(jobId) as Array<{ id: string }>).map((row) => row.id);
  }

  private insertDependencies(jobId: string, dependencyJobIds: string[], timestamp: string): void {
    const insert = this.database.sqlite.prepare(
      "INSERT INTO job_dependencies (job_id, dependency_job_id, created_at) VALUES (?, ?, ?)"
    );
    for (const dependencyJobId of dependencyJobIds) insert.run(jobId, dependencyJobId, timestamp);
  }

  private replaceDependencies(jobId: string, dependencyJobIds: string[], timestamp: string): void {
    this.database.sqlite.prepare("DELETE FROM job_dependencies WHERE job_id = ?").run(jobId);
    this.insertDependencies(jobId, dependencyJobIds, timestamp);
  }

  private findActiveDuplicate(deduplicationKey: string): JobRow | null {
    return (this.database.sqlite
      .prepare(
        `
        SELECT *
        FROM jobs
        WHERE status IN ('pending', 'running')
          AND deduplication_key = ?
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `
      )
      .get(deduplicationKey) as JobRow | undefined) ?? null;
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
    return this.getJobDependencies(jobId)[0];
  }

  getJobDependencies(jobId: string) {
    return this.database.sqlite
      .prepare(
        `
        SELECT
          ${publicJobSelectColumns("d")}
        FROM job_dependencies jd
        JOIN jobs d ON d.id = jd.dependency_job_id
        WHERE jd.job_id = ?
        ORDER BY d.created_at ASC, d.id ASC
      `
      )
      .all(jobId);
  }

  getJobDependents(jobId: string) {
    return this.database.sqlite
      .prepare(
        `
        SELECT
          ${publicJobSelectColumns("j")}
        FROM job_dependencies jd
        JOIN jobs j ON j.id = jd.job_id
        WHERE jd.dependency_job_id = ?
        ORDER BY j.created_at ASC
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

  private requestTick(): void {
    if (this.deferTickDepth > 0) {
      this.tickRequested = true;
      return;
    }
    void this.tick();
  }

  private nextRunnableJob(): JobRow | null {
    const candidates = this.database.sqlite
      .prepare(
        `
        SELECT j.*
        FROM jobs j
        WHERE j.status = 'pending'
          AND NOT EXISTS (
            SELECT 1
            FROM job_dependencies jd
            JOIN jobs d ON d.id = jd.dependency_job_id
            WHERE jd.job_id = j.id AND d.status <> 'succeeded'
          )
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
        SELECT DISTINCT j.id
        FROM jobs j
        JOIN job_dependencies jd ON jd.job_id = j.id
        JOIN jobs d ON d.id = jd.dependency_job_id
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
    this.notifyAfterCommit(() => {
      this.events.emit(jobId, record);
      if (eventType === "status") this.publishJobInvalidation(jobId);
    });
  }

  private notifyAfterCommit(notification: () => void): void {
    if (this.atomicNotifications) {
      this.atomicNotifications.push(notification);
      return;
    }
    notification();
  }

  private publishJobInvalidation(jobId: string): void {
    if (!this.dashboardEvents) return;
    const job = this.database.sqlite.prepare("SELECT space_id AS spaceId, type, status FROM jobs WHERE id = ?").get(jobId) as
      | { spaceId: string | null; type: string; status: JobStatus }
      | undefined;
    const snapshotChanged = Boolean(
      job?.spaceId &&
      job.status === "succeeded" &&
      /snapshot|reindex|repository|checkout/.test(job.type)
    );
    this.dashboardEvents.publish(
      { type: "jobs" },
      { type: "job", jobId },
      ...(job?.spaceId ? [{ type: "space" as const, spaceId: job.spaceId }] : []),
      ...(snapshotChanged ? [{ type: "snapshots" as const, spaceId: job!.spaceId! }] : []),
      ...(job?.type === "sync_github_repositories" && job.status === "succeeded" ? [{ type: "spaces" as const }] : [])
    );
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

function createJobDeduplicationKey(job: JobRecord, dependencyJobIds: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([job.type, job.spaceId, job.spaceRepositoryId, dependencyJobIds, job.payloadJson]))
    .digest("hex");
}

function normalizeDependencyJobIds(input: EnqueueJobInput): string[] {
  const values = [...(input.dependsOnJobIds ?? []), ...(input.dependsOnJobId ? [input.dependsOnJobId] : [])];
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Job dependency IDs must be non-empty strings");
  }
  return [...new Set(values)].sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
