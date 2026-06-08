import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, Send, Phone, MessageCircle } from "lucide-react";
import type { Edge, Node } from "reactflow";
import type { NodeData, ResponseBranch, WorkflowTools } from "./types";

type Msg = { role: "ai" | "user" | "system"; text: string };

type Props = {
  open: boolean;
  nodes: Node<NodeData>[];
  edges: Edge[];
  tools: WorkflowTools;
  onClose: () => void;
};

function findNextNode(
  nodeId: string,
  sourceHandle: string | null,
  nodes: Node<NodeData>[],
  edges: Edge[],
): Node<NodeData> | null {
  const edge = edges.find(
    (e) => e.source === nodeId && (e.sourceHandle ?? null) === sourceHandle,
  );
  if (!edge) return null;
  return nodes.find((n) => n.id === edge.target) ?? null;
}

function getStartNode(nodes: Node<NodeData>[]) {
  return nodes.find((n) => n.type === "start") ?? null;
}

export function TestModal({ open, nodes, edges, tools, onClose }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [branchOptions, setBranchOptions] = useState<ResponseBranch[]>([]);
  const [finished, setFinished] = useState(false);
  const [userInput, setUserInput] = useState("");

  const reset = useCallback(() => {
    setMessages([]);
    setCurrentNodeId(null);
    setBranchOptions([]);
    setFinished(false);
    setUserInput("");
  }, []);

  const advanceFrom = useCallback(
    (nodeId: string) => {
      let node = nodes.find((n) => n.id === nodeId) ?? null;

      while (node) {
        if (node.type === "start") {
          const next = findNextNode(node.id, null, nodes, edges);
          if (!next) {
            setFinished(true);
            return;
          }
          node = next;
          continue;
        }

        if (node.type === "userInput") {
          const instruction =
            node.data.instruction?.trim() || "Check context and tell the user all relevant details.";
          setMessages((prev) => [
            ...prev,
            { role: "ai", text: `[Speaks from Context: ${instruction}]` },
          ]);

          const waitForResponse = node.data.waitForResponse !== false;
          if (waitForResponse) {
            setCurrentNodeId(node.id);
            setBranchOptions([{ id: "ai-out", label: "okay", examples: ["okay"] }]);
            return;
          }

          const next = findNextNode(node.id, "ai-out", nodes, edges);
          if (!next) {
            setFinished(true);
            return;
          }
          node = next;
          continue;
        }

        if (node.type === "conversation" || node.type === "qa") {
          const text = node.data.message?.trim();
          if (text) {
            setMessages((prev) => [...prev, { role: "ai", text }]);
          }

          const responses = node.data.responses ?? [];
          if (responses.length > 0) {
            setCurrentNodeId(node.id);
            setBranchOptions(responses);
            return;
          }

          const next = findNextNode(node.id, "ai-out", nodes, edges);
          if (!next) {
            setFinished(true);
            return;
          }
          node = next;
          continue;
        }

        if (node.type === "end") {
          setMessages((prev) => [
            ...prev,
            {
              role: "system",
              text: `Workflow ended — ${node.data.status ?? "Completed"}`,
            },
          ]);
          setFinished(true);
          return;
        }

        setFinished(true);
        return;
      }
    },
    [nodes, edges],
  );

  const pickBranch = useCallback(
    (branch: ResponseBranch) => {
      setMessages((prev) => [...prev, { role: "user", text: branch.label.trim() || "Response" }]);
      setBranchOptions([]);
      setCurrentNodeId(null);

      const handle =
        currentNodeId &&
        nodes.find((n) => n.id === currentNodeId)?.type === "userInput" &&
        branch.id === "ai-out"
          ? "ai-out"
          : branch.id;
      const next = findNextNode(currentNodeId!, handle, nodes, edges);
      if (next) {
        advanceFrom(next.id);
      } else {
        setFinished(true);
      }
    },
    [currentNodeId, nodes, edges, advanceFrom],
  );

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    const start = getStartNode(nodes);
    if (start) {
      advanceFrom(start.id);
    } else {
      setFinished(true);
    }
  }, [open, nodes, edges, advanceFrom, reset]);

  const activeTools = useMemo(() => {
    const items: { icon: typeof Phone; label: string; detail: string }[] = [];
    if (tools.voice.enabled) {
      items.push({
        icon: Phone,
        label: "Voice",
        detail: "Enabled",
      });
    }
    if (tools.whatsapp.enabled) {
      items.push({
        icon: MessageCircle,
        label: "WhatsApp",
        detail: tools.whatsapp.phoneNumber,
      });
    }
    return items;
  }, [tools]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ y: 16, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 8, opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-white shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Preview
                </div>
                <div className="text-sm font-semibold">Test Conversation</div>
              </div>
              <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </div>

            {activeTools.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-b border-border bg-emerald-50/60 px-4 py-2">
                {activeTools.map((t) => (
                  <span
                    key={t.label}
                    className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-500 px-2 py-0.5 text-[10px] font-medium text-white"
                    title={t.detail}
                  >
                    <t.icon className="h-3 w-3" />
                    {t.label}
                  </span>
                ))}
              </div>
            )}

            <div className="max-h-[420px] space-y-3 overflow-y-auto bg-muted/30 px-4 py-4">
              {messages.length === 0 && !finished && (
                <p className="text-center text-xs text-muted-foreground">Starting workflow…</p>
              )}
              {messages.map((m, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed ${
                      m.role === "user"
                        ? "rounded-br-sm bg-foreground text-background"
                        : m.role === "system"
                          ? "rounded-md border border-emerald-200 bg-emerald-50 text-emerald-900"
                          : "rounded-bl-sm border border-border bg-white text-foreground"
                    }`}
                  >
                    {m.text}
                  </div>
                </motion.div>
              ))}

              {branchOptions.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {branchOptions.map((b) => (
                    <button
                      key={b.id}
                      onClick={() => pickBranch(b)}
                      className="rounded-full border border-border bg-white px-3 py-1 text-xs font-medium transition hover:border-foreground hover:bg-foreground hover:text-background"
                    >
                      {b.label.trim() || "Response"}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 border-t border-border px-3 py-3">
              <input
                placeholder={finished ? "Workflow complete" : "Type a free-form reply…"}
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                disabled={finished || branchOptions.length > 0}
                className="input flex-1 disabled:opacity-50"
              />
              <button
                disabled={finished || branchOptions.length > 0}
                className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-2 text-xs font-medium text-background disabled:opacity-40"
              >
                <Send className="h-3.5 w-3.5" /> Send
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
