import assert from "node:assert/strict";
import { test } from "node:test";
import { createCbmEnvironment } from "../src/services/cbmService.js";

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
