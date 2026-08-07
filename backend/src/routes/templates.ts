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
import { compileWordGraph } from "../lib/compile-workflow.js";

const NO_RESPONSE_HANDLE = "no-response";

const toolsSchema = z.object({
  voice: z.object({ enabled: z.boolean() }),
  whatsapp: z.object({ enabled: z.boolean(), phoneNumber: z.string() }),
});

const templateBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  prompt: z.string().optional(),
  script: z.string().optional(),
  confirmationQuestion: z.string().max(500).optional(),
  tools: toolsSchema.optional(),
  nodes: z.array(z.unknown()).optional(),
  edges: z.array(z.unknown()).optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
});

const templatePutSchema = templateBodySchema.extend({
  expectedUpdatedAt: z.number().optional(),
});

function toClientTemplate(
  w: {
    id: string;
    name: string;
    context: string;
    script?: string;
    confirmationQuestion?: string | null;
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
    prompt: w.context,
    script: w.script ?? "",
    confirmationQuestion: w.confirmationQuestion ?? "",
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

type ParsedLine =
  | { kind: "ai"; text: string }
  | { kind: "user"; label: string; examples: string[] };

function parsePrompt(prompt: string): ParsedLine[] {
  const lines = prompt
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean);

  const out: ParsedLine[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("ai:")) {
      const text = line.slice(3).trim();
      if (text) out.push({ kind: "ai", text });
      continue;
    }
    if (lower.startsWith("assistant:")) {
      const text = line.slice(10).trim();
      if (text) out.push({ kind: "ai", text });
      continue;
    }

    const m = /^user\s*\((.*?)\)\s*:?\s*(.*)$/i.exec(line);
    if (m) {
      const inside = (m[1] ?? "").trim();
      const tail = (m[2] ?? "").trim();

      // Accept formats:
      // User (busy â€” e.g. "later", "not now"):
      // User (busy): later, not now
      const parts = inside.split(/â€”|-{1,2}/).map((p) => p.trim()).filter(Boolean);
      const label = parts[0] ?? "Response";

      const examplesText =
        parts.slice(1).join(" ") ||
        tail;

      let examples: string[] = [];
      const eg = /e\.g\.\s*(.*)$/i.exec(examplesText);
      const raw = (eg ? eg[1] : examplesText).trim();
      if (raw) {
        // try quoted examples first
        const quoted = Array.from(raw.matchAll(/"([^"]+)"/g)).map((x) => x[1].trim());
        examples = quoted.length
          ? quoted
          : raw
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean)
              .slice(0, 8);
      }

      out.push({ kind: "user", label, examples });
      continue;
    }
  }
  return out;
}

