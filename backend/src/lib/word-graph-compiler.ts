/**
 * Compiles LLM-produced semantic workflow graphs into React Flow nodes/edges.
 * Also validates: no cycles, all paths reach end, branch completeness.
 */

export const NO_RESPONSE_HANDLE = "no-response";

export type SemanticBranch = {
  label: string;
  examples?: string[];
  goesTo: string;
};

export type SemanticNodeType = "conversation" | "qa" | "userInput" | "react" | "end";

export type SemanticNode = {
  id: string;
  type: SemanticNodeType;
  say?: string;
  instruct?: string;
  replyGuide?: string;
  waitForResponse?: boolean;
  silenceSec?: number;
  silenceGoesTo?: string;
  noResponseGoesTo?: string;
  branches?: SemanticBranch[];
  nextGoesTo?: string;
  endStatus?: "Completed" | "Uninterested" | "Callback Needed";
};

export type SemanticGraph = {
  startAt: string;
  nodes: SemanticNode[];
};

export type FlowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
};

export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  type: string;
};

export type CompileResult = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  warnings: string[];
  errors: string[];
};

const DEFAULT_SILENCE_SEC = 3;
const END_STATUSES = new Set(["Completed", "Uninterested", "Callback Needed"]);

function slugId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `node-${Date.now()}`;
}

function addEdge(
  edges: FlowEdge[],
  source: string,
  target: string,
  sourceHandle: string | null,
) {
  const id = `e-${source}-${sourceHandle ?? "out"}-${target}`;
  if (edges.some((e) => e.id === id)) return;
  edges.push({
    id,
    source,
    target,
    sourceHandle,
    targetHandle: null,
    type: "smoothstep",
  });
}

function injectGoodbyeNodes(semantic: SemanticGraph): SemanticGraph {
  const nodes: SemanticNode[] = semantic.nodes.map((n) => ({
    ...n,
    branches: n.branches?.map((b) => ({ ...b })),
  }));
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const endIds = new Set(nodes.filter((n) => n.type === "end").map((n) => n.id));
  if (endIds.size === 0) return semantic;

  const defaultEnd = [...endIds][0]!;

  const rewriteTarget = (target: string | undefined, srcId: string): string | undefined => {
    if (!target || !endIds.has(target)) return target;
    const goodbyeId = `goodbye-${srcId}`;
    if (!nodeMap.has(goodbyeId)) {
      const goodbye: SemanticNode = {
        id: goodbyeId,
        type: "conversation",
        say: "Thank you for your time. Goodbye.",
        nextGoesTo: defaultEnd,
        silenceSec: 3,
      };
      nodes.push(goodbye);
      nodeMap.set(goodbyeId, goodbye);
    }
    return goodbyeId;
  };

  for (const n of [...nodes]) {
    if (n.type === "end") continue;
    n.nextGoesTo = rewriteTarget(n.nextGoesTo, n.id);
    n.silenceGoesTo = rewriteTarget(n.silenceGoesTo, n.id);
    n.noResponseGoesTo = rewriteTarget(n.noResponseGoesTo, n.id);
    if (n.branches) {
      for (const b of n.branches) {
        b.goesTo = rewriteTarget(b.goesTo, n.id) ?? b.goesTo;
      }
    }
  }

  return { ...semantic, nodes };
}

function ensureEndNode(semantic: SemanticGraph): SemanticGraph {
  const hasEnd = semantic.nodes.some((n) => n.type === "end");
  if (hasEnd) return semantic;
  return {
    ...semantic,
    nodes: [
      ...semantic.nodes,
      { id: "end", type: "end", endStatus: "Completed" },
    ],
  };
}

