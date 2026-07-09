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
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [connectionToken, setConnectionToken] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<McpConnectionTestResult | null>(null);
  const [deletingConnectionId, setDeletingConnectionId] = useState<string | null>(null);
  const connectionsQuery = useQuery({
    queryKey: ["mcp-connections", space.id],
    queryFn: () => api<{ connections: McpConnection[] }>(`/api/spaces/${space.id}/mcp-connections`),
    refetchInterval: 5000
  });
  const mutation = useMutation({
    mutationFn: () =>
      api<{ token: string; configs: Record<string, unknown> }>(`/api/spaces/${space.id}/mcp-connections`, {
        method: "POST",
        body: JSON.stringify({ name: client, client })
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
      void queryClient.invalidateQueries({ queryKey: ["mcp-connections", space.id] });
      void queryClient.invalidateQueries({ queryKey: ["space", space.id] });
    },
    onError: (error) => {
      window.alert(error instanceof Error ? error.message : "MCP connection could not be deleted");
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
    const activeWarning = connection.revoked_at ? "" : " Active agents using this config will stop working.";
    if (!window.confirm(`Delete MCP connection ${connection.name}?${activeWarning}`)) {
      return;
    }
    deleteConnectionMutation.mutate(connection.id);
  }

  return (
    <Modal title="Connect agent" onClose={onClose} wide>
      <div className="mcp-tabs">
        {["generic", "codex", "claude", "gemini", "http"].map((item) => (
          <button
            key={item}
            type="button"
            className={client === item ? "active" : ""}
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
        <button className="primary-button" type="button" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 className="spin" size={18} /> : <GitBranch size={18} />}
          <span>Create read-only token</span>
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
        {copyState ? <div className="mcp-config-state">{copyState}</div> : null}
        {testResult ? (
          <div className={`mcp-test-result ${testResult.status}`}>
            <strong>{testResult.message}</strong>
            {testResult.detail ? <span>{testResult.detail}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="connection-list">
        <div className="jobs-header">
          <h2>Connections</h2>
          <button className="text-button" type="button" onClick={() => void queryClient.invalidateQueries({ queryKey: ["mcp-connections", space.id] })}>
            Refresh
          </button>
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
                className="icon-button danger"
                type="button"
                onClick={() => deleteConnection(connection)}
                disabled={deletingConnectionId === connection.id}
                aria-label="Delete MCP connection"
              >
                {deletingConnectionId === connection.id ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
              </button>
            </article>
          ))
        ) : (
          <div className="empty-inline">No MCP connections yet.</div>
        )}
      </div>
    </Modal>
  );
}