function promptToGraph(prompt: string) {
  const parsed = parsePrompt(prompt);
  const hasAnyAi = parsed.some((p) => p.kind === "ai");
  if (!hasAnyAi) return { nodes: defaultNodes, edges: [] };

  const nodes: any[] = [
    {
      id: "start",
      type: "start",
      position: { x: 80, y: 220 },
      data: { title: "Start" },
    },
  ];
  const edges: any[] = [];

  const nodeById = new Map<string, any>();
  nodeById.set("start", nodes[0]);

  const depthById = new Map<string, number>([["start", 0]]);

  let aiIndex = 0;
  let cursorId: string = "start";
  let lastAiId: string | null = null;
  let yBase = 220;

  type PendingBranch = {
    parentId: string;
    response: { id: string; label: string; examples?: string[] };
    depth: number;
    branchNo: number;
  };
  let pending: PendingBranch[] = [];
  const branchCountByParent = new Map<string, number>();

  function addEdge(source: string, target: string, sourceHandle: string | null) {
    edges.push({
      id: `e-${source}-${sourceHandle ?? "out"}-${target}`,
      source,
      target,
      sourceHandle,
      targetHandle: null,
      type: "smoothstep",
    });
  }

  function addConversationNode(text: string, depth: number, y: number) {
    aiIndex += 1;
    const id = `conversation-${aiIndex}`;
    nodes.push({
      id,
      type: "conversation",
      position: { x: 360 + depth * 260, y },
      data: {
        title: "",
        message: text,
        responses: [],
        tone: "Professional",
        notes: "",
        silenceTimeoutSec: 3,
      },
    });
    nodeById.set(id, nodes[nodes.length - 1]);
    depthById.set(id, depth);
    return id;
  }

  function ensureResponseOnParent(parentId: string, response: PendingBranch["response"]) {
    const parent = nodeById.get(parentId);
    if (!parent || parent.type !== "conversation") return;
    parent.data.responses = parent.data.responses ?? [];
    if (!parent.data.responses.some((r: any) => r.id === response.id)) {
      parent.data.responses.push(response);
    }
  }

  for (const item of parsed) {
    if (item.kind === "user") {
      if (!lastAiId) continue;
      const n = (branchCountByParent.get(lastAiId) ?? 0) + 1;
      branchCountByParent.set(lastAiId, n);
      const response = {
        id: `r-${lastAiId}-${n}`,
        label: item.label,
        ...(item.examples.length ? { examples: item.examples } : {}),
      };
      const parentDepth = depthById.get(lastAiId) ?? 0;
      pending.push({ parentId: lastAiId, response, depth: parentDepth + 1, branchNo: n });
      ensureResponseOnParent(lastAiId, response);
      continue;
    }

    // AI
    if (pending.length > 0) {
      const b = pending.shift()!;
      const y = yBase + 140 * b.branchNo;
      const id = addConversationNode(item.text, b.depth, y);
      addEdge(b.parentId, id, b.response.id);
      cursorId = id;
      lastAiId = id;
      continue;
    }

    // linear continuation
    yBase += 140;
    const depth = depthById.get(cursorId) ?? 0;
    const id = addConversationNode(item.text, depth, yBase);
    addEdge(cursorId, id, cursorId === "start" ? null : "ai-out");
    cursorId = id;
    lastAiId = id;
  }

  // Any remaining branches with no AI target: ignore safely.

  const endId = "end";
  const endY = yBase + 280;
  nodes.push({
    id: endId,
    type: "end",
    position: { x: 700, y: endY },
    data: { title: "End", status: "Completed" },
  });
  nodeById.set(endId, nodes[nodes.length - 1]);

  const outgoing = new Set<string>(edges.map((e: any) => e.source));
  for (const n of nodes) {
    if (n.id === "start" || n.id === "end") continue;
    if (n.type !== "conversation") continue;
    if (outgoing.has(n.id)) continue;
    addEdge(n.id, endId, "ai-out");
  }

  return { nodes, edges };
}

type PromptMeta = { caller?: string; company?: string; reason?: string };

function parsePromptMeta(prompt: string): PromptMeta {
  const meta: PromptMeta = {};
  const collected: Record<string, string[]> = {
    caller: [],
    company: [],
    reason: [],
  };
  let pendingKey: string | null = null;

  for (const raw of prompt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      pendingKey = null;
      continue;
    }

    const kv = /^([A-Za-z][A-Za-z_\s]*)\s*[:ï¼š]\s*(.*)$/.exec(line);
    if (kv) {
      const key = kv[1].trim().toLowerCase().replace(/\s+/g, " ");
      const val = kv[2].trim();
      if (val && !val.startsWith("{{")) {
        pushMetaValue(collected, key, val);
        pendingKey = null;
      } else {
        pendingKey = key;
      }
      continue;
    }

    if (pendingKey) {
      pushMetaValue(collected, pendingKey, line);
      pendingKey = null;
    }
  }

  meta.caller = collected.caller[0];
  meta.company = collected.company.length
    ? collected.company[collected.company.length - 1]
    : undefined;
  meta.reason = collected.reason.length
    ? collected.reason[collected.reason.length - 1]
    : undefined;

  return meta;
}

function pushMetaValue(collected: Record<string, string[]>, key: string, val: string) {
  if (key === "caller" || key === "name" || key === "guest") {
    collected.caller.push(val);
  } else if (key === "org" || key === "organization" || key === "company") {
    collected.company.push(val);
  } else if (key === "purpose" || key === "reason" || key === "resason") {
    collected.reason.push(val);
  }
}

function buildIntroMessage(prompt: string): string {
  const { company, reason } = parsePromptMeta(prompt);
  const companyPart = company ?? "{{company}}";
  const reasonPart = reason ?? "{{reason}}";
  return `Hello {{name}}, I am Susha from ${companyPart}, calling about ${reasonPart}.`;
}

