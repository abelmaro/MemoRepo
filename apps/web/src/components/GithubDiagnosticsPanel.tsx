import { useQuery } from "@tanstack/react-query";
import { Github } from "lucide-react";
import { api, type GitHubDiagnostics } from "../lib/api";
import { QueryErrorState } from "./QueryErrorState";

export function GithubDiagnosticsPanel() {
  const githubDiagnosticsQuery = useQuery({
    queryKey: ["github-diagnostics"],
    queryFn: () => api<GitHubDiagnostics>("/api/github/diagnostics"),
    staleTime: 60_000
  });

  return (
    <section className="diagnostics-panel management-panel" aria-labelledby="github-access-title">
      <div className="diagnostics-header">
        <div className="panel-heading with-icon">
          <Github size={20} />
          <div>
            <h3 id="github-access-title">GitHub access</h3>
            <span>
              {githubDiagnosticsQuery.data?.connected
                ? `${githubDiagnosticsQuery.data.visibleRepositoryCount ?? 0} visible repos, ${githubDiagnosticsQuery.data.visibleOrganizationCount ?? 0} visible orgs`
                : githubDiagnosticsQuery.data?.error ?? "Checking access..."}
            </span>
          </div>
        </div>
      </div>
      {githubDiagnosticsQuery.isError ? (
        <QueryErrorState title="GitHub access could not be checked" error={githubDiagnosticsQuery.error} onRetry={() => void githubDiagnosticsQuery.refetch()} />
      ) : null}
      <div className="diagnostics-grid" aria-live="polite">
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
        <div className="diagnostics-warning" role="alert">
          {(githubDiagnosticsQuery.data?.warnings ?? [githubDiagnosticsQuery.data?.error]).filter(Boolean).join(" ")}
        </div>
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
