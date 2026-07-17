import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Bot,
  Check,
  Clipboard,
  Clock3,
  Database,
  ExternalLink,
  History,
  Loader2,
  LogOut,
  MessageSquareCode,
  MoveDiagonal2,
  Plus,
  Send,
  Square,
  Trash2,
  X
} from "lucide-react";
import {
  api,
  subscribeToAgentTurnEvents,
  type AgentChat,
  type AgentLogin,
  type AgentModelCatalog,
  type AgentMessage,
  type AgentSource,
  type AgentStatus,
  type AgentTurn,
  type AgentTurnEvent,
  type Space
} from "../lib/api";
import { AgentMarkdown } from "./AgentMarkdown";

interface AskSpacePanelProps {
  space: Space | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ChatDetail {
  chat: AgentChat;
  messages: AgentMessage[];
}

interface SendMessageResponse {
  turn: AgentTurn;
  userMessage: AgentMessage;
  assistantMessage: AgentMessage;
}

interface PanelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const PANEL_MARGIN = 16;
const PANEL_DEFAULT_WIDTH = 440;
const PANEL_MIN_WIDTH = 360;
const PANEL_MIN_HEIGHT = 360;

export function AskSpacePanel({ space, open, onOpenChange }: AskSpacePanelProps) {
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLElement>(null);
  const loginWindowRef = useRef<Window | null>(null);
  const currentSpaceIdRef = useRef<string | null>(space?.id ?? null);
  const selectedChatIdRef = useRef<string | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loginAttempt, setLoginAttempt] = useState<AgentLogin | null>(null);
  const [providerDisclosureAccepted, setProviderDisclosureAccepted] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [toolActivity, setToolActivity] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [panelRect, setPanelRect] = useState<PanelRect | null>(null);
  const [compactViewport, setCompactViewport] = useState(compactViewportMatches);
  const messageListRef = useRef<HTMLDivElement>(null);
  currentSpaceIdRef.current = space?.id ?? null;
  selectedChatIdRef.current = selectedChatId;

  useEffect(() => {
    setSelectedChatId(null);
    setDraft("");
    setToolActivity(null);
    setStreamError(null);
  }, [space?.id]);

