import assert from "node:assert/strict";
import {
  compileSemanticGraph,
  sampleSemanticGraph,
  validateWorkflowGraph,
  buildEmptyGraph,
} from "./word-graph-compiler.js";

function testSampleGraphCompiles() {
  const result = compileSemanticGraph(sampleSemanticGraph());
  assert.equal(result.errors.length, 0, result.errors.join("; "));
  const types = new Set(result.nodes.map((n) => n.type));
  assert.ok(types.has("conversation"));
  assert.ok(types.has("qa"));
  assert.ok(types.has("userInput"));
  assert.ok(types.has("react"));
  assert.ok(types.has("end"));
  assert.ok(types.has("start"));
  console.log("testSampleGraphCompiles: ok");
}

function testEmptyGraph() {
  const result = buildEmptyGraph();
  assert.equal(result.errors.length, 0);
  console.log("testEmptyGraph: ok");
}

function testCycleRejected() {
  const bad = {
    startAt: "a",
    nodes: [
      { id: "a", type: "conversation" as const, say: "Hi", nextGoesTo: "b" },
      { id: "b", type: "conversation" as const, say: "Again", nextGoesTo: "a" },
      { id: "end", type: "end" as const, endStatus: "Completed" as const },
    ],
  };
  const result = compileSemanticGraph(bad);
  assert.ok(result.errors.some((e) => e.includes("cycle") || e.includes("end")));
  console.log("testCycleRejected: ok");
}

function testAllPathsReachEnd() {
  const result = compileSemanticGraph(sampleSemanticGraph());
  const validation = validateWorkflowGraph(result.nodes, result.edges);
  assert.equal(validation.errors.length, 0);
  console.log("testAllPathsReachEnd: ok");
}

testSampleGraphCompiles();
testEmptyGraph();
testCycleRejected();
testAllPathsReachEnd();
console.log("All word-graph-compiler tests passed");
