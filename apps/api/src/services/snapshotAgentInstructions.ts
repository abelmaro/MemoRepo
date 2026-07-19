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
  return `Required evidence flow: start with list_space_repositories when project names are unclear. Run snapshot_index_coverage before coverage or absence claims and require exhaustive=true; candidate files are not proof of CBM graph membership. Use CBM get_architecture and graph/search tools for structure and symbol discovery, but use search_snapshot_text for exact or exhaustive questions and read_snapshot_file to verify final source evidence. Use list_snapshot_files for path or extension inventories. Continue every offset page until has_more=false. Never claim that text, files, symbols, or relationships are absent when complete=false, truncated=true, coverage is partial/unknown, exhaustive=false, or pagination remains. Use get_graph_schema before custom Cypher and label inferred graph relationships as inference unless exact source verifies them. Tool availability is negotiated with the installed CBM engine. Search limits cap at ${SNAPSHOT_SEARCH_RESULT_MAX} results and query_graph at ${SNAPSHOT_QUERY_GRAPH_MAX_ROWS} rows.`;
}
