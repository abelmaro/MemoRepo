import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Github, Loader2, LogOut, RefreshCw } from "lucide-react";
import {
  api,
  type GitHubConnectionStatus,
  type GitHubDeviceAuthorizationStart,
  type GitHubDeviceAuthorizationStatus,
  type GitHubDiagnostics
} from "../lib/api";
import { Modal } from "./Modal";
import { QueryErrorState } from "./QueryErrorState";

export interface GitHubSignInRequest {
  id: number;
  authorizationWindow: Window | null;
}

interface GitHubConnectionPanelProps {
  signInRequest?: GitHubSignInRequest | null;
  onSignInRequestHandled?: () => void;
}

export function GitHubConnectionPanel({ signInRequest, onSignInRequestHandled }: GitHubConnectionPanelProps = {}) {
  const queryClient = useQueryClient();
  const [authorization, setAuthorization] = useState<GitHubDeviceAuthorizationStart | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [automaticOpenFailed, setAutomaticOpenFailed] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const completedAttempt = useRef<string | null>(null);
  const authorizationWindow = useRef<Window | null>(null);
  const handledSignInRequest = useRef<number | null>(null);

  const connectionQuery = useQuery({
    queryKey: ["github-auth-status"],
    queryFn: () => api<GitHubConnectionStatus>("/api/github/auth/status")
  });

  const diagnosticsQuery = useQuery({
    queryKey: ["github-diagnostics"],
    queryFn: () => api<GitHubDiagnostics>("/api/github/diagnostics"),
    enabled: connectionQuery.data?.connected === true,
    staleTime: 60_000
  });

  const attemptQuery = useQuery({
    queryKey: ["github-auth-attempt", authorization?.attemptId],
    queryFn: () =>
      api<GitHubDeviceAuthorizationStatus>(`/api/github/auth/device/${encodeURIComponent(authorization!.attemptId)}`),
    enabled: Boolean(authorization),
    refetchInterval: (query) =>
      query.state.data?.status === "pending" || query.state.data === undefined
        ? Math.max(1_000, (authorization?.intervalSeconds ?? 5) * 1_000)
        : false
  });

  const connectMutation = useMutation({
    mutationFn: () =>
      api<GitHubDeviceAuthorizationStart>("/api/github/auth/device", {
        method: "POST",
        body: "{}"
      }),
    onSuccess: (started) => {
      completedAttempt.current = null;
      setCopied(false);
      setFeedback(null);
      setAuthorization(started);
      const openedWindow = authorizationWindow.current;
      if (openedWindow && !openedWindow.closed) {
        try {
          openedWindow.opener = null;
          openedWindow.location.replace(started.verificationUri);
          setAutomaticOpenFailed(false);
        } catch {
          closeAuthorizationWindow();
          setAutomaticOpenFailed(true);
        }
      } else {
        setAutomaticOpenFailed(true);
      }

      if (navigator.clipboard) {
        void navigator.clipboard.writeText(started.userCode).then(
          () => setCopied(true),
          () => setCopied(false)
        );
      }
    },
    onError: () => {
      closeAuthorizationWindow();
    }
  });

  const disconnectMutation = useMutation({
    mutationFn: () => api<void>("/api/github/auth", { method: "DELETE" }),
    onSuccess: () => {
      setDisconnectOpen(false);
      setFeedback("GitHub was disconnected from this MemoRepo installation.");
      queryClient.removeQueries({ queryKey: ["github-diagnostics"] });
      void refreshGitHubState(queryClient);
    }
  });

  const attemptStatus = attemptQuery.data;

  useEffect(() => {
    return () => closeAuthorizationWindow();
  }, []);

  useEffect(() => {
    if (!signInRequest || handledSignInRequest.current === signInRequest.id) {
      return;
    }

    handledSignInRequest.current = signInRequest.id;
    beginAuthorization(signInRequest.authorizationWindow);
    onSignInRequestHandled?.();
  }, [signInRequest, onSignInRequestHandled]);

  useEffect(() => {
    if (
      !authorization ||
      attemptStatus?.status !== "connected" ||
      completedAttempt.current === authorization.attemptId
    ) {
      return;
    }

    completedAttempt.current = authorization.attemptId;
    let active = true;
    void api("/api/github/sync", { method: "POST", body: "{}" })
      .then(() => {
        if (active) {
          setFeedback(`Connected as ${attemptStatus.viewer.login}. Repository sync was queued.`);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setFeedback(
            `Connected as ${attemptStatus.viewer.login}, but repository sync could not start: ${errorMessage(error)}`
          );
        }
      })
      .finally(() => {
        if (active) {
          closeAuthorizationWindow();
          setAuthorization(null);
          void refreshGitHubState(queryClient);
        }
      });

    return () => {
      active = false;
    };
  }, [attemptStatus, authorization, queryClient]);

  async function copyUserCode() {
    if (!authorization) {
      return;
    }
    try {
      await navigator.clipboard.writeText(authorization.userCode);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function cancelAuthorization() {
    const attemptId = authorization?.attemptId;
    closeAuthorizationWindow();
    setAuthorization(null);
    if (attemptId && (!attemptStatus || attemptStatus.status === "pending")) {
      void api(`/api/github/auth/device/${encodeURIComponent(attemptId)}`, { method: "DELETE" }).catch(() => undefined);
    }
  }

  function restartAuthorization() {
    setAuthorization(null);
    startAuthorization();
  }

  function startAuthorization() {
    let openedWindow: Window | null = null;
    try {
      openedWindow = window.open("about:blank", "memorepo-github-authorization");
    } catch {
      openedWindow = null;
    }
    beginAuthorization(openedWindow);
  }

  function beginAuthorization(openedWindow: Window | null) {
    setAutomaticOpenFailed(false);
    closeAuthorizationWindow();
    authorizationWindow.current = openedWindow;
    connectMutation.mutate();
  }

  function closeAuthorizationWindow() {
    const openedWindow = authorizationWindow.current;
    authorizationWindow.current = null;
    if (openedWindow && !openedWindow.closed) {
      try {
        openedWindow.close();
      } catch {
        // The manual GitHub link remains available if the browser refuses window control.
      }
    }
  }

  const connection = connectionQuery.data;
  const connected = connection?.connected === true;
  const connectedAccount = connected && connection.viewer;
  const usesEnvironmentToken = connection?.authenticationMode === "token";

  return (
    <>
      <section className="github-connection-panel management-panel" aria-labelledby="github-connection-title">
        <div className="github-connection-header">
          <div className="panel-heading with-icon">
            <Github size={20} />
            <div>
              <h3 id="github-connection-title">GitHub connection</h3>
              <span>{connectionSummary(connection, connectionQuery.isPending)}</span>
            </div>
          </div>
          {usesEnvironmentToken ? null : connectedAccount ? (
            <button className="secondary-button compact-button danger" type="button" onClick={() => setDisconnectOpen(true)}>
              <LogOut size={16} />
              <span>Disconnect</span>
            </button>
          ) : (
            <button
              className="primary-button compact-button"
              type="button"
              onClick={startAuthorization}
              disabled={connectMutation.isPending || connectionQuery.isPending}
            >
              {connectMutation.isPending ? <Loader2 className="spin" size={16} /> : <Github size={16} />}
              <span>{connectMutation.isPending ? "Opening GitHub…" : "Sign in with GitHub"}</span>
            </button>
          )}
        </div>

        {connectionQuery.isError ? (
          <QueryErrorState
            title="GitHub connection status could not be loaded"
            error={connectionQuery.error}
            onRetry={() => void connectionQuery.refetch()}
          />
        ) : null}

        {usesEnvironmentToken ? (
          <div className="diagnostics-warning" role="status">
            <strong>GH_TOKEN configured</strong>
            <span>MemoRepo is using the token from the environment; OAuth sign-in is not required.</span>
          </div>
        ) : connectedAccount ? (
          <div className="github-account-card">
            <img src={connection.viewer!.avatarUrl} alt="" />
            <div>
              <strong>{connection.viewer!.name || connection.viewer!.login}</strong>
              <span>@{connection.viewer!.login}</span>
            </div>
            <div className="github-account-metrics">
              <span>
                <strong>{diagnosticsQuery.data?.visibleRepositoryCount ?? "—"}</strong> repositories
              </span>
              <span>
                <strong>{diagnosticsQuery.data?.visibleOrganizationCount ?? "—"}</strong> organizations
              </span>
              <span>
                <strong>{formatScopes(connection.scopes)}</strong> scope
              </span>
            </div>
          </div>
        ) : (
          <p className="github-connection-copy">
            Authorize MemoRepo directly in GitHub without storing a manually generated credential in your environment.
          </p>
        )}

        {diagnosticsQuery.isError && connected ? (
          <QueryErrorState
            title="GitHub access could not be checked"
            error={diagnosticsQuery.error}
            onRetry={() => void diagnosticsQuery.refetch()}
          />
        ) : null}

        {connectMutation.error ? <div className="inline-alert error">{errorMessage(connectMutation.error)}</div> : null}
        {disconnectMutation.error ? <div className="inline-alert error">{errorMessage(disconnectMutation.error)}</div> : null}
        {feedback ? <div className="inline-alert" role="status">{feedback}</div> : null}

        {connectedAccount && connection.manageAuthorizationUrl ? (
          <a
            className="text-button with-icon github-manage-link"
            href={connection.manageAuthorizationUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={15} />
            <span>Manage authorization on GitHub</span>
          </a>
        ) : null}
      </section>

      {authorization ? (
        <Modal title="Sign in with GitHub" onClose={cancelAuthorization}>
          <div className="github-device-flow">
            <div>
              <p className="modal-eyebrow">Secure device authorization</p>
              <p>
                Enter this one-time code on GitHub. MemoRepo never receives your password.
              </p>
            </div>
            <div className="github-device-code" aria-label={`GitHub device code ${authorization.userCode}`}>
              <code>{authorization.userCode}</code>
              <button className="secondary-button compact-button" type="button" onClick={() => void copyUserCode()}>
                {copied ? <Check size={16} /> : <Copy size={16} />}
                <span>{copied ? "Copied" : "Copy code"}</span>
              </button>
            </div>
            {automaticOpenFailed ? (
              <div className="inline-alert" role="status">
                Your browser did not open GitHub automatically. Use the button below to continue.
              </div>
            ) : null}
            <a
              className="primary-button github-device-link"
              href={authorization.verificationUri}
              target="_blank"
              rel="noreferrer"
              data-modal-autofocus
            >
              <ExternalLink size={17} />
              <span>Continue on GitHub</span>
            </a>
            <div className="github-device-status" aria-live="polite">
              {attemptQuery.isError ? (
                <div className="inline-alert error">{errorMessage(attemptQuery.error)}</div>
              ) : attemptStatus?.status === "pending" || !attemptStatus ? (
                <>
                  <Loader2 className="spin" size={18} />
                  <span>Waiting for GitHub authorization…</span>
                </>
              ) : attemptStatus.status === "connected" ? (
                <>
                  <Check size={18} />
                  <span>Connected. Starting repository sync…</span>
                </>
              ) : (
                <div className="inline-alert error">
                  <span>{attemptStatus.error}</span>
                  <button className="secondary-button compact-button" type="button" onClick={restartAuthorization}>
                    <RefreshCw size={15} />
                    <span>Try again</span>
                  </button>
                </div>
              )}
            </div>
            <small>Code expires {formatExpiry(authorization.expiresAt)}.</small>
          </div>
        </Modal>
      ) : null}

      {disconnectOpen && connectedAccount ? (
        <Modal title="Disconnect GitHub" onClose={() => !disconnectMutation.isPending && setDisconnectOpen(false)}>
          <div className="confirmation-dialog">
            <p>
              Disconnect <strong>@{connection.viewer!.login}</strong> from this installation? Existing clones, indexes, and
              snapshots will remain available locally.
            </p>
            <p className="github-disconnect-note">
              This removes the local credential. To revoke the OAuth authorization itself, use GitHub account settings.
            </p>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setDisconnectOpen(false)}
                disabled={disconnectMutation.isPending}
              >
                Cancel
              </button>
              <button
                className="secondary-button danger"
                type="button"
                onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending}
              >
                {disconnectMutation.isPending ? <Loader2 className="spin" size={17} /> : <LogOut size={17} />}
                <span>Disconnect locally</span>
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function connectionSummary(connection: GitHubConnectionStatus | undefined, pending: boolean): string {
  if (pending) return "Checking connection…";
  if (!connection) return "Connection unavailable";
  if (connection.authenticationMode === "token") return "Connected with GH_TOKEN";
  if (!connection.connected) return "Not connected";
  return `Connected as @${connection.viewer?.login ?? "unknown"}`;
}

function formatScopes(scopes: string[] | undefined): string {
  return scopes?.length ? scopes.join(", ") : "not reported";
}

function formatExpiry(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function refreshGitHubState(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["github-auth-status"] }),
    queryClient.invalidateQueries({ queryKey: ["github-diagnostics"] }),
    queryClient.invalidateQueries({ queryKey: ["system"] }),
    queryClient.invalidateQueries({ queryKey: ["preflight"] }),
    queryClient.invalidateQueries({ queryKey: ["jobs"] })
  ]);
}
