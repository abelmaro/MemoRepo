interface StatusBadgeProps {
  status: string;
  tone?: "green" | "blue" | "red" | "amber" | "gray";
}

const statusTone: Record<string, StatusBadgeProps["tone"]> = {
  cloned: "green",
  indexed: "blue",
  active: "green",
  complete: "green",
  partial: "amber",
  degraded: "red",
  unknown: "gray",
  stale: "amber",
  failed: "red",
  missing: "red",
  cloning: "amber",
  indexing: "amber",
  building: "amber",
  pending: "gray",
  running: "amber",
  succeeded: "green",
  skipped: "gray"
};

export function StatusBadge({ status, tone }: StatusBadgeProps) {
  return <span className={`status-badge status-${tone ?? statusTone[status] ?? "gray"}`}>{status.replaceAll("_", " ")}</span>;
}