function buildGenericTemplateGraph(prompt: string, confirmationQuestion?: string | null) {
  const introMessage = buildIntroMessage(prompt);
  const confirmText = (confirmationQuestion ?? "").trim();
  const hasConfirm = confirmText.length > 0;

  const nodes: any[] = [
    { id: "start", type: "start", position: { x: 80, y: 220 }, data: { title: "Start" } },
    {
      id: "intro",
      type: "conversation",
      position: { x: 360, y: 220 },
      data: {
        title: "Introduction",
        message: introMessage,
        responses: [],
        tone: "Professional",
        notes: "",
        waitForResponse: false,
        silenceTimeoutSec: 3,
      },
    },
    {
      id: "permission",
      type: "conversation",
      position: { x: 360, y: 360 },
      data: {
        title: "Ask time",
        message: "Is this a good time to talk?",
        responses: [
          { id: "permission-yes", label: "Yes", examples: ["yes", "ok", "sure", "haan", "go ahead"] },
          {
            id: "permission-no",
            label: "No",
            examples: ["no", "busy", "later", "not now", "don't want to talk", "not interested"],
          },
        ],
        tone: "Professional",
        notes: "",
        silenceTimeoutSec: 3,
      },
    },
    {
      id: "info",
      type: "userInput",
      position: { x: 620, y: 360 },
      data: {
        title: "Details",
        instruction:
          "Using ONLY facts from the Prompt and CONTACT DATA for this caller, tell the call details once in natural spoken sentences (phone style). Address the caller by their CONTACT DATA name ({{name}}) — never call them Susha (you are Susha, the agent). Do NOT use bullet points or labeled lines like Event/Date/Place. Do NOT mention word limits or system instructions. Personalize with Excel fields when present. Do NOT ask confirmation questions. Do NOT repeat the intro greeting.",
        waitForResponse: false,
        responses: [],
        notes: "",
        silenceTimeoutSec: 3,
      },
    },
    {
      id: "qa",
      type: "qa",
      position: { x: 880, y: 440 },
      data: {
        title: "Q&A",
        message: "Do you have any questions?",
        responses: [
          {
            id: "qa-no",
            label: "No questions",
            examples: ["no", "no questions", "nothing", "all good", "nope"],
          },
        ],
        notes: "",
        silenceTimeoutSec: 3,
      },
    },
    {
      id: "bye",
      type: "conversation",
      position: { x: 880, y: 560 },
      data: {
        title: "Bye",
        message: "Thank you for your time. Have a nice day. Bye.",
        responses: [],
        tone: "Professional",
        notes: "",
        silenceTimeoutSec: 3,
      },
    },
    {
      id: "end",
      type: "end",
      position: { x: 1120, y: 560 },
      data: { title: "End", status: "Completed" },
    },
  ];

  const edges: any[] = [
    {
      id: "e-start-intro",
      source: "start",
      target: "intro",
      sourceHandle: null,
      targetHandle: null,
      type: "smoothstep",
    },
    {
      id: "e-intro-permission",
      source: "intro",
      target: "permission",
      sourceHandle: "ai-out",
      targetHandle: null,
      type: "smoothstep",
    },
    {
      id: "e-permission-yes-info",
      source: "permission",
      target: "info",
      sourceHandle: "permission-yes",
      targetHandle: null,
      type: "smoothstep",
    },
    {
      id: "e-permission-no-bye",
      source: "permission",
      target: "bye",
      sourceHandle: "permission-no",
      targetHandle: null,
      type: "smoothstep",
    },
    // Silence at ask-time â†’ continue to details
    {
      id: "e-permission-nr-info",
      source: "permission",
      target: "info",
      sourceHandle: NO_RESPONSE_HANDLE,
      targetHandle: null,
      type: "smoothstep",
    },
    {
      id: "e-qa-nr-bye",
      source: "qa",
      target: "bye",
      sourceHandle: NO_RESPONSE_HANDLE,
      targetHandle: null,
      type: "smoothstep",
    },
    {
      id: "e-qa-no-bye",
      source: "qa",
      target: "bye",
      sourceHandle: "qa-no",
      targetHandle: null,
      type: "smoothstep",
    },
    {
      id: "e-bye-end",
      source: "bye",
      target: "end",
      sourceHandle: "ai-out",
      targetHandle: null,
      type: "smoothstep",
    },
  ];

  if (hasConfirm) {
    nodes.push({
      id: "confirm",
      type: "conversation",
      position: { x: 620, y: 440 },
      data: {
        title: "Confirm",
        message: confirmText,
        responses: [
          { id: "confirm-yes", label: "Yes", examples: ["yes", "i will", "sure", "haan", "ok"] },
          {
            id: "confirm-no",
            label: "No",
            examples: ["no", "not", "can't", "won't", "nahi"],
          },
        ],
        tone: "Professional",
        notes: "",
        silenceTimeoutSec: 3,
      },
    });
    edges.push(
      {
        id: "e-info-confirm",
        source: "info",
        target: "confirm",
        sourceHandle: "ai-out",
        targetHandle: null,
        type: "smoothstep",
      },
      {
        id: "e-confirm-yes-qa",
        source: "confirm",
        target: "qa",
        sourceHandle: "confirm-yes",
        targetHandle: null,
        type: "smoothstep",
      },
      {
        id: "e-confirm-no-qa",
        source: "confirm",
        target: "qa",
        sourceHandle: "confirm-no",
        targetHandle: null,
        type: "smoothstep",
      },
      {
        id: "e-confirm-nr-qa",
        source: "confirm",
        target: "qa",
        sourceHandle: NO_RESPONSE_HANDLE,
        targetHandle: null,
        type: "smoothstep",
      },
    );
  } else {
    edges.push({
      id: "e-info-qa",
      source: "info",
      target: "qa",
      sourceHandle: "ai-out",
      targetHandle: null,
      type: "smoothstep",
    });
  }

  return { nodes, edges };
}

