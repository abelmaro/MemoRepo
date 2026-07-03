import { EventEmitter } from "node:events";
import type { AppDatabase } from "../db/connection.js";
import { insertRecord, updateRecord } from "../db/sql.js";
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
}

export type JobHandler = (payload: Record<string, unknown>, context: JobContext) => Promise<void>;

export class JobRunner {
  readonly events = new EventEmitter();
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private activeJobs = 0;
  private recoveredRunningJobs = false;

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
  }

  enqueue(input: EnqueueJobInput) {
    const timestamp = nowIso();
    const record = {
      id: createId("job"),
      type: input.type,
      status: "pending",
      spaceId: input.spaceId ?? null,
      spaceRepositoryId: input.spaceRepositoryId ?? null,
      dependsOnJobId: input.dependsOnJobId ?? null,
      payloadJson: JSON.stringify(input.payload ?? {}),
      error: null,
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null
    };

    insertRecord(this.database, "jobs", record);
    this.writeEvent(record.id, "status", "pending");
    void this.tick();
    return record;
  }

  getJob(jobId: string) {
    return this.database.sqlite.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  }

  getJobDependency(jobId: string) {
    return this.database.sqlite
      .prepare(
        `
        SELECT d.*
        FROM jobs j
        JOIN jobs d ON d.id = j.depends_on_job_id
        WHERE j.id = ?
      `
      )
      .get(jobId);
  }

  getJobDependents(jobId: string) {
    return this.database.sqlite.prepare("SELECT * FROM jobs WHERE depends_on_job_id = ? ORDER BY created_at ASC").all(jobId);
  }

  getJobEvents(jobId: string) {
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
      throw new Error("Running jobs cannot be cancelled yet; wait for completion or restart MemoRepo to mark abandoned jobs failed.");
    }
    if (job.status !== "pending") {
      throw new Error("Only pending jobs can be cancelled");
    }

    const finishedAt = nowIso();
    updateRecord(this.database, "jobs", { status: "cancelled", error: "Cancelled before start", finishedAt }, "id", job.id);
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
      this.fail(job.id, `No handler registered for job type ${job.type}`);
      return;
    }

    updateRecord(this.database, "jobs", { status: "running", startedAt }, "id", job.id);
    this.writeEvent(job.id, "status", "running");

    try {
      await handler(JSON.parse(job.payload_json) as Record<string, unknown>, {
        jobId: job.id,
        log: (message) => this.writeEvent(job.id, "log", message)
      });
      const finishedAt = nowIso();
      if (this.isRunning(job.id)) {
        updateRecord(this.database, "jobs", { status: "succeeded", finishedAt }, "id", job.id);
        this.writeEvent(job.id, "status", "succeeded");
      }
    } catch (error) {
      if (this.isRunning(job.id)) {
        this.fail(job.id, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private fail(jobId: string, message: string): void {
    const finishedAt = nowIso();
    updateRecord(this.database, "jobs", { status: "failed", error: message, finishedAt }, "id", jobId);
    this.writeEvent(jobId, "error", message);
    this.writeEvent(jobId, "status", "failed");
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
    const record = {
      id: createId("evt"),
      jobId,
      eventType,
      message,
      createdAt: nowIso()
    };
    insertRecord(this.database, "job_events", record);
    this.events.emit(jobId, record);
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
