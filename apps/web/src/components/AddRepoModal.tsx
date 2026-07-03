import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Filter, Github, Plus } from "lucide-react";
import { api, booleanValue, fullName, type GitHubRepository, type Job, type Space } from "../lib/api";
import { REPOSITORY_KIND_FILTERS, type RepositoryKindFilter } from "../lib/repositoryKinds";
import { Modal } from "./Modal";
import { StatusBadge } from "./StatusBadge";

export function AddRepoModal({ space, onClose, onJob }: { space: Space; onClose: () => void; onJob: (jobId: string) => void }) {
  const [query, setQuery] = useState("");
  const [locator, setLocator] = useState("");
  const [kindFilter, setKindFilter] = useState<RepositoryKindFilter>("all");
  const repositoriesQuery = useQuery({
    queryKey: ["github-repositories", query, kindFilter],
    queryFn: () =>
      api<{ repositories: GitHubRepository[] }>(`/api/github/repositories?query=${encodeURIComponent(query)}&kind=${kindFilter}`),
    enabled: true
  });
  const addMutation = useMutation({
    mutationFn: (body: { repositoryId?: string; locator?: string }) =>
      api<{ jobs: Job[] }>(`/api/spaces/${space.id}/repositories`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: ({ jobs }) => {
      onJob(jobs[0]!.id);
      onClose();
    }
  });

  return (
    <Modal title="Add repository" onClose={onClose} wide>
      <div className="form-stack">
        <label>
          <span>Search synced GitHub repositories</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="owner/repo" autoFocus />
        </label>
        <div className="filter-control compact" aria-label="Synced repository filters">
          <Filter size={16} />
          {REPOSITORY_KIND_FILTERS.map((filter) => (
            <button key={filter.value} type="button" className={kindFilter === filter.value ? "active" : ""} onClick={() => setKindFilter(filter.value)}>
              {filter.label}
            </button>
          ))}
        </div>
        <div className="repo-picker">
          {(repositoriesQuery.data?.repositories ?? []).map((repository) => (
            <button key={repository.id} type="button" className="repo-picker-row" onClick={() => addMutation.mutate({ repositoryId: repository.id })}>
              <Github size={20} />
              <span>{fullName(repository)}</span>
              {booleanValue(repository.private) ? <StatusBadge status="private" tone="gray" /> : null}
              {booleanValue(repository.archived) ? <StatusBadge status="archived" tone="amber" /> : null}
              {booleanValue(repository.fork) ? <StatusBadge status="fork" tone="blue" /> : null}
            </button>
          ))}
        </div>
        <div className="inline-form">
          <input value={locator} onChange={(event) => setLocator(event.target.value)} placeholder="https://github.com/owner/repo or owner/repo" />
          <button className="secondary-button" type="button" disabled={!locator.trim()} onClick={() => addMutation.mutate({ locator })}>
            <Plus size={18} />
            <span>Add by URL</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
