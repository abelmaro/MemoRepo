import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { schema } from "../src/db/schema.js";
import { recordMcpToolMetric } from "../src/services/mcpToolStats.js";

test("MCP tool metrics aggregate duration, errors, cache hits, truncation, and bytes", () => {
  const sqlite = new Database(":memory:");
  const database = { sqlite, db: drizzle(sqlite, { schema }) };
  try {
    migrate(sqlite);
    sqlite.exec(`INSERT INTO spaces (id, name, slug, root_path, snapshot_status, snapshot_status_updated_at, created_at, updated_at)
      VALUES ('spc_test', 'Test', 'test', '/tmp/test', 'none', '2026-01-01', '2026-01-01', '2026-01-01')`);
    recordMcpToolMetric(database, { spaceId: "spc_test", toolName: "search_graph", durationMs: 10.4, responseBytes: 100 });
    recordMcpToolMetric(database, { spaceId: "spc_test", toolName: "search_graph", durationMs: 20.8, responseBytes: 50,
      error: true, cacheHit: true, truncated: true });
    const row = sqlite.prepare("SELECT * FROM mcp_tool_stats").get() as Record<string, number>;
    assert.equal(row.call_count, 2);
    assert.equal(row.total_response_bytes, 150);
    assert.equal(row.max_response_bytes, 100);
    assert.equal(row.total_duration_ms, 31);
    assert.equal(row.max_duration_ms, 21);
    assert.equal(row.error_count, 1);
    assert.equal(row.cache_hit_count, 1);
    assert.equal(row.truncated_count, 1);
  } finally { sqlite.close(); }
});
