import { EventEmitter } from "node:events";
import type {
  AgentHistoryMessage,
  AgentLoginAttempt,
  AgentModelCatalog,
  AgentProviderStatus,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentToolDefinition,
  AgentToolRequest,
  AgentToolResult,
  JsonValue
} from "@memorepo/agent-runtime";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/connection.js";
import { createId } from "../domain/ids.js";
import { sanitizePublicMessage } from "../domain/publicSanitize.js";
import { nowIso } from "../domain/time.js";
import type { SnapshotQueryService } from "./snapshotQueryService.js";
import type { SnapshotManifest, SnapshotService } from "./snapshotService.js";

const MAX_ACTIVE_TURNS = 2;
const MAX_HISTORY_MESSAGES = 100;
const MAX_HISTORY_BYTES = 192_000;
const MAX_SOURCES = 24;
const MAX_TOOL_RESULT_BYTES = 900_000;
const DEFAULT_TITLE = "New chat";

type ChatStatus = "active" | "archived";
type TurnStatus = "pending" | "running" | "completed" | "interrupted" | "failed";

export type AgentRuntimePort = Pick<
  AgentRuntime,
  | "status"
  | "startLogin"
  | "loginStatus"
  | "cancelLogin"
  | "logout"
  | "startRun"
  | "interrupt"
  | "close"
>;

export interface AgentModelSelectionPort {
  catalog(): AgentModelCatalog;
  selectModel(providerId: string, modelId: string): void;
}

interface ChatRow {
  id: string;
  spaceId: string;
  accountSessionId: string;
  snapshotId: string | null;
  snapshotVersion: number;
  snapshotMetaJson: string;
  title: string;
  status: ChatStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  activeSnapshotId: string | null;
  activeSnapshotVersion: number | null;
  messageCount: number;
  activeTurnId: string | null;
}