function normalizeSemanticGraph(raw: SemanticGraph): SemanticGraph {
  const seen = new Set<string>();
  const nodes: SemanticNode[] = raw.nodes.map((n) => {
    let id = slugId(n.id);
    if (seen.has(id)) id = `${id}-${seen.size}`;
    seen.add(id);
    return { ...n, id };
  });

  const idRemap = new Map(raw.nodes.map((n, i) => [n.id, nodes[i]!.id]));
  const remap = (ref?: string) => (ref ? (idRemap.get(ref) ?? slugId(ref)) : undefined);

  const normalized: SemanticNode[] = nodes.map((n) => ({
    ...n,
    nextGoesTo: remap(n.nextGoesTo),
    silenceGoesTo: remap(n.silenceGoesTo),
    noResponseGoesTo: remap(n.noResponseGoesTo),
    branches: (n.branches ?? []).map((b) => ({
      ...b,
      goesTo: remap(b.goesTo) ?? slugId(b.goesTo),
    })),
  }));

  return {
    startAt: remap(raw.startAt) ?? normalized[0]?.id ?? "start",
    nodes: normalized,
  };
}

function buildFlowNodes(semantic: SemanticGraph): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [
    {
      id: "start",
      type: "start",
      position: { x: 80, y: 220 },
      data: { title: "Start" },
    },
  ];
  const edges: FlowEdge[] = [];
  const depthById = new Map<string, number>([["start", 0]]);
  const yByDepth = new Map<number, number>();

  const nodeMap = new Map(semantic.nodes.map((n) => [n.id, n]));

  function nextY(depth: number): number {
    const y = yByDepth.get(depth) ?? 220;
    yByDepth.set(depth, y + 140);
    return y;
  }

  for (const sn of semantic.nodes) {
    const depth = 1;
    const y = nextY(depth);
    const base = {
      id: sn.id,
      position: { x: 360, y },
      data: {} as Record<string, unknown>,
    };

    if (sn.type === "end") {
      nodes.push({
        ...base,
        type: "end",
        data: {
          title: "End",
          status: sn.endStatus && END_STATUSES.has(sn.endStatus) ? sn.endStatus : "Completed",
        },
      });
    } else if (sn.type === "qa") {
      nodes.push({
        ...base,
        type: "qa",
        data: {
          title: sn.id,
          message: sn.say ?? "Do you have any questions?",
          responses: (sn.branches ?? []).map((b, i) => ({
            id: `${sn.id}-r-${i + 1}`,
            label: b.label,
            ...(b.examples?.length ? { examples: b.examples } : {}),
          })),
          silenceTimeoutSec: sn.silenceSec ?? DEFAULT_SILENCE_SEC,
          notes: "",
        },
      });
    } else if (sn.type === "userInput") {
      nodes.push({
        ...base,
        type: "userInput",
        data: {
          title: sn.id,
          instruction: sn.instruct ?? sn.say ?? "",
          waitForResponse: sn.waitForResponse ?? true,
          responses: (sn.branches ?? []).map((b, i) => ({
            id: `${sn.id}-r-${i + 1}`,
            label: b.label,
            ...(b.examples?.length ? { examples: b.examples } : {}),
          })),
          silenceTimeoutSec: sn.silenceSec ?? DEFAULT_SILENCE_SEC,
          notes: "",
        },
      });
    } else if (sn.type === "react") {
      nodes.push({
        ...base,
        type: "react",
        data: {
          title: sn.id,
          instruction: sn.instruct ?? "",
          replyGuide: sn.replyGuide ?? "",
          waitForResponse: sn.waitForResponse ?? true,
          responses: (sn.branches ?? []).map((b, i) => ({
            id: `${sn.id}-r-${i + 1}`,
            label: b.label,
            ...(b.examples?.length ? { examples: b.examples } : {}),
          })),
          silenceTimeoutSec: sn.silenceSec ?? DEFAULT_SILENCE_SEC,
          notes: "",
        },
      });
    } else {
      nodes.push({
        ...base,
        type: "conversation",
        data: {
          title: sn.id,
          message: sn.say ?? "",
          responses: (sn.branches ?? []).map((b, i) => ({
            id: `${sn.id}-r-${i + 1}`,
            label: b.label,
            ...(b.examples?.length ? { examples: b.examples } : {}),
          })),
          tone: "Professional",
          silenceTimeoutSec: sn.silenceSec ?? DEFAULT_SILENCE_SEC,
          notes: "",
        },
      });
    }
    depthById.set(sn.id, depth);
  }

  addEdge(edges, "start", semantic.startAt, null);

  for (const sn of semantic.nodes) {
    if (sn.type === "end") continue;

    const responses = (sn.branches ?? []).map((b, i) => ({
      branch: b,
      handleId: `${sn.id}-r-${i + 1}`,
    }));

    if (responses.length > 0) {
      for (const { branch, handleId } of responses) {
        if (nodeMap.has(branch.goesTo)) {
          addEdge(edges, sn.id, branch.goesTo, handleId);
        }
      }
      const nrTarget = sn.noResponseGoesTo ?? sn.silenceGoesTo;
      if (nrTarget && nodeMap.has(nrTarget)) {
        addEdge(edges, sn.id, nrTarget, NO_RESPONSE_HANDLE);
      }
    } else if (sn.nextGoesTo && nodeMap.has(sn.nextGoesTo)) {
      addEdge(edges, sn.id, sn.nextGoesTo, "ai-out");
      const nrTarget = sn.noResponseGoesTo ?? sn.silenceGoesTo;
      const waits =
        sn.type === "conversation" ||
        sn.type === "qa" ||
        (sn.waitForResponse ?? (sn.type === "userInput" || sn.type === "react"));
      if (nrTarget && nodeMap.has(nrTarget) && waits) {
        addEdge(edges, sn.id, nrTarget, NO_RESPONSE_HANDLE);
      }
    }
  }

  layoutNodes(nodes, edges);
  return { nodes, edges };
}

