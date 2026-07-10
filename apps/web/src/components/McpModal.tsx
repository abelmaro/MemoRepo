import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clipboard, Download, GitBranch, Loader2, Trash2 } from "lucide-react";
import { api, mcpJsonRpc, type McpConnection, type McpToolsListResult, type Space } from "../lib/api";
import { Modal } from "./Modal";
import { StatusBadge } from "./StatusBadge";

interface McpConnectionTestResult {
  status: "success" | "error";
  message: string;
  detail?: string;
}

export function McpModal({ space, onClose }: { space: Space; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [client, setClient] = useState("generic");
  const [connectionName, setConnectionName] = useState("My agent");
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [connectionToken, setConnectionToken] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<McpConnectionTestResult | null>(null);
  const [deletingConnectionId, setDeletingConnectionId] = useState<string | null>(null);
  const [connectionToDelete, setConnectionToDelete] = useState<McpConnection | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const connectionsQuery = useQuery({
    queryKey: ["mcp-connections", space.id],
    queryFn: () => api<{ connections: McpConnection[] }>(`/api/spaces/${space.id}/mcp-connections`),
    refetchInterval: 5000
  });
  const mutation = useMutation({
    mutationFn: () =>
      api<{ token: string; configs: Record<string, unknown> }>(`/api/spaces/${space.id}/mcp-connections`, {
        method: "POST",
        body: JSON.stringify({ name: connectionName.trim(), client })
      }),
    onSuccess: (data) => {
      setConfig(data.configs);
      setConnectionToken(data.token);
      setCopyState(null);
      setTestResult(null);
      void queryClient.invalidateQueries({ queryKey: ["mcp-connections", space.id] });
      void queryClient.invalidateQueries({ queryKey: ["space", space.id] });
    }
  });
  const testMutation = useMutation({
    mutationFn: async () => {
      if (!connectionToken) {
        throw new Error("Create a read-only token first.");
      }

      await mcpJsonRpc(space.slug, connectionToken, {
        jsonrpc: "2.0",
        id: "dashboard-init",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "memorepo-dashboard", version: "0.1.2" }
        }
      });

      const response = await mcpJsonRpc<McpToolsListResult>(space.slug, connectionToken, {
        jsonrpc: "2.0",
        id: "dashboard-tools",
        method: "tools/list"
      });

      return response.result?.tools ?? [];
    },
    onSuccess: (tools) => {
      setTestResult({
        status: "success",
        message: `Connected. ${tools.length} tools available.`,
        detail: tools.map((tool) => tool.name).join(", ")
      });
      void queryClient.invalidateQueries({ queryKey: ["mcp-connections", space.id] });
    },
    onError: (error) => {
      setTestResult({
        status: "error",
        message: error instanceof Error ? error.message : "MCP connection test failed."
      });
    }
  });
  const deleteConnectionMutation = useMutation({
    mutationFn: (connectionId: string) => api(`/api/mcp-connections/${connectionId}`, { method: "DELETE" }),
    onMutate: (connectionId) => {
      setDeletingConnectionId(connectionId);
    },
    onSuccess: () => {
      setConnectionToDelete(null);
      setDeleteError(null);
      void queryClient.invalidateQueries({ queryKey: ["mcp-connections", space.id] });
      void queryClient.invalidateQueries({ queryKey: ["space", space.id] });
    },
    onError: (error) => {
      setDeleteError(error instanceof Error ? error.message : "MCP connection could not be deleted");
    },
    onSettled: () => {
      setDeletingConnectionId(null);
    }
  });

  const selectedConfig = config ? config[client] ?? config.generic : null;
  const connections = connectionsQuery.data?.connections ?? [];

  async function copySelectedConfig() {
    if (!selectedConfig) {
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(selectedConfig, null, 2));
    setCopyState(`${client} config copied`);
  }

  function downloadSelectedConfig() {
    if (!selectedConfig) {
      return;
    }
    const blob = new Blob([JSON.stringify(selectedConfig, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `memorepo-${space.slug}-${client}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setCopyState(`${client} config downloaded`);
  }

  function deleteConnection(connection: McpConnection) {
    deleteConnectionMutation.reset();
    setDeleteError(null);
    setConnectionToDelete(connection);
  }

  return (
    <Modal
      title={connectionToDelete ? "Delete MCP connection" : "Connect agent"}
      onClose={() => {
        if (deleteConnectionMutation.isPending) {
          return;
        }
        if (connectionToDelete) {
          setConnectionToDelete(null);
          setDeleteError(null);
        } else {
          onClose();
        }
      }}
      wide={!connectionToDelete}
    >
      {connectionToDelete ? (
        <div className="confirmation-dialog">
          <p>
            Delete the <strong>{connectionToDelete.name}</strong> MCP connection?
            {!connectionToDelete.revoked_at ? " Active agents using this configuration will stop working." : ""}
          </p>
          {deleteError ? <div className="inline-alert error" role="alert">{deleteError}</div> : null}
          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={() => setConnectionToDelete(null)} disabled={deleteConnectionMutation.isPending}>
              Cancel
            </button>
            <button
              className="secondary-button danger"
              type="button"
              onClick={() => deleteConnectionMutation.mutate(connectionToDelete.id)}
              disabled={deleteConnectionMutation.isPending}
            >
              {deleteConnectionMutation.isPending ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
              <span>Delete connection</span>
            </button>
          </div>
        </div>
      ) : (
        <>
      <div className="mcp-intro">
        <p>Create a named, read-only connection for an agent. Each connection can be revoked independently without affecting this Space.</p>
      </div>
      <div className="mcp-tabs" aria-label="Agent client">
        {["generic", "codex", "claude", "gemini", "http"].map((item) => (
          <button
            key={item}
            type="button"
            className={client === item ? "active" : ""}
            aria-pressed={client === item}
            onClick={() => {
              setClient(item);
              setCopyState(null);
            }}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="form-stack">
        <label>
          <span>Connection name</span>
          <input data-modal-autofocus value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder="My Codex workspace" />
        </label>
        <button className="primary-button" type="button" onClick={() => mutation.mutate()} disabled={!connectionName.trim() || mutation.isPending} aria-busy={mutation.isPending}>
          {mutation.isPending ? <Loader2 className="spin" size={18} /> : <GitBranch size={18} />}
          <span>Create connection</span>
        </button>
        <pre className="config-block">{selectedConfig ? JSON.stringify(selectedConfig, null, 2) : "Create a connection to generate config."}</pre>
        {selectedConfig ? (
          <div className="mcp-action-row">
            <button className="secondary-button" type="button" onClick={() => void copySelectedConfig()}>
              <Clipboard size={18} />
              <span>Copy config</span>
            </button>
            <button className="secondary-button" type="button" onClick={downloadSelectedConfig}>
              <Download size={18} />
              <span>Download config</span>
            </button>
            <button className="secondary-button" type="button" onClick={() => testMutation.mutate()} disabled={!connectionToken || testMutation.isPending}>
              {testMutation.isPending ? <Loader2 className="spin" size={18} /> : <CheckCircle2 size={18} />}
              <span>Test connection</span>
            </button>
          </div>
        ) : null}
        {copyState ? <div className="mcp-config-state" role="status" aria-live="polite">{copyState}</div> : null}
        {testResult ? (
          <div className={`mcp-test-result ${testResult.status}`}>
            <strong>{testResult.message}</strong>
            {testResult.detail ? <span>{testResult.detail}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="connection-list">
        <div className="connection-list-header">
          <div>
            <h2>Active connections</h2>
            <span>{connections.filter((connection) => !connection.revoked_at).length} active</span>
          </div>
        </div>
        {connections.length > 0 ? (
          connections.map((connection) => (
            <article className="connection-row" key={connection.id}>
              <div>
                <strong>{connection.name}</strong>
                <span>{connection.client} · created {new Date(connection.created_at).toLocaleString()}</span>
              </div>
              <StatusBadge status={connection.revoked_at ? "revoked" : "active"} tone={connection.revoked_at ? "gray" : "green"} />
              <button
                className="secondary-button danger compact-button"
                type="button"
                onClick={() => deleteConnection(connection)}
                disabled={deletingConnectionId === connection.id}
                aria-label={`Delete ${connection.name} connection`}
              >
                {deletingConnectionId === connection.id ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
                <span>Delete</span>
              </button>
            </article>
          ))
        ) : (
          <div className="empty-inline">No MCP connections yet.</div>
        )}
      </div>
        </>
      )}
    </Modal>
  );
}
