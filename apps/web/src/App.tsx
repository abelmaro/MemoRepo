import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Boxes, Filter, HeartPulse, Layers, Loader2, Plus, RefreshCw, Search, Settings2 } from "lucide-react";
import { AddRepoModal } from "./components/AddRepoModal";
import { AskSpacePanel } from "./components/AskSpacePanel";
import { GitHubConnectionPanel, type GitHubSignInRequest } from "./components/GitHubConnectionPanel";
import { JobLog } from "./components/JobLog";
import { JobsPanel } from "./components/JobsPanel";
import { LifecyclePanel } from "./components/LifecyclePanel";
import { McpModal } from "./components/McpModal";
import { Modal } from "./components/Modal";
import { NewSpaceModal } from "./components/NewSpaceModal";
import { PreflightPanel } from "./components/PreflightPanel";
import { QueryErrorState } from "./components/QueryErrorState";
import { RemovedRepositoryRow } from "./components/RemovedRepositoryRow";
import { RepositoryRow } from "./components/RepositoryRow";
import { StatusStrip } from "./components/StatusStrip";
import { api, type Job, type Space, type SpaceRepository } from "./lib/api";
import { useDashboardEvents } from "./lib/dashboardEvents";
import { matchesRepositoryKind, REPOSITORY_KIND_FILTERS, type RepositoryKindFilter } from "./lib/repositoryKinds";
import { snapshotStateSummary } from "./lib/snapshotState";

type ManagementView = "activity" | "system" | "settings";