interface MessageRow {
  id: string;
  chatId: string;
  sequence: number;
  role: "user" | "assistant";
  status: TurnStatus;
  content: string;
  sourcesJson: string;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface TurnRow {
  id: string;
  chatId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: TurnStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AgentSource {
  tool: string;
  repository?: string;
  project?: string;
  path?: string;
  symbol?: string;
  commit?: string;
}

export type AgentClientEvent =
  | { type: "assistant.delta"; turnId: string; messageId: string; offset: number; delta: string }
  | { type: "tool.started"; turnId: string; tool: string }
  | { type: "tool.completed"; turnId: string; tool: string; success: boolean; sources: AgentSource[] }
  | {
      type: "turn.completed";
      turnId: string;
      status: "completed" | "interrupted" | "failed";
      error: string | null;
    };

interface RunState {
  turnId: string;
  assistantMessageId: string;
  content: string;
  sources: AgentSource[];
  allowedTools: Set<string>;
  completed: boolean;
  persistedLength: number;
  lastPersistedAt: number;
}

export class AgentService {
  private readonly events = new EventEmitter();
  private readonly runs = new Map<string, RunState>();
  private readonly mutatingChats = new Set<string>();
  private closed = false;
  private authenticationChanging = false;
  private authenticationEpoch = 0;
  private activeLoginId: string | null = null;
  private logoutTask: Promise<void> | null = null;

  constructor(
    private readonly database: AppDatabase,
    private readonly config: AppConfig,
    private readonly runtime: AgentRuntimePort,
    private readonly snapshotQueries: SnapshotQueryService,
    private readonly snapshots: Pick<SnapshotService, "assertAgentTurnCanStart">,
    private readonly modelSelection?: AgentModelSelectionPort
  ) {
    this.recoverInterruptedTurns();
    this.deleteOrphanedAccountSessions();
  }

  modelCatalog(): AgentModelCatalog {
    if (this.modelSelection) return this.modelSelection.catalog();
    return {
      providers: [],
      selected: { providerId: this.config.agentProvider, modelId: this.config.agentModel }
    };
  }

  selectModel(providerId: string, modelId: string): AgentModelCatalog {
    this.assertAuthenticationReady();
    if (this.activeTurnIds().length > 0) throw httpError(409, "Wait for active agent runs before changing models");
    if (!this.modelSelection) throw httpError(503, "Agent model selection is unavailable");
    this.modelSelection.selectModel(providerId, modelId);
    return this.modelSelection.catalog();
  }

  async status() {
    await this.reconcileActiveLogin();
    const epoch = this.authenticationEpoch;
    try {
      const status = await this.runtime.status();
      const current = epoch === this.authenticationEpoch && !this.authenticationChanging && !this.closed;
      if (current && status.connected && status.accountKey) this.ensureAccountSession(status);
      // A status read cannot confirm logout; keep the persisted session until logout or a new identity does.
      const publicStatus = publicProviderStatus(status);
      return current ? publicStatus : publicAuthenticationChangingStatus(publicStatus);
    } catch (error) {
      if (epoch !== this.authenticationEpoch || this.authenticationChanging) {
        return publicAuthenticationChangingStatus({
          configured: true,
          available: true,
          connected: false,
          providerId: this.config.agentProvider,
          providerName: this.config.agentProvider,
          modelId: this.config.agentModel,
          modelName: this.config.agentModel,
          authSource: null,
          version: null,
          message: null
        });
      }
      return {
        configured: true,
        available: false,
        connected: false,
        providerId: this.config.agentProvider,
        providerName: this.config.agentProvider,
        modelId: this.config.agentModel,
        modelName: this.config.agentModel,
        authSource: null,
        version: null,
        message: this.publicError(error, "Agent runtime is unavailable")
      };
    }
  }

  startLogin(): Promise<AgentLoginAttempt> {
    this.assertAuthenticationReady();
    if (this.activeTurnIds().length > 0) throw httpError(409, "Wait for active agent answers before connecting");
    this.beginAuthenticationChange();
    let task: Promise<AgentLoginAttempt>;
    try {
      task = this.runtime.startLogin();
    } catch (error) {
      this.finishLoginChange();
      throw error;
    }
    return task.then(
      (attempt) => {
        if (attempt.status === "pending") this.activeLoginId = attempt.loginId;
        else this.finishLoginChange(attempt.loginId);
        return attempt;
      },
      (error) => {
        this.finishLoginChange();
        throw error;
      }
    );
  }

  async loginStatus(loginId: string): Promise<AgentLoginAttempt> {
    const epoch = this.authenticationEpoch;
    const login = await this.runtime.loginStatus(loginId);
    if (login.status === "completed") {
      const status = await this.runtime.status();
      if (
        epoch === this.authenticationEpoch &&
        this.authenticationChanging &&
        !this.logoutTask &&
        this.activeLoginId === loginId &&
        status.connected &&
        status.accountKey
      ) {
        this.ensureAccountSession(status);
      }
    }
    if (login.status !== "pending") this.finishLoginChange(loginId);
    return login;
  }

  async cancelLogin(loginId: string): Promise<void> {
    try {
      await this.runtime.cancelLogin(loginId);
    } finally {
      this.finishLoginChange(loginId);
    }
  }

  logout(): Promise<void> {
    if (this.logoutTask) return this.logoutTask;
    if (this.closed) return Promise.reject(httpError(503, "Agent service is closed"));
    this.beginAuthenticationChange();
    this.activeLoginId = null;
    const activeTurns = this.activeTurnIds();
    const task = (async () => {
      try {
        await this.runtime.logout();
        const status = await this.runtime.status();
        if (!status.available) throw httpError(503, "Agent sign-out could not be confirmed");
        if (status.connected) throw httpError(409, "Agent sign-out did not remove the active credential");
        this.disconnectActiveAccountSession();
        this.deleteOrphanedAccountSessions();
      } finally {
        this.forceInterruptTurns([...new Set([...activeTurns, ...this.activeTurnIds()])]);
      }
    })().finally(() => {
      if (this.logoutTask === task) this.logoutTask = null;
      this.endAuthenticationChange();
    });
    this.logoutTask = task;
    return task;
  }

  async createChat(spaceId: string) {
    const authentication = await this.requireConnectedProvider();
    const accountSessionId = this.ensureAccountSession(authentication.provider);
    const space = this.database.sqlite
      .prepare(
        "SELECT s.id, s.active_snapshot_id AS activeSnapshotId, " +
          "ss.version, ss.manifest_json AS manifestJson, ss.created_at AS createdAt, " +
          "ss.activated_at AS activatedAt " +
          "FROM spaces s LEFT JOIN space_snapshots ss ON ss.id = s.active_snapshot_id " +
          "WHERE s.id = ?"
      )
      .get(spaceId) as
      | {
          id: string;
          activeSnapshotId: string | null;
          version: number | null;
          manifestJson: string | null;
          createdAt: string | null;
          activatedAt: string | null;
        }
      | undefined;
    if (!space) throw httpError(404, "Space not found");
    if (!space.activeSnapshotId || !space.version || !space.manifestJson) {
      throw httpError(409, "Build an active snapshot before starting a chat");
    }

    const tools = await this.snapshotQueries.listTools(space.id, space.activeSnapshotId);
    this.assertAuthenticationContext(authentication.epoch, accountSessionId);
    if (tools.length === 0) throw httpError(409, "The active snapshot has no available query tools");
    const chatId = createId("ach");
    const at = nowIso();
    const meta = publicSnapshotMeta(parseManifest(space.manifestJson), space.createdAt, space.activatedAt);
    this.database.sqlite
      .prepare(
        "INSERT INTO agent_chats " +
          "(id, space_id, account_session_id, snapshot_id, snapshot_version, snapshot_meta_json, " +
          "title, status, created_at, updated_at, archived_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)"
      )
      .run(
        chatId,
        space.id,
        accountSessionId,
        space.activeSnapshotId,
        space.version,
        JSON.stringify(meta),
        DEFAULT_TITLE,
        at,
        at
      );
    return this.getChat(space.id, chatId);
  }

  listChats(spaceId: string, includeArchived = false) {
    this.assertSpace(spaceId);
    const filter = includeArchived ? "" : "AND c.status = 'active'";
    const rows = this.database.sqlite
      .prepare(chatSelect() + " WHERE c.space_id = ? " + filter + " ORDER BY c.updated_at DESC, c.created_at DESC")
      .all(spaceId) as ChatRow[];
    const activeSessionId = this.activeAccountSessionId();
    return { chats: rows.map((row) => this.toChatView(row, activeSessionId)) };
  }

  getChat(spaceId: string, chatId: string) {
    const row = this.chatRow(spaceId, chatId);
    const messages = this.database.sqlite
      .prepare(
        "SELECT id, chat_id AS chatId, sequence, role, status, content, " +
          "sources_json AS sourcesJson, error, created_at AS createdAt, completed_at AS completedAt " +
          "FROM agent_messages WHERE chat_id = ? ORDER BY sequence"
      )
      .all(chatId) as MessageRow[];
    return {
      chat: this.toChatView(row, this.activeAccountSessionId()),
      messages: messages.map(toMessageView)
    };
  }

  async sendMessage(spaceId: string, chatId: string, message: string) {
    let chat = this.chatRow(spaceId, chatId);
    const authentication = await this.requireConnectedProvider();
    const accountSessionId = this.ensureAccountSession(authentication.provider);
    this.assertContinuable(chat, accountSessionId);
    if (!chat.snapshotId) throw httpError(409, "This chat cannot be continued");

    const content = message.trim();
    if (!content) throw httpError(400, "Message cannot be empty");
    const tools = toRuntimeTools(await this.snapshotQueries.listTools(chat.spaceId, chat.snapshotId));
    this.assertAuthenticationContext(authentication.epoch, accountSessionId);
    if (tools.length === 0) throw httpError(409, "The pinned snapshot has no available query tools");

    chat = this.chatRow(spaceId, chatId);
    this.assertContinuable(chat, accountSessionId);
    if (!chat.snapshotId) throw httpError(409, "This chat cannot be continued");
    this.snapshots.assertAgentTurnCanStart(chat.snapshotId);
    if (this.mutatingChats.has(chatId)) throw httpError(409, "This chat is being archived or deleted");

    const userMessageId = createId("agm");
    const assistantMessageId = createId("agm");
    const turnId = createId("atr");
    const at = nowIso();
    try {
      this.database.sqlite.transaction(() => {
        this.assertTurnCapacity(chatId);
        const sequence = (
          this.database.sqlite
            .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_messages WHERE chat_id = ?")
            .get(chatId) as { sequence: number }
        ).sequence;
        this.database.sqlite
          .prepare(
            "INSERT INTO agent_messages " +
              "(id, chat_id, sequence, role, status, content, sources_json, error, created_at, completed_at) " +
              "VALUES (?, ?, ?, 'user', 'completed', ?, '[]', NULL, ?, ?)"
          )
          .run(userMessageId, chatId, sequence, content, at, at);
        this.database.sqlite
          .prepare(
            "INSERT INTO agent_messages " +
              "(id, chat_id, sequence, role, status, content, sources_json, error, created_at, completed_at) " +
              "VALUES (?, ?, ?, 'assistant', 'pending', '', '[]', NULL, ?, NULL)"
          )
          .run(assistantMessageId, chatId, sequence + 1, at);
        this.database.sqlite
          .prepare(
            "INSERT INTO agent_turns " +
              "(id, chat_id, user_message_id, assistant_message_id, status, error, created_at, started_at, finished_at) " +
              "VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL)"
          )
          .run(turnId, chatId, userMessageId, assistantMessageId, at);
        this.database.sqlite
          .prepare(
            "UPDATE agent_chats SET title = CASE WHEN title = ? THEN ? ELSE title END, updated_at = ? WHERE id = ?"
          )
          .run(DEFAULT_TITLE, titleFromMessage(content), at, chatId);
      })();
    } catch (error) {
      if (isActiveTurnConstraint(error)) {
        throw httpError(409, "Wait for the current answer before sending another message");
      }
      throw error;
    }

    const state: RunState = {
      turnId,
      assistantMessageId,
      content: "",
      sources: [],
      allowedTools: new Set(tools.map((tool) => tool.name)),
      completed: false,
      persistedLength: 0,
      lastPersistedAt: 0
    };
    this.runs.set(turnId, state);
    const startedAt = nowIso();
    this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare("UPDATE agent_turns SET status = 'running', started_at = ? WHERE id = ?")
        .run(startedAt, turnId);
      this.database.sqlite.prepare("UPDATE agent_messages SET status = 'running' WHERE id = ?").run(assistantMessageId);
    })();

    try {
      this.runtime.startRun({
        runId: turnId,
        sessionId: chatId,
        systemPrompt: systemPrompt(chat),
        history: this.runtimeHistory(chatId, turnId),
        tools,
        requestTool: (request, signal) => this.executeTool(chat, state, request, signal),
        onEvent: (event) => this.handleRuntimeEvent(turnId, state, event)
      });
      return {
        turn: this.getTurn(turnId),
        userMessage: this.messageById(userMessageId),
        assistantMessage: this.messageById(assistantMessageId)
      };
    } catch (error) {
      state.completed = true;
      this.runs.delete(turnId);
      this.finishTurnLocally(turnId, "failed", this.publicError(error, "The agent could not start this answer"));
      throw error;
    }
  }

