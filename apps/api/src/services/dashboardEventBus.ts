import { randomUUID } from "node:crypto";

export type DashboardResourceType =
  | "spaces"
  | "space"
  | "jobs"
  | "job"
  | "snapshots"
  | "connections"
  | "maintenance"
  | "system"
  | "preflight"
  | "agent";

export interface DashboardResource {
  type: DashboardResourceType;
  spaceId?: string;
  jobId?: string;
  chatId?: string;
}

export interface DashboardInvalidationEvent {
  type: "invalidate";
  eventId: string;
  occurredAt: string;
  resources: DashboardResource[];
}

export type DashboardEventListener = (event: DashboardInvalidationEvent) => void;

const DEFAULT_COALESCE_WINDOW_MS = 25;

/**
 * Process-local invalidations. They intentionally contain identifiers only: clients
 * reconcile authoritative state through the existing authenticated JSON APIs.
 */
export class DashboardEventBus {
  private readonly instanceId = randomUUID();
  private sequence = 0;
  private readonly listeners = new Set<DashboardEventListener>();
  private readonly pending = new Map<string, DashboardResource>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly coalesceWindowMs = DEFAULT_COALESCE_WINDOW_MS) {}

  publish(...resources: DashboardResource[]): void {
    for (const resource of resources) {
      const normalized = normalizeResource(resource);
      this.pending.set(resourceKey(normalized), normalized);
    }
    if (this.pending.size === 0 || this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.coalesceWindowMs);
  }

  subscribe(listener: DashboardEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscriberCount(): number {
    return this.listeners.size;
  }

  nextEventId(): string {
    return `${this.instanceId}:${++this.sequence}`;
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending.clear();
    this.listeners.clear();
  }

  private flush(): void {
    this.flushTimer = null;
    if (this.pending.size === 0) return;
    const resources = [...this.pending.values()];
    this.pending.clear();
    const event: DashboardInvalidationEvent = {
      type: "invalidate",
      eventId: this.nextEventId(),
      occurredAt: new Date().toISOString(),
      resources
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }
}

function normalizeResource(resource: DashboardResource): DashboardResource {
  return {
    type: resource.type,
    ...(resource.spaceId ? { spaceId: resource.spaceId } : {}),
    ...(resource.jobId ? { jobId: resource.jobId } : {}),
    ...(resource.chatId ? { chatId: resource.chatId } : {})
  };
}

function resourceKey(resource: DashboardResource): string {
  return [resource.type, resource.spaceId ?? "", resource.jobId ?? "", resource.chatId ?? ""].join("\0");
}
