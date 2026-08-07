import { Prisma } from "@prisma/client";
import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { hasPermission } from "../lib/permissions.js";
import { prisma } from "../lib/prisma.js";
import { routeParam } from "../lib/params.js";
import {
  acquireOrExtendLock,
  getActiveLock,
  lockToClient,
  releaseLock,
} from "../lib/workflow-lock.js";
import {
  canAccessWorkflowDelete,
  canAccessWorkflowRead,
  canAccessWorkflowWrite,
  toMemberContext,
  workflowListWhere,
} from "../lib/workflow-access.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

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

const workflowPutSchema = workflowBodySchema.extend({
  expectedUpdatedAt: z.number().optional(),
});

function toClientWorkflow(
  w: {
    id: string;
    name: string;
    context: string;
    tools: unknown;
    nodes: unknown;
    edges: unknown;
    status: string;
    updatedAt: Date;
    userId: string;
    user?: { id: string; name: string };
  },
  lock?: ReturnType<typeof lockToClient>,
) {
  return {
    id: w.id,
    name: w.name,
    context: w.context,
    tools: w.tools,
    nodes: w.nodes,
    edges: w.edges,
    status: w.status,
    updatedAt: w.updatedAt.getTime(),
    createdBy: {
      id: w.user?.id ?? w.userId,
      name: w.user?.name ?? "Unknown",
    },
    lock: lock ?? null,
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
  const user = req.user!;
  const member = toMemberContext(user);
  if (
    !hasPermission(member, "workflows.view_own") &&
    !hasPermission(member, "workflows.view_all")
  ) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const rows = await prisma.workflow.findMany({
    where: workflowListWhere(user),
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      status: true,
      updatedAt: true,
      userId: true,
      user: { select: { id: true, name: true } },
    },
  });

  res.json({
    workflows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      updatedAt: r.updatedAt.getTime(),
      createdBy: { id: r.user.id, name: r.user.name },
    })),
  });
});

workflowsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const wf = await prisma.workflow.findFirst({
    where: { id, organizationId: req.user!.organizationId },
    include: { user: { select: { id: true, name: true } } },
  });
  if (!wf || !canAccessWorkflowRead(req.user!, wf)) {
    res.status(404).json({ error: "Workflow not found" });
    return;
  }

  const lock = await getActiveLock(id);
  res.json({ workflow: toClientWorkflow(wf, lockToClient(lock)) });
});

workflowsRouter.post("/:id/lock", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const wf = await prisma.workflow.findFirst({
    where: { id, organizationId: req.user!.organizationId },
  });
  if (!wf || !canAccessWorkflowWrite(req.user!, wf)) {
    res.status(404).json({ error: "Workflow not found" });
    return;
  }

  const result = await acquireOrExtendLock(id, req.user!.id);
  if (!result.ok) {
    res.status(423).json({
      error: "Workflow is locked by another user",
      lock: {
        userId: result.lockedBy.userId,
        userName: result.lockedBy.userName,
        expiresAt: result.lockedBy.expiresAt.getTime(),
      },
    });
    return;
  }

  res.json({ ok: true, expiresAt: result.expiresAt.getTime() });
});

workflowsRouter.delete("/:id/lock", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const released = await releaseLock(id, req.user!.id);
  res.json({ ok: released });
});

workflowsRouter.post("/", requirePermission("workflows.create"), async (req: AuthedRequest, res) => {
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
      organizationId: req.user!.organizationId,
      name: data.name ?? "Untitled workflow",
      context: data.context ?? "",
      script: "",
      tools: asJson(data.tools ?? defaultTools),
      nodes: asJson(data.nodes ?? defaultNodes),
      edges: asJson(data.edges ?? []),
    },
  });

  const created = await prisma.workflow.findUnique({
    where: { id: wf.id },
    include: { user: { select: { id: true, name: true } } },
  });
  res.status(201).json({ workflow: toClientWorkflow(created ?? { ...wf, user: undefined }) });
});

workflowsRouter.put("/:id", async (req: AuthedRequest, res) => {
  const parsed = workflowPutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const id = routeParam(req.params.id);
  const existing = await prisma.workflow.findFirst({
    where: { id, organizationId: req.user!.organizationId },
    include: { user: { select: { id: true, name: true } } },
  });
  if (!existing || !canAccessWorkflowWrite(req.user!, existing)) {
    res.status(404).json({ error: "Workflow not found" });
    return;
  }

  const data = parsed.data;
  if (
    data.expectedUpdatedAt !== undefined &&
    existing.updatedAt.getTime() > data.expectedUpdatedAt
  ) {
    const lock = await getActiveLock(id);
    res.status(409).json({
      error: "Workflow was modified by another user",
      workflow: toClientWorkflow(existing, lockToClient(lock)),
    });
    return;
  }

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

  const updated = await prisma.workflow.findUnique({
    where: { id: wf.id },
    include: { user: { select: { id: true, name: true } } },
  });
  res.json({ workflow: toClientWorkflow(updated ?? { ...wf, user: undefined }) });
});

workflowsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const existing = await prisma.workflow.findFirst({
    where: { id, organizationId: req.user!.organizationId },
  });
  if (!existing || !canAccessWorkflowDelete(req.user!, existing)) {
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
  const user = req.user!;
  const member = toMemberContext(user);
  if (!hasPermission(member, "workflows.publish")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const id = routeParam(req.params.id);
  const wf = await prisma.workflow.findFirst({
    where: { id, organizationId: user.organizationId },
  });
  if (!wf || !canAccessWorkflowRead(user, wf)) {
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
        publishedBy: user.id,
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
    where: { id, organizationId: req.user!.organizationId },
  });
  if (!wf || !canAccessWorkflowRead(req.user!, wf)) {
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