  getTurn(turnId: string) {
    return toTurnView(this.turnRow(turnId));
  }

  getTurnStreamState(turnId: string) {
    const turn = this.getTurn(turnId);
    const persistedMessage = this.messageById(turn.assistantMessageId);
    const run = this.runs.get(turnId);
    return {
      turn,
      assistantMessage: run
        ? { ...persistedMessage, content: run.content, sources: run.sources }
        : persistedMessage
    };
  }

  onTurnEvent(turnId: string, listener: (event: AgentClientEvent) => void | Promise<void>): () => void {
    const name = "turn:" + turnId;
    this.events.on(name, listener);
    return () => this.events.off(name, listener);
  }

  async interruptTurn(spaceId: string, chatId: string, turnId: string): Promise<void> {
    this.chatRow(spaceId, chatId);
    const turn = this.turnRow(turnId);
    if (turn.chatId !== chatId) throw httpError(404, "Agent turn not found");
    if (turn.status !== "pending" && turn.status !== "running") return;
    await this.runtime.interrupt(turnId);
    if (this.finishTurnLocally(turnId, "interrupted", null)) {
      this.emit(turnId, { type: "turn.completed", turnId, status: "interrupted", error: null });
    }
    this.runs.delete(turnId);
  }

  async archiveChat(spaceId: string, chatId: string) {
    const chat = this.chatRow(spaceId, chatId);
    if (chat.activeTurnId) throw httpError(409, "Wait for the current answer before archiving this chat");
    if (chat.status === "archived") return this.getChat(spaceId, chatId);
    const release = this.beginChatMutation(chatId);
    try {
      const at = nowIso();
      this.database.sqlite
        .prepare("UPDATE agent_chats SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
        .run(at, at, chatId);
      return this.getChat(spaceId, chatId);
    } finally {
      release();
    }
  }

  async deleteChat(spaceId: string, chatId: string): Promise<void> {
    const chat = this.chatRow(spaceId, chatId);
    if (chat.activeTurnId) throw httpError(409, "Wait for the current answer before deleting this chat");
    const release = this.beginChatMutation(chatId);
    try {
      this.database.sqlite.transaction(() => {
        this.database.sqlite.prepare("DELETE FROM agent_chats WHERE id = ?").run(chatId);
        this.deleteOrphanedAccountSessions();
      })();
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.logoutTask?.catch(() => undefined);
    const activeTurns = this.activeTurnIds();
    try {
      await this.runtime.close();
    } finally {
      this.forceInterruptTurns(activeTurns);
      this.runs.clear();
      this.events.removeAllListeners();
    }
  }

  private async executeTool(
    chat: ChatRow,
    state: RunState,
    request: AgentToolRequest,
    signal: AbortSignal
  ): Promise<AgentToolResult> {
    if (signal.aborted || state.completed) return interruptedToolResult();
    if (request.runId !== state.turnId || request.sessionId !== chat.id) {
      return { ok: false, error: { code: "invalid_request", message: "Agent tool request correlation failed" } };
    }
    if (!state.allowedTools.has(request.name)) {
      return { ok: false, error: { code: "unknown_tool", message: "The requested snapshot tool is not available" } };
    }
    if (!chat.snapshotId) {
      return { ok: false, error: { code: "snapshot_unavailable", message: "The pinned snapshot is unavailable" } };
    }

    try {
      const result = await this.snapshotQueries.call(
        chat.spaceId,
        chat.snapshotId,
        request.name,
        request.arguments,
        signal
      );
      if (signal.aborted || state.completed) return interruptedToolResult();
      const value = boundedJsonValue(result);
      state.sources = mergeSources(state.sources, extractSources(request.name, request.arguments, result));
      this.database.sqlite
        .prepare("UPDATE agent_messages SET sources_json = ? WHERE id = ?")
        .run(JSON.stringify(state.sources), state.assistantMessageId);
      return { ok: true, value };
    } catch (error) {
      if (signal.aborted || state.completed) return interruptedToolResult();
      return { ok: false, error: { code: "tool_error", message: this.publicError(error, "Snapshot query failed") } };
    }
  }

  private handleRuntimeEvent(turnId: string, state: RunState, event: AgentRuntimeEvent): void {
    if (event.runId !== turnId || state.completed) return;
    if (event.type === "run.started") return;

    if (event.type === "assistant.delta") {
      const offset = state.content.length;
      state.content += event.delta;
      const at = Date.now();
      if (state.content.length - state.persistedLength >= 128 || at - state.lastPersistedAt >= 250) {
        this.database.sqlite
          .prepare("UPDATE agent_messages SET content = ? WHERE id = ?")
          .run(state.content, state.assistantMessageId);
        state.persistedLength = state.content.length;
        state.lastPersistedAt = at;
      }
      this.emit(turnId, {
        type: "assistant.delta",
        turnId,
        messageId: state.assistantMessageId,
        offset,
        delta: event.delta
      });
      return;
    }

    if (event.type === "tool.started") {
      this.emit(turnId, { type: "tool.started", turnId, tool: event.name });
      return;
    }
    if (event.type === "tool.completed") {
      this.emit(turnId, {
        type: "tool.completed",
        turnId,
        tool: event.name,
        success: event.success,
        sources: state.sources
      });
      return;
    }

    const error =
      event.status === "failed" ? this.publicError(event.error, "The agent could not complete this answer") : null;
    const changed = this.finishTurnLocally(turnId, event.status, error, nowIso(), state.content, state.sources);
    state.completed = true;
    this.runs.delete(turnId);
    if (changed) {
      this.emit(turnId, { type: "turn.completed", turnId, status: event.status, error });
    }
  }

  private runtimeHistory(chatId: string, currentTurnId: string): AgentHistoryMessage[] {
    const turns = this.database.sqlite
      .prepare(
        "SELECT t.id, t.status, u.content AS userContent, u.created_at AS userCreatedAt, " +
          "a.content AS assistantContent, a.created_at AS assistantCreatedAt " +
          "FROM agent_turns t " +
          "JOIN agent_messages u ON u.id = t.user_message_id " +
          "JOIN agent_messages a ON a.id = t.assistant_message_id " +
          "WHERE t.chat_id = ? AND (t.status = 'completed' OR t.id = ?) " +
          "ORDER BY u.sequence DESC LIMIT ?"
      )
      .all(chatId, currentTurnId, Math.ceil(MAX_HISTORY_MESSAGES / 2)) as Array<{
      id: string;
      status: TurnStatus;
      userContent: string;
      userCreatedAt: string;
      assistantContent: string;
      assistantCreatedAt: string;
    }>;

    const selected: AgentHistoryMessage[][] = [];
    let messageCount = 0;
    let byteCount = 0;
    for (const turn of turns) {
      const pair: AgentHistoryMessage[] = [historyMessage("user", turn.userContent, turn.userCreatedAt)];
      if (turn.status === "completed" && turn.assistantContent) {
        pair.push(historyMessage("assistant", turn.assistantContent, turn.assistantCreatedAt));
      }
      const pairBytes = pair.reduce((total, message) => total + Buffer.byteLength(message.content, "utf8"), 0);
      const isCurrent = turn.id === currentTurnId;
      if (!isCurrent && (messageCount + pair.length > MAX_HISTORY_MESSAGES || byteCount + pairBytes > MAX_HISTORY_BYTES)) {
        break;
      }
      selected.push(pair);
      messageCount += pair.length;
      byteCount += pairBytes;
    }
    return selected.reverse().flat();
  }

  private finishTurnLocally(
    turnId: string,
    status: "completed" | "interrupted" | "failed",
    error: string | null,
    at = nowIso(),
    content?: string,
    sources?: AgentSource[]
  ): boolean {
    const turn = this.database.sqlite
      .prepare(
        "SELECT chat_id AS chatId, assistant_message_id AS assistantMessageId, status FROM agent_turns WHERE id = ?"
      )
      .get(turnId) as { chatId: string; assistantMessageId: string; status: TurnStatus } | undefined;
    if (!turn || (turn.status !== "pending" && turn.status !== "running")) return false;
    this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare("UPDATE agent_turns SET status = ?, error = ?, finished_at = ? WHERE id = ?")
        .run(status, error, at, turnId);
      this.database.sqlite
        .prepare(
          "UPDATE agent_messages SET status = ?, error = ?, completed_at = ?, " +
            "content = COALESCE(?, content), sources_json = COALESCE(?, sources_json) WHERE id = ?"
        )
        .run(status, error, at, content ?? null, sources ? JSON.stringify(sources) : null, turn.assistantMessageId);
      this.database.sqlite.prepare("UPDATE agent_chats SET updated_at = ? WHERE id = ?").run(at, turn.chatId);
    })();
    return true;
  }

