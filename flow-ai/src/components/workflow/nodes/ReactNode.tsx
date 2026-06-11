import { motion } from "framer-motion";
import { Handle, Position, type NodeProps } from "reactflow";
import { Sparkles, ChevronRight } from "lucide-react";
import type { NodeData } from "../types";
import { NO_RESPONSE_HANDLE } from "../types";

export function ReactNode({ data, selected }: NodeProps<NodeData>) {
  const instruction = data.instruction?.trim();
  const replyGuide = data.replyGuide?.trim();
  const waitForResponse = data.waitForResponse !== false;
  const responses = data.responses ?? [];

  return (
    <motion.div
      whileHover={{ y: -1, boxShadow: "0 10px 30px -12px rgba(0,0,0,0.18)" }}
      transition={{ duration: 0.15 }}
      className={`w-[280px] overflow-hidden rounded-xl border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_16px_-8px_rgba(0,0,0,0.08)] ${
        selected ? "border-sky-600 ring-2 ring-sky-600/15" : "border-border"
      }`}
    >
      <Handle type="target" position={Position.Left} />

      <div className="flex items-center gap-2 border-b border-border bg-sky-50/60 px-3.5 py-2.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-sky-100">
          <Sparkles className="h-3.5 w-3.5 text-sky-700" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight">
            {data.title?.trim() ? data.title : "React"}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-sky-700/80">
            React Block
          </div>
        </div>
      </div>

      <div className="px-3.5 py-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Instruction
        </div>
        {instruction ? (
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-foreground/90">
            {instruction}
          </p>
        ) : (
          <p className="mt-1 line-clamp-2 text-[12.5px] italic leading-relaxed text-muted-foreground">
            Check the caller&apos;s last reply using context.
          </p>
        )}
        <div className="mt-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Reply
        </div>
        {replyGuide ? (
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-foreground/90">
            {replyGuide}
          </p>
        ) : (
          <p className="mt-1 line-clamp-2 text-[12.5px] italic leading-relaxed text-muted-foreground">
            Guide how the AI should respond aloud.
          </p>
        )}
        <p className="mt-2 text-[10px] text-muted-foreground">
          {waitForResponse ? "Waits for caller response" : "Auto-advances after speaking"}
        </p>
      </div>

      <div className="border-t border-border bg-muted/30 px-3.5 py-2.5">
        {responses.length > 0 && (
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Expected responses
          </div>
        )}
        <div className="space-y-1.5">
          {responses.length === 0 ? (
            <div className="relative">
              <div className="flex items-center justify-between rounded-md border border-border bg-white px-2.5 py-1.5 text-[12px]">
                <span className="font-medium text-foreground/90">Next</span>
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              </div>
              <Handle id="ai-out" type="source" position={Position.Right} style={{ top: "50%" }} />
            </div>
          ) : (
            responses.map((r) => (
              <div key={r.id} className="relative">
                <div className="flex items-center justify-between rounded-md border border-border bg-white px-2.5 py-1.5 text-[12px]">
                  <span className="font-medium text-foreground/90">
                    {r.label.trim() ? r.label : "Response label"}
                  </span>
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                </div>
                <Handle
                  id={r.id}
                  type="source"
                  position={Position.Right}
                  style={{ top: "50%" }}
                />
              </div>
            ))
          )}
          {waitForResponse && (
            <div className="relative">
              <div className="flex items-center justify-between rounded-md border border-dashed border-sky-300/80 bg-sky-50/50 px-2.5 py-1.5 text-[12px] text-sky-900/80">
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
          )}
        </div>
      </div>
    </motion.div>
  );
}