function layoutNodes(nodes: FlowNode[], edges: FlowEdge[]) {
  const depth = new Map<string, number>();
  depth.set("start", 0);

  for (let pass = 0; pass < nodes.length + 2; pass++) {
    let changed = false;
    for (const e of edges) {
      const sd = depth.get(e.source);
      if (sd === undefined) continue;
      const nd = sd + 1;
      if ((depth.get(e.target) ?? -1) < nd) {
        depth.set(e.target, nd);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const yByDepth = new Map<number, number>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const y = yByDepth.get(d) ?? 120;
    yByDepth.set(d, y + 140);
    n.position = { x: 80 + d * 280, y };
  }
}

export function validateWorkflowGraph(
  nodes: FlowNode[],
  edges: FlowEdge[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const nodeIds = new Set(nodes.map((n) => n.id));
  const startNodes = nodes.filter((n) => n.type === "start");
  const endNodes = nodes.filter((n) => n.type === "end");

  if (startNodes.length !== 1) {
    errors.push(`Expected exactly 1 start node, found ${startNodes.length}`);
  }
  if (endNodes.length < 1) {
    errors.push("Workflow must have at least one end node");
  }

  for (const e of edges) {
    if (!nodeIds.has(e.source)) errors.push(`Edge source missing node: ${e.source}`);
    if (!nodeIds.has(e.target)) errors.push(`Edge target missing node: ${e.target}`);
    if (e.source === e.target) errors.push(`Self-loop on node "${e.source}"`);
  }

  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function hasCycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adj.get(id) ?? []) {
      if (hasCycle(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  for (const n of nodes) {
    if (!visited.has(n.id) && hasCycle(n.id)) {
      errors.push("Workflow contains a cycle");
      break;
    }
  }

  const endIds = new Set(endNodes.map((n) => n.id));
  function reachesEnd(from: string, seen = new Set<string>()): boolean {
    if (endIds.has(from)) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const next of adj.get(from) ?? []) {
      if (reachesEnd(next, seen)) return true;
    }
    return false;
  }

  for (const n of nodes) {
    if (n.type === "start" || n.type === "end") continue;
    if (!reachesEnd(n.id)) {
      errors.push(`Node "${n.id}" does not reach an end node`);
    }
  }

  const reachable = new Set<string>();
  const startId = startNodes[0]?.id;
  if (startId) {
    const q = [startId];
    while (q.length) {
      const id = q.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const next of adj.get(id) ?? []) q.push(next);
    }
  }
  for (const n of nodes) {
    if (n.type !== "start" && !reachable.has(n.id)) {
      errors.push(`Orphan node "${n.id}" is not reachable from start`);
    }
  }

  for (const n of nodes) {
    if (!["conversation", "qa", "userInput", "react"].includes(n.type)) continue;
    const responses = (n.data.responses as { id: string }[] | undefined) ?? [];
    const out = edges.filter((e) => e.source === n.id);
    if (responses.length > 0) {
      for (const r of responses) {
        if (!out.some((e) => e.sourceHandle === r.id)) {
          errors.push(`Node "${n.id}" missing edge for branch "${r.id}"`);
        }
      }
      if (!out.some((e) => e.sourceHandle === NO_RESPONSE_HANDLE)) {
        errors.push(`Node "${n.id}" missing no-response edge`);
      }
    } else if (out.length === 0 && n.type !== "end") {
      const isGoodbye =
        n.type === "conversation" &&
        out.every((e) => endIds.has(e.target));
      if (!isGoodbye) warnings.push(`Node "${n.id}" has no outgoing edges`);
    }
  }

  const hasGoodbye = nodes.some((n) => {
    if (n.type !== "conversation") return false;
    const out = edges.filter((e) => e.source === n.id);
    return out.length > 0 && out.every((e) => endIds.has(e.target));
  });
  if (!hasGoodbye) {
    warnings.push("No goodbye conversation node (conversation → end only)");
  }

  return { errors, warnings };
}

export function compileSemanticGraph(raw: SemanticGraph): CompileResult {
  const warnings: string[] = [];
  let semantic = normalizeSemanticGraph(raw);
  semantic = ensureEndNode(semantic);
  semantic = injectGoodbyeNodes(semantic);

  if (!semantic.nodes.some((n) => n.id === semantic.startAt)) {
    return {
      nodes: [],
      edges: [],
      warnings: [],
      errors: [`startAt "${semantic.startAt}" not found in nodes`],
    };
  }

  const { nodes, edges } = buildFlowNodes(semantic);
  const validation = validateWorkflowGraph(nodes, edges);
  return {
    nodes,
    edges,
    warnings: [...warnings, ...validation.warnings],
    errors: validation.errors,
  };
}

export function buildEmptyGraph(): CompileResult {
  const nodes: FlowNode[] = [
    {
      id: "start",
      type: "start",
      position: { x: 80, y: 220 },
      data: { title: "Start" },
    },
    {
      id: "end",
      type: "end",
      position: { x: 360, y: 220 },
      data: { title: "End", status: "Completed" },
    },
  ];
  const edges: FlowEdge[] = [
    {
      id: "e-start-out-end",
      source: "start",
      target: "end",
      sourceHandle: null,
      targetHandle: null,
      type: "smoothstep",
    },
  ];
  return { nodes, edges, warnings: [], errors: [] };
}

/** Sample semantic graph covering all node types — used in tests and as LLM few-shot. */
export function sampleSemanticGraph(): SemanticGraph {
  return {
    startAt: "intro",
    nodes: [
      {
        id: "intro",
        type: "conversation",
        say: "Hello {{name}}, calling about {{reason}}. Do you have a moment?",
        silenceSec: 8,
        branches: [
          { label: "Yes", examples: ["yes", "sure", "haan"], goesTo: "qa" },
          { label: "No", examples: ["no", "busy"], goesTo: "goodbye" },
        ],
        noResponseGoesTo: "goodbye",
      },
      {
        id: "qa",
        type: "qa",
        say: "Do you have any questions?",
        silenceSec: 8,
        branches: [
          { label: "No questions", examples: ["no", "nothing"], goesTo: "detail" },
        ],
        noResponseGoesTo: "closing",
      },
      {
        id: "detail",
        type: "userInput",
        instruct: "Explain their loan details from the contact row data.",
        waitForResponse: true,
        silenceSec: 5,
        nextGoesTo: "react_ack",
        noResponseGoesTo: "closing",
      },
      {
        id: "react_ack",
        type: "react",
        instruct: "Acknowledge their response briefly.",
        replyGuide: "One short sentence.",
        waitForResponse: false,
        nextGoesTo: "closing",
      },
      {
        id: "closing",
        type: "conversation",
        say: "Thank you for your time. Goodbye.",
        nextGoesTo: "end",
      },
      {
        id: "goodbye",
        type: "conversation",
        say: "No problem. Thank you. Goodbye.",
        nextGoesTo: "end",
      },
      {
        id: "end",
        type: "end",
        endStatus: "Completed",
      },
    ],
  };
}
