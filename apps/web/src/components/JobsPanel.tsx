import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, type Job } from "../lib/api";

export function JobsPanel({ onSelectJob }: { onSelectJob: (jobId: string) => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(true);
  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<{ jobs: Job[] }>("/api/jobs"),
    refetchInterval: open ? 3000 : false
  });

  return (
    <section className="jobs-panel">
      <div className="jobs-header">
        <button className="panel-toggle" type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
          <h2>Recent jobs</h2>
        </button>
        <button className="text-button" type="button" onClick={() => void queryClient.invalidateQueries({ queryKey: ["jobs"] })}>
          Refresh
        </button>
      </div>
      {open ? (
        <div className="jobs-terminal" aria-label="Recent jobs terminal">
          {(jobsQuery.data?.jobs ?? []).slice(0, 8).map((job) => (
            <button className="job-terminal-row" type="button" key={job.id} onClick={() => onSelectJob(job.id)}>
              <span className="job-terminal-time">{formatJobTime(job)}</span>
              <span className={`job-terminal-status job-terminal-status-${job.status}`}>{formatJobStatus(job.status)}</span>
              <span className="job-terminal-type">{formatJobType(job.type)}</span>
              {job.error || jobDependencyText(job) ? <span className="job-terminal-error">{job.error ?? jobDependencyText(job)}</span> : null}
            </button>
          ))}
          {(jobsQuery.data?.jobs ?? []).length === 0 ? <div className="job-terminal-empty">No jobs yet.</div> : null}
        </div>
      ) : null}
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
