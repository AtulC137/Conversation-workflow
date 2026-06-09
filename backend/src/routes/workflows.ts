import { Prisma } from "@prisma/client";
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { routeParam } from "../lib/params.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";

const toolsSchema = z.object({
  voice: z.object({ enabled: z.boolean() }),
  whatsapp: z.object({ enabled: z.boolean(), phoneNumber: z.string() }),
});

const workflowBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  context: z.string().optional(),
  tools: toolsSchema.optional(),
  nodes: z.array(z.unknown()).optional(),
  edges: z.array(z.unknown()).optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
});

function toClientWorkflow(w: {
  id: string;
  name: string;
  context: string;
  tools: unknown;
  nodes: unknown;
  edges: unknown;
  status: string;
  updatedAt: Date;
}) {
  return {
    id: w.id,
    name: w.name,
    context: w.context,
    tools: w.tools,
    nodes: w.nodes,
    edges: w.edges,
    status: w.status,
    updatedAt: w.updatedAt.getTime(),
  };
}

const defaultTools = {
  voice: { enabled: false },
  whatsapp: { enabled: false, phoneNumber: "" },
};

const defaultNodes = [
  {
    id: "start",
    type: "start",
    position: { x: 80, y: 220 },
    data: { title: "Start" },
  },
];

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export const workflowsRouter = Router();
workflowsRouter.use(requireAuth);

workflowsRouter.get("/", async (req: AuthedRequest, res) => {
  const rows = await prisma.workflow.findMany({
    where: { userId: req.user!.id, status: { not: "archived" } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, status: true, updatedAt: true },
  });
  res.json({
    workflows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      updatedAt: r.updatedAt.getTime(),
    })),
  });
});

workflowsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const wf = await prisma.workflow.findFirst({
    where: { id, userId: req.user!.id },
  });
  if (!wf) {
    res.status(404).json({ error: "Workflow not found" });
    return;
  }
  res.json({ workflow: toClientWorkflow(wf) });
});

workflowsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = workflowBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const data = parsed.data;
  const wf = await prisma.workflow.create({
    data: {
      id: uuidv4(),
      userId: req.user!.id,
      name: data.name ?? "Untitled workflow",
      context: data.context ?? "",
      tools: asJson(data.tools ?? defaultTools),
      nodes: asJson(data.nodes ?? defaultNodes),
      edges: asJson(data.edges ?? []),
    },
  });

  res.status(201).json({ workflow: toClientWorkflow(wf) });
});

workflowsRouter.put("/:id", async (req: AuthedRequest, res) => {
  const parsed = workflowBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const id = routeParam(req.params.id);
  const existing = await prisma.workflow.findFirst({
    where: { id, userId: req.user!.id },
  });
  if (!existing) {
    res.status(404).json({ error: "Workflow not found" });
    return;
  }

  const data = parsed.data;
  const wf = await prisma.workflow.update({
    where: { id: existing.id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.context !== undefined && { context: data.context }),
      ...(data.tools !== undefined && { tools: asJson(data.tools) }),
      ...(data.nodes !== undefined && { nodes: asJson(data.nodes) }),
      ...(data.edges !== undefined && { edges: asJson(data.edges) }),
      ...(data.status !== undefined && { status: data.status }),
    },
  });

  res.json({ workflow: toClientWorkflow(wf) });
});

workflowsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const existing = await prisma.workflow.findFirst({
    where: { id, userId: req.user!.id },
  });
  if (!existing) {
    res.status(404).json({ error: "Workflow not found" });
    return;
  }

  await prisma.workflow.update({
    where: { id: existing.id },
    data: { status: "archived" },
  });

  res.json({ ok: true });
});

workflowsRouter.post("/:id/publish", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const wf = await prisma.workflow.findFirst({
    where: { id, userId: req.user!.id },
  });
  if (!wf) {
    res.status(404).json({ error: "Workflow not found" });
    return;
  }

  const lastVersion = await prisma.workflowVersion.findFirst({
    where: { workflowId: wf.id },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });

  const versionNumber = (lastVersion?.versionNumber ?? 0) + 1;
  const snapshot = {
    name: wf.name,
    context: wf.context,
    tools: wf.tools,
    nodes: wf.nodes,
    edges: wf.edges,
  };

  const version = await prisma.$transaction(async (tx) => {
    const v = await tx.workflowVersion.create({
      data: {
        id: uuidv4(),
        workflowId: wf.id,
        versionNumber,
        snapshot: asJson(snapshot),
        publishedBy: req.user!.id,
      },
    });
    await tx.workflow.update({
      where: { id: wf.id },
      data: { status: "published" },
    });
    return v;
  });

  res.status(201).json({
    version: {
      id: version.id,
      workflowId: version.workflowId,
      versionNumber: version.versionNumber,
      createdAt: version.createdAt.getTime(),
    },
  });
});

workflowsRouter.get("/:id/versions", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const wf = await prisma.workflow.findFirst({
    where: { id, userId: req.user!.id },
  });
  if (!wf) {
    res.status(404).json({ error: "Workflow not found" });
    return;
  }

  const versions = await prisma.workflowVersion.findMany({
    where: { workflowId: wf.id },
    orderBy: { versionNumber: "desc" },
    select: { id: true, versionNumber: true, createdAt: true },
  });

  res.json({
    versions: versions.map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      createdAt: v.createdAt.getTime(),
    })),
  });
});