export function App() {
  const queryClient = useQueryClient();
  useDashboardEvents();
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [askSpaceOpen, setAskSpaceOpen] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [repoSearch, setRepoSearch] = useState("");
  const [repoKindFilter, setRepoKindFilter] = useState<RepositoryKindFilter>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [managementView, setManagementView] = useState<ManagementView | null>(null);
  const [updateConfirmationOpen, setUpdateConfirmationOpen] = useState(false);
  const [githubSignInRequest, setGitHubSignInRequest] = useState<GitHubSignInRequest | null>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const githubSignInRequestId = useRef(0);

  const spacesQuery = useQuery({
    queryKey: ["spaces"],
    queryFn: () => api<{ spaces: Space[] }>("/api/spaces")
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
    enabled: Boolean(selectedSpace)
  });

  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<{ jobs: Job[] }>("/api/jobs")
  });

  const updateSpaceMutation = useMutation({
    mutationFn: (spaceId: string) => api<{ job: Job }>(`/api/spaces/${spaceId}/reindex`, { method: "POST", body: "{}" }),
    onSuccess: ({ job }) => {
      setUpdateConfirmationOpen(false);
      setActiveJobId(job.id);
      setManagementView("activity");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    }
  });

  const repositories = spaceDetailQuery.data?.repositories ?? [];
  const removedRepositories = spaceDetailQuery.data?.removedRepositories ?? [];
  const selectedRepositoryIds = new Set([...repositories, ...removedRepositories].map((repository) => repository.id));
  const hasActiveSpaceJob = Boolean(
    selectedSpace &&
      (jobsQuery.data?.jobs ?? []).some(
        (job) =>
          ["pending", "running"].includes(job.status) &&
          (job.space_id === selectedSpace.id || Boolean(job.space_repository_id && selectedRepositoryIds.has(job.space_repository_id))),
      ),
  );
  const snapshotSummary = selectedSpace
    ? snapshotStateSummary(selectedSpace.id, selectedSpace.snapshot_status, repositories, jobsQuery.data?.jobs)
    : { state: "ready" as const, excludedRepositoryCount: 0, latestSnapshotJob: null };
  const snapshotJobId = snapshotSummary.latestSnapshotJob?.id;
  const normalizedSearch = repoSearch.trim().toLowerCase();
  const filteredRepositories = repositories.filter(
    (repository) => repository.full_name.toLowerCase().includes(normalizedSearch) && matchesRepositoryKind(repository, repoKindFilter)
  );
  const activeFilter = REPOSITORY_KIND_FILTERS.find((filter) => filter.value === repoKindFilter)?.label ?? "All";

  useEffect(() => {
    if (!filterMenuOpen) {
      return;
    }
    function closeOnOutsideClick(event: PointerEvent) {
      if (event.target instanceof Node && !filterMenuRef.current?.contains(event.target)) {
        setFilterMenuOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setFilterMenuOpen(false);
        filterButtonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [filterMenuOpen]);

  function selectSpace(space: Space) {
    setSelectedSpaceId(space.id);
    setRepoSearch("");
    setRepoKindFilter("all");
    setManagementView(null);
    setAskSpaceOpen(false);
  }

  function checkForUpdates() {
    if (!selectedSpace || hasActiveSpaceJob) {
      return;
    }
    if (repositories.length >= 5) {
      updateSpaceMutation.reset();
      setUpdateConfirmationOpen(true);
      return;
    }
    updateSpaceMutation.mutate(selectedSpace.id);
  }

  function confirmCheckForUpdates() {
    if (selectedSpace) {
      updateSpaceMutation.mutate(selectedSpace.id);
    }
  }

  function clearRepositoryFilters() {
    setRepoSearch("");
    setRepoKindFilter("all");
  }

  function toggleManagementView(view: ManagementView) {
    setManagementView((current) => (current === view ? null : view));
  }

  function signInWithGitHub() {
    let authorizationWindow: Window | null = null;
    try {
      authorizationWindow = window.open("about:blank", "memorepo-github-authorization");
    } catch {
      authorizationWindow = null;
    }

    githubSignInRequestId.current += 1;
    setGitHubSignInRequest({ id: githubSignInRequestId.current, authorizationWindow });
    setManagementView("system");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <img src="/android-chrome-192x192.png?v=3" alt="" />
          </div>
          <span>MemoRepo</span>
        </div>

        <div className="sidebar-section-heading">
          <span>Spaces</span>
          <button className="sidebar-add-button" type="button" onClick={() => setNewSpaceOpen(true)} disabled={spacesQuery.isError} aria-label="Create Space" title="Create Space">
            <Plus size={18} />
          </button>
        </div>
        <nav className="space-list" aria-label="Spaces">
          {(spacesQuery.data?.spaces ?? []).map((space) => (
            <button
              type="button"
              key={space.id}
              className={selectedSpace?.id === space.id ? "space-item active" : "space-item"}
              onClick={() => selectSpace(space)}
              aria-current={selectedSpace?.id === space.id ? "page" : undefined}
            >
              <Boxes size={19} />
              <span>{space.name}</span>
              <strong aria-label={`${space.repository_count ?? 0} repositories`}>{space.repository_count ?? 0}</strong>
            </button>
          ))}
        </nav>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <span className="eyebrow">{selectedSpace ? "Space" : "Local repository context"}</span>
            <h1>{selectedSpace?.name ?? "MemoRepo"}</h1>
            <p>
              {selectedSpace
                ? "Group repositories so coding agents can search them together without modifying source code."
                : "Create an isolated Space to give coding agents safe, read-only access to your repositories."}
            </p>
          </div>
          {selectedSpace ? (
            <div className="header-actions">
              <button className="primary-button" type="button" onClick={() => setAddRepoOpen(true)} disabled={hasActiveSpaceJob}>
                <Plus size={18} />
                <span>Add repository</span>
              </button>
            </div>
          ) : null}
        </header>

        {spacesQuery.isError ? (
          <section className="api-unavailable page-empty-state" aria-labelledby="api-unavailable-title">
            <HeartPulse size={38} aria-hidden="true" />
            <h2 id="api-unavailable-title">MemoRepo API is unavailable</h2>
            <p>The dashboard could not load your Spaces. Check that the API is running, then try again.</p>
            <QueryErrorState
              title="Connection failed"
              error={spacesQuery.error}
              onRetry={() => void spacesQuery.refetch()}
            />
          </section>
        ) : !selectedSpace ? (
          <section className="empty-state page-empty-state">
            <Layers size={38} />
            <h2>Create your first Space</h2>
            <p>A Space groups repositories into one isolated, read-only context for coding agents.</p>
            <button className="primary-button" type="button" onClick={() => setNewSpaceOpen(true)}>
              <Plus size={18} />
              <span>Create Space</span>
            </button>
          </section>
        ) : (
          <>
            <StatusStrip
              space={selectedSpace}
              repositories={repositories}
              loading={spaceDetailQuery.isPending}
              snapshotSummary={snapshotSummary}
              onConnectAgent={() => setMcpOpen(true)}
              onAddRepository={() => setAddRepoOpen(true)}
              onSignInGitHub={signInWithGitHub}
              onOpenSnapshotJob={(jobId) => setActiveJobId(jobId)}
              operationsDisabled={hasActiveSpaceJob}
            />

            <section className="repo-section" aria-labelledby="repositories-title">
              <header className="repo-section-header">
                <div>
                  <div className="section-title-row">
                    <h2 id="repositories-title">Repositories</h2>
                    <span className="count-badge">{repositories.length}</span>
                  </div>
                  <p>Only repositories in this list are included in the Space context.</p>
                </div>
                {repositories.length > 0 ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={checkForUpdates}
                    disabled={updateSpaceMutation.isPending || hasActiveSpaceJob}
                    aria-busy={updateSpaceMutation.isPending}
                    title="Check remote commits and rebuild only repositories that changed"
                  >
                    {updateSpaceMutation.isPending ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                    <span>Check for updates</span>
                  </button>
                ) : null}
              </header>

              {hasActiveSpaceJob ? (
                <div className="inline-alert operation-notice" role="status">
                  A Space operation is in progress. Repository changes are available again when it finishes.
                </div>
              ) : null}

              {repositories.length > 0 ? (
                <div className="toolbar" aria-label="Repository list controls">
                  <label className="search-box">
                    <Search size={19} aria-hidden="true" />
                    <span className="sr-only">Search repositories</span>
                    <input
                      value={repoSearch}
                      onChange={(event) => setRepoSearch(event.target.value)}
                      placeholder="Search repositories"
                    />
                  </label>
                  <div className="filter-menu" ref={filterMenuRef}>
                    <button
                      ref={filterButtonRef}
                      className="secondary-button"
                      type="button"
                      aria-haspopup="true"
                      aria-expanded={filterMenuOpen}
                      onClick={() => setFilterMenuOpen((open) => !open)}
                    >
                      <Filter size={18} />
                      <span>{repoKindFilter === "all" ? "Filter" : activeFilter}</span>
                    </button>
                    {filterMenuOpen ? (
                      <div className="filter-menu-popover" role="group" aria-label="Repository type">
                        {REPOSITORY_KIND_FILTERS.map((filter) => (
                          <button
                            key={filter.value}
                            className={repoKindFilter === filter.value ? "active" : ""}
                            type="button"
                            aria-pressed={repoKindFilter === filter.value}
                            onClick={() => {
                              setRepoKindFilter(filter.value);
                              setFilterMenuOpen(false);
                            }}
                          >
                            <span>{filter.label}</span>
                            {repoKindFilter === filter.value ? <CheckCircleMarker /> : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {spaceDetailQuery.isPending ? (
                <div className="loading-state" role="status">
                  <Loader2 className="spin" size={24} />
                  <span>Loading repositories…</span>
                </div>
              ) : spaceDetailQuery.isError ? (
                <div className="inline-alert error" role="alert">
                  <strong>Repositories could not be loaded.</strong>
                  <span>{spaceDetailQuery.error instanceof Error ? spaceDetailQuery.error.message : "Try again in a moment."}</span>
                </div>
              ) : repositories.length === 0 ? (
                <div className="empty-state compact-empty-state">
                  <Layers size={34} />
                  <h3>This Space has no repositories</h3>
                  <p>Add a GitHub repository to build the first read-only snapshot.</p>
                  <button className="primary-button" type="button" onClick={() => setAddRepoOpen(true)}>
                    <Plus size={18} />
                    <span>Add repository</span>
                  </button>
                </div>
              ) : filteredRepositories.length === 0 ? (
                <div className="empty-state compact-empty-state">
                  <Search size={34} />
                  <h3>No repositories match your search</h3>
                  <p>Try another repository name or clear the active filter.</p>
                  <button className="secondary-button" type="button" onClick={clearRepositoryFilters}>
                    Clear search and filters
                  </button>
                </div>
              ) : (
                <div className="repo-list" role="table" aria-label="Repositories in this Space">
                  <div className="repo-table-header" role="row">
                    <span role="columnheader">Repository</span>
                    <span role="columnheader">Status</span>
                    <span role="columnheader">Branch</span>
                    <span role="columnheader">Last indexed</span>
                    <span role="columnheader" className="sr-only">Actions</span>
                  </div>
                  {filteredRepositories.map((repository) => (
                    <RepositoryRow
                      key={repository.id}
                      repository={repository}
                      snapshotState={snapshotSummary.state}
                      onSnapshotJob={snapshotJobId ? () => setActiveJobId(snapshotJobId) : undefined}
                      onJob={(jobId) => setActiveJobId(jobId)}
                      onChanged={() => {
                        void queryClient.invalidateQueries({ queryKey: ["space", selectedSpace.id] });
                        void queryClient.invalidateQueries({ queryKey: ["jobs"] });
                      }}
                      operationsDisabled={hasActiveSpaceJob}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="management-section" aria-labelledby="management-title">
              <header className="management-header">
                <div>
                  <h2 id="management-title">Space management</h2>
                  <p>Open operational details only when you need them.</p>
                </div>
                <div className="management-switcher" aria-label="Space management views">
                  <button type="button" aria-label="Activity" title="Activity" aria-pressed={managementView === "activity"} onClick={() => toggleManagementView("activity")}>
                    <Activity size={17} />
                    <span>Activity</span>
                  </button>
                  <button type="button" aria-label="System health" title="System health" aria-pressed={managementView === "system"} onClick={() => toggleManagementView("system")}>
                    <HeartPulse size={17} />
                    <span>System health</span>
                  </button>
                  <button type="button" aria-label="Settings" title="Settings" aria-pressed={managementView === "settings"} onClick={() => toggleManagementView("settings")}>
                    <Settings2 size={17} />
                    <span>Settings</span>
                  </button>
                </div>
              </header>

              {managementView ? (
                <div className="management-content">
                  {managementView === "activity" ? <JobsPanel onSelectJob={(jobId) => setActiveJobId(jobId)} /> : null}
                  {managementView === "system" ? (
                    <div className="system-panels">
                      <PreflightPanel />
                      <GitHubConnectionPanel
                        signInRequest={githubSignInRequest}
                        onSignInRequestHandled={() => setGitHubSignInRequest(null)}
                      />
                    </div>
                  ) : null}
                  {managementView === "settings" ? (
                    <div className="settings-panels">
                      {removedRepositories.length > 0 ? (
                        <section className="removed-panel">
                          <div className="panel-heading">
                            <h3>Removed repositories</h3>
                            <p>Clean up retained clones after confirming they are no longer needed.</p>
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
                      <LifecyclePanel
                        space={selectedSpace}
                        operationsDisabled={hasActiveSpaceJob}
                        onChanged={() => {
                          void queryClient.invalidateQueries({ queryKey: ["space", selectedSpace.id] });
                          void queryClient.invalidateQueries({ queryKey: ["spaces"] });
                          void queryClient.invalidateQueries({ queryKey: ["jobs"] });
                        }}
                        onDeleted={() => {
                          setSelectedSpaceId(null);
                          setAddRepoOpen(false);
                          setMcpOpen(false);
                          setAskSpaceOpen(false);
                          setManagementView(null);
                          void queryClient.invalidateQueries({ queryKey: ["spaces"] });
                          void queryClient.invalidateQueries({ queryKey: ["jobs"] });
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          </>
        )}
      </main>

      {newSpaceOpen ? <NewSpaceModal onClose={() => setNewSpaceOpen(false)} /> : null}
      {addRepoOpen && selectedSpace ? (
        <AddRepoModal
          space={selectedSpace}
          onClose={() => setAddRepoOpen(false)}
          onJob={(jobId) => {
            setActiveJobId(jobId);
            setManagementView("activity");
            void queryClient.invalidateQueries({ queryKey: ["space", selectedSpace.id] });
          }}
        />
      ) : null}
      {mcpOpen && selectedSpace ? <McpModal space={selectedSpace} onClose={() => setMcpOpen(false)} /> : null}
      {updateConfirmationOpen && selectedSpace ? (
        <Modal title="Check repositories for updates" onClose={() => !updateSpaceMutation.isPending && setUpdateConfirmationOpen(false)}>
          <div className="confirmation-dialog">
            <p>
              Check and update all <strong>{repositories.length} repositories</strong> in {selectedSpace.name}? MemoRepo will rebuild the Space snapshot when needed.
            </p>
            {updateSpaceMutation.error ? (
              <div className="inline-alert error" role="alert">
                {updateSpaceMutation.error instanceof Error ? updateSpaceMutation.error.message : "Repositories could not be updated."}
              </div>
            ) : null}
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => setUpdateConfirmationOpen(false)} disabled={updateSpaceMutation.isPending}>
                Cancel
              </button>
              <button className="primary-button" type="button" onClick={confirmCheckForUpdates} disabled={updateSpaceMutation.isPending}>
                {updateSpaceMutation.isPending ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                <span>Check for updates</span>
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
      {activeJobId ? (
        <Modal title="Job details" onClose={() => setActiveJobId(null)} wide contained>
          <JobLog jobId={activeJobId} onJob={(jobId) => setActiveJobId(jobId)} />
        </Modal>
      ) : null}
      <AskSpacePanel space={selectedSpace} open={askSpaceOpen} onOpenChange={setAskSpaceOpen} />
    </div>
  );
}

function CheckCircleMarker() {
  return <span className="filter-check" aria-hidden="true">✓</span>;
}
