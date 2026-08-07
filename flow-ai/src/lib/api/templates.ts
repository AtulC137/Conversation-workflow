import type { Edge, Node } from "reactflow";
import type { NodeData, WorkflowTools } from "@/components/workflow/types";
import { apiFetch } from "./client";

export type TemplateLock = {
  userId: string;
  userName: string;
  expiresAt: number;
};

export type TemplateRecord = {
  id: string;
  name: string;
  prompt: string;
  script: string;
  confirmationQuestion?: string;
  tools: WorkflowTools;
  nodes: Node<NodeData>[];
  edges: Edge[];
  status: string;
  updatedAt: number;
  lock?: TemplateLock | null;
};

export type TemplateCreator = {
  id: string;
  name: string;
};

export type TemplateSummary = {
  id: string;
  name: string;
  status: string;
  updatedAt: number;
  createdBy?: TemplateCreator;
};

export async function listTemplates() {
  return apiFetch<{ templates: TemplateSummary[] }>("/api/templates");
}

export async function getTemplate(id: string) {
  return apiFetch<{ template: TemplateRecord }>(`/api/templates/${id}`);
}

export async function createTemplate(payload?: Partial<TemplateRecord>) {
  return apiFetch<{ template: TemplateRecord }>("/api/templates", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export async function createTemplateFromPrompt(payload: {
  name?: string;
  prompt: string;
  confirmationQuestion?: string;
  script?: string;
  tools?: WorkflowTools;
}) {
  return apiFetch<{ template: TemplateRecord }>("/api/templates/from-prompt", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export type CompileScriptResult = {
  nodes: Node<NodeData>[];
  edges: Edge[];
  warnings: string[];
  errors: string[];
  attempts: number;
};

export async function compileScript(script: string) {
  return apiFetch<CompileScriptResult>("/api/templates/compile-script", {
    method: "POST",
    body: JSON.stringify({ script }),
  });
}

export async function updateTemplate(
  id: string,
  payload: Partial<
    Pick<
      TemplateRecord,
      "name" | "prompt" | "script" | "confirmationQuestion" | "tools" | "nodes" | "edges" | "status"
    >
  > & {
    expectedUpdatedAt?: number;
  },
) {
  return apiFetch<{ template: TemplateRecord }>(`/api/templates/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteTemplate(id: string) {
  return apiFetch<{ ok: boolean }>(`/api/templates/${id}`, { method: "DELETE" });
}

export async function publishTemplate(id: string) {
  return apiFetch<{
    version: { id: string; templateId: string; versionNumber: number; createdAt: number };
  }>(`/api/templates/${id}/publish`, { method: "POST" });
}

export async function acquireTemplateLock(id: string) {
  return apiFetch<{ ok: boolean; expiresAt: number }>(`/api/templates/${id}/lock`, {
    method: "POST",
  });
}

export async function releaseTemplateLock(id: string) {
  return apiFetch<{ ok: boolean }>(`/api/templates/${id}/lock`, { method: "DELETE" });
}

