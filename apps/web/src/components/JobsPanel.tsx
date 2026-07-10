import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { api, type Job } from "../lib/api";

export function JobsPanel({ onSelectJob }: { onSelectJob: (jobId: string) => void }) {
  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<{ jobs: Job[] }>("/api/jobs"),
    refetchInterval: 3000
  });

  return (
    <section className="jobs-panel management-panel" aria-labelledby="activity-title">
      <div className="panel-heading with-icon">
        <Activity size={20} />
        <div>
          <h3 id="activity-title">Recent activity</h3>
          <p>Open an operation to inspect logs, dependencies, and retry options.</p>
        </div>
      </div>
      <div className="jobs-terminal" aria-label="Recent operations" aria-live="polite">
        {(jobsQuery.data?.jobs ?? []).slice(0, 8).map((job) => (
          <button className="job-terminal-row" type="button" key={job.id} onClick={() => onSelectJob(job.id)}>
            <span className="job-terminal-time">{formatJobTime(job)}</span>
            <span className={`job-terminal-status job-terminal-status-${job.status}`}>{formatJobStatus(job.status)}</span>
            <span className="job-terminal-type">{formatJobType(job.type)}</span>
            {job.error || jobDependencyText(job) ? <span className="job-terminal-error">{job.error ?? jobDependencyText(job)}</span> : null}
          </button>
        ))}
        {(jobsQuery.data?.jobs ?? []).length === 0 ? <div className="job-terminal-empty">No operations yet.</div> : null}
      </div>
    </section>
  );
}

function formatJobType(type: string): string {
  return type.replaceAll("_", " ");
}

function formatJobStatus(status: string): string {
  if (status === "pending") {
    return "queued";
  }
  return status.replaceAll("_", " ");
}

function formatJobTime(job: Job): string {
  const timestamp = job.finished_at ?? job.started_at ?? job.created_at;
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function jobDependencyText(job: Job): string | null {
  if (!job.depends_on_job_id || !job.dependency_status || job.dependency_status === "succeeded") {
    return null;
  }
  return `blocked by ${formatJobType(job.dependency_type ?? "dependency")} (${formatJobStatus(job.dependency_status)})`;
}
