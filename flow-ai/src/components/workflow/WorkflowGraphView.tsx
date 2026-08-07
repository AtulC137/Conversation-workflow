import { useEffect, useRef } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";

import { StartNode } from "./nodes/StartNode";
import { EndNode } from "./nodes/EndNode";
import { ConversationNode } from "./nodes/ConversationNode";
import { QaNode } from "./nodes/QaNode";
import { UserInputNode } from "./nodes/UserInputNode";
import { ReactNode } from "./nodes/ReactNode";
import type { NodeData } from "./types";

const nodeTypes = {
  start: StartNode,
  conversation: ConversationNode,
  qa: QaNode,
  userInput: UserInputNode,
  react: ReactNode,
  end: EndNode,
};

const marker = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#3f3f46" } as const;

type WorkflowGraphViewProps = {
  nodes: Node<NodeData>[];
  edges: Edge[];
  readOnly?: boolean;
  onNodesChange?: (changes: NodeChange[]) => void;
  onEdgesChange?: (changes: EdgeChange[]) => void;
  onConnect?: (connection: Connection) => void;
};

function FitViewOnStructureChange({ nodes }: { nodes: Node<NodeData>[] }) {
  const { fitView } = useReactFlow();
  const structureKey = nodes
    .map((n) => n.id)
    .sort()
    .join(",");
  const prevKey = useRef("");

  useEffect(() => {
    if (nodes.length === 0) return;
    if (structureKey === prevKey.current) return;
    prevKey.current = structureKey;
    const t = setTimeout(() => fitView({ padding: 0.2, duration: 200 }), 50);
    return () => clearTimeout(t);
  }, [structureKey, nodes.length, fitView]);

  return null;
}

export function WorkflowGraphView({
  nodes,
  edges,
  readOnly = true,
  onNodesChange,
  onEdgesChange,
  onConnect,
}: WorkflowGraphViewProps) {
  const decoratedEdges = edges.map((e) => ({
    ...e,
    type: e.type ?? "smoothstep",
    markerEnd: e.markerEnd ?? marker,
  }));

  if (nodes.length <= 1) {
    return (
      <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_center,_#f4f4f5_1px,_transparent_1px)] [background-size:22px_22px]">
        <p className="text-sm text-muted-foreground">
          No graph yet. Save call info to build the default flow.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={decoratedEdges}
        nodeTypes={nodeTypes}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        onNodesChange={readOnly ? undefined : onNodesChange}
        onEdgesChange={readOnly ? undefined : onEdgesChange}
        onConnect={readOnly ? undefined : onConnect}
        panOnDrag
        zoomOnScroll
        fitView
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#e4e4e7" />
        <Controls showInteractive={!readOnly} />
        <MiniMap
          className="!bg-white/90"
          nodeColor={(n) => {
            if (n.type === "start") return "#a1a1aa";
            if (n.type === "end") return "#71717a";
            if (n.type === "qa") return "#60a5fa";
            if (n.type === "userInput") return "#a78bfa";
            if (n.type === "react") return "#f472b6";
            return "#d4d4d8";
          }}
        />
        <FitViewOnStructureChange nodes={nodes} />
      </ReactFlow>
    </div>
  );
}
