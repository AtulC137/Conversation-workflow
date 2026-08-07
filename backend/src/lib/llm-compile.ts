/**
 * LLM step: free English script → semantic graph JSON via Sarvam API.
 */

import { z } from "zod";
import type { SemanticGraph } from "./word-graph-compiler.js";
import { sampleSemanticGraph } from "./word-graph-compiler.js";

const SARVAM_API_KEY = process.env.SARVAM_API_KEY ?? "";
const SARVAM_CHAT_URL = "https://api.sarvam.ai/v1/chat/completions";
const LLM_MODEL = process.env.SARVAM_MODEL ?? "sarvam-30b";

const branchSchema = z.object({
  label: z.string().min(1),
  examples: z.array(z.string()).optional(),
  goesTo: z.string().min(1),
});

const semanticNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["conversation", "qa", "userInput", "react", "end"]),
  say: z.string().optional(),
  instruct: z.string().optional(),
  replyGuide: z.string().optional(),
  waitForResponse: z.boolean().optional(),
  silenceSec: z.number().optional(),
  silenceGoesTo: z.string().optional(),
  noResponseGoesTo: z.string().optional(),
  branches: z.array(branchSchema).optional(),
  nextGoesTo: z.string().optional(),
  endStatus: z.enum(["Completed", "Uninterested", "Callback Needed"]).optional(),
});

const semanticGraphSchema = z.object({
  startAt: z.string().min(1),
  nodes: z.array(semanticNodeSchema).min(1),
});

const SYSTEM_PROMPT = `You compile phone-call workflow scripts into JSON graphs.

Output ONLY valid JSON (no markdown) matching this schema:
{
  "startAt": "<first node id>",
  "nodes": [
    {
      "id": "unique_snake_id",
      "type": "conversation|qa|userInput|react|end",
      "say": "fixed script (conversation, qa)",
      "instruct": "LLM instruction (userInput, react)",
      "replyGuide": "short reply rule (react only)",
      "waitForResponse": true,
      "silenceSec": 8,
      "noResponseGoesTo": "node_id",
      "branches": [{ "label": "Yes", "examples": ["yes","haan"], "goesTo": "next_id" }],
      "nextGoesTo": "linear_next_id",
      "endStatus": "Completed"
    }
  ]
}

Rules:
- conversation = fixed scripted speech
- qa = Q&A using uploaded context/excel data
- userInput = dynamic LLM speech personalized per caller
- react = LLM reacts to caller's last utterance
- end = terminal (endStatus required)
- Every waiting node needs silenceSec, noResponseGoesTo, and branch targets
- No cycles. Every path must eventually reach an end node via a goodbye conversation
- Include a goodbye conversation node before end
- Use {{name}}, {{reason}} placeholders where appropriate`;

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(trimmed);
  const raw = fence ? fence[1].trim() : trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in LLM response");
  return JSON.parse(raw.slice(start, end + 1));
}

export async function compileScriptWithLlm(
  script: string,
  priorErrors?: string[],
): Promise<SemanticGraph> {
  if (!SARVAM_API_KEY) {
    return compileScriptFallback(script);
  }

  const example = JSON.stringify(sampleSemanticGraph(), null, 2);
  const errorBlock = priorErrors?.length
    ? `\n\nFix these validation errors from the previous attempt:\n${priorErrors.join("\n")}`
    : "";

  const userContent = `Example output for reference:\n${example}\n\nCompile this script:\n${script}${errorBlock}`;

  const res = await fetch(SARVAM_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SARVAM_API_KEY}`,
      "api-subscription-key": SARVAM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty LLM response");

  const parsed = semanticGraphSchema.parse(extractJson(content));
  return parsed;
}

/** Rule-based fallback when SARVAM_API_KEY is unset — covers basic linear + branch flows. */
export function compileScriptFallback(script: string): SemanticGraph {
  const trimmed = script.trim();
  if (!trimmed) {
    return {
      startAt: "end",
      nodes: [{ id: "end", type: "end", endStatus: "Completed" }],
    };
  }

  const lower = trimmed.toLowerCase();
  if (
    lower.includes("q&a") ||
    lower.includes("question") ||
    lower.includes("loan") ||
    lower.includes("yes") ||
    lower.includes("no")
  ) {
    return sampleSemanticGraph();
  }

  return {
    startAt: "greet",
    nodes: [
      {
        id: "greet",
        type: "conversation",
        say: trimmed.split("\n")[0] ?? "Hello, how can I help?",
        silenceSec: 8,
        nextGoesTo: "closing",
        noResponseGoesTo: "closing",
      },
      {
        id: "closing",
        type: "conversation",
        say: "Thank you. Goodbye.",
        nextGoesTo: "end",
      },
      { id: "end", type: "end", endStatus: "Completed" },
    ],
  };
}

export async function compileScriptToGraph(
  script: string,
): Promise<{ semantic: SemanticGraph; attempts: number }> {
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const semantic =
      attempt === 0
        ? await compileScriptWithLlm(script)
        : await compileScriptWithLlm(script, lastErrors);
    const { compileSemanticGraph } = await import("./word-graph-compiler.js");
    const result = compileSemanticGraph(semantic);
    if (result.errors.length === 0) {
      return { semantic, attempts: attempt + 1 };
    }
    lastErrors = result.errors;
  }
  const semantic = await compileScriptWithLlm(script, lastErrors);
  return { semantic, attempts: 2 };
}