  private forceInterruptTurns(turnIds: string[]): void {
    const at = nowIso();
    for (const turnId of turnIds) {
      if (this.finishTurnLocally(turnId, "interrupted", null, at)) {
        this.emit(turnId, { type: "turn.completed", turnId, status: "interrupted", error: null });
      }
      this.runs.delete(turnId);
    }
  }

  private assertTurnCapacity(chatId: string): void {
    const chatTurn = this.database.sqlite
      .prepare("SELECT id FROM agent_turns WHERE chat_id = ? AND status IN ('pending', 'running') LIMIT 1")
      .get(chatId);
    if (chatTurn) throw httpError(409, "Wait for the current answer before sending another message");
    const activeTurns = this.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM agent_turns WHERE status IN ('pending', 'running')")
      .get() as { count: number };
    if (activeTurns.count >= MAX_ACTIVE_TURNS) {
      throw httpError(429, "Two agent answers are already running; wait for one to finish");
    }
  }

  private ensureAccountSession(status: AgentProviderStatus): string {
    if (!status.connected || !status.accountKey) {
      throw httpError(409, "Connect " + status.providerName + " before starting a chat");
    }
    const existing = this.database.sqlite
      .prepare(
        "SELECT id, provider_id AS providerId, account_key AS accountKey " +
          "FROM agent_account_sessions WHERE disconnected_at IS NULL ORDER BY connected_at DESC LIMIT 1"
      )
      .get() as { id: string; providerId: string; accountKey: string } | undefined;
    if (existing && existing.providerId === status.providerId && existing.accountKey === status.accountKey) {
      return existing.id;
    }

    const at = nowIso();
    if (existing) this.disconnectActiveAccountSession(at);
    const id = createId("aas");
    this.database.sqlite
      .prepare(
        "INSERT INTO agent_account_sessions " +
          "(id, provider_id, account_key, connected_at, disconnected_at) VALUES (?, ?, ?, ?, NULL)"
      )
      .run(id, status.providerId, status.accountKey, at);
    return id;
  }

