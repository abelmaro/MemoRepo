import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { StatusBadge } from "./StatusBadge";

interface PreflightState {
  status: "ready" | "warning" | "failed";
  checkedAt: string;
  checks: PreflightCheck[];
  memorepoHome: string;
  mcpContainerName: string;
}

interface PreflightCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  message: string;
  detail?: string;
}

export function PreflightPanel() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const preflightQuery = useQuery({
    queryKey: ["preflight"],
    queryFn: () => api<PreflightState>("/api/preflight"),
    refetchInterval: open ? 30000 : false
  });

  return (
    <section className="preflight-panel">
      <div className="preflight-header">
        <button className="panel-toggle" type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          <div>
            <h2>Preflight</h2>
            <span>
              {preflightQuery.data
                ? `${formatPreflightStatus(preflightQuery.data.status)} · checked ${formatCheckedAt(preflightQuery.data.checkedAt)}`
                : "Checking local runtime..."}
            </span>
          </div>
        </button>
        <button className="text-button" type="button" onClick={() => void queryClient.invalidateQueries({ queryKey: ["preflight"] })}>
          Refresh
        </button>
      </div>
      {open ? (
        <div className="preflight-grid">
          {(preflightQuery.data?.checks ?? []).map((check) => (
            <div className={`preflight-check preflight-check-${check.status}`} key={check.id}>
              <ShieldCheck size={18} />
              <div>
                <strong>{check.label}</strong>
                <span>{check.message}</span>
                {check.detail ? <small>{check.detail}</small> : null}
              </div>
              <StatusBadge status={formatCheckStatus(check.status)} tone={checkStatusTone(check.status)} />
            </div>
          ))}
          {!preflightQuery.data ? <div className="empty-inline">Checking runtime requirements...</div> : null}
        </div>
      ) : null}
    </section>
  );
}

function formatPreflightStatus(status: PreflightState["status"]): string {
  if (status === "ready") {
    return "Ready";
  }
  if (status === "warning") {
    return "Needs attention";
  }
  return "Blocked";
}

function formatCheckStatus(status: PreflightCheck["status"]): string {
  if (status === "pass") {
    return "ok";
  }
  if (status === "warn") {
    return "review";
  }
  return "failed";
}

function checkStatusTone(status: PreflightCheck["status"]): "green" | "amber" | "red" {
  if (status === "pass") {
    return "green";
  }
  if (status === "warn") {
    return "amber";
  }
  return "red";
}

function formatCheckedAt(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
