import type { Edge, Node } from "reactflow";
import { defaultWorkflowTools, type NodeData, type WorkflowTools } from "./types";
import {
  createLoanReminderTemplate,
  DEFAULT_WORKFLOW_CONTEXT,
  LOAN_REMINDER_TEMPLATE_ID,
} from "./templateWorkflow";

export type WorkflowSeed = {
  id: string;
  name: string;
  nodes: Node<NodeData>[];
  edges: Edge[];
  tools: WorkflowTools;
  context: string;
  updatedAt: number;
};

// Each new workflow starts with just a Start node.
export function createInitialNodes(): Node<NodeData>[] {
  return [
    {
      id: "start",
      type: "start",
      position: { x: 80, y: 220 },
      data: { title: "Start" },
    },
  ];
}

export function createInitialEdges(): Edge[] {
  return [];
}

export function createLoanReminderWorkflow(): WorkflowSeed {
  const { nodes, edges } = createLoanReminderTemplate();
  return {
    id: LOAN_REMINDER_TEMPLATE_ID,
    name: "Loan Payment Reminder",
    nodes,
    edges,
    tools: defaultWorkflowTools(),
    context: DEFAULT_WORKFLOW_CONTEXT,
    updatedAt: Date.now(),
  };
}