  private disconnectActiveAccountSession(at = nowIso()): void {
    this.database.sqlite
      .prepare("UPDATE agent_account_sessions SET disconnected_at = ? WHERE disconnected_at IS NULL")
      .run(at);
  }

  private deleteOrphanedAccountSessions(): void {
    this.database.sqlite
      .prepare(
        `DELETE FROM agent_account_sessions
         WHERE NOT EXISTS (
           SELECT 1 FROM agent_chats c WHERE c.account_session_id = agent_account_sessions.id
         )`
      )
      .run();
  }

  private activeAccountSessionId(): string | null {
    const row = this.database.sqlite
      .prepare("SELECT id FROM agent_account_sessions WHERE disconnected_at IS NULL ORDER BY connected_at DESC LIMIT 1")
      .get() as { id: string } | undefined;
    return row?.id ?? null;
  }

  private async requireConnectedProvider(): Promise<{ provider: AgentProviderStatus; epoch: number }> {
    this.assertAuthenticationReady();
    const epoch = this.authenticationEpoch;
    const status = await this.runtime.status();
    this.assertAuthenticationEpoch(epoch);
    if (!status.configured || !status.available) {
      throw httpError(503, status.message ?? "Agent runtime is unavailable");
    }
    if (!status.connected || !status.accountKey) {
      throw httpError(409, status.message ?? "Connect " + status.providerName + " before starting a chat");
    }
    return { provider: status, epoch };
  }