export const templatesRouter = Router();
templatesRouter.use(requireAuth);

templatesRouter.get("/", async (req: AuthedRequest, res) => {
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
    templates: rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      updatedAt: r.updatedAt.getTime(),
      createdBy: { id: r.user.id, name: r.user.name },
    })),
  });
});

templatesRouter.get("/:id", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const wf = await prisma.workflow.findFirst({
    where: { id, organizationId: req.user!.organizationId },
    include: { user: { select: { id: true, name: true } } },
  });
  if (!wf || !canAccessWorkflowRead(req.user!, wf)) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const lock = await getActiveLock(id);
  res.json({ template: toClientTemplate(wf, lockToClient(lock)) });
});

templatesRouter.post("/:id/lock", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const wf = await prisma.workflow.findFirst({
    where: { id, organizationId: req.user!.organizationId },
  });
  if (!wf || !canAccessWorkflowWrite(req.user!, wf)) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const result = await acquireOrExtendLock(id, req.user!.id);
  if (!result.ok) {
    res.status(423).json({
      error: "Template is locked by another user",
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

templatesRouter.delete("/:id/lock", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const released = await releaseLock(id, req.user!.id);
  res.json({ ok: released });
});

templatesRouter.post(
  "/compile-script",
  async (req: AuthedRequest, res) => {
    const schema = z.object({ script: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    try {
      const result = await compileWordGraph(parsed.data.script);
      res.json({
        nodes: result.nodes,
        edges: result.edges,
        warnings: result.warnings,
        errors: result.errors,
        attempts: result.attempts,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Compile failed",
      });
    }
  },
);

templatesRouter.post(
  "/from-prompt",
  requirePermission("workflows.create"),
  async (req: AuthedRequest, res) => {
    const schema = z.object({
      name: z.string().min(1).max(200).optional(),
      prompt: z.string().min(1),
      confirmationQuestion: z.string().max(500).optional(),
      script: z.string().optional(),
      tools: toolsSchema.optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const confirmationQuestion = (parsed.data.confirmationQuestion ?? "").trim();
    const graph = buildGenericTemplateGraph(parsed.data.prompt, confirmationQuestion);

    const wf = await prisma.workflow.create({
      data: {
        id: uuidv4(),
        userId: req.user!.id,
        organizationId: req.user!.organizationId,
        name: parsed.data.name ?? "Untitled template",
        context: parsed.data.prompt,
        script: parsed.data.script?.trim() ?? "",
        confirmationQuestion,
        tools: asJson(parsed.data.tools ?? defaultTools),
        nodes: asJson(graph.nodes),
        edges: asJson(graph.edges),
      },
    });

    const created = await prisma.workflow.findUnique({
      where: { id: wf.id },
      include: { user: { select: { id: true, name: true } } },
    });
    res.status(201).json({ template: toClientTemplate(created ?? { ...wf, user: undefined }) });
  },
);

templatesRouter.post("/", requirePermission("workflows.create"), async (req: AuthedRequest, res) => {
  const parsed = templateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const data = parsed.data;
  const prompt = data.prompt ?? "";
  const confirmationQuestion = (data.confirmationQuestion ?? "").trim();
  const graph =
    data.nodes && data.edges
      ? { nodes: data.nodes, edges: data.edges }
      : buildGenericTemplateGraph(prompt, confirmationQuestion);

  const wf = await prisma.workflow.create({
    data: {
      id: uuidv4(),
      userId: req.user!.id,
      organizationId: req.user!.organizationId,
      name: data.name ?? "Untitled template",
      context: prompt,
      script: data.script ?? "",
      confirmationQuestion,
      tools: asJson(data.tools ?? defaultTools),
      nodes: asJson(graph.nodes),
      edges: asJson(graph.edges),
    },
  });

  const created = await prisma.workflow.findUnique({
    where: { id: wf.id },
    include: { user: { select: { id: true, name: true } } },
  });
  res.status(201).json({ template: toClientTemplate(created ?? { ...wf, user: undefined }) });
});

templatesRouter.put("/:id", async (req: AuthedRequest, res) => {
  const parsed = templatePutSchema.safeParse(req.body);
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
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const data = parsed.data;
  if (
    data.expectedUpdatedAt !== undefined &&
    existing.updatedAt.getTime() > data.expectedUpdatedAt
  ) {
    const lock = await getActiveLock(id);
    res.status(409).json({
      error: "Template was modified by another user",
      template: toClientTemplate(existing, lockToClient(lock)),
    });
    return;
  }

  const nextPrompt = data.prompt !== undefined ? data.prompt : existing.context;
  const nextConfirm =
    data.confirmationQuestion !== undefined
      ? data.confirmationQuestion.trim()
      : (existing.confirmationQuestion ?? "");
  const promptChanged = data.prompt !== undefined && data.prompt !== existing.context;
  const confirmChanged =
    data.confirmationQuestion !== undefined &&
    data.confirmationQuestion.trim() !== (existing.confirmationQuestion ?? "");
  const shouldRebuildGraph = promptChanged || confirmChanged;
  const graph = shouldRebuildGraph
    ? buildGenericTemplateGraph(nextPrompt, nextConfirm)
    : null;

  const wf = await prisma.workflow.update({
    where: { id: existing.id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.prompt !== undefined && { context: data.prompt }),
      ...(data.script !== undefined && { script: data.script }),
      ...(data.confirmationQuestion !== undefined && {
        confirmationQuestion: data.confirmationQuestion.trim(),
      }),
      ...(data.tools !== undefined && { tools: asJson(data.tools) }),
      ...(graph
        ? { nodes: asJson(graph.nodes), edges: asJson(graph.edges) }
        : {
            ...(data.nodes !== undefined && { nodes: asJson(data.nodes) }),
            ...(data.edges !== undefined && { edges: asJson(data.edges) }),
          }),
      ...(data.status !== undefined && { status: data.status }),
    },
  });

  const updated = await prisma.workflow.findUnique({
    where: { id: wf.id },
    include: { user: { select: { id: true, name: true } } },
  });
  res.json({ template: toClientTemplate(updated ?? { ...wf, user: undefined }) });
});

templatesRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const existing = await prisma.workflow.findFirst({
    where: { id, organizationId: req.user!.organizationId },
  });
  if (!existing || !canAccessWorkflowDelete(req.user!, existing)) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  await prisma.workflow.update({
    where: { id: existing.id },
    data: { status: "archived" },
  });

  res.json({ ok: true });
});

templatesRouter.post("/:id/publish", async (req: AuthedRequest, res) => {
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
    res.status(404).json({ error: "Template not found" });
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
    prompt: wf.context,
    script: wf.script,
    confirmationQuestion: wf.confirmationQuestion,
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
      templateId: version.workflowId,
      versionNumber: version.versionNumber,
      createdAt: version.createdAt.getTime(),
    },
  });
});

templatesRouter.get("/:id/versions", async (req: AuthedRequest, res) => {
  const id = routeParam(req.params.id);
  const wf = await prisma.workflow.findFirst({
    where: { id, organizationId: req.user!.organizationId },
  });
  if (!wf || !canAccessWorkflowRead(req.user!, wf)) {
    res.status(404).json({ error: "Template not found" });
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


