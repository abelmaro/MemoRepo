import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Braces, Filter, Layers, Loader2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { AddRepoModal } from "./components/AddRepoModal";
import { GithubDiagnosticsPanel } from "./components/GithubDiagnosticsPanel";
import { JobLog } from "./components/JobLog";
import { JobsPanel } from "./components/JobsPanel";
import { LifecyclePanel } from "./components/LifecyclePanel";
import { McpModal } from "./components/McpModal";
import { Modal } from "./components/Modal";
import { NewSpaceModal } from "./components/NewSpaceModal";
import { PreflightPanel } from "./components/PreflightPanel";
import { RemovedRepositoryRow } from "./components/RemovedRepositoryRow";
import { RepositoryRow } from "./components/RepositoryRow";
import { StatusStrip } from "./components/StatusStrip";
import { api, type Job, type Space, type SpaceRepository } from "./lib/api";
import { matchesRepositoryKind, REPOSITORY_KIND_FILTERS, type RepositoryKindFilter } from "./lib/repositoryKinds";

export function App() {
  const queryClient = useQueryClient();
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [repoSearch, setRepoSearch] = useState("");
  const [repoKindFilter, setRepoKindFilter] = useState<RepositoryKindFilter>("all");

  const spacesQuery = useQuery({
    queryKey: ["spaces"],
    queryFn: () => api<{ spaces: Space[] }>("/api/spaces"),
    refetchInterval: 5000
  });

  const selectedSpace = useMemo(() => {
    const spaces = spacesQuery.data?.spaces ?? [];
    if (selectedSpaceId) {
      return spaces.find((space) => space.id === selectedSpaceId) ?? spaces[0] ?? null;
    }
    return spaces[0] ?? null;
  }, [selectedSpaceId, spacesQuery.data?.spaces]);

  const spaceDetailQuery = useQuery({
    queryKey: ["space", selectedSpace?.id],
    queryFn: () =>
      api<{ space: Space; repositories: SpaceRepository[]; removedRepositories: SpaceRepository[] }>(`/api/spaces/${selectedSpace!.id}`),
    enabled: Boolean(selectedSpace),
    refetchInterval: 5000
  });

  const syncMutation = useMutation({
    mutationFn: () => api<{ job: Job }>("/api/github/sync", { method: "POST", body: "{}" }),
    onSuccess: ({ job }) => {
      setActiveJobId(job.id);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    }
  });

  const reindexSpaceMutation = useMutation({
    mutationFn: (spaceId: string) => api<{ job: Job }>(`/api/spaces/${spaceId}/reindex`, { method: "POST", body: "{}" }),
    onSuccess: ({ job }) => {
      setActiveJobId(job.id);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    }
  });
  const deleteSpaceMutation = useMutation({
    mutationFn: (spaceId: string) => api<{ spaceId: string }>(`/api/spaces/${spaceId}`, { method: "DELETE" }),
    onSuccess: () => {
      setSelectedSpaceId(null);
      setAddRepoOpen(false);
      setMcpOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["spaces"] });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (error) => {
      window.alert(error instanceof Error ? error.message : "Space could not be deleted");
    }
  });

  const repositories = spaceDetailQuery.data?.repositories ?? [];
  const removedRepositories = spaceDetailQuery.data?.removedRepositories ?? [];
  const selectedSpaceHasContent =
    repositories.length > 0 || removedRepositories.length > 0 || Boolean(selectedSpace?.active_snapshot_id);
  const filteredRepositories = repositories.filter(
    (repository) =>
      repository.full_name.toLowerCase().includes(repoSearch.trim().toLowerCase()) && matchesRepositoryKind(repository, repoKindFilter)
  );

  function selectSpace(space: Space) {
    setSelectedSpaceId(space.id);
  }

  function reindexSpace() {
    if (!selectedSpace) {
      return;
    }
    if (repositories.length >= 5 && !window.confirm(`Reindex ${repositories.length} repositories in this space?`)) {
      return;
    }
    reindexSpaceMutation.mutate(selectedSpace.id);
  }

  function deleteSelectedSpace() {
    if (!selectedSpace) {
      return;
    }
    if (selectedSpaceHasContent) {
      window.alert("Clean up repositories and snapshots before deleting this space.");
      return;
    }
    const confirmation = window.prompt(`Delete space "${selectedSpace.name}"? Type DELETE to confirm.`);
    if (confirmation !== "DELETE") {
      return;
    }
    deleteSpaceMutation.mutate(selectedSpace.id);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Braces size={26} />
          </div>
          <span>MemoRepo</span>
        </div>

        <div className="sidebar-section-title">Spaces</div>
        <nav className="space-list">
          {(spacesQuery.data?.spaces ?? []).map((space) => (
            <button
              type="button"
              key={space.id}
              className={selectedSpace?.id === space.id ? "space-item active" : "space-item"}
              onClick={() => selectSpace(space)}
            >
              <Boxes size={20} />
              <span>{space.name}</span>
              <strong>{space.repository_count ?? 0}</strong>
            </button>
          ))}
        </nav>

        <button className="new-space-button" type="button" onClick={() => setNewSpaceOpen(true)}>
          <Plus size={18} />
          <span>New Space</span>
        </button>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <h1>{selectedSpace ? `Space: ${selectedSpace.name}` : "MemoRepo"}</h1>
            <p>Spaces isolate repository sets for read-only RAG and MCP workflows between repos.</p>
          </div>
          <div className="header-actions">
            <button className="primary-button" type="button" onClick={() => setAddRepoOpen(true)} disabled={!selectedSpace}>
              <Plus size={18} />
              <span>Add repo</span>
            </button>
            <button className="secondary-button" type="button" onClick={reindexSpace} disabled={!selectedSpace || repositories.length === 0}>
              <RefreshCw size={18} />
              <span>Reindex all</span>
            </button>
            <button
              className="secondary-button danger"
              type="button"
              onClick={deleteSelectedSpace}
              disabled={!selectedSpace || selectedSpaceHasContent || deleteSpaceMutation.isPending}
              title={selectedSpaceHasContent ? "Clean up repositories and snapshots before deleting this space" : "Delete empty space"}
            >
              {deleteSpaceMutation.isPending ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
              <span>Delete</span>
            </button>
          </div>
        </header>

        <StatusStrip onConnectAgent={() => setMcpOpen(true)} connectDisabled={!selectedSpace} />

        <section className="toolbar">
          <label className="search-box">
            <Search size={20} />
            <input value={repoSearch} onChange={(event) => setRepoSearch(event.target.value)} placeholder="Search repositories..." />
          </label>
          <div className="filter-control" aria-label="Repository filters">
            <Filter size={18} />
            {REPOSITORY_KIND_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className={repoKindFilter === filter.value ? "active" : ""}
                onClick={() => setRepoKindFilter(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <button className="secondary-button" type="button" onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
            {syncMutation.isPending ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>Sync GitHub</span>
          </button>
        </section>

        <section className="repo-list">
          {selectedSpace && filteredRepositories.length > 0 ? (
            filteredRepositories.map((repository) => (
              <RepositoryRow
                key={repository.id}
                repository={repository}
                onJob={(jobId) => setActiveJobId(jobId)}
                onChanged={() => {
                  void queryClient.invalidateQueries({ queryKey: ["space", selectedSpace.id] });
                  void queryClient.invalidateQueries({ queryKey: ["jobs"] });
                }}
              />
            ))
          ) : (
            <div className="empty-state">
              <Layers size={38} />
              <h2>{selectedSpace ? "No repositories in this space" : "Create your first space"}</h2>
              <p>{selectedSpace ? "Add a GitHub repository to clone, index, and expose it through a read-only MCP gateway." : "Spaces group repos into isolated agent contexts."}</p>
            </div>
          )}
        </section>

        {selectedSpace && removedRepositories.length > 0 ? (
          <section className="removed-panel">
            <div className="jobs-header">
              <h2>Removed repositories</h2>
            </div>
            <div className="removed-list">
              {removedRepositories.map((repository) => (
                <RemovedRepositoryRow
                  key={repository.id}
                  repository={repository}
                  onChanged={() => {
                    void queryClient.invalidateQueries({ queryKey: ["space", selectedSpace.id] });
                    void queryClient.invalidateQueries({ queryKey: ["spaces"] });
                  }}
                />
              ))}
            </div>
          </section>
        ) : null}

        <JobsPanel onSelectJob={(jobId) => setActiveJobId(jobId)} />

        <PreflightPanel />

        <GithubDiagnosticsPanel />

        {selectedSpace ? (
          <LifecyclePanel
            space={selectedSpace}
            onChanged={() => {
              void queryClient.invalidateQueries({ queryKey: ["space", selectedSpace.id] });
              void queryClient.invalidateQueries({ queryKey: ["spaces"] });
              void queryClient.invalidateQueries({ queryKey: ["jobs"] });
            }}
            onDeleted={() => {
              setSelectedSpaceId(null);
              setAddRepoOpen(false);
              setMcpOpen(false);
              void queryClient.invalidateQueries({ queryKey: ["spaces"] });
              void queryClient.invalidateQueries({ queryKey: ["jobs"] });
            }}
          />
        ) : null}
      </main>

      {newSpaceOpen ? <NewSpaceModal onClose={() => setNewSpaceOpen(false)} /> : null}
      {addRepoOpen && selectedSpace ? (
        <AddRepoModal
          space={selectedSpace}
          onClose={() => setAddRepoOpen(false)}
          onJob={(jobId) => {
            setActiveJobId(jobId);
            void queryClient.invalidateQueries({ queryKey: ["space", selectedSpace.id] });
          }}
        />
      ) : null}
      {mcpOpen && selectedSpace ? <McpModal space={selectedSpace} onClose={() => setMcpOpen(false)} /> : null}
      {activeJobId ? (
        <Modal title="Job log" onClose={() => setActiveJobId(null)} wide>
          <JobLog jobId={activeJobId} onJob={(jobId) => setActiveJobId(jobId)} />
        </Modal>
      ) : null}
    </div>
  );
}
