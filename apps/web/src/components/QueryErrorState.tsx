import { AlertTriangle, RefreshCw } from "lucide-react";

export function QueryErrorState({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="query-error-state" role="alert">
      <AlertTriangle size={20} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span>{error instanceof Error ? error.message : "MemoRepo could not load this information."}</span>
      </div>
      <button className="secondary-button compact-button" type="button" onClick={onRetry}>
        <RefreshCw size={16} aria-hidden="true" />
        <span>Try again</span>
      </button>
    </div>
  );
}
