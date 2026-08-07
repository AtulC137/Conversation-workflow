import type { Edge, Node } from "reactflow";

import type { NodeData } from "@/components/workflow/types";



export type WorkflowGraphNode = {

  id: string;

  type: "start" | "conversation" | "qa" | "userInput" | "react" | "end";

  title?: string;

  message?: string;

  instruction?: string;

  replyGuide?: string;

  waitForResponse?: boolean;

  silenceTimeoutSec?: number;

  responses?: { id: string; label: string; examples?: string[] }[];

  status?: string;

};



export type WorkflowGraphEdge = {

  source: string;

  target: string;

  sourceHandle: string | null;

};



export type WorkflowGraph = {

  nodes: WorkflowGraphNode[];

  edges: WorkflowGraphEdge[];

};



export type VoiceSessionConfig = {

  context: string;

  example: string;

  endPoints: string[];

  greeting: string | null;

  graph: WorkflowGraph;

};



function findNextNode(

  nodeId: string,

  sourceHandle: string | null,

  nodes: Node<NodeData>[],

  edges: Edge[],

): Node<NodeData> | null {

  const edge = edges.find(

    (e) => e.source === nodeId && (e.sourceHandle ?? null) === sourceHandle,

  );

  if (!edge) return null;

  return nodes.find((n) => n.id === edge.target) ?? null;

}



function getStartNode(nodes: Node<NodeData>[]) {

  return nodes.find((n) => n.type === "start") ?? null;

}



function collectEndPoints(nodes: Node<NodeData>[]): string[] {

  const points: string[] = [];

  for (const node of nodes) {

    if (node.type !== "end") continue;

    const status = node.data.status?.trim() || "Completed";

    if (!points.includes(status)) points.push(status);

  }

  return points;

}



function findFirstConversationMessage(nodes: Node<NodeData>[], edges: Edge[]): string | null {

  const start = getStartNode(nodes);

  if (!start) return null;



  let node: Node<NodeData> | null = start;

  const visited = new Set<string>();



  while (node && !visited.has(node.id)) {

    visited.add(node.id);

    if (node.type === "conversation") {

      const msg = node.data.message?.trim();

      if (msg) return msg;

    }

    if (node.type === "start") {

      node = findNextNode(node.id, null, nodes, edges);

      continue;

    }

    if (node.type === "conversation") {

      node = findNextNode(node.id, "ai-out", nodes, edges);

      continue;

    }

    break;

  }



  return null;

}



function walkPath(

  nodeId: string,

  nodes: Node<NodeData>[],

  edges: Edge[],

  lines: string[],

  visited: Set<string>,

): void {

  if (visited.has(nodeId)) return;

  visited.add(nodeId);



  const node = nodes.find((n) => n.id === nodeId);

  if (!node) return;



  if (node.type === "start") {

    const next = findNextNode(node.id, null, nodes, edges);

    if (next) walkPath(next.id, nodes, edges, lines, visited);

    return;

  }



  if (node.type === "userInput") {

    const instruction = node.data.instruction?.trim() || "Check context and tell the user all relevant details.";

    lines.push(`AI [from context]: ${instruction}`);

    const responses = node.data.responses ?? [];

    if (responses.length === 0) {

      const waitForResponse = node.data.waitForResponse !== false;

      if (waitForResponse) {

        lines.push("User (acknowledged):");

      }

      const next = findNextNode(node.id, "ai-out", nodes, edges);

      if (next) {

        const branchVisited = waitForResponse ? new Set(visited) : visited;

        walkPath(next.id, nodes, edges, lines, branchVisited);

      }

      return;

    }



    for (const branch of responses) {

      const branchLabel = branch.label.trim() || "Response";

      const examples = (branch.examples ?? []).map((e) => e.trim()).filter(Boolean);

      const exampleHint = examples.length > 0 ? ` — e.g. "${examples.join('", "')}"` : "";

      lines.push(`User (${branchLabel})${exampleHint}:`);



      const next = findNextNode(node.id, branch.id, nodes, edges);

      if (next) {

        const branchVisited = new Set(visited);

        walkPath(next.id, nodes, edges, lines, branchVisited);

      }

    }

    return;

  }



  if (node.type === "react") {

    const instruction =

      node.data.instruction?.trim() ||

      "Respond to the caller's last reply using context and this instruction.";

    lines.push(`AI [react to caller]: ${instruction}`);

    const replyGuide = node.data.replyGuide?.trim();

    if (replyGuide) {

      lines.push(`AI [react]: (reply) ${replyGuide}`);

    }

    lines.push("User (previous reply): …");

    const responses = node.data.responses ?? [];

    if (responses.length === 0) {

      const waitForResponse = node.data.waitForResponse !== false;

      if (waitForResponse) {

        lines.push("User (acknowledged):");

      }

      const next = findNextNode(node.id, "ai-out", nodes, edges);

      if (next) {

        const branchVisited = waitForResponse ? new Set(visited) : visited;

        walkPath(next.id, nodes, edges, lines, branchVisited);

      }

      return;

    }

    for (const branch of responses) {

      const branchLabel = branch.label.trim() || "Response";

      const examples = (branch.examples ?? []).map((e) => e.trim()).filter(Boolean);

      const exampleHint = examples.length > 0 ? ` — e.g. "${examples.join('", "')}"` : "";

      lines.push(`User (${branchLabel})${exampleHint}:`);

      const next = findNextNode(node.id, branch.id, nodes, edges);

      if (next) {

        const branchVisited = new Set(visited);

        walkPath(next.id, nodes, edges, lines, branchVisited);

      }

    }

    return;

  }



  if (node.type === "conversation" || node.type === "qa") {

    const msg = node.data.message?.trim();

    if (msg) lines.push(`AI: ${msg}`);



    const responses = node.data.responses ?? [];

    if (responses.length === 0) {

      const next = findNextNode(node.id, "ai-out", nodes, edges);

      if (next) walkPath(next.id, nodes, edges, lines, visited);

      return;

    }



    for (const branch of responses) {

      const branchLabel = branch.label.trim() || "Response";

      const examples = (branch.examples ?? []).map((e) => e.trim()).filter(Boolean);

      const exampleHint = examples.length > 0 ? ` — e.g. "${examples.join('", "')}"` : "";

      lines.push(`User (${branchLabel})${exampleHint}:`);



      const next = findNextNode(node.id, branch.id, nodes, edges);

      if (next) {

        const branchVisited = new Set(visited);

        walkPath(next.id, nodes, edges, lines, branchVisited);

      }

    }

    return;

  }



  if (node.type === "end") {

    const status = node.data.status?.trim() || "Completed";

    lines.push(`END: ${status}`);

  }

}