  private assertAuthenticationReady(): void {
    if (this.closed) throw httpError(503, "Agent service is closed");
    if (this.authenticationChanging) throw httpError(409, "Agent authentication is changing");
  }

  private assertAuthenticationEpoch(epoch: number): void {
    this.assertAuthenticationReady();
    if (epoch !== this.authenticationEpoch) throw httpError(409, "Agent authentication changed during the request");
  }

  private assertAuthenticationContext(epoch: number, accountSessionId: string): void {
    this.assertAuthenticationEpoch(epoch);
    if (this.activeAccountSessionId() !== accountSessionId) {
      throw httpError(409, "Agent connection changed during the request");
    }
  }

  private beginAuthenticationChange(): void {
    this.authenticationChanging = true;
    this.authenticationEpoch += 1;
  }

  private endAuthenticationChange(): void {
    this.authenticationChanging = false;
    this.authenticationEpoch += 1;
  }

  private finishLoginChange(loginId?: string): void {
    if (loginId && this.activeLoginId && this.activeLoginId !== loginId) return;
    if (!this.authenticationChanging || this.logoutTask) return;
    this.activeLoginId = null;
    this.endAuthenticationChange();
  }

  private async reconcileActiveLogin(): Promise<void> {
    const loginId = this.activeLoginId;
    if (!loginId || this.logoutTask) return;
    try {
      const attempt = await this.runtime.loginStatus(loginId);
      if (attempt.status !== "pending") this.finishLoginChange(loginId);
    } catch (error) {
      if ((error as { statusCode?: number } | null)?.statusCode === 404) this.finishLoginChange(loginId);
    }
  }

  private chatRow(spaceId: string, chatId: string): ChatRow {
    const row = this.database.sqlite
      .prepare(chatSelect() + " WHERE c.space_id = ? AND c.id = ?")
      .get(spaceId, chatId) as ChatRow | undefined;
    if (!row) throw httpError(404, "Chat not found");
    return row;
  }

  private turnRow(turnId: string): TurnRow {
    const row = this.database.sqlite
      .prepare(
        "SELECT id, chat_id AS chatId, user_message_id AS userMessageId, " +
          "assistant_message_id AS assistantMessageId, status, error, " +
          "created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt " +
          "FROM agent_turns WHERE id = ?"
      )
      .get(turnId) as TurnRow | undefined;
    if (!row) throw httpError(404, "Agent turn not found");
    return row;
  }

  private messageById(messageId: string) {
    const row = this.database.sqlite
      .prepare(
        "SELECT id, chat_id AS chatId, sequence, role, status, content, sources_json AS sourcesJson, " +
          "error, created_at AS createdAt, completed_at AS completedAt FROM agent_messages WHERE id = ?"
      )
      .get(messageId) as MessageRow | undefined;
    if (!row) throw httpError(404, "Agent message not found");
    return toMessageView(row);
  }

