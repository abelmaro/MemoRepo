import assert from "node:assert/strict";
import test from "node:test";
import { snapshotToolWorkflow } from "../src/services/snapshotAgentInstructions.js";

test("snapshot workflow requires source verification and complete pagination before absence claims", () => {
  const workflow = snapshotToolWorkflow();
  assert.match(workflow, /snapshot_index_coverage/);
  assert.match(workflow, /exhaustive=true/);
  assert.match(workflow, /search_snapshot_text/);
  assert.match(workflow, /read_snapshot_file/);
  assert.match(workflow, /has_more=false/);
  assert.match(workflow, /Never claim.*absent.*complete=false.*truncated=true.*exhaustive=false/);
  assert.match(workflow, /graph relationships as inference/);
});
