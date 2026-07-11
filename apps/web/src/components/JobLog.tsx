import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, subscribeToJobEvents, type Job, type JobEvent } from "../lib/api";
import { QueryErrorState } from "./QueryErrorState";

interface JobLogProps {
  jobId: string;
  onJob?: (jobId: string) => void;
}

export function JobLog({ jobId, onJob }: JobLogProps) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<JobEvent[]>([]);
  const jobQuery = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api<{ job: Job; dependency: Job | null; dependents: Job[]; events: JobEvent[] }>(`/api/jobs/${jobId}`),
    refetchInterval: 2500
  });
  const retryMutation = useMutation({
    mutationFn: () => api<{ job: Job }>(`/api/jobs/${jobId}/retry`, { method: "POST", body: "{}" }),
    onSuccess: ({ job }) => {
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      onJob?.(job.id);
    }
  });
  const cancelMutation = useMutation({
    mutationFn: () => api<{ job: Job }>(`/api/jobs/${jobId}/cancel`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["job", jobId] });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    }
  });

  useEffect(() => {
    setEvents(jobQuery.data?.events ?? []);
  }, [jobQuery.data?.events]);

  useEffect(() => {
    return subscribeToJobEvents(`/api/jobs/${jobId}/events`, (parsed) => {
      setEvents((current) => {
        if (current.some((existing) => existing.id === parsed.id)) {
          return current;
        }
        return [...current, parsed];
      });
    });
  }, [jobId]);

  const mutationError = retryMutation.error ?? cancelMutation.error;
  const mutationErrorMessage = mutationError instanceof Error ? mutationError.message : mutationError ? String(mutationError) : null;
  const dependentCount = jobQuery.data?.dependents.length ?? 0;

  return (
    <div className="job-log">
      {jobQuery.isError ? (
        <QueryErrorState title="Job details could not be loaded" error={jobQuery.error} onRetry={() => void jobQuery.refetch()} />
      ) : null}
      <div className="job-log-meta">
        <span>{jobQuery.data?.job.type ?? "job"}</span>
        <span>{jobQuery.data?.job.status ?? "loading"}</span>
      </div>
      <div className="job-log-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={() => retryMutation.mutate()}
          disabled={!canRetry(jobQuery.data?.job.status) || retryMutation.isPending}
        >
          <span>Retry</span>
        </button>
        <button
          className="secondary-button danger"
          type="button"
          onClick={() => cancelMutation.mutate()}
          disabled={jobQuery.data?.job.status !== "pending" || cancelMutation.isPending}
        >
          <span>Cancel</span>
        </button>
      </div>
      {jobQuery.data?.dependency ? (
        <div className="job-log-dependency">
          Depends on {jobQuery.data.dependency.type.replaceAll("_", " ")} · {jobQuery.data.dependency.status}
        </div>
      ) : null}
      {dependentCount > 0 ? (
        <div className="job-log-dependency">{dependentCount} dependent jobs</div>
      ) : null}
      <pre>
        {events.map((event) => `[${new Date(event.created_at).toLocaleTimeString()}] ${event.message}`).join("\n") ||
          "Waiting for job events..."}
      </pre>
      {mutationErrorMessage ? (
        <div className="repo-error">{mutationErrorMessage}</div>
      ) : null}
    </div>
  );
}

function canRetry(status: string | undefined): boolean {
  return status === "failed" || status === "skipped" || status === "cancelled";
}
