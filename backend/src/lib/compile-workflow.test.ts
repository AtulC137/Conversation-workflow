import assert from "node:assert/strict";
import { compileWordGraph } from "./compile-workflow.js";

async function testCompileExampleScript() {
  const script = `Start: greet caller about {{reason}}. Wait for yes/no. Silence 8s → goodbye.
If yes: ask open questions using their excel row (Q&A block).
If no: say goodbye and end.
After Q&A: LLM explains loan details. Then end.`;

  const result = await compileWordGraph(script);
  assert.equal(result.errors.length, 0, result.errors.join("; "));
  const types = new Set(result.nodes.map((n) => n.type));
  assert.ok(types.has("conversation"));
  assert.ok(types.has("qa"));
  assert.ok(types.has("userInput"));
  assert.ok(types.has("react"));
  assert.ok(types.has("end"));
  console.log("testCompileExampleScript: ok", result.nodes.length, "nodes");
}

testCompileExampleScript().catch((err) => {
  console.error(err);
  process.exit(1);
});
