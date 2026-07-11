import assert from "node:assert/strict";
import test from "node:test";
import { sanitizePublicMessage } from "../src/domain/publicSanitize.js";

test("public messages redact managed paths in Windows and portable forms", () => {
  const root = "C:\\Users\\example\\MemoRepo";
  assert.equal(sanitizePublicMessage(new Error(`failed at ${root}\\snapshots\\one`), [root]), "failed at [MANAGED_PATH]\\snapshots\\one");
  assert.equal(sanitizePublicMessage(`failed at C:/Users/example/MemoRepo/indexes/one`, [root]), "failed at [MANAGED_PATH]/indexes/one");
  assert.equal(sanitizePublicMessage(`FAILED AT c:\\users\\example\\memorepo\\db.sqlite`, [root]), "FAILED AT [MANAGED_PATH]\\db.sqlite");
});
