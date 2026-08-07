import { Router } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import {
  mergeSessionWithContact,
  normalizeContactFields,
  parseContactsFromWorkbook,
  type ContactFields,
} from "../lib/contact-data.js";
import { prisma } from "../lib/prisma.js";
import { getVoiceBackendOutboundUrl, getVoiceBackendSessionsUrl } from "../lib/voice-backend-url.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

const E164_REGEX = /^\+?[1-9]\d{6,14}$/;

type CampaignStatus = "queued" | "running" | "completed" | "failed";
type Campaign = {
  id: string;
  templateId: string;
  status: CampaignStatus;
  total: number;
  succeeded: number;
  failed: number;
  lastError?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  sessionIds: string[];
};

const campaigns = new Map<string, Campaign>();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const contactSchema = z.object({
  phoneNumber: z.string(),
  fields: z.record(z.string()).default({}),
});

const voiceGraphNodeSchema = z
  .object({
    id: z.string(),
    type: z.enum(["start", "conversation", "qa", "userInput", "react", "end"]),
  })
  .passthrough();

const voiceGraphEdgeSchema = z
  .object({
    source: z.string(),
    target: z.string(),
    sourceHandle: z.string().nullable(),
  })
  .passthrough();

const sessionConfigSchema = z.object({
  context: z.string(),
  example: z.string(),
  endPoints: z.array(z.string()),
  greeting: z.string().nullable(),
  graph: z.object({
    nodes: z.array(voiceGraphNodeSchema),
    edges: z.array(voiceGraphEdgeSchema),
  }),
});

const startCampaignSchema = z.object({
  templateId: z.string().uuid(),
  contacts: z.array(contactSchema),
  sessionConfig: sessionConfigSchema,
});

async function registerSessionToVoiceBackend(
  sessionId: string,
  sessionConfig: z.infer<typeof sessionConfigSchema>,
) {
  const pyRes = await fetch(getVoiceBackendSessionsUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...sessionConfig }),
  });
  if (!pyRes.ok) {
    const text = await pyRes.text();
    throw new Error(`Voice backend error: ${text}`);
  }
}

async function placeOutboundCall(sessionId: string, phoneNumber: string) {
  const outboundRes = await fetch(getVoiceBackendOutboundUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, phoneNumber }),
  });
  if (!outboundRes.ok) {
    const text = await outboundRes.text();
    throw new Error(`Telephony outbound call error: ${text}`);
  }
}

export const campaignsRouter = Router();
campaignsRouter.use(requireAuth);

campaignsRouter.post(
  "/parse-excel",
  requirePermission("workflows.test"),
  upload.single("file"),
  async (req: AuthedRequest, res) => {
    const file = (req as any).file as { buffer: Buffer } | undefined;
    if (!file?.buffer) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    try {
      const contacts = parseContactsFromWorkbook(file.buffer);
      res.json({ contacts });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to parse Excel" });
    }
  },
);

campaignsRouter.post("/start", requirePermission("workflows.test"), async (req: AuthedRequest, res) => {
  const parsed = startCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { templateId, contacts, sessionConfig } = parsed.data;
  const campaignId = uuidv4();
  const campaign: Campaign = {
    id: campaignId,
    templateId,
    status: "queued",
    total: contacts.length,
    succeeded: 0,
    failed: 0,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    sessionIds: [],
  };
  campaigns.set(campaignId, campaign);

  res.status(202).json({ campaignId });

  void (async () => {
    campaign.status = "running";
    campaign.startedAt = Date.now();

    for (const c of contacts) {
      const phoneNumber = c.phoneNumber.trim();
      if (!E164_REGEX.test(phoneNumber)) {
        campaign.failed += 1;
        campaign.lastError = `Invalid phone number: ${phoneNumber}`;
        continue;
      }

      const fields = normalizeContactFields({ ...c.fields });
      if (!fields.phone && !fields.phoneNumber) {
        fields.phone = phoneNumber;
      }

      const perContactConfig = mergeSessionWithContact(sessionConfig, fields);
      const sessionId = uuidv4();
      campaign.sessionIds.push(sessionId);

      try {
        const expiresAt = new Date(Date.now() + 3600 * 1000);
        await prisma.voiceSession.create({
          data: {
            id: sessionId,
            userId: req.user!.id,
            workflowId: templateId,
            workflowVersionId: null,
            context: perContactConfig.context,
            example: perContactConfig.example,
            endPoints: perContactConfig.endPoints,
            greeting: perContactConfig.greeting,
            graph: perContactConfig.graph as unknown as Prisma.InputJsonValue,
            expiresAt,
          },
        });

        await registerSessionToVoiceBackend(sessionId, perContactConfig);
        await placeOutboundCall(sessionId, phoneNumber);
        campaign.succeeded += 1;
      } catch (err) {
        campaign.failed += 1;
        campaign.lastError = err instanceof Error ? err.message : "Call failed";
        await prisma.voiceSession
          .update({ where: { id: sessionId }, data: { status: "failed" } })
          .catch(() => {});
      }
    }

    campaign.status = "completed";
    campaign.finishedAt = Date.now();
  })();
});

campaignsRouter.get("/:id", requirePermission("workflows.test"), async (req: AuthedRequest, res) => {
  const id = String(req.params.id ?? "");
  const campaign = campaigns.get(id);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }
  res.json({ campaign });
});
