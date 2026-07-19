export const SNAPSHOT_SEARCH_RESULT_MAX = 25;
export const SNAPSHOT_QUERY_GRAPH_MAX_ROWS = 25;

export interface SnapshotInstructionRepository {
  fullName: string;
  projectName: string;
  branch: string;
  commit: string;
}

export interface SnapshotInstructionContext {
  spaceName: string;
  snapshotVersion: number;
  stale: boolean;
  repositories: SnapshotInstructionRepository[];
}

export function buildSnapshotInstructions(context: SnapshotInstructionContext): string {
  const repositories = context.repositories
    .map(
      (repository) =>
        `- ${repository.fullName} (project: ${repository.projectName}, branch: ${repository.branch}, commit: ${repository.commit.slice(0, 12)})`
    )
    .join("\n");
  return [
    `MemoRepo serves read-only code intelligence for the "${context.spaceName}" space from immutable snapshot v${context.snapshotVersion}${context.stale ? " (stale: repositories changed after this snapshot was built)" : ""}.`,
    `Repositories in this snapshot:\n${repositories}`,
    'Pass "project" to scope a tool to one repository; omit it to search across all of them.',
    snapshotToolWorkflow()
  ].join("\n\n");
}

export function snapshotToolWorkflow(): string {
  return `Recommended flow: start with list_space_repositories when project names are unclear; use list_snapshot_files for file inventories or questions about whether paths/extensions exist; use get_architecture for broad questions and get_graph_schema before custom Cypher; use an advertised search tool to locate symbols, then trace_path or get_code_snippet to verify implementations. Follow has_more pagination and retry narrower queries when a response reports truncation. Tool availability is negotiated with the installed CBM engine. Search limits cap at ${SNAPSHOT_SEARCH_RESULT_MAX} results and query_graph at ${SNAPSHOT_QUERY_GRAPH_MAX_ROWS} rows.`;
}
