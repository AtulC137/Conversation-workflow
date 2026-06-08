import { motion } from "framer-motion";
import { Handle, Position, type NodeProps } from "reactflow";
import { Square } from "lucide-react";
import type { NodeData } from "../types";

export function EndNode({ data, selected }: NodeProps<NodeData>) {
  return (
    <motion.div
      whileHover={{ scale: 1.02 }}
      className={`flex flex-col items-start gap-0.5 rounded-xl border bg-muted px-3.5 py-2 text-foreground shadow-sm ${
        selected ? "border-foreground ring-2 ring-foreground/20" : "border-border"
      }`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <Square className="h-3 w-3 fill-muted-foreground text-muted-foreground" />
        <span className="text-xs font-semibold tracking-wide text-muted-foreground">END</span>
      </div>
      <div className="text-xs font-medium">{data.status ?? "Completed"}</div>
    </motion.div>
  );
}
