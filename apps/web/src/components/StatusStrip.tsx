import { useQuery } from "@tanstack/react-query";
import { Database, GitBranch, Server } from "lucide-react";
import { api } from "../lib/api";
import { StatusBadge } from "./StatusBadge";

interface SystemState {
  github: { connected: boolean; viewer?: { login: string }; error?: string };
  codebaseMemory: { installed: boolean; version?: string; error?: string };
  memorepoHome: string;
  jobConcurrency: number;
}

export function StatusStrip({ onConnectAgent, connectDisabled }: { onConnectAgent: () => void; connectDisabled: boolean }) {
  const systemQuery = useQuery({
    queryKey: ["system"],
    queryFn: () => api<SystemState>("/api/system"),
    refetchInterval: 30000
  });

  return (
    <section className="status-strip">
      <div className="status-panel">
        <Server size={34} />
        <div>
          <strong>GitHub</strong>
          <span>{systemQuery.data?.github.connected ? systemQuery.data.github.viewer?.login ?? "Connected" : "Not connected"}</span>
        </div>
        <StatusBadge status={systemQuery.data?.github.connected ? "connected" : "failed"} tone={systemQuery.data?.github.connected ? "green" : "red"} />
      </div>
      <div className="status-panel">
        <Database size={34} />
        <div>
          <strong>codebase-memory-mcp</strong>
          <span>{systemQuery.data?.codebaseMemory.installed ? systemQuery.data.codebaseMemory.version : "Unavailable"}</span>
        </div>
        <StatusBadge
          status={systemQuery.data?.codebaseMemory.installed ? "installed" : "failed"}
          tone={systemQuery.data?.codebaseMemory.installed ? "green" : "red"}
        />
      </div>
      <button className="connect-agent-button" type="button" onClick={onConnectAgent} disabled={connectDisabled}>
        <GitBranch size={18} />
        <span>Connect agent</span>
      </button>
    </section>
  );
}
