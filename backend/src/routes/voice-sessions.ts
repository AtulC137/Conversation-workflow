import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { hasPermission } from "../lib/permissions.js";
import { prisma } from "../lib/prisma.js";
import { routeParam } from "../lib/params.js";
import { canAccessWorkflowRead, toMemberContext } from "../lib/workflow-access.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

const SESSION_TTL_SECONDS = 3600;

const workflowGraphNodeSchema = z.object({
  id: z.string(),
  type: z.enum(["start", "conversation", "qa", "userInput", "react", "end"]),
  title: z.string().optional(),
  message: z.string().optional(),
  instruction: z.string().optional(),
  replyGuide: z.string().optional(),
  waitForResponse: z.boolean().optional(),
  silenceTimeoutSec: z.number().optional(),
  responses: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        examples: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  status: z.string().optional(),
});

const voiceSessionConfigSchema = z.object({
  workflowId: z.string().uuid().optional(),
  workflowVersionId: z.string().uuid().optional(),
  context: z.string(),
  example: z.string(),
  endPoints: z.array(z.string()),
  greeting: z.string().nullable(),
  graph: z.object({
    nodes: z.array(workflowGraphNodeSchema),
    edges: z.array(
      z.object({
        source: z.string(),
        target: z.string(),
        sourceHandle: z.string().nullable(),
      }),
    ),
  }),
});

async function canAccessSession(user: AuthedRequest["user"], sessionId: string) {
  const session = await prisma.voiceSession.findFirst({
    where: { id: sessionId },
    include: { workflow: true },
  });
  if (!session || !user) return null;

  if (session.userId === user.id) {
    if (hasPermission(toMemberContext(user), "sessions.view_own")) return session;
    return null;
  }

  if (!hasPermission(toMemberContext(user), "sessions.view_all")) return null;

  if (session.workflow && session.workflow.organizationId === user.organizationId) {
    return session;
  }

  return null;
}

export const voiceSessionsRouter = Router();
voiceSessionsRouter.use(requireAuth);

voiceSessionsRouter.post("/", requirePermission("workflows.test"), async (req: AuthedRequest, res) => {
  const parsed = voiceSessionConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const data = parsed.data;

  if (data.workflowId) {
    const wf = await prisma.workflow.findFirst({
      where: { id: data.workflowId, organizationId: req.user!.organizationId },
    });
    if (!wf || !canAccessWorkflowRead(req.user!, wf)) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
  }

  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);

  await prisma.voiceSession.create({
    data: {
      id: sessionId,
      userId: req.user!.id,
      workflowId: data.workflowId ?? null,
      workflowVersionId: data.workflowVersionId ?? null,
      context: data.context,
      example: data.example,
      endPoints: data.endPoints,
      greeting: data.greeting,
      graph: data.graph,
      expiresAt,
    },
  });

  const voiceBackendUrl = process.env.VOICE_BACKEND_URL ?? "http://localhost:8000";
  const pyRes = await fetch(`${voiceBackendUrl}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      context: data.context,
      example: data.example,
      endPoints: data.endPoints,
      greeting: data.greeting,
      graph: data.graph,
    }),
  });

  if (!pyRes.ok) {
    await prisma.voiceSession.update({
      where: { id: sessionId },
      data: { status: "failed" },
    });
    const text = await pyRes.text();
    res.status(502).json({ error: `Voice backend error: ${text}` });
    return;
  }

  res.status(201).json({ sessionId });
});

voiceSessionsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const session = await canAccessSession(req.user, id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({
    session: {
      id: session.id,
      workflowId: session.workflowId,
      status: session.status,
      startedAt: session.startedAt?.getTime() ?? null,
      endedAt: session.endedAt?.getTime() ?? null,
      createdAt: session.createdAt.getTime(),
    },
  });
});

voiceSessionsRouter.get("/:id/transcript", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const session = await canAccessSession(req.user, id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const turns = await prisma.callTurn.findMany({
    where: { sessionId: session.id },
    orderBy: { turnIndex: "asc" },
    select: {
      turnIndex: true,
      speaker: true,
      nodeId: true,
      content: true,
      isComplete: true,
      completionStatus: true,
      metadata: true,
      createdAt: true,
    },
  });

  res.json({
    turns: turns.map((t) => ({
      turnIndex: t.turnIndex,
      speaker: t.speaker,
      nodeId: t.nodeId,
      content: t.content,
      isComplete: t.isComplete,
      completionStatus: t.completionStatus,
      metadata: t.metadata,
      createdAt: t.createdAt.getTime(),
    })),
  });
});
