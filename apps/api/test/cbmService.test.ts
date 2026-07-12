import assert from "node:assert/strict";
import { test } from "node:test";
import { CbmToolExecutionError, createCbmEnvironment, parseCbmToolResult } from "../src/services/cbmService.js";

test("CBM receives only allowlisted system variables and explicit overrides", () => {
  const environment = createCbmEnvironment(
    "/tmp/cbm-cache",
    {
      Path: "/usr/local/bin:/usr/bin",
      TEMP: "/tmp",
      HOME: "/home/memorepo",
      GH_TOKEN: "github-secret",
      MEMOREPO_CONTROL_TOKEN: "control-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock"
    }
  );

  assert.deepEqual(environment, {
    PATH: "/usr/local/bin:/usr/bin",
    TEMP: "/tmp",
    HOME: "/home/memorepo",
    CBM_CACHE_DIR: "/tmp/cbm-cache",
    CBM_LOG_LEVEL: "warn"
  });
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.MEMOREPO_CONTROL_TOKEN, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.SSH_AUTH_SOCK, undefined);
});

test("CBM tool execution errors preserve plain-text feedback", () => {
  assert.throws(
    () => parseCbmToolResult("detect_changes", {
      isError: true,
      content: [{ type: "text", text: "project is required" }]
    }),
    (error: unknown) => error instanceof CbmToolExecutionError && error.message === "project is required"
  );
});

test("CBM tool execution errors extract JSON error messages", () => {
  assert.throws(
    () => parseCbmToolResult("search_code", {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: "project not found" }) }]
    }),
    (error: unknown) => error instanceof CbmToolExecutionError && error.message === "project not found"
  );
});

test("CBM rejects legacy embedded errors even when isError is missing", () => {
  assert.throws(
    () => parseCbmToolResult("get_graph_schema", {
      content: [{ type: "text", text: JSON.stringify({ error: "project not found or not indexed" }) }]
    }),
    /project not found or not indexed/
  );
});

test("CBM parses successful structured tool content", () => {
  assert.deepEqual(
    parseCbmToolResult("search_graph", {
      content: [{ type: "text", text: JSON.stringify({ results: [{ name: "target" }] }) }]
    }),
    { results: [{ name: "target" }] }
  );
});
