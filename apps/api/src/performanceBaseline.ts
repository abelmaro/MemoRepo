import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "skipped", "cancelled"]);
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);
const DEFAULT_API_URL = "http://127.0.0.1:8787";
const DEFAULT_IDLE_SECONDS = 600;
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_PIPELINE_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_AGENT_TIMEOUT_MS = 12 * 60 * 1_000;

export interface BaselineConfig {
  apiUrl: string;
  controlToken: string;
  repositories: [string, string, string];
  outputPath: string;
  storageRoot: string | null;
  includeAgents: boolean;
  idleSeconds: number;
  pollIntervalMs: number;
  pipelineTimeoutMs: number;
  agentTimeoutMs: number;
}

export interface BaselineReport {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scenario: {
    repositoryCount: 3;
    spaceCount: 2;
    sequentialRepositoryAdds: true;
    agentConcurrencyRequested: number;
    idleProbeSeconds: number;
  };
  ingestion: {
    durationMs: number;
    spaces: SpaceRunReport[];
    jobsByType: Record<string, JobAggregate>;
    snapshotJobCount: number;
  };
  agents: AgentRunReport;
  idleProbe: IdleProbeReport;
  storage: {
    available: boolean;
    before: StorageMeasurement | null;
    after: StorageMeasurement | null;
    deltaBytes: Record<string, number> | null;
  };
  http: HttpAggregate;
}

interface SpaceRunReport {
  label: string;
  durationMs: number;
  additions: Array<{
    repositoryLabel: string;
    durationMs: number;
    jobs: JobMeasurement[];
  }>;
  snapshots: { count: number; activeCount: number; totalSizeBytes: number };
}

export interface JobMeasurement {
  type: string;
  status: string;
  queueMs: number | null;
  runMs: number | null;
  totalMs: number | null;
}

export interface JobAggregate {
  count: number;
  succeeded: number;
  failed: number;
  totalRunMs: number;
  medianRunMs: number | null;
  p95RunMs: number | null;
  maxRunMs: number | null;
}

interface UsageMeasurement {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

interface AgentTurnMeasurement {
  label: string;
  accepted: boolean;
  httpStatus: number;
  errorCode: string | null;
  status: string;
  durationMs: number;
  queueMs: number | null;
  providerRounds: number;
  toolCalls: number;
  usage: UsageMeasurement;
}

interface AgentRunReport {
  requested: boolean;
  available: boolean;
  connected: boolean;
  outcome: "completed" | "partially_completed" | "skipped";
  turns: AgentTurnMeasurement[];
  totals: {
    accepted: number;
    rejected: number;
    completed: number;
    durationMs: number;
    providerRounds: number;
    toolCalls: number;
    usage: UsageMeasurement;
  };
}

interface IdleProbeReport {
  mode: "api-cadence-simulation" | "disabled";
  durationMs: number;
  requests: number;
  browserPreflightsIncluded: false;
}

interface StorageMeasurement {
  total: number;
  spaces: number;
  repositoryIndexes: number;
  snapshots: number;
  revisionSources: number;
  database: number;
  other: number;
}

interface HttpSample {
  route: string;
  method: string;
  status: number;
  durationMs: number;
  responseBytes: number;
}

interface HttpAggregate {
  requestCount: number;
  totalDurationMs: number;
  totalResponseBytes: number;
  byRoute: Array<{
    route: string;
    method: string;
    status: number;
    count: number;
    totalDurationMs: number;
    medianDurationMs: number;
    p95DurationMs: number;
    maxDurationMs: number;
    responseBytes: number;
  }>;
}

interface JobView {
  id: string;
  type: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface TurnView {
  id: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  metrics?: {
    providerRoundCount?: number;
    toolCallCount?: number;
    usage?: Partial<UsageMeasurement>;
  };
}

interface ApiResult<T> {
  ok: boolean;
  status: number;
  errorCode: string | null;
  body: T | null;
}

export class BaselineInputError extends Error {}

class ApiClient {
  private readonly samples: HttpSample[] = [];

  constructor(
    private readonly apiUrl: string,
    private readonly controlToken: string
  ) {}

