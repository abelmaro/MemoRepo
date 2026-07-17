import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Filter, Github, Link, Loader2, Plus, RefreshCw, Search } from "lucide-react";
import { api, booleanValue, fullName, type GitHubRepository, type Job, type Space } from "../lib/api";
import { REPOSITORY_KIND_FILTERS, type RepositoryKindFilter } from "../lib/repositoryKinds";
import { Modal } from "./Modal";
import { StatusBadge } from "./StatusBadge";

export function AddRepoModal({ space, onClose, onJob }: { space: Space; onClose: () => void; onJob: (jobId: string) => void }) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [locator, setLocator] = useState("");
  const [kindFilter, setKindFilter] = useState<RepositoryKindFilter>("all");
  const [syncJobId, setSyncJobId] = useState<string | null>(null);
  const normalizedQuery = query.trim();
  const searchReady = normalizedQuery.length >= 2;

  const repositoriesQuery = useQuery({
    queryKey: ["github-repositories", normalizedQuery, kindFilter],
    queryFn: () =>
      api<{ repositories: GitHubRepository[] }>(`/api/github/repositories?query=${encodeURIComponent(normalizedQuery)}&kind=${kindFilter}`),
    enabled: searchReady
  });

  const addMutation = useMutation({
    mutationFn: (body: { repositoryId?: string; locator?: string }) =>
      api<{ jobs: Job[] }>(`/api/spaces/${space.id}/repositories`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: ({ jobs }) => {
      const firstJob = jobs[0];
      if (firstJob) {
        onJob(firstJob.id);
      }
      onClose();
    }
  });

  const syncMutation = useMutation({
    mutationFn: () => api<{ job: Job }>("/api/github/sync", { method: "POST", body: "{}" }),
    onSuccess: ({ job }) => {
      setSyncJobId(job.id);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    }
  });

  const syncJobQuery = useQuery({
    queryKey: ["job", syncJobId],
    queryFn: () => api<{ job: Job }>(`/api/jobs/${syncJobId}`),
    enabled: Boolean(syncJobId),
    refetchInterval: (query) => ["pending", "running"].includes(query.state.data?.job.status ?? "") ? 1_000 : false
  });

  useEffect(() => {
    if (syncJobQuery.data?.job.status === "succeeded") {
      void queryClient.invalidateQueries({ queryKey: ["github-repositories"] });
    }
  }, [queryClient, syncJobQuery.data?.job.status]);

  const repositories = repositoriesQuery.data?.repositories ?? [];
  const visibleRepositories = repositories.slice(0, 50);
  const mutationError = addMutation.error ?? syncMutation.error;
  const syncActive = ["pending", "running"].includes(syncJobQuery.data?.job.status ?? "");

  return (
    <Modal title="Add repository" onClose={onClose} wide>
      <div className="add-repo-dialog">
        <div className="modal-intro">
          <p>Search the GitHub catalog, then add a repository to <strong>{space.name}</strong>. Cloning and indexing run in the background.</p>
          <button className="text-button with-icon" type="button" onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending || syncActive}>
            {syncMutation.isPending || syncActive ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
            <span>{syncActive ? "Refreshing GitHub catalog…" : "Refresh GitHub catalog"}</span>
          </button>
        </div>

        <label className="catalog-search">
          <span>Search synced GitHub repositories</span>
          <div>
            <Search size={19} />
            <input data-modal-autofocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Owner or repository name" autoFocus />
          </div>
        </label>

        <div className="filter-control compact" aria-label="Repository type">
          <Filter size={16} aria-hidden="true" />
          {REPOSITORY_KIND_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={kindFilter === filter.value ? "active" : ""}
              aria-pressed={kindFilter === filter.value}
              onClick={() => setKindFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div className="repo-picker" aria-live="polite" aria-busy={repositoriesQuery.isFetching}>
          {!searchReady ? (
            <div className="picker-empty-state">
              <Search size={28} />
              <strong>Find a repository</strong>
              <span>Enter at least two characters. MemoRepo will search repositories already synced from GitHub.</span>
            </div>
          ) : repositoriesQuery.isFetching ? (
            <div className="picker-empty-state">
              <Loader2 className="spin" size={28} />
              <strong>Searching GitHub catalog…</strong>
            </div>
          ) : repositoriesQuery.isError ? (
            <div className="picker-empty-state error" role="alert">
              <strong>Repositories could not be loaded</strong>
              <span>{repositoriesQuery.error instanceof Error ? repositoriesQuery.error.message : "Try refreshing the GitHub catalog."}</span>
            </div>
          ) : visibleRepositories.length === 0 ? (
            <div className="picker-empty-state">
              <Github size={28} />
              <strong>No repositories match “{normalizedQuery}”</strong>
              <span>Try another name, change the type filter, or add a repository by URL below.</span>
            </div>
          ) : (
            <>
              <div className="repo-picker-summary">
                <span>{repositories.length} {repositories.length === 1 ? "result" : "results"}</span>
                {repositories.length > 50 ? <small>Showing the first 50</small> : null}
              </div>
              {visibleRepositories.map((repository) => (
                <button
                  key={repository.id}
                  type="button"
                  className="repo-picker-row"
                  disabled={addMutation.isPending}
                  onClick={() => addMutation.mutate({ repositoryId: repository.id })}
                >
                  <Github size={20} />
                  <span>{fullName(repository)}</span>
                  {booleanValue(repository.private) ? <StatusBadge status="private" tone="gray" /> : null}
                  {booleanValue(repository.archived) ? <StatusBadge status="archived" tone="amber" /> : null}
                  {booleanValue(repository.fork) ? <StatusBadge status="fork" tone="blue" /> : null}
                </button>
              ))}
            </>
          )}
        </div>

        <section className="add-by-url" aria-labelledby="add-by-url-title">
          <div>
            <Link size={18} />
            <div>
              <h3 id="add-by-url-title">Add by URL</h3>
              <p>Use this when the repository is not available in the synced catalog.</p>
            </div>
          </div>
          <div className="inline-form">
            <input
              aria-label="GitHub repository URL or owner and repository name"
              value={locator}
              onChange={(event) => setLocator(event.target.value)}
              placeholder="https://github.com/owner/repo or owner/repo"
            />
            <button className="secondary-button" type="button" disabled={!locator.trim() || addMutation.isPending} onClick={() => addMutation.mutate({ locator })}>
              {addMutation.isPending ? <Loader2 className="spin" size={18} /> : <Plus size={18} />}
              <span>Add repository</span>
            </button>
          </div>
        </section>

        {mutationError ? (
          <div className="inline-alert error" role="alert">
            {mutationError instanceof Error ? mutationError.message : "The repository action failed."}
          </div>
        ) : null}
        {syncJobQuery.data?.job.status === "succeeded" ? (
          <div className="inline-alert success" role="status">GitHub catalog refreshed. Search results are up to date.</div>
        ) : syncJobQuery.data?.job.status === "failed" ? (
          <div className="inline-alert error" role="alert">{syncJobQuery.data.job.error ?? "GitHub catalog refresh failed."}</div>
        ) : null}
      </div>
    </Modal>
  );
}
