import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getServerConfig } from "../config.server";

const workflowGraphNodeSchema = z.object({
  id: z.string(),
  type: z.enum(["start", "conversation", "qa", "userInput", "end"]),
  title: z.string().optional(),
  message: z.string().optional(),
  instruction: z.string().optional(),
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

const workflowGraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().nullable(),
});

const voiceSessionConfigSchema = z.object({
  context: z.string(),
  example: z.string(),
  endPoints: z.array(z.string()),
  greeting: z.string().nullable(),
  graph: z.object({
    nodes: z.array(workflowGraphNodeSchema),
    edges: z.array(workflowGraphEdgeSchema),
  }),
});

export const createVoiceSession = createServerFn({ method: "POST" })
  .inputValidator(voiceSessionConfigSchema)
  .handler(async ({ data }) => {
    const { voiceBackendUrl } = getServerConfig();
    const res = await fetch(`${voiceBackendUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Voice backend error (${res.status}): ${text}`);
    }

    return res.json() as Promise<{ sessionId: string }>;
  });