  async request<T>(route: string, requestPath: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.controlToken}`);
    if (init.body !== undefined && init.body !== null) headers.set("content-type", "application/json");
    if (!new Set(["GET", "HEAD", "OPTIONS"]).has(method)) headers.set("x-memorepo-csrf", "1");
    const startedAt = performance.now();
    let status = 0;
    let responseBytes = 0;

    try {
      const response = await fetch(`${this.apiUrl}${requestPath}`, {
        ...init,
        method,
        headers,
        signal: init.signal ?? AbortSignal.timeout(30_000)
      });
      status = response.status;
      const text = await response.text();
      responseBytes = Buffer.byteLength(text);
      const parsed = parseJson(text);
      const errorCode = isRecord(parsed) && typeof parsed.code === "string" ? parsed.code : null;
      return { ok: response.ok, status: response.status, errorCode, body: response.ok ? (parsed as T) : null };
    } finally {
      this.samples.push({
        route,
        method,
        status,
        durationMs: Math.round(performance.now() - startedAt),
        responseBytes
      });
    }
  }

  async required<T>(route: string, requestPath: string, init: RequestInit = {}): Promise<T> {
    const result = await this.request<T>(route, requestPath, init);
    if (!result.ok || result.body === null) throw new Error(`Request failed for ${route} with HTTP ${result.status}`);
    return result.body;
  }

  async waitForTurn(turnId: string, timeoutMs: number): Promise<TurnView> {
    const route = "/api/agent/turns/:turnId/events";
    const startedAt = performance.now();
    let status = 0;
    let responseBytes = 0;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.apiUrl}/api/agent/turns/${encodeURIComponent(turnId)}/events`, {
        headers: { authorization: `Bearer ${this.controlToken}` },
        signal: controller.signal
      });
      status = response.status;
      if (!response.ok || !response.body) throw new Error(`Turn stream failed with HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let latestTurn: TurnView | null = null;

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        responseBytes += chunk.value.byteLength;
        buffered += decoder.decode(chunk.value, { stream: true });
        let boundary = buffered.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (data) {
            const event = parseJson(data);
            if (isRecord(event) && event.type === "state" && isRecord(event.turn)) {
              latestTurn = event.turn as unknown as TurnView;
              if (TERMINAL_TURN_STATUSES.has(latestTurn.status)) return latestTurn;
            }
            if (isRecord(event) && event.type === "turn.completed") {
              const metrics = isRecord(event.metrics)
                ? (event.metrics as unknown as TurnView["metrics"])
                : latestTurn?.metrics;
              return {
                ...(latestTurn ?? emptyTurn(turnId)),
                status: typeof event.status === "string" ? event.status : latestTurn?.status ?? "unknown",
                ...(metrics ? { metrics } : {})
              };
            }
          }
          boundary = buffered.indexOf("\n\n");
        }
      }
      if (latestTurn && TERMINAL_TURN_STATUSES.has(latestTurn.status)) return latestTurn;
      throw new Error("Turn stream ended before completion");
    } finally {
      clearTimeout(timeout);
      this.samples.push({
        route,
        method: "GET",
        status,
        durationMs: Math.round(performance.now() - startedAt),
        responseBytes
      });
    }
  }

  requestCount(): number {
    return this.samples.length;
  }

  summary(): HttpAggregate {
    const grouped = new Map<string, HttpSample[]>();
    for (const sample of this.samples) {
      const key = `${sample.method} ${sample.route} ${sample.status}`;
      const values = grouped.get(key) ?? [];
      values.push(sample);
      grouped.set(key, values);
    }
    const byRoute = [...grouped.values()]
      .map((values) => {
        const first = values[0]!;
        const durations = values.map((value) => value.durationMs);
        return {
          route: first.route,
          method: first.method,
          status: first.status,
          count: values.length,
          totalDurationMs: sum(durations),
          medianDurationMs: percentile(durations, 0.5) ?? 0,
          p95DurationMs: percentile(durations, 0.95) ?? 0,
          maxDurationMs: Math.max(...durations),
          responseBytes: sum(values.map((value) => value.responseBytes))
        };
      })
      .sort((left, right) => left.route.localeCompare(right.route) || left.method.localeCompare(right.method));
    return {
      requestCount: this.samples.length,
      totalDurationMs: sum(this.samples.map((sample) => sample.durationMs)),
      totalResponseBytes: sum(this.samples.map((sample) => sample.responseBytes)),
      byRoute
    };
  }
}

export function parseBaselineArguments(
  argv: string[],
  environment: NodeJS.ProcessEnv = process.env,
  temporaryRoot = os.tmpdir()
): BaselineConfig {
  const options = parseOptions(argv);
  const repositoryValue = options.get("repositories") ?? environment.MEMOREPO_PERF_REPOSITORIES ?? "";
  const repositories = repositoryValue.split(",").map((value) => value.trim()).filter(Boolean);
  if (repositories.length !== 3) {
    throw new BaselineInputError("Exactly three repositories are required through --repositories or MEMOREPO_PERF_REPOSITORIES");
  }
  const controlToken = options.get("control-token") ?? environment.MEMOREPO_CONTROL_TOKEN ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(controlToken)) {
    throw new BaselineInputError("MEMOREPO_CONTROL_TOKEN is missing or invalid");
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.resolve(
    options.get("output") ?? path.join(temporaryRoot, "memorepo-performance", `baseline-${timestamp}.json`)
  );
  const storageValue = options.get("storage-root") ?? environment.MEMOREPO_HOME?.trim() ?? "";
  return {
    apiUrl: (options.get("api-url") ?? environment.MEMOREPO_PUBLIC_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, ""),
    controlToken,
    repositories: repositories as [string, string, string],
    outputPath,
    storageRoot: storageValue ? path.resolve(storageValue) : null,
    includeAgents: options.has("include-agents"),
    idleSeconds: nonNegativeNumber(options.get("idle-seconds"), DEFAULT_IDLE_SECONDS, "idle-seconds"),
    pollIntervalMs: positiveNumber(options.get("poll-interval-ms"), DEFAULT_POLL_INTERVAL_MS, "poll-interval-ms"),
    pipelineTimeoutMs: positiveNumber(options.get("pipeline-timeout-ms"), DEFAULT_PIPELINE_TIMEOUT_MS, "pipeline-timeout-ms"),
    agentTimeoutMs: positiveNumber(options.get("agent-timeout-ms"), DEFAULT_AGENT_TIMEOUT_MS, "agent-timeout-ms")
  };
}

export async function runPerformanceBaseline(config: BaselineConfig): Promise<BaselineReport> {
  const client = new ApiClient(config.apiUrl, config.controlToken);
  const startedAt = new Date();
  const storageBefore = await measureStorage(config.storageRoot);
  await client.required("/api/health", "/api/health");
  const runSuffix = startedAt.toISOString().replace(/\D/g, "").slice(0, 14);
  const spaces = await Promise.all(
    ["A", "B"].map(async (label) => {
      const response = await client.required<{ space: { id: string } }>("/api/spaces", "/api/spaces", {
        method: "POST",
        body: JSON.stringify({ name: `Performance Baseline ${label} ${runSuffix}` })
      });
      return { label: `space-${label.toLowerCase()}`, id: response.space.id };
    })
  );

  const ingestionStartedAt = performance.now();
  const spaceReports: SpaceRunReport[] = [];
  const allJobs: JobMeasurement[] = [];
  for (const space of spaces) {
    const spaceStartedAt = performance.now();
    const additions: SpaceRunReport["additions"] = [];
    for (const [repositoryIndex, locator] of config.repositories.entries()) {
      const additionStartedAt = performance.now();
      const response = await client.required<{ jobs: JobView[] }>(
        "/api/spaces/:spaceId/repositories",
        `/api/spaces/${encodeURIComponent(space.id)}/repositories`,
        { method: "POST", body: JSON.stringify({ locator }) }
      );
      const finalJobs = await waitForJobs(client, response.jobs.map((job) => job.id), config);
      const jobs = finalJobs.map(measureJob);
      allJobs.push(...jobs);
      additions.push({
        repositoryLabel: `repository-${repositoryIndex + 1}`,
        durationMs: Math.round(performance.now() - additionStartedAt),
        jobs
      });
    }
    const snapshotResponse = await client.required<{ snapshots: Array<{ active: boolean }>; totalSizeBytes: number }>(
      "/api/spaces/:spaceId/snapshots",
      `/api/spaces/${encodeURIComponent(space.id)}/snapshots`
    );
    spaceReports.push({
      label: space.label,
      durationMs: Math.round(performance.now() - spaceStartedAt),
      additions,
      snapshots: {
        count: snapshotResponse.snapshots.length,
        activeCount: snapshotResponse.snapshots.filter((snapshot) => snapshot.active).length,
        totalSizeBytes: snapshotResponse.totalSizeBytes
      }
    });
  }
  const ingestionDurationMs = Math.round(performance.now() - ingestionStartedAt);
  const agents = await runAgentScenario(client, spaces[0]!.id, config);
  const idleProbe = await runIdleProbe(client, spaces[0]!.id, config);
  const storageAfter = await measureStorage(config.storageRoot);
  const finishedAt = new Date();

  return {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    scenario: {
      repositoryCount: 3,
      spaceCount: 2,
      sequentialRepositoryAdds: true,
      agentConcurrencyRequested: config.includeAgents ? 3 : 0,
      idleProbeSeconds: config.idleSeconds
    },
    ingestion: {
      durationMs: ingestionDurationMs,
      spaces: spaceReports,
      jobsByType: aggregateJobs(allJobs),
      snapshotJobCount: allJobs.filter((job) => job.type === "rebuild_space_snapshot").length
    },
    agents,
    idleProbe,
    storage: {
      available: storageBefore !== null && storageAfter !== null,
      before: storageBefore,
      after: storageAfter,
      deltaBytes: storageBefore && storageAfter ? storageDelta(storageBefore, storageAfter) : null
    },
    http: client.summary()
  };
}

export async function writeBaselineReport(report: BaselineReport, outputPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(temporaryPath, outputPath);
}

export function aggregateJobs(jobs: JobMeasurement[]): Record<string, JobAggregate> {
  const grouped = new Map<string, JobMeasurement[]>();
  for (const job of jobs) {
    const values = grouped.get(job.type) ?? [];
    values.push(job);
    grouped.set(job.type, values);
  }
  return Object.fromEntries(
    [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([type, values]) => {
      const runDurations = values.flatMap((value) => (value.runMs === null ? [] : [value.runMs]));
      return [type, {
        count: values.length,
        succeeded: values.filter((value) => value.status === "succeeded").length,
        failed: values.filter((value) => value.status === "failed").length,
        totalRunMs: sum(runDurations),
        medianRunMs: percentile(runDurations, 0.5),
        p95RunMs: percentile(runDurations, 0.95),
        maxRunMs: runDurations.length > 0 ? Math.max(...runDurations) : null
      }];
    })
  );
}

async function waitForJobs(client: ApiClient, jobIds: string[], config: BaselineConfig): Promise<JobView[]> {
  const deadline = Date.now() + config.pipelineTimeoutMs;
  const wanted = new Set(jobIds);
  while (Date.now() < deadline) {
    const response = await client.required<{ jobs: JobView[] }>("/api/jobs", "/api/jobs");
    const matching = response.jobs.filter((job) => wanted.has(job.id));
    if (matching.length === wanted.size && matching.every((job) => TERMINAL_JOB_STATUSES.has(job.status))) {
      if (matching.some((job) => job.status !== "succeeded")) throw new Error("A benchmark pipeline job did not succeed");
      return matching.sort((left, right) => left.created_at.localeCompare(right.created_at));
    }
    await sleep(config.pollIntervalMs);
  }
  throw new Error("Timed out while waiting for the repository pipeline");
}

function measureJob(job: JobView): JobMeasurement {
  return {
    type: job.type,
    status: job.status,
    queueMs: durationBetween(job.created_at, job.started_at),
    runMs: durationBetween(job.started_at, job.finished_at),
    totalMs: durationBetween(job.created_at, job.finished_at)
  };
}

async function runAgentScenario(client: ApiClient, spaceId: string, config: BaselineConfig): Promise<AgentRunReport> {
  const status = await client.required<{ available?: boolean; connected?: boolean }>("/api/agent/status", "/api/agent/status");
  const base = { requested: config.includeAgents, available: Boolean(status.available), connected: Boolean(status.connected) };
  if (!config.includeAgents || !status.available || !status.connected) {
    return { ...base, outcome: "skipped", turns: [], totals: emptyAgentTotals() };
  }

  const prompts = [
    "Give a concise architecture overview of this space and support the important conclusions with repository evidence.",
    "Compare the main application boundaries across the repositories and present the result as a compact table.",
    "Identify the highest-risk coupling across repositories, explain why it matters, and cite the relevant evidence."
  ];
  const chats = await Promise.all(
    prompts.map(() => client.required<{ chat: { id: string } }>(
      "/api/agent/spaces/:spaceId/chats",
      `/api/agent/spaces/${encodeURIComponent(spaceId)}/chats`,
      { method: "POST", body: "{}" }
    ))
  );
  const scenarioStartedAt = performance.now();
  const submissions = await Promise.all(
    prompts.map(async (prompt, index) => {
      const startedAt = performance.now();
      const chatId = chats[index]!.chat.id;
      const result = await client.request<{ turn: TurnView }>(
        "/api/agent/spaces/:spaceId/chats/:chatId/messages",
        `/api/agent/spaces/${encodeURIComponent(spaceId)}/chats/${encodeURIComponent(chatId)}/messages`,
        { method: "POST", body: JSON.stringify({ message: prompt }) }
      );
      return { label: `agent-${index + 1}`, startedAt, result };
    })
  );
  const turns = await Promise.all(
    submissions.map(async ({ label, startedAt, result }): Promise<AgentTurnMeasurement> => {
      if (!result.ok || !result.body) {
        return {
          label,
          accepted: false,
          httpStatus: result.status,
          errorCode: result.errorCode,
          status: "rejected",
          durationMs: Math.round(performance.now() - startedAt),
          queueMs: null,
          providerRounds: 0,
          toolCalls: 0,
          usage: emptyUsage()
        };
      }
      const turn = await client.waitForTurn(result.body.turn.id, config.agentTimeoutMs);
      return measureTurn(label, result.status, startedAt, turn);
    })
  );
  const totals = turns.reduce((aggregate, turn) => {
    aggregate.accepted += turn.accepted ? 1 : 0;
    aggregate.rejected += turn.accepted ? 0 : 1;
    aggregate.completed += turn.status === "completed" ? 1 : 0;
    aggregate.providerRounds += turn.providerRounds;
    aggregate.toolCalls += turn.toolCalls;
    addUsage(aggregate.usage, turn.usage);
    return aggregate;
  }, { ...emptyAgentTotals(), durationMs: Math.round(performance.now() - scenarioStartedAt) });
  return {
    ...base,
    outcome: totals.completed === turns.length ? "completed" : "partially_completed",
    turns,
    totals
  };
}

function measureTurn(label: string, httpStatus: number, startedAt: number, turn: TurnView): AgentTurnMeasurement {
  return {
    label,
    accepted: true,
    httpStatus,
    errorCode: null,
    status: turn.status,
    durationMs: Math.round(performance.now() - startedAt),
    queueMs: durationBetween(turn.createdAt, turn.startedAt),
    providerRounds: numberValue(turn.metrics?.providerRoundCount),
    toolCalls: numberValue(turn.metrics?.toolCallCount),
    usage: normalizedUsage(turn.metrics?.usage)
  };
}

async function runIdleProbe(client: ApiClient, spaceId: string, config: BaselineConfig): Promise<IdleProbeReport> {
  if (config.idleSeconds === 0) return { mode: "disabled", durationMs: 0, requests: 0, browserPreflightsIncluded: false };
  const schedules = [
    { intervalMs: 3_000, route: "/api/jobs", path: "/api/jobs" },
    { intervalMs: 5_000, route: "/api/spaces", path: "/api/spaces" },
    { intervalMs: 5_000, route: "/api/spaces/:spaceId", path: `/api/spaces/${encodeURIComponent(spaceId)}` },
    { intervalMs: 10_000, route: "/api/spaces/:spaceId/mcp-connections", path: `/api/spaces/${encodeURIComponent(spaceId)}/mcp-connections` },
    { intervalMs: 30_000, route: "/api/system", path: "/api/system" }
  ].map((schedule) => ({ ...schedule, nextAt: performance.now() }));
  const startedAt = performance.now();
  const startingRequestCount = client.requestCount();
  const deadline = startedAt + config.idleSeconds * 1_000;
  while (performance.now() < deadline) {
    const now = performance.now();
    const due = schedules.filter((schedule) => schedule.nextAt <= now);
    if (due.length > 0) {
      await Promise.all(due.map(async (schedule) => {
        schedule.nextAt += schedule.intervalMs;
        await client.required(schedule.route, schedule.path);
      }));
      continue;
    }
    const nextAt = Math.min(...schedules.map((schedule) => schedule.nextAt), deadline);
    await sleep(Math.max(10, Math.min(250, nextAt - performance.now())));
  }
  return {
    mode: "api-cadence-simulation",
    durationMs: Math.round(performance.now() - startedAt),
    requests: client.requestCount() - startingRequestCount,
    browserPreflightsIncluded: false
  };
}

async function measureStorage(storageRoot: string | null): Promise<StorageMeasurement | null> {
  if (!storageRoot || !fs.existsSync(storageRoot)) return null;
  const spaces = await directorySize(path.join(storageRoot, "spaces"));
  const repositoryIndexes = await directorySize(path.join(storageRoot, "indexes", "r"));
  const snapshots = await directorySize(path.join(storageRoot, "indexes", "s"));
  const revisionSources = await directorySize(path.join(storageRoot, "indexes", "c"));
  const database = await directorySize(path.join(storageRoot, "data"));
  const total = await directorySize(storageRoot);
  return {
    total,
    spaces,
    repositoryIndexes,
    snapshots,
    revisionSources,
    database,
    other: Math.max(0, total - spaces - repositoryIndexes - snapshots - revisionSources - database)
  };
}

async function directorySize(target: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(target);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    const sizes = await Promise.all(entries.map((entry) => entry.isSymbolicLink() ? 0 : directorySize(path.join(target, entry.name))));
    return sum(sizes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function storageDelta(before: StorageMeasurement, after: StorageMeasurement): Record<string, number> {
  return Object.fromEntries(Object.keys(after).map((key) => [
    key,
    after[key as keyof StorageMeasurement] - before[key as keyof StorageMeasurement]
  ]));
}

function parseOptions(argv: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) throw new BaselineInputError(`Unexpected argument: ${argument}`);
    const withoutPrefix = argument.slice(2);
    const equalsAt = withoutPrefix.indexOf("=");
    if (equalsAt >= 0) {
      options.set(withoutPrefix.slice(0, equalsAt), withoutPrefix.slice(equalsAt + 1));
      continue;
    }
    if (withoutPrefix === "include-agents") {
      options.set(withoutPrefix, "true");
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new BaselineInputError(`Missing value for --${withoutPrefix}`);
    options.set(withoutPrefix, value);
    index += 1;
  }
  return options;
}

function positiveNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new BaselineInputError(`--${name} must be a positive number`);
  return parsed;
}

function nonNegativeNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new BaselineInputError(`--${name} must be zero or a positive number`);
  return parsed;
}

function durationBetween(start: string | null, finish: string | null): number | null {
  if (!start || !finish) return null;
  const duration = Date.parse(finish) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1));
  return sorted[index]!;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function emptyUsage(): UsageMeasurement {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function normalizedUsage(usage: Partial<UsageMeasurement> | undefined): UsageMeasurement {
  return {
    input: numberValue(usage?.input),
    output: numberValue(usage?.output),
    reasoning: numberValue(usage?.reasoning),
    cacheRead: numberValue(usage?.cacheRead),
    cacheWrite: numberValue(usage?.cacheWrite),
    total: numberValue(usage?.total)
  };
}

function addUsage(target: UsageMeasurement, value: UsageMeasurement): void {
  target.input += value.input;
  target.output += value.output;
  target.reasoning += value.reasoning;
  target.cacheRead += value.cacheRead;
  target.cacheWrite += value.cacheWrite;
  target.total += value.total;
}

function emptyAgentTotals() {
  return {
    accepted: 0,
    rejected: 0,
    completed: 0,
    durationMs: 0,
    providerRounds: 0,
    toolCalls: 0,
    usage: emptyUsage()
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyTurn(id: string): TurnView {
  return { id, status: "unknown", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null };
}

function parseJson(value: string): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
