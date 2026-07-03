import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, type GitHubDiagnostics } from "../lib/api";

export function GithubDiagnosticsPanel() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const githubDiagnosticsQuery = useQuery({
    queryKey: ["github-diagnostics"],
    queryFn: () => api<GitHubDiagnostics>("/api/github/diagnostics"),
    staleTime: 60_000
  });

  return (
    <section className="diagnostics-panel">
      <div className="diagnostics-header">
        <button className="panel-toggle" type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          <div>
            <h2>GitHub access</h2>
            <span>
              {githubDiagnosticsQuery.data?.connected
                ? `${githubDiagnosticsQuery.data.visibleRepositoryCount ?? 0} visible repos, ${githubDiagnosticsQuery.data.visibleOrganizationCount ?? 0} visible orgs`
                : githubDiagnosticsQuery.data?.error ?? "Checking access..."}
            </span>
          </div>
        </button>
        <button
          className="text-button"
          type="button"
          onClick={() => void queryClient.invalidateQueries({ queryKey: ["github-diagnostics"] })}
        >
          Refresh
        </button>
      </div>
      {open ? (
        <>
          <div className="diagnostics-grid">
            <div>
              <strong>Scopes</strong>
              <span>{formatScopes(githubDiagnosticsQuery.data?.tokenScopes)}</span>
            </div>
            <div>
              <strong>User repos</strong>
              <span>{githubDiagnosticsQuery.data?.userRepositoryCount ?? 0}</span>
            </div>
            <div>
              <strong>Organizations</strong>
              <span>{formatOrganizations(githubDiagnosticsQuery.data)}</span>
            </div>
          </div>
          {(githubDiagnosticsQuery.data?.warnings ?? []).length > 0 || githubDiagnosticsQuery.data?.error ? (
            <div className="diagnostics-warning">
              {(githubDiagnosticsQuery.data?.warnings ?? [githubDiagnosticsQuery.data?.error]).filter(Boolean).join(" ")}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function formatScopes(scopes: string[] | undefined): string {
  if (!scopes || scopes.length === 0) {
    return "not reported";
  }
  return scopes.join(", ");
}

function formatOrganizations(diagnostics: GitHubDiagnostics | undefined): string {
  if (!diagnostics?.organizations || diagnostics.organizations.length === 0) {
    return "none";
  }

  const visible = diagnostics.organizations.filter((organization) => organization.status === "visible").length;
  const inaccessible = diagnostics.organizations.length - visible;
  if (inaccessible === 0) {
    return `${visible} visible`;
  }
  return `${visible} visible, ${inaccessible} inaccessible`;
}