  private toChatView(row: ChatRow, activeSessionId: string | null) {
    const continuation = continuationState(row, activeSessionId);
    return {
      id: row.id,
      spaceId: row.spaceId,
      title: row.title,
      status: row.status,
      snapshot: { id: row.snapshotId, version: row.snapshotVersion, ...safeObject(row.snapshotMetaJson) },
      activeSnapshot: row.activeSnapshotVersion
        ? { id: row.activeSnapshotId, version: row.activeSnapshotVersion }
        : null,
      usesLatestSnapshot: row.snapshotId !== null && row.snapshotId === row.activeSnapshotId,
      continuable: continuation.continuable,
      continuationReason: continuation.reason,
      messageCount: row.messageCount,
      activeTurnId: row.activeTurnId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt
    };
  }

  private assertContinuable(chat: ChatRow, activeSessionId: string): void {
    const continuation = continuationState(chat, activeSessionId);
    if (!continuation.continuable) throw httpError(409, continuation.reason ?? "This chat cannot be continued");
  }

  private beginChatMutation(chatId: string): () => void {
    if (this.mutatingChats.has(chatId)) throw httpError(409, "This chat is already being archived or deleted");
    this.mutatingChats.add(chatId);
    return () => this.mutatingChats.delete(chatId);
  }

  private activeTurnIds(): string[] {
    return (
      this.database.sqlite
        .prepare("SELECT id FROM agent_turns WHERE status IN ('pending', 'running')")
        .all() as Array<{ id: string }>
    ).map((row) => row.id);
  }

  private emit(turnId: string, event: AgentClientEvent): void {
    const eventName = "turn:" + turnId;
    for (const listener of this.events.listeners(eventName)) {
      const callback = listener as (event: AgentClientEvent) => void | Promise<void>;
      try {
        const result = callback(event);
        if (result && typeof result.then === "function") {
          void result.catch(() => this.events.off(eventName, callback));
        }
      } catch {
        this.events.off(eventName, callback);
      }
    }
  }

  private assertSpace(spaceId: string): void {
    if (!this.database.sqlite.prepare("SELECT id FROM spaces WHERE id = ?").get(spaceId)) {
      throw httpError(404, "Space not found");
    }
  }

  private recoverInterruptedTurns(): void {
    const at = nowIso();
    this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare(
          "UPDATE agent_messages SET status = 'interrupted', error = NULL, completed_at = ? " +
            "WHERE id IN (SELECT assistant_message_id FROM agent_turns WHERE status IN ('pending', 'running'))"
        )
        .run(at);
      this.database.sqlite
        .prepare(
          "UPDATE agent_turns SET status = 'interrupted', error = NULL, finished_at = ? " +
            "WHERE status IN ('pending', 'running')"
        )
        .run(at);
    })();
  }

  private publicError(error: unknown, fallback: string): string {
    const sanitized = sanitizePublicMessage(error ?? fallback, [this.config.memorepoHome])
      .replace(/[\r\n]+/g, " ")
      .trim();
    return stripRuntimePaths(sanitized || fallback).slice(0, 500);
  }
}

function chatSelect(): string {
  return (
    "SELECT c.id, c.space_id AS spaceId, c.account_session_id AS accountSessionId, " +
    "c.snapshot_id AS snapshotId, c.snapshot_version AS snapshotVersion, " +
    "c.snapshot_meta_json AS snapshotMetaJson, c.title, c.status, " +
    "c.created_at AS createdAt, c.updated_at AS updatedAt, c.archived_at AS archivedAt, " +
    "s.active_snapshot_id AS activeSnapshotId, active_snapshot.version AS activeSnapshotVersion, " +
    "(SELECT COUNT(*) FROM agent_messages m WHERE m.chat_id = c.id) AS messageCount, " +
    "(SELECT t.id FROM agent_turns t WHERE t.chat_id = c.id " +
    "AND t.status IN ('pending', 'running') LIMIT 1) AS activeTurnId " +
    "FROM agent_chats c JOIN spaces s ON s.id = c.space_id " +
    "LEFT JOIN space_snapshots active_snapshot ON active_snapshot.id = s.active_snapshot_id"
  );
}

function continuationState(row: ChatRow, activeSessionId: string | null) {
  if (row.status !== "active") return { continuable: false, reason: "This chat is archived" };
  if (!row.snapshotId) return { continuable: false, reason: "Its pinned snapshot was pruned" };
  if (!activeSessionId || row.accountSessionId !== activeSessionId) {
    return { continuable: false, reason: "It belongs to a previous agent connection" };
  }
  return { continuable: true, reason: null };
}

function publicProviderStatus(status: AgentProviderStatus) {
  return {
    configured: status.configured,
    available: status.available,
    connected: status.connected && Boolean(status.accountKey),
    providerId: status.providerId,
    providerName: status.providerName,
    modelId: status.modelId,
    modelName: status.modelName,
    authSource: status.authSource,
    version: status.runtimeVersion,
    message: status.message
  };
}

function publicAuthenticationChangingStatus<
  T extends { connected: boolean; authSource: string | null; message: string | null }
