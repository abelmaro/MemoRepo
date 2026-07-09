const PUBLIC_JOB_COLUMN_NAMES = [
  "id",
  "type",
  "status",
  "space_id",
  "space_repository_id",
  "depends_on_job_id",
  "payload_json",
  "error",
  "created_at",
  "started_at",
  "finished_at"
] as const;

type JobTableAlias = "j" | "d";

export function publicJobSelectColumns(alias?: JobTableAlias): string {
  const prefix = alias ? `${alias}.` : "";
  return PUBLIC_JOB_COLUMN_NAMES.map((column) => `${prefix}${column}`).join(",\n          ");
}
