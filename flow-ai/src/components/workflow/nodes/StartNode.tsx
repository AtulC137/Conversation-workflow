import { motion } from "framer-motion";
import { Handle, Position } from "reactflow";
import { Play } from "lucide-react";

export function StartNode({ selected }: { selected?: boolean }) {
  return (
    <motion.div
      whileHover={{ scale: 1.02 }}
      className={`flex items-center gap-2 rounded-full border bg-foreground px-3.5 py-1.5 text-background shadow-sm ${
        selected ? "ring-2 ring-foreground ring-offset-2" : "border-foreground"
      }`}
    >
      <Play className="h-3 w-3 fill-background" />
      <span className="text-xs font-semibold tracking-wide">START</span>
      <Handle type="source" position={Position.Right} className="!bg-foreground !border-background" />
    </motion.div>
  );
}
