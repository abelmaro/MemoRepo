import type { AppDatabase } from "../db/connection.js";
import { nowIso } from "../domain/time.js";

export interface McpToolMetric {
  spaceId: string;
  toolName: string;
  durationMs: number;
  responseBytes?: number;
  error?: boolean;
  cacheHit?: boolean;
  truncated?: boolean;
}

export function recordMcpToolMetric(database: AppDatabase, metric: McpToolMetric): void {
  const bytes = bounded(metric.responseBytes ?? 0);
  const duration = bounded(metric.durationMs);
  database.sqlite.prepare(`
    INSERT INTO mcp_tool_stats (
      space_id, tool_name, call_count, total_response_bytes, max_response_bytes,
      total_duration_ms, max_duration_ms, error_count, cache_hit_count, truncated_count, last_called_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(space_id, tool_name) DO UPDATE SET
      call_count = call_count + 1,
      total_response_bytes = total_response_bytes + excluded.total_response_bytes,
      max_response_bytes = MAX(max_response_bytes, excluded.max_response_bytes),
      total_duration_ms = total_duration_ms + excluded.total_duration_ms,
      max_duration_ms = MAX(max_duration_ms, excluded.max_duration_ms),
      error_count = error_count + excluded.error_count,
      cache_hit_count = cache_hit_count + excluded.cache_hit_count,
      truncated_count = truncated_count + excluded.truncated_count,
      last_called_at = excluded.last_called_at
  `).run(metric.spaceId, metric.toolName, bytes, bytes, duration, duration, metric.error ? 1 : 0,
    metric.cacheHit ? 1 : 0, metric.truncated ? 1 : 0, nowIso());
}

function bounded(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(value)) : 0;
}