>(status: T): T {
  return {
    ...status,
    connected: false,
    authSource: null,
    message: "Agent authentication is changing"
  } as T;
}

function systemPrompt(chat: ChatRow): string {
  return [
    "You answer questions about the code indexed in one MemoRepo Space.",
    "This chat is pinned to immutable snapshot version " + chat.snapshotVersion + ".",
    "Use only the provided read-only snapshot query tools for repository facts.",
    "Base technical claims on tool evidence, and say when the snapshot does not contain enough evidence.",
    "Never claim to have changed files. Keep repository paths relative and never expose internal filesystem paths."
  ].join(" ");
}

function toRuntimeTools(
  tools: ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }>
): AgentToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: boundedJsonValue(tool.inputSchema)
  }));
}

function parseManifest(value: string): SnapshotManifest {
  const parsed = JSON.parse(value) as SnapshotManifest;
  if (!parsed || !Array.isArray(parsed.repositories)) throw new Error("Snapshot manifest is invalid");
  return parsed;
}

function publicSnapshotMeta(manifest: SnapshotManifest, createdAt: string | null, activatedAt: string | null) {
  return {
    createdAt: createdAt ?? manifest.createdAt,
    activatedAt,
    repositories: manifest.repositories.map((repository) => ({
      fullName: repository.fullName,
      branch: repository.branch,
      commit: repository.commit,
      projectName: repository.projectName
    }))
  };
}

function toMessageView(row: MessageRow) {
  return {
    id: row.id,
    sequence: row.sequence,
    role: row.role,
    status: row.status,
    content: row.content,
    sources: safeArray<AgentSource>(row.sourcesJson),
    error: row.error,
    createdAt: row.createdAt,
    completedAt: row.completedAt
  };
}

function historyMessage(role: "user" | "assistant", content: string, createdAt: string): AgentHistoryMessage {
  const timestamp = Date.parse(createdAt);
  return { role, content, timestamp: Number.isFinite(timestamp) ? timestamp : Date.now() };
}

function toTurnView(row: TurnRow) {
  return {
    id: row.id,
    chatId: row.chatId,
    userMessageId: row.userMessageId,
    assistantMessageId: row.assistantMessageId,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt
  };
}

function titleFromMessage(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length <= 72 ? compact : compact.slice(0, 71).trimEnd() + "…";
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function stripRuntimePaths(value: string): string {
  return value
    .replace(/(^|[\s("' ])(?:[A-Za-z]:[\\/][^\s"'<>]+|\/(?:app|home|run|tmp|var|workspace)\/[^\s"'<>]+)/g, "$1[PATH]")
    .trim();
}

function safeObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function boundedJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value ?? null);
  if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_RESULT_BYTES) {
    throw new Error("Snapshot query result is too large for the agent");
  }
  return JSON.parse(serialized) as JsonValue;
}

function interruptedToolResult(): AgentToolResult {
  return { ok: false, error: { code: "interrupted", message: "The agent answer was interrupted" } };
}

function mergeSources(existing: AgentSource[], incoming: AgentSource[]): AgentSource[] {
  const merged = [...existing];
  const keys = new Set(merged.map((source) => JSON.stringify(source)));
  for (const source of incoming) {
    const key = JSON.stringify(source);
    if (!keys.has(key)) {
      keys.add(key);
      merged.push(source);
    }
    if (merged.length >= MAX_SOURCES) break;
  }
  return merged;
}

function extractSources(tool: string, args: unknown, result: unknown): AgentSource[] {
  const sources: AgentSource[] = [];
  const visit = (value: unknown, depth: number) => {
    if (sources.length >= MAX_SOURCES || depth > 7 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 100)) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const source: AgentSource = { tool };
    const repository = firstString(record, ["fullName", "full_name", "repository", "repo"]);
    const project = firstString(record, ["project", "projectName", "project_name"]);
    const filePath = firstString(record, ["file_path", "filePath", "relativePath", "path"]);
    const symbol = firstString(record, ["qualified_name", "qualifiedName", "symbol", "function_name"]);
    const commit = firstString(record, ["commit", "commitSha", "commit_sha"]);
    if (repository && !looksAbsolute(repository)) source.repository = cleanSourceValue(repository);
    if (project && !looksAbsolute(project)) source.project = cleanSourceValue(project);
    if (filePath && !looksAbsolute(filePath)) source.path = cleanSourceValue(filePath.replaceAll("\\", "/"));
    if (symbol && !looksAbsolute(symbol)) source.symbol = cleanSourceValue(symbol);
    if (commit && !looksAbsolute(commit)) source.commit = cleanSourceValue(commit);
    if (Object.keys(source).length > 1) sources.push(source);
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(args, 0);
  visit(result, 0);
  return mergeSources([], sources);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function cleanSourceValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 300);
}

function looksAbsolute(value: string): boolean {
  return /^([A-Za-z]:[\\/]|\/)/.test(value.trim());
}

function isActiveTurnConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    /agent_turns_active_chat_unique|UNIQUE constraint failed: agent_turns\.chat_id/i.test(error.message)
  );
}
