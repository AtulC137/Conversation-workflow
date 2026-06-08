import { motion } from "framer-motion";
import { Handle, Position, type NodeProps } from "reactflow";
import { HelpCircle, ChevronRight } from "lucide-react";
import type { NodeData } from "../types";
import { NO_RESPONSE_HANDLE } from "../types";

export function QaNode({ data, selected }: NodeProps<NodeData>) {
  const responses = data.responses ?? [];
  const hasMessage = Boolean(data.message?.trim());

  return (
    <motion.div
      whileHover={{ y: -1, boxShadow: "0 10px 30px -12px rgba(0,0,0,0.18)" }}
      transition={{ duration: 0.15 }}
      className={`w-[280px] overflow-hidden rounded-xl border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_16px_-8px_rgba(0,0,0,0.08)] ${
        selected ? "border-violet-600 ring-2 ring-violet-600/15" : "border-border"
      }`}
    >
      <Handle type="target" position={Position.Left} />

      <div className="flex items-center gap-2 border-b border-border bg-violet-50/60 px-3.5 py-2.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-100">
          <HelpCircle className="h-3.5 w-3.5 text-violet-700" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight">
            {data.title?.trim() ? data.title : "Q&A"}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-violet-700/80">Context Q&A</div>
        </div>
      </div>

      <div className="px-3.5 py-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          AI asks
        </div>
        {hasMessage ? (
          <p className="mt-1 line-clamp-3 text-[12.5px] leading-relaxed text-foreground/90">
            &ldquo;{data.message}&rdquo;
          </p>
        ) : (
          <p className="mt-1 line-clamp-3 text-[12.5px] italic leading-relaxed text-muted-foreground">
            Do you have any questions?
          </p>
        )}
      </div>

      <div className="border-t border-border bg-muted/30 px-3.5 py-2.5">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Closing branches
        </div>
        <div className="space-y-1.5">
          {responses.length === 0 ? (
            <div className="relative">
              <div className="flex items-center justify-between rounded-md border border-dashed border-border bg-white/80 px-2.5 py-1.5 text-[12px] text-muted-foreground">
                <span>No questions</span>
                <ChevronRight className="h-3 w-3" />
              </div>
              <Handle id="ai-out" type="source" position={Position.Right} style={{ top: "50%" }} />
            </div>
          ) : (
            responses.map((r) => (
              <div key={r.id} className="relative">
                <div className="flex items-center justify-between rounded-md border border-border bg-white px-2.5 py-1.5 text-[12px]">
                  <span className="font-medium text-foreground/90">
                    {r.label.trim() ? r.label : "No questions"}
                  </span>
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                </div>
                <Handle id={r.id} type="source" position={Position.Right} style={{ top: "50%" }} />
              </div>
            ))
          )}
          <div className="relative">
            <div className="flex items-center justify-between rounded-md border border-dashed border-amber-300/80 bg-amber-50/50 px-2.5 py-1.5 text-[12px] text-amber-900/80">
              <span>No response</span>
              <ChevronRight className="h-3 w-3" />
            </div>
            <Handle
              id={NO_RESPONSE_HANDLE}
              type="source"
              position={Position.Right}
              style={{ top: "50%" }}
            />
          </div>
        </div>
      </div>
    </motion.div>
  );
}