  useEffect(() => {
    setDraft("");
    setToolActivity(null);
    setStreamError(null);
  }, [selectedChatId]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => setCompactViewport(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!open || compactViewport) return;
    setPanelRect((current) => clampPanelRect(current ?? defaultPanelRect(), window.innerWidth, window.innerHeight));
    const handleResize = () => {
      setPanelRect((current) => clampPanelRect(current ?? defaultPanelRect(), window.innerWidth, window.innerHeight));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [compactViewport, open]);

  const statusQuery = useQuery({
    queryKey: ["agent", "status"],
    queryFn: () => api<AgentStatus>("/api/agent/status"),
    enabled: open,
    refetchInterval: (query) => (query.state.data?.connected ? 30_000 : 5_000)
  });

  const modelCatalogQuery = useQuery({
    queryKey: ["agent", "models"],
    queryFn: () => api<AgentModelCatalog>("/api/agent/models"),
    enabled: open
  });

  const selectModelMutation = useMutation({
    mutationFn: (selection: { providerId: string; modelId: string }) =>
      api<AgentModelCatalog>("/api/agent/model", {
        method: "PUT",
        body: JSON.stringify(selection)
      }),
    onSuccess: (catalog) => {
      queryClient.setQueryData(["agent", "models"], catalog);
      void queryClient.invalidateQueries({ queryKey: ["agent", "status"] });
    }
  });

  const chatsQuery = useQuery({
    queryKey: ["agent", "chats", space?.id],
    queryFn: () =>
      api<{ chats: AgentChat[] }>(
        `/api/agent/spaces/${encodeURIComponent(space!.id)}/chats?includeArchived=true`
      ),
    enabled: open && Boolean(space)
  });

  const detailQuery = useQuery({
    queryKey: ["agent", "chat", space?.id, selectedChatId],
    queryFn: () =>
      api<ChatDetail>(
        `/api/agent/spaces/${encodeURIComponent(space!.id)}/chats/${encodeURIComponent(selectedChatId!)}`
      ),
    enabled: open && Boolean(space && selectedChatId)
  });

  const loginQuery = useQuery({
    queryKey: ["agent", "login", loginAttempt?.loginId],
    queryFn: () => api<{ login: AgentLogin }>(`/api/agent/logins/${encodeURIComponent(loginAttempt!.loginId)}`),
    enabled: Boolean(open && loginAttempt?.status === "pending"),
    refetchInterval: (query) => (query.state.data?.login.status === "pending" ? 2_000 : false)
  });

  const currentLogin = loginQuery.data?.login ?? loginAttempt;
  useEffect(() => {
    if (!loginQuery.data?.login) return;
    setLoginAttempt(loginQuery.data.login);
    if (loginQuery.data.login.status === "completed") {
      void queryClient.invalidateQueries({ queryKey: ["agent", "status"] });
      void queryClient.invalidateQueries({ queryKey: ["agent", "chats"] });
    }
  }, [loginQuery.data?.login, queryClient]);

  const connectMutation = useMutation({
    mutationFn: () => api<{ login: AgentLogin }>("/api/agent/login", { method: "POST", body: "{}" }),
    onSuccess: ({ login }) => {
      setLoginAttempt(login);
      const safeUrl = safeVerificationUrl(login.verificationUrl);
      if (safeUrl && loginWindowRef.current) {
        loginWindowRef.current.opener = null;
        loginWindowRef.current.location.href = safeUrl;
      } else loginWindowRef.current?.close();
      loginWindowRef.current = null;
    },
    onError: () => {
      loginWindowRef.current?.close();
      loginWindowRef.current = null;
    }
  });

  const logoutMutation = useMutation({
    mutationFn: () => api<void>("/api/agent/logout", { method: "POST", body: "{}" }),
    onSuccess: () => {
      setLoginAttempt(null);
      setProviderDisclosureAccepted(false);
      void queryClient.invalidateQueries({ queryKey: ["agent"] });
    }
  });

  const createChatMutation = useMutation({
    mutationFn: (spaceId: string) =>
      api<ChatDetail>(`/api/agent/spaces/${encodeURIComponent(spaceId)}/chats`, {
        method: "POST",
        body: "{}"
      }),
    onSuccess: (detail, requestedSpaceId) => {
      queryClient.setQueryData(["agent", "chat", requestedSpaceId, detail.chat.id], detail);
      if (currentSpaceIdRef.current === requestedSpaceId) setSelectedChatId(detail.chat.id);
      void queryClient.invalidateQueries({ queryKey: ["agent", "chats", requestedSpaceId] });
    }
  });

  const sendMessageMutation = useMutation({
    mutationFn: (request: { spaceId: string; chatId: string; message: string }) =>
      api<SendMessageResponse>(
        `/api/agent/spaces/${encodeURIComponent(request.spaceId)}/chats/${encodeURIComponent(request.chatId)}/messages`,
        { method: "POST", body: JSON.stringify({ message: request.message }) }
      ),
    onSuccess: (result, request) => {
      if (currentSpaceIdRef.current === request.spaceId && selectedChatIdRef.current === request.chatId) {
        setDraft("");
        setStreamError(null);
      }
      const key = ["agent", "chat", request.spaceId, request.chatId];
      queryClient.setQueryData<ChatDetail>(key, (current) =>
        current
          ? {
              chat: { ...current.chat, activeTurnId: result.turn.id, updatedAt: result.turn.createdAt },
              messages: [...current.messages, result.userMessage, result.assistantMessage]
            }
          : current
      );
      void queryClient.invalidateQueries({ queryKey: ["agent", "chats", request.spaceId] });
    }
  });

  const archiveMutation = useMutation({
    mutationFn: (request: { spaceId: string; chatId: string }) =>
      api<ChatDetail>(
        `/api/agent/spaces/${encodeURIComponent(request.spaceId)}/chats/${encodeURIComponent(request.chatId)}/archive`,
        { method: "POST", body: "{}" }
      ),
    onSuccess: (_detail, request) => {
      if (currentSpaceIdRef.current === request.spaceId && selectedChatIdRef.current === request.chatId) {
        setSelectedChatId(null);
      }
      void queryClient.invalidateQueries({ queryKey: ["agent", "chats", request.spaceId] });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (request: { spaceId: string; chatId: string }) =>
      api<void>(
        `/api/agent/spaces/${encodeURIComponent(request.spaceId)}/chats/${encodeURIComponent(request.chatId)}`,
        { method: "DELETE" }
      ),
    onSuccess: (_result, request) => {
      if (currentSpaceIdRef.current === request.spaceId && selectedChatIdRef.current === request.chatId) {
        setSelectedChatId(null);
      }
      void queryClient.invalidateQueries({ queryKey: ["agent", "chats", request.spaceId] });
    }
  });

  const interruptMutation = useMutation({
    mutationFn: (request: { spaceId: string; chatId: string; turnId: string }) =>
      api<void>(
        `/api/agent/spaces/${encodeURIComponent(request.spaceId)}/chats/${encodeURIComponent(request.chatId)}/turns/${encodeURIComponent(request.turnId)}/interrupt`,
        { method: "POST", body: "{}" }
      ),
    onSuccess: (_result, request) => refreshChat(queryClient, request.spaceId, request.chatId)
  });

  const activeTurnId = detailQuery.data?.chat.activeTurnId ?? null;
  useEffect(() => {
    if (!open || !activeTurnId || !space || !selectedChatId) return;
    const key = ["agent", "chat", space.id, selectedChatId];
    return subscribeToAgentTurnEvents(
      activeTurnId,
      (event) => handleTurnEvent(event, key, queryClient, setToolActivity, setStreamError),
      (error) => setStreamError(error.message)
    );
  }, [activeTurnId, open, queryClient, selectedChatId, space?.id]);

  const messageCount = detailQuery.data?.messages.length ?? 0;
  const lastMessageContent = detailQuery.data?.messages.at(-1)?.content;
  useEffect(() => {
    if (!messageCount && !lastMessageContent) return;
    requestAnimationFrame(() => {
      const element = messageListRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }, [lastMessageContent, messageCount, toolActivity]);

  const status = statusQuery.data;
  const chat = detailQuery.data?.chat;
  const canCreate = Boolean(status?.connected && space?.active_snapshot_id && !createChatMutation.isPending);
  const canSend = Boolean(
    chat?.continuable && status?.connected && !activeTurnId && draft.trim() && !sendMessageMutation.isPending
  );
  const groupedChats = useMemo(() => {
    const chats = chatsQuery.data?.chats ?? [];
    return {
      active: chats.filter((item) => item.status === "active"),
      archived: chats.filter((item) => item.status === "archived")
    };
  }, [chatsQuery.data?.chats]);

  function startLogin() {
    if (!providerDisclosureAccepted) return;
    try {
      loginWindowRef.current = window.open("about:blank", "memorepo-agent-authorization");
    } catch {
      loginWindowRef.current = null;
    }
    connectMutation.mutate();
  }

  function submitMessage() {
    const message = draft.trim();
    if (message && canSend && space && selectedChatId) {
      sendMessageMutation.mutate({ spaceId: space.id, chatId: selectedChatId, message });
    }
  }

  function confirmDelete() {
    if (!space || !selectedChatId) return;
    if (window.confirm("Delete this chat and its persistent transcript? This cannot be undone.")) {
      deleteMutation.mutate({ spaceId: space.id, chatId: selectedChatId });
    }
  }

  function selectProvider(providerId: string) {
    const provider = modelCatalogQuery.data?.providers.find((candidate) => candidate.id === providerId);
    const modelId = provider?.models[0]?.id;
    if (modelId) selectModelMutation.mutate({ providerId, modelId });
  }

  function startPanelInteraction(kind: "drag" | "resize", event: ReactPointerEvent<HTMLElement>) {
    if (compactViewport || event.button !== 0 || !panelRect) return;
    if (kind === "drag" && (event.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const start = panelRect;
    const startX = event.clientX;
    const startY = event.clientY;
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const next = kind === "drag"
        ? { ...start, left: start.left + dx, top: start.top + dy }
        : { left: start.left + dx, top: start.top, width: start.width - dx, height: start.height + dy };
      setPanelRect(clampPanelRect(next, window.innerWidth, window.innerHeight));
    };
    const onEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== event.pointerId) return;
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onEnd);
      target.removeEventListener("pointercancel", onEnd);
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onEnd);
    target.addEventListener("pointercancel", onEnd);
  }

  if (!space) return null;

  return (
    <>
      {!open ? (
        <button
          className="ask-space-launcher"
          type="button"
          onClick={() => onOpenChange(true)}
          aria-controls="ask-space-panel"
          aria-expanded="false"
        >
          <MessageSquareCode size={20} />
          <span>Ask this Space</span>
        </button>
      ) : null}

      {open ? (
        <aside
          id="ask-space-panel"
          className="ask-space-panel"
          aria-label={`Ask ${space.name}`}
          tabIndex={-1}
          ref={panelRef}
          style={!compactViewport && panelRect ? panelRectStyle(panelRect) : undefined}
        >
          <header className="ask-space-header" onPointerDown={(event) => startPanelInteraction("drag", event)}>
            <div className="ask-space-title">
              {selectedChatId ? (
                <button type="button" onClick={() => setSelectedChatId(null)} aria-label="Back to chat history">
                  <ArrowLeft size={18} />
                </button>
              ) : (
                <span className="ask-space-brand-icon" aria-hidden="true"><MessageSquareCode size={19} /></span>
              )}
              <div>
                <strong>Ask this Space</strong>
                <span>{space.name}</span>
              </div>
            </div>
            <button type="button" onClick={() => onOpenChange(false)} aria-label="Close Ask this Space">
              <X size={19} />
            </button>
          </header>

          {selectedChatId ? (
            <ChatView
              detail={detailQuery.data}
              loading={detailQuery.isPending}
              error={detailQuery.error}
              status={status}
              draft={draft}
              onDraftChange={setDraft}
              onSubmit={submitMessage}
              canSend={canSend}
              sending={sendMessageMutation.isPending}
              sendError={sendMessageMutation.error}
              toolActivity={toolActivity}
              streamError={streamError}
              messageListRef={messageListRef}
              onNewChat={() => createChatMutation.mutate(space.id)}
              creatingChat={createChatMutation.isPending}
              onArchive={() => archiveMutation.mutate({ spaceId: space.id, chatId: selectedChatId })}
              onDelete={confirmDelete}
              onInterrupt={() =>
                activeTurnId &&
                interruptMutation.mutate({ spaceId: space.id, chatId: selectedChatId, turnId: activeTurnId })
              }
              archiving={archiveMutation.isPending}
              deleting={deleteMutation.isPending}
              interrupting={interruptMutation.isPending}
            />
          ) : (
            <HistoryView
              status={status}
              statusLoading={statusQuery.isPending}
              statusError={statusQuery.error}
              onRetryStatus={() => void statusQuery.refetch()}
              onConnect={startLogin}
              disclosureAccepted={providerDisclosureAccepted}
              onDisclosureAcceptedChange={setProviderDisclosureAccepted}
              connecting={connectMutation.isPending}
              connectError={connectMutation.error}
              login={currentLogin}
              copiedCode={copiedCode}
              onCopyCode={async () => {
                if (!currentLogin?.userCode) return;
                try {
                  await navigator.clipboard.writeText(currentLogin.userCode);
                  setCopiedCode(true);
                  window.setTimeout(() => setCopiedCode(false), 1_500);
                } catch {
                  setCopiedCode(false);
                }
              }}
              onOpenVerification={() => openVerification(currentLogin?.verificationUrl)}
              onLogout={() => logoutMutation.mutate()}
              loggingOut={logoutMutation.isPending}
              chats={groupedChats}
              chatsLoading={chatsQuery.isPending}
              chatsError={chatsQuery.error}
              onRetryChats={() => void chatsQuery.refetch()}
              onSelectChat={setSelectedChatId}
              onNewChat={() => createChatMutation.mutate(space.id)}
              canCreate={canCreate}
              creatingChat={createChatMutation.isPending}
              createError={createChatMutation.error}
              hasSnapshot={Boolean(space.active_snapshot_id)}
              modelCatalog={modelCatalogQuery.data}
              modelCatalogLoading={modelCatalogQuery.isPending}
              modelSelectionError={selectModelMutation.error ?? modelCatalogQuery.error}
              modelSelectionPending={selectModelMutation.isPending}
              onSelectProvider={selectProvider}
              onSelectModel={(modelId) => {
                const providerId = modelCatalogQuery.data?.selected.providerId;
                if (providerId) selectModelMutation.mutate({ providerId, modelId });
              }}
            />
          )}
          {!compactViewport ? (
            <button
              className="ask-space-resize-handle"
              type="button"
              aria-label="Resize Ask this Space"
              title="Drag to resize"
              onPointerDown={(event) => startPanelInteraction("resize", event)}
            >
              <MoveDiagonal2 size={15} />
            </button>
          ) : null}
        </aside>
      ) : null}
    </>
  );
}

function HistoryView(props: {
  status: AgentStatus | undefined;
  statusLoading: boolean;
  statusError: Error | null;
  onRetryStatus: () => void;
  onConnect: () => void;
  disclosureAccepted: boolean;
  onDisclosureAcceptedChange: (accepted: boolean) => void;
  connecting: boolean;
  connectError: Error | null;
  login: AgentLogin | null;
  copiedCode: boolean;
  onCopyCode: () => void;
  onOpenVerification: () => void;
  onLogout: () => void;
  loggingOut: boolean;
  chats: { active: AgentChat[]; archived: AgentChat[] };
  chatsLoading: boolean;
  chatsError: Error | null;
  onRetryChats: () => void;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  canCreate: boolean;
  creatingChat: boolean;
  createError: Error | null;
  hasSnapshot: boolean;
  modelCatalog: AgentModelCatalog | undefined;
  modelCatalogLoading: boolean;
  modelSelectionError: Error | null;
  modelSelectionPending: boolean;
  onSelectProvider: (providerId: string) => void;
  onSelectModel: (modelId: string) => void;
}) {
  return (
    <div className="ask-space-history">
      <AgentStatusCard {...props} />
      <ModelSelector {...props} />

      <div className="ask-space-history-heading">
        <div>
          <h2>Chats</h2>
          <p>Persistent and pinned to the snapshot where each chat started.</p>
        </div>
        <button className="ask-space-new-button" type="button" onClick={props.onNewChat} disabled={!props.canCreate}>
          {props.creatingChat ? <Loader2 className="spin" size={17} /> : <Plus size={17} />}
          <span>New</span>
        </button>
      </div>

      {!props.hasSnapshot ? (
        <PanelNotice icon={<Database size={17} />} text="Build an active snapshot before starting a chat." />
      ) : null}
      {props.createError ? <PanelError error={props.createError} /> : null}

      {props.chatsLoading ? (
        <PanelLoading label="Loading chats…" />
      ) : props.chatsError ? (
        <PanelError error={props.chatsError} action="Retry" onAction={props.onRetryChats} />
      ) : props.chats.active.length + props.chats.archived.length === 0 ? (
        <div className="ask-space-empty">
          <Bot size={30} />
          <strong>No chats yet</strong>
          <p>Start a read-only conversation about the current Space snapshot.</p>
        </div>
      ) : (
        <div className="ask-space-conversation-groups">
          <ChatGroup
            label="Recent"
            chats={props.chats.active}
            onSelect={props.onSelectChat}
          />
          <ChatGroup
            label="Archived"
            chats={props.chats.archived}
            onSelect={props.onSelectChat}
          />
        </div>
      )}
    </div>
  );
}

function ModelSelector(props: Parameters<typeof HistoryView>[0]) {
  const catalog = props.modelCatalog;
  const selectedProvider = catalog?.providers.find((provider) => provider.id === catalog.selected.providerId);
  if (props.modelCatalogLoading) return <PanelLoading label="Loading agent models…" compact />;
  if (!catalog?.providers.length) {
    return props.modelSelectionError ? <PanelError error={props.modelSelectionError} /> : null;
  }
  return (
    <section className="ask-space-model-selector" aria-label="Agent model selection">
      <label>
        <span>Provider</span>
        <select
          value={catalog.selected.providerId}
          onChange={(event) => props.onSelectProvider(event.target.value)}
          disabled={props.modelSelectionPending}
        >
          {!selectedProvider ? <option value="">Select provider</option> : null}
          {catalog.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select>
      </label>
      <label>
        <span>Model</span>
        <select
          value={catalog.selected.modelId}
          onChange={(event) => props.onSelectModel(event.target.value)}
          disabled={props.modelSelectionPending || !selectedProvider}
        >
          {selectedProvider?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      {props.modelSelectionError ? <PanelError error={props.modelSelectionError} /> : null}
    </section>
  );
}

function AgentStatusCard(props: Parameters<typeof HistoryView>[0]) {
  const status = props.status;
  const providerName = status?.providerName?.trim() || "Agent provider";
  if (props.statusLoading) return <PanelLoading label="Checking agent…" compact />;
  if (props.statusError) return <PanelError error={props.statusError} action="Retry" onAction={props.onRetryStatus} />;
  if (!status?.available) {
    return (
      <section className="ask-space-account unavailable">
        <AlertTriangle size={19} />
        <div>
          <strong>{providerName} unavailable</strong>
          <p>{status?.message ?? "MemoRepo could not reach the configured agent runtime."}</p>
        </div>
        <button type="button" onClick={props.onRetryStatus}>Retry</button>
      </section>
    );
  }
  if (status.connected) {
    return (
      <section className="ask-space-account connected">
        <span className="ask-space-account-mark"><Check size={15} /></span>
        <div>
          <strong>{providerName} connected</strong>
          <p>{status.modelName ?? status.modelId ?? status.message ?? "Ready to ask this Space"}</p>
        </div>
        <button type="button" onClick={props.onLogout} disabled={props.loggingOut} aria-label={`Disconnect ${providerName}`}>
          {props.loggingOut ? <Loader2 className="spin" size={16} /> : <LogOut size={16} />}
        </button>
      </section>
    );
  }

  return (
    <section className="ask-space-connect-card">
      <div className="ask-space-connect-copy">
        <span><Bot size={20} /></span>
        <div>
          <strong>Connect {providerName}</strong>
          <p>{status.message ?? `Authenticate with ${providerName} to ask this Space.`}</p>
        </div>
      </div>
      <label className="ask-space-provider-consent">
        <input
          type="checkbox"
          checked={props.disclosureAccepted}
          onChange={(event) => props.onDisclosureAcceptedChange(event.target.checked)}
          disabled={props.connecting || props.login?.status === "pending"}
        />
        <span>
          I agree to send my questions, chat history, snapshot query results, and relevant code excerpts to {providerName}{" "}
          for inference. Repository-access credentials and the MemoRepo control token are not included in prompt or
          tool payloads.
        </span>
      </label>
      {props.login?.status === "pending" ? (
        <div className="ask-space-device-login" role="status">
          {props.login.instructions ? <span>{props.login.instructions}</span> : null}
          {props.login.userCode ? (
            <div>
              <code>{props.login.userCode}</code>
              <button type="button" onClick={props.onCopyCode} aria-label="Copy login code">
                {props.copiedCode ? <Check size={16} /> : <Clipboard size={16} />}
              </button>
            </div>
          ) : null}
          {safeVerificationUrl(props.login.verificationUrl) ? (
            <button className="ask-space-connect-button" type="button" onClick={props.onOpenVerification}>
              <ExternalLink size={16} />
              <span>Open sign-in</span>
            </button>
          ) : null}
          <small>Waiting for authorization…</small>
        </div>
      ) : (
        <button
          className="ask-space-connect-button"
          type="button"
          onClick={props.onConnect}
          disabled={props.connecting || !props.disclosureAccepted}
        >
          {props.connecting ? <Loader2 className="spin" size={17} /> : <ExternalLink size={17} />}
          <span>Connect {providerName}</span>
        </button>
      )}
      {props.login?.status === "failed" ? <PanelError error={new Error(props.login.error ?? "Sign-in failed")} /> : null}
      {props.connectError ? <PanelError error={props.connectError} /> : null}
    </section>
  );
}

function ChatGroup(props: {
  label: string;
  chats: AgentChat[];
  onSelect: (id: string) => void;
}) {
  if (props.chats.length === 0) return null;
  return (
    <section className="ask-space-conversation-group">
      <h3>{props.label}</h3>
      {props.chats.map((chat) => (
        <button key={chat.id} type="button" onClick={() => props.onSelect(chat.id)}>
          <span className="ask-space-conversation-icon"><History size={16} /></span>
          <span className="ask-space-conversation-copy">
            <strong>{chat.title}</strong>
            <small>
              Snapshot v{chat.snapshot.version} · {formatDate(chat.updatedAt)}
            </small>
          </span>
          {chat.activeTurnId ? <Loader2 className="spin" size={15} aria-label="Answer in progress" /> : null}
        </button>
      ))}
    </section>
  );
}

function ChatView(props: {
  detail: ChatDetail | undefined;
  loading: boolean;
  error: Error | null;
  status: AgentStatus | undefined;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  canSend: boolean;
  sending: boolean;
  sendError: Error | null;
  toolActivity: string | null;
  streamError: string | null;
  messageListRef: React.RefObject<HTMLDivElement | null>;
  onNewChat: () => void;
  creatingChat: boolean;
  onArchive: () => void;
  onDelete: () => void;
  onInterrupt: () => void;
  archiving: boolean;
  deleting: boolean;
  interrupting: boolean;
}) {
  if (props.loading) return <PanelLoading label="Loading transcript…" />;
  if (props.error || !props.detail) return <PanelError error={props.error ?? new Error("Chat could not be loaded")} />;
  const { chat, messages } = props.detail;
  const running = Boolean(chat.activeTurnId);
  const newerSnapshot = !chat.usesLatestSnapshot && chat.activeSnapshot;

  return (
    <div className="ask-space-conversation">
      <div className="ask-space-conversation-bar">
        <div>
          <strong>{chat.title}</strong>
          <span><Database size={13} /> Snapshot v{chat.snapshot.version}</span>
        </div>
        <div className="ask-space-conversation-actions">
          {chat.status === "active" ? (
            <button type="button" onClick={props.onArchive} disabled={props.archiving || running} aria-label="Archive chat">
              {props.archiving ? <Loader2 className="spin" size={16} /> : <Archive size={16} />}
            </button>
          ) : null}
          <button type="button" onClick={props.onDelete} disabled={props.deleting || running} aria-label="Delete chat">
            {props.deleting ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
          </button>
        </div>
      </div>

      {newerSnapshot ? (
        <div className="ask-space-snapshot-notice">
          <div>
            <Database size={17} />
            <span>A newer snapshot (v{newerSnapshot.version}) is active.</span>
          </div>
          <button type="button" onClick={props.onNewChat} disabled={!props.status?.connected || props.creatingChat}>
            {props.creatingChat ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
            New chat
          </button>
        </div>
      ) : null}

      <div className="ask-space-messages" ref={props.messageListRef} aria-live="polite">
        {messages.length === 0 ? (
          <div className="ask-space-empty conversation-empty">
            <Bot size={29} />
            <strong>Ask about this snapshot</strong>
            <p>Architecture, flows, symbols, dependencies, or where behavior is implemented.</p>
          </div>
        ) : (
          messages.map((message) => <ChatMessage key={message.id} message={message} />)
        )}
        {props.toolActivity ? (
          <div className="ask-space-tool-activity" role="status">
            <Loader2 className="spin" size={15} />
            <span>{props.toolActivity}</span>
          </div>
        ) : null}
      </div>

      {props.streamError ? <div className="ask-space-stream-error">{props.streamError}</div> : null}
      {props.sendError ? <PanelError error={props.sendError} /> : null}

      {chat.continuable && props.status?.connected ? (
        <div className="ask-space-composer">
          <textarea
            value={props.draft}
            onChange={(event) => props.onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                props.onSubmit();
              }
            }}
            placeholder="Ask about this Space…"
            rows={2}
            maxLength={16_000}
            disabled={running}
            aria-label="Message to agent"
          />
          {running ? (
            <button type="button" onClick={props.onInterrupt} disabled={props.interrupting} aria-label="Stop answer">
              {props.interrupting ? <Loader2 className="spin" size={17} /> : <Square size={16} fill="currentColor" />}
            </button>
          ) : (
            <button type="button" onClick={props.onSubmit} disabled={!props.canSend} aria-label="Send message">
              {props.sending ? <Loader2 className="spin" size={17} /> : <Send size={17} />}
            </button>
          )}
          <small>Read-only · pinned to snapshot v{chat.snapshot.version}</small>
        </div>
      ) : (
        <div className="ask-space-readonly-note">
          <AlertTriangle size={17} />
          <div>
            <strong>Read-only transcript</strong>
            <span>{chat.continuationReason ?? "Connect the agent provider to continue."}</span>
          </div>
          {props.status?.connected && chat.activeSnapshot ? (
            <button type="button" onClick={props.onNewChat} disabled={props.creatingChat}>New chat</button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ChatMessage({ message }: { message: AgentMessage }) {
  return (
    <article className={`ask-space-message ${message.role}`}>
      <header>
        <span>{message.role === "user" ? "You" : "Assistant"}</span>
        {message.status === "running" || message.status === "pending" ? <Loader2 className="spin" size={13} /> : null}
      </header>
      {message.content ? (
        <div className="ask-space-message-content">
          {message.role === "assistant" ? <AgentMarkdown content={message.content} /> : message.content}
        </div>
      ) : null}
      {message.error ? <div className="ask-space-message-error">{message.error}</div> : null}
      {message.sources.length > 0 ? <SourceList sources={message.sources} /> : null}
      {message.status === "interrupted" ? <small>Answer stopped</small> : null}
    </article>
  );
}

function SourceList({ sources }: { sources: AgentSource[] }) {
  return (
    <details className="ask-space-sources">
      <summary>{sources.length} {sources.length === 1 ? "source" : "sources"} consulted</summary>
      <ul>
        {sources.map((source, index) => (
          <li key={`${source.tool}-${source.path ?? source.symbol ?? index}`}>
            <strong>{source.repository ?? source.project ?? "Space index"}</strong>
            <span>{[source.path, source.symbol].filter(Boolean).join(" · ") || friendlyTool(source.tool)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function PanelLoading({ label, compact = false }: { label: string; compact?: boolean }) {
  return <div className={`ask-space-panel-loading${compact ? " compact" : ""}`}><Loader2 className="spin" size={18} /><span>{label}</span></div>;
}

function PanelNotice({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="ask-space-panel-notice">{icon}<span>{text}</span></div>;
}

function PanelError({ error, action, onAction }: { error: unknown; action?: string; onAction?: () => void }) {
  return (
    <div className="ask-space-panel-error" role="alert">
      <AlertTriangle size={16} />
      <span>{error instanceof Error ? error.message : "Something went wrong"}</span>
      {action && onAction ? <button type="button" onClick={onAction}>{action}</button> : null}
    </div>
  );
}

function handleTurnEvent(
  event: AgentTurnEvent,
  key: unknown[],
  queryClient: ReturnType<typeof useQueryClient>,
  setToolActivity: (value: string | null) => void,
  setStreamError: (value: string | null) => void
) {
  setStreamError(null);
  if (event.type === "state") {
    queryClient.setQueryData<ChatDetail>(key, (current) =>
      current
        ? {
            ...current,
            chat: { ...current.chat, activeTurnId: isActiveTurn(event.turn) ? event.turn.id : null },
            messages: current.messages.map((message) =>
              message.id === event.assistantMessage.id ? event.assistantMessage : message
            )
          }
        : current
    );
    return;
  }
  if (event.type === "assistant.delta") {
    queryClient.setQueryData<ChatDetail>(key, (current) =>
      current
        ? {
            ...current,
            messages: current.messages.map((message) =>
              message.id === event.messageId
                ? { ...message, status: "running", content: applyAgentDelta(message.content, event.offset, event.delta) }
                : message
            )
          }
        : current
    );
    return;
  }
  if (event.type === "tool.started") {
    setToolActivity(friendlyToolActivity(event.tool));
    return;
  }
  if (event.type === "tool.completed") {
    setToolActivity(null);
    return;
  }
  setToolActivity(null);
  queryClient.setQueryData<ChatDetail>(key, (current) =>
    current ? { ...current, chat: { ...current.chat, activeTurnId: null } } : current
  );
  void queryClient.invalidateQueries({ queryKey: key });
  void queryClient.invalidateQueries({ queryKey: ["agent", "chats"] });
}

function applyAgentDelta(content: string, offset: number, delta: string): string {
  if (content.length <= offset) return `${content}${delta.slice(Math.max(0, content.length - offset))}`;
  const consumed = content.length - offset;
  return consumed >= delta.length ? content : `${content}${delta.slice(consumed)}`;
}

function isActiveTurn(turn: AgentTurn): boolean {
  return turn.status === "pending" || turn.status === "running";
}

function friendlyToolActivity(tool: string): string {
  if (tool.includes("search")) return "Searching the snapshot…";
  if (tool.includes("architecture")) return "Reading the architecture map…";
  if (tool.includes("depend")) return "Tracing dependencies…";
  if (tool.includes("call") || tool.includes("trace")) return "Following the call graph…";
  if (tool.includes("snippet") || tool.includes("code")) return "Reading indexed code…";
  return "Consulting the Space index…";
}

function friendlyTool(tool: string): string {
  return tool.replaceAll("_", " ");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function safeVerificationUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function openVerification(value: string | null | undefined) {
  if (!value) return;
  const url = safeVerificationUrl(value);
  if (url) window.open(url, "memorepo-agent-authorization", "noopener,noreferrer");
}

function refreshChat(
  queryClient: ReturnType<typeof useQueryClient>,
  spaceId: string,
  chatId: string
) {
  void queryClient.invalidateQueries({ queryKey: ["agent", "chat", spaceId, chatId] });
  void queryClient.invalidateQueries({ queryKey: ["agent", "chats", spaceId] });
}

function defaultPanelRect(): PanelRect {
  const availableWidth = Math.max(1, window.innerWidth - PANEL_MARGIN * 2);
  const availableHeight = Math.max(1, window.innerHeight - PANEL_MARGIN * 2);
  const width = Math.min(PANEL_DEFAULT_WIDTH, availableWidth);
  return {
    left: window.innerWidth - PANEL_MARGIN - width,
    top: PANEL_MARGIN,
    width,
    height: availableHeight
  };
}

function compactViewportMatches(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 700px)").matches;
}

function clampPanelRect(rect: PanelRect, viewportWidth: number, viewportHeight: number): PanelRect {
  const availableWidth = Math.max(1, viewportWidth - PANEL_MARGIN * 2);
  const availableHeight = Math.max(1, viewportHeight - PANEL_MARGIN * 2);
  const width = Math.min(Math.max(Math.min(PANEL_MIN_WIDTH, availableWidth), rect.width), availableWidth);
  const height = Math.min(Math.max(Math.min(PANEL_MIN_HEIGHT, availableHeight), rect.height), availableHeight);
  return {
    left: Math.min(Math.max(PANEL_MARGIN, rect.left), viewportWidth - PANEL_MARGIN - width),
    top: Math.min(Math.max(PANEL_MARGIN, rect.top), viewportHeight - PANEL_MARGIN - height),
    width,
    height
  };
}

function panelRectStyle(rect: PanelRect): CSSProperties {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: "auto", bottom: "auto" };
}
