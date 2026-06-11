import type { Edge, Node } from "reactflow";
import type { NodeData, WorkflowTools } from "@/components/workflow/types";
import { apiFetch } from "./client";

export type WorkflowLock = {
  userId: string;
  userName: string;
  expiresAt: number;
};

export type WorkflowRecord = {
  id: string;
  name: string;
  context: string;
  tools: WorkflowTools;
  nodes: Node<NodeData>[];
  edges: Edge[];
  status: string;
  updatedAt: number;
  lock?: WorkflowLock | null;
};

export type WorkflowCreator = {
  id: string;
  name: string;
};

export type WorkflowSummary = {
  id: string;
  name: string;
  status: string;
  updatedAt: number;
  createdBy?: WorkflowCreator;
};

export async function listWorkflows() {
  return apiFetch<{ workflows: WorkflowSummary[] }>("/api/workflows");
}

export async function getWorkflow(id: string) {
  return apiFetch<{ workflow: WorkflowRecord }>(`/api/workflows/${id}`);
}

export async function createWorkflow(payload?: Partial<WorkflowRecord>) {
  return apiFetch<{ workflow: WorkflowRecord }>("/api/workflows", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export async function updateWorkflow(
  id: string,
  payload: Partial<
    Pick<WorkflowRecord, "name" | "context" | "tools" | "nodes" | "edges" | "status">
  > & { expectedUpdatedAt?: number },
) {
  return apiFetch<{ workflow: WorkflowRecord }>(`/api/workflows/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteWorkflow(id: string) {
  return apiFetch<{ ok: boolean }>(`/api/workflows/${id}`, { method: "DELETE" });
}

export async function publishWorkflow(id: string) {
  return apiFetch<{
    version: { id: string; workflowId: string; versionNumber: number; createdAt: number };
  }>(`/api/workflows/${id}/publish`, { method: "POST" });
}

export async function acquireWorkflowLock(id: string) {
  return apiFetch<{ ok: boolean; expiresAt: number }>(`/api/workflows/${id}/lock`, {
    method: "POST",
  });
}

export async function releaseWorkflowLock(id: string) {
  return apiFetch<{ ok: boolean }>(`/api/workflows/${id}/lock`, { method: "DELETE" });
}
