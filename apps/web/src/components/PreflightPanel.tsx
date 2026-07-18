import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { StatusBadge } from "./StatusBadge";
import { QueryErrorState } from "./QueryErrorState";

interface PreflightState {
  status: "ready" | "warning" | "failed";
  checkedAt: string;
  checks: PreflightCheck[];
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
  const preflightQuery = useQuery({
    queryKey: ["preflight"],
    queryFn: () => api<PreflightState>("/api/preflight")
  });

  return (
    <section className="preflight-panel management-panel" aria-labelledby="preflight-title">
      <div className="preflight-header">
        <div className="panel-heading with-icon">
          <ShieldCheck size={20} />
          <div>
            <h3 id="preflight-title">Runtime checks</h3>
            <span>
              {preflightQuery.data
                ? `${formatPreflightStatus(preflightQuery.data.status)} · checked ${formatCheckedAt(preflightQuery.data.checkedAt)}`
                : "Checking local runtime..."}
            </span>
          </div>
        </div>
      </div>
      {preflightQuery.isError ? (
        <QueryErrorState title="Runtime checks could not be loaded" error={preflightQuery.error} onRetry={() => void preflightQuery.refetch()} />
      ) : null}
      <div className="preflight-grid" aria-live="polite">
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
        {!preflightQuery.data && !preflightQuery.isError ? <div className="empty-inline">Checking runtime requirements...</div> : null}
      </div>
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