function buildExampleScript(nodes: Node<NodeData>[], edges: Edge[]): string {

  const start = getStartNode(nodes);

  if (!start) return "AI: Hello! How can I help you today?";



  const lines: string[] = [];

  walkPath(start.id, nodes, edges, lines, new Set());

  return lines.length > 0 ? lines.join("\n") : "AI: Hello! How can I help you today?";

}



export function serializeWorkflowGraph(

  nodes: Node<NodeData>[],

  edges: Edge[],

): WorkflowGraph {

  const graphNodes: WorkflowGraphNode[] = nodes

    .filter(
      (n) =>
        n.type === "start" ||
        n.type === "conversation" ||
        n.type === "qa" ||
        n.type === "userInput" ||
        n.type === "react" ||
        n.type === "end",
    )

    .map((n) => {

      if (n.type === "start") {

        return { id: n.id, type: "start" as const, title: n.data.title };

      }

      if (n.type === "end") {

        return {

          id: n.id,

          type: "end" as const,

          title: n.data.title,

          status: n.data.status,

        };

      }

      if (n.type === "qa") {

        return {

          id: n.id,

          type: "qa" as const,

          title: n.data.title,

          message: n.data.message,

          responses: (n.data.responses ?? []).map((r) => ({

            id: r.id,

            label: r.label,

            examples: r.examples?.filter(Boolean),

          })),

          silenceTimeoutSec: n.data.silenceTimeoutSec,

        };

      }

      if (n.type === "userInput") {

        return {

          id: n.id,

          type: "userInput" as const,

          title: n.data.title,

          instruction: n.data.instruction,

          waitForResponse: n.data.waitForResponse,

          responses: (n.data.responses ?? []).map((r) => ({

            id: r.id,

            label: r.label,

            examples: r.examples?.filter(Boolean),

          })),

          silenceTimeoutSec: n.data.silenceTimeoutSec,

        };

      }

      if (n.type === "react") {

        return {

          id: n.id,

          type: "react" as const,

          title: n.data.title,

          instruction: n.data.instruction,

          replyGuide: n.data.replyGuide,

          waitForResponse: n.data.waitForResponse,

          responses: (n.data.responses ?? []).map((r) => ({

            id: r.id,

            label: r.label,

            examples: r.examples?.filter(Boolean),

          })),

          silenceTimeoutSec: n.data.silenceTimeoutSec,

        };

      }

      return {

        id: n.id,

        type: "conversation" as const,

        title: n.data.title,

        message: n.data.message,

        waitForResponse: n.data.waitForResponse,

        silenceTimeoutSec: n.data.silenceTimeoutSec,

        responses: (n.data.responses ?? []).map((r) => ({

          id: r.id,

          label: r.label,

          examples: r.examples?.filter(Boolean),

        })),

      };

    });



  const graphEdges: WorkflowGraphEdge[] = edges.map((e) => ({

    source: e.source,

    target: e.target,

    sourceHandle: e.sourceHandle ?? null,

  }));



  return { nodes: graphNodes, edges: graphEdges };

}



export function workflowToPrompt(

  nodes: Node<NodeData>[],

  edges: Edge[],

  workflowContext: string,

): VoiceSessionConfig {

  const greeting = findFirstConversationMessage(nodes, edges);

  return {

    context: workflowContext.trim(),

    example: buildExampleScript(nodes, edges),

    endPoints: collectEndPoints(nodes),

    greeting,

    graph: serializeWorkflowGraph(nodes, edges),

  };

}



export function graphHasQaBlock(nodes: Node<NodeData>[]): boolean {

  return nodes.some((n) => n.type === "qa");

}


