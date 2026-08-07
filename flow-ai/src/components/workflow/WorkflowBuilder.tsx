import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type OnSelectionChangeParams,
  MarkerType,
} from "reactflow";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus,
  MessageSquareText,
  Square,
  Trash2,
  Copy,
  ClipboardPaste,
  HelpCircle,
  FileText,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { SettingsSheet } from "@/components/settings/SettingsSheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Sidebar } from "./Sidebar";
import { TopHeader } from "./TopHeader";
import { PropertiesPanel } from "./PropertiesPanel";
import { TestModal } from "./TestModal";
import { VoiceTestModal, type VoiceTestMode } from "./VoiceTestModal";
import { TemplateRunner, type RunnerContact } from "./TemplateRunner";
import { WorkflowGraphView } from "./WorkflowGraphView";
import { ToolConfigDialog } from "./ToolConfigDialog";
import { ContextConfigDialog, type ContextSaveValue } from "./ContextConfigDialog";
import { StartNode } from "./nodes/StartNode";
import { EndNode } from "./nodes/EndNode";
import { ConversationNode } from "./nodes/ConversationNode";
import { QaNode } from "./nodes/QaNode";
import { UserInputNode } from "./nodes/UserInputNode";
import { ReactNode } from "./nodes/ReactNode";
import {
  canTestWorkflow,
  DEFAULT_SILENCE_TIMEOUT_SEC,
  defaultWorkflowTools,
  type NodeData,
  type WorkflowTools,
} from "./types";
import { createInitialEdges, createInitialNodes } from "./initialFlow";
import { ApiError, getAccessToken } from "@/lib/api/client";
import { createVoiceSession } from "@/lib/api/voice.functions";
import { buildVoiceMicUiUrl } from "@/lib/voice-mic-url";
import {
  acquireTemplateLock,
  createTemplateFromPrompt,
  deleteTemplate,
  getTemplate,
  listTemplates,
  publishTemplate,
  releaseTemplateLock,
  updateTemplate,
  type TemplateRecord,
} from "@/lib/api/templates";
import { useAuth } from "@/lib/auth/AuthContext";
import { graphHasQaBlock, workflowToPrompt } from "@/lib/workflow-to-prompt";
import { resolveContactFields } from "@/lib/contact-fields";
import { Toaster } from "@/components/ui/sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const nodeTypes = {
  start: StartNode,
  end: EndNode,
  conversation: ConversationNode,
  qa: QaNode,
  userInput: UserInputNode,
  react: ReactNode,
};

type Workflow = {
  id: string;
  name: string;
  nodes: Node<NodeData>[];
  edges: Edge[];
  tools: WorkflowTools;
  context: string;
  script: string;
  confirmationQuestion: string;
  status: string;
  updatedAt: number;
  createdByUserId: string;
  createdByName: string;
};

type MainTab = "run" | "graph";

const marker = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#3f3f46" } as const;

function apiToWorkflow(w: {
  id: string;
  name: string;
  nodes: Node<NodeData>[];
  edges: Edge[];
  tools: WorkflowTools;
  prompt: string;
  script?: string;
  confirmationQuestion?: string;
  status: string;
  updatedAt: number;
  createdBy?: { id: string; name: string };
}): Workflow {
  return {
    id: w.id,
    name: w.name,
    nodes: w.nodes,
    edges: w.edges,
    tools: w.tools,
    context: w.prompt,
    script: w.script ?? "",
    confirmationQuestion: w.confirmationQuestion ?? "",
    status: w.status,
    updatedAt: w.updatedAt,
    createdByUserId: w.createdBy?.id ?? "",
    createdByName: w.createdBy?.name ?? "",
  };
}

function stripChannelNodes(nodes: Node<NodeData>[], edges: Edge[]) {
  const channelIds = new Set(nodes.filter((n) => n.type === "channel").map((n) => n.id));
  return {
    nodes: nodes.filter((n) => n.type !== "channel"),
    edges: edges.filter((e) => !channelIds.has(e.source) && !channelIds.has(e.target)),
  };
}

type BlockClipboard = { node: Node<NodeData> } | null;

type PendingDelete =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "workflow"; id: string };

function cloneNodeForPaste(
  source: Node<NodeData>,
  offset = { x: 40, y: 40 },
): Node<NodeData> {
  const id = `${source.type}-${Date.now()}`;
  const data = structuredClone(source.data);
  if ((source.type === "conversation" || source.type === "qa") && data.responses) {
    data.responses = data.responses.map((r) => ({
      ...r,
      id: `${id}-r-${Math.random().toString(36).slice(2, 7)}`,
    }));
  }
  return {
    ...source,
    id,
    position: {
      x: source.position.x + offset.x,
      y: source.position.y + offset.y,
    },
    data,
    selected: false,
  };
}

function isTypingTarget(target: EventTarget | null) {
  const t = target as HTMLElement | null;
  return (
    t &&
    (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
  );
}

function Inner() {
  const { user, logout, hasPermission } = useAuth();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingWorkflows, setLoadingWorkflows] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [voiceTestOpen, setVoiceTestOpen] = useState(false);
  const [voiceTestLoading, setVoiceTestLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toolConfigOpen, setToolConfigOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [clipboard, setClipboard] = useState<BlockClipboard>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasEditLock, setHasEditLock] = useState(false);
  const [lockedByName, setLockedByName] = useState<string | null>(null);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [campaignInfo, setCampaignInfo] = useState<{
    status: string;
    total: number;
    succeeded: number;
    failed: number;
    lastError?: string | null;
  } | null>(null);
  const [runnerContacts, setRunnerContacts] = useState<RunnerContact[]>([]);
  const [mainTab, setMainTab] = useState<MainTab>("run");
  const hasEditLockRef = useRef(false);

  const { fitView, getNode, setCenter } = useReactFlow();

  const active = useMemo(
    () => workflows.find((w) => w.id === activeId) ?? null,
    [workflows, activeId],
  );

  const { nodes, edges } = useMemo(() => {
    const rawNodes = active?.nodes ?? [];
    const rawEdges = active?.edges ?? [];
    return stripChannelNodes(rawNodes, rawEdges);
  }, [active?.nodes, active?.edges]);

  const tools = active?.tools ?? defaultWorkflowTools();
  const workflowContext = active?.context ?? "";
  const workflowConfirmation = active?.confirmationQuestion ?? "";

  const isOwnWorkflow = !!active && !!user && active.createdByUserId === user.id;
  const baseCanEditActive =
    !!active &&
    (isOwnWorkflow
      ? hasPermission("workflows.edit_own")
      : hasPermission("workflows.edit_all"));
  const canEditActive = baseCanEditActive && hasEditLock;
  const canPublishActive = canEditActive && hasPermission("workflows.publish");
  const canTestActive = hasPermission("workflows.test");
  const canCreateWorkflow = hasPermission("workflows.create");
  const canDeleteOwn = hasPermission("workflows.delete");
  const showCreatorInSidebar = hasPermission("workflows.view_all");

  const updateActive = useCallback(
    (updater: (w: Workflow) => Workflow) => {
      setWorkflows((ws) => ws.map((w) => (w.id === activeId ? updater(w) : w)));
    },
    [activeId],
  );

  const applyServerWorkflow = useCallback((record: TemplateRecord) => {
    const wf = apiToWorkflow(record);
    setWorkflows((ws) => ws.map((w) => (w.id === wf.id ? wf : w)));
    return wf;
  }, []);

  useEffect(() => {
    hasEditLockRef.current = hasEditLock;
  }, [hasEditLock]);

  useEffect(() => {
    if (!activeId || !user || loadingWorkflows || !baseCanEditActive) {
      setHasEditLock(false);
      setLockedByName(null);
      return;
    }

    let cancelled = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    (async () => {
      try {
        await acquireTemplateLock(activeId);
        if (cancelled) {
          await releaseTemplateLock(activeId).catch(() => {});
          return;
        }
        setHasEditLock(true);
        setLockedByName(null);
        heartbeat = setInterval(() => {
          acquireTemplateLock(activeId).catch(() => {});
        }, 30_000);
      } catch (err) {
        if (err instanceof ApiError && err.status === 423) {
          const body = err.body as { lock?: { userName: string } };
          setHasEditLock(false);
          setLockedByName(body.lock?.userName ?? "Another user");
          try {
            const { template } = await getTemplate(activeId);
            if (!cancelled) applyServerWorkflow(template);
          } catch {
            /* ignore refresh failure */
          }
        } else {
          setHasEditLock(false);
          setLockedByName(null);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (heartbeat) clearInterval(heartbeat);
      releaseTemplateLock(activeId).catch(() => {});
      setHasEditLock(false);
    };
  }, [activeId, user?.id, loadingWorkflows, baseCanEditActive, applyServerWorkflow]);

  useEffect(() => {
    const onBeforeUnload = () => {
      if (!activeId || !hasEditLockRef.current) return;
      const token = getAccessToken();
      const base = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
      fetch(`${base}/api/templates/${activeId}/lock`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [activeId]);

  useEffect(() => {
    (async () => {
      try {
        const { templates: list } = await listTemplates();
        if (list.length === 0) {
          setWorkflows([]);
          setActiveId(null);
        } else {
          const loaded = await Promise.all(
            list.map(async (s) => {
              const { template } = await getTemplate(s.id);
              return apiToWorkflow(template);
            }),
          );
          setWorkflows(loaded);
          setActiveId(loaded[0]?.id ?? null);
        }
      } catch (err) {
        toast.error("Failed to load templates", {
          description: err instanceof Error ? err.message : "Could not reach API",
        });
      } finally {
        setLoadingWorkflows(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!active || loadingWorkflows || !canEditActive) return;

    const serverUpdatedAt = active.updatedAt;
    const timer = setTimeout(async () => {
      setSaving(true);
      try {
        const { template } = await updateTemplate(active.id, {
          name: active.name,
          prompt: active.context,
          confirmationQuestion: active.confirmationQuestion,
          script: active.script,
          tools: active.tools,
          nodes: active.nodes,
          edges: active.edges,
          expectedUpdatedAt: serverUpdatedAt,
        });
        applyServerWorkflow(template);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const body = err.body as { template?: TemplateRecord };
          if (body.template) {
            applyServerWorkflow(body.template);
          }
          toast.error("Template was modified by another user", {
            description: "Your changes were discarded. Reloaded the latest version.",
          });
        } else {
          toast.error("Auto-save failed", {
            description: err instanceof Error ? err.message : "Could not save template",
          });
        }
      } finally {
        setSaving(false);
      }
    }, 800);

    return () => clearTimeout(timer);
  }, [
    active?.id,
    active?.name,
    active?.context,
    active?.confirmationQuestion,
    active?.script,
    active?.tools,
    active?.nodes,
    active?.edges,
    loadingWorkflows,
    canEditActive,
    applyServerWorkflow,
  ]);

  const setNodes = useCallback(
    (updater: Node<NodeData>[] | ((nds: Node<NodeData>[]) => Node<NodeData>[])) => {
      updateActive((w) => ({
        ...w,
        nodes: typeof updater === "function" ? (updater as any)(w.nodes) : updater,
      }));
    },
    [updateActive],
  );

  const setEdges = useCallback(
    (updater: Edge[] | ((eds: Edge[]) => Edge[])) => {
      updateActive((w) => ({
        ...w,
        edges: typeof updater === "function" ? (updater as any)(w.edges) : updater,
      }));
    },
    [updateActive],
  );

  const updateTools = useCallback(
    (updater: (tools: WorkflowTools) => WorkflowTools) => {
      updateActive((w) => ({
        ...w,
        tools: updater(w.tools ?? defaultWorkflowTools()),
      }));
    },
    [updateActive],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (!active || !canEditActive) return;
      const remove = changes.find((c) => c.type === "remove");
      if (remove && "id" in remove) {
        const node = nodes.find((n) => n.id === remove.id);
        if (node?.type === "start") return;
        setPendingDelete({ kind: "node", id: remove.id });
        const rest = changes.filter((c) => c.type !== "remove");
        if (rest.length) setNodes((nds) => applyNodeChanges(rest, nds));
        return;
      }
      setNodes((nds) => applyNodeChanges(changes, nds));
    },
    [active, canEditActive, nodes, setNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (!active || !canEditActive) return;
      const remove = changes.find((c) => c.type === "remove");
      if (remove && "id" in remove) {
        setPendingDelete({ kind: "edge", id: remove.id });
        const rest = changes.filter((c) => c.type !== "remove");
        if (rest.length) setEdges((eds) => applyEdgeChanges(rest, eds));
        return;
      }
      setEdges((eds) => applyEdgeChanges(changes, eds));
    },
    [active, canEditActive, setEdges],
  );

  const onConnect = useCallback(
    (params: Connection) => {
      if (!canEditActive) return;
      setEdges((eds) => {
        const cleaned = eds.filter(
          (e) =>
            !(
              e.source === params.source &&
              (e.sourceHandle ?? null) === (params.sourceHandle ?? null)
            ),
        );
        return addEdge({ ...params, type: "smoothstep", markerEnd: marker }, cleaned);
      });
    },
    [canEditActive, setEdges],
  );

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    setSelectedId(node.id);
    setSelectedEdgeId(null);
  }, []);

  const onSelectionChange = useCallback((sel: OnSelectionChangeParams) => {
    if (sel.edges.length === 1) {
      setSelectedEdgeId(sel.edges[0].id);
    }
  }, []);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  const updateNodeData = useCallback(
    (id: string, updater: (data: NodeData) => NodeData) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: updater(n.data) } : n)));
    },
    [setNodes],
  );

  const decoratedEdges = useMemo(() => {
    return edges.map((e) => {
      const connected = selectedId && (e.source === selectedId || e.target === selectedId);
      const isSelected = e.id === selectedEdgeId;
      return {
        ...e,
        animated: !!connected || isSelected,
        selected: isSelected,
        style: {
          ...(e.style ?? {}),
          stroke: connected || isSelected ? "#18181b" : "#a1a1aa",
          strokeWidth: connected || isSelected ? 1.75 : 1.25,
        },
      };
    });
  }, [edges, selectedId, selectedEdgeId]);

  const decoratedNodes = useMemo(
    () => nodes.map((n) => ({ ...n, selected: n.id === selectedId })),
    [nodes, selectedId],
  );

  const createWorkflow = useCallback(async () => {
    if (!canCreateWorkflow) {
      toast.error("You do not have permission to create templates");
      return;
    }
    setCreatingNew(true);
    setContextOpen(true);
  }, [canCreateWorkflow]);

  const selectWorkflow = useCallback((id: string) => {
    setActiveId(id);
    setSelectedId(null);
    setSelectedEdgeId(null);
  }, []);

  const renameWorkflow = useCallback(
    (name: string) => {
      if (!active) return;
      updateActive((w) => ({ ...w, name }));
    },
    [active, updateActive],
  );

  const addConversationNode = useCallback(() => {
    if (!active) return;
    const id = `conv-${Date.now()}`;
    const newNode: Node<NodeData> = {
      id,
      type: "conversation",
      position: { x: 360 + Math.random() * 80, y: 200 + Math.random() * 80 },
      data: {
        title: "",
        message: "",
        responses: [],
        tone: "Professional",
        notes: "",
        silenceTimeoutSec: DEFAULT_SILENCE_TIMEOUT_SEC,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setSelectedId(id);
  }, [active, setNodes]);

  const addQaNode = useCallback(() => {
    if (!active) return;
    const id = `qa-${Date.now()}`;
    const newNode: Node<NodeData> = {
      id,
      type: "qa",
      position: { x: 520 + Math.random() * 80, y: 320 + Math.random() * 80 },
      data: {
        title: "Q&A",
        message: "Do you have any questions?",
        responses: [
          {
            id: `${id}-r-no`,
            label: "no questions",
            examples: ["no", "no questions", "nothing", "nahi"],
          },
        ],
        notes: "",
        silenceTimeoutSec: DEFAULT_SILENCE_TIMEOUT_SEC,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setSelectedId(id);
  }, [active, setNodes]);

  const addUserInputNode = useCallback(() => {
    if (!active) return;
    const id = `userInput-${Date.now()}`;
    const newNode: Node<NodeData> = {
      id,
      type: "userInput",
      position: { x: 520 + Math.random() * 80, y: 240 + Math.random() * 80 },
      data: {
        title: "LLM",
        instruction: "Check context and tell the user all relevant details.",
        waitForResponse: true,
        responses: [],
        notes: "",
        silenceTimeoutSec: DEFAULT_SILENCE_TIMEOUT_SEC,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setSelectedId(id);
  }, [active, setNodes]);

  const addReactNode = useCallback(() => {
    if (!active) return;
    const id = `react-${Date.now()}`;
    const newNode: Node<NodeData> = {
      id,
      type: "react",
      position: { x: 520 + Math.random() * 80, y: 320 + Math.random() * 80 },
      data: {
        title: "React",
        instruction: "Check the caller's last reply using context.",
        replyGuide:
          "If anything is missing, tell the user we have noted it and will add it to the list. Name the item. Be short.",
        waitForResponse: true,
        responses: [],
        notes: "",
        silenceTimeoutSec: DEFAULT_SILENCE_TIMEOUT_SEC,
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setSelectedId(id);
  }, [active, setNodes]);

  const addEndNode = useCallback(() => {
    if (!active) return;
    const id = `end-${Date.now()}`;
    setNodes((nds) => [
      ...nds,
      {
        id,
        type: "end",
        position: { x: 700, y: 460 },
        data: { title: "End", status: "Completed" },
      },
    ]);
    setSelectedId(id);
  }, [active, setNodes]);

  const handleToggleTool = useCallback(
    (tool: "voice" | "whatsapp") => {
      if (!active) return;
      const current = tools[tool];
      if (current.enabled) {
        updateTools((t) => ({
          ...t,
          [tool]: { ...t[tool], enabled: false },
        }));
        return;
      }
      if (tool === "voice") {
        updateTools((t) => ({ ...t, voice: { enabled: true } }));
        return;
      }
      setToolConfigOpen(true);
    },
    [active, tools, updateTools],
  );

  const handleConfigureTool = useCallback(() => {
    setToolConfigOpen(true);
  }, []);

  const handleSaveToolConfig = useCallback(
    (value: string) => {
      updateTools((t) => ({
        ...t,
        whatsapp: { enabled: true, phoneNumber: value },
      }));
      setToolConfigOpen(false);
    },
    [updateTools],
  );

  const handleSaveContext = useCallback(
    async ({ prompt, confirmationQuestion }: ContextSaveValue) => {
      if (!prompt.trim()) {
        setContextOpen(false);
        setCreatingNew(false);
        return;
      }
      try {
        if (active && canEditActive && !creatingNew) {
          const { template } = await updateTemplate(active.id, {
            prompt: prompt.trim(),
            confirmationQuestion: confirmationQuestion.trim(),
            expectedUpdatedAt: active.updatedAt,
          });
          applyServerWorkflow(template);
          setContextOpen(false);
          toast.success("Call info updated");
          return;
        }

        const { template } = await createTemplateFromPrompt({
          name: `Template ${workflows.length + 1}`,
          prompt: prompt.trim(),
          confirmationQuestion: confirmationQuestion.trim(),
        });
        const wf = apiToWorkflow(template);
        setWorkflows((ws) => [wf, ...ws]);
        setActiveId(wf.id);
        setSelectedId(null);
        setSelectedEdgeId(null);
        setMainTab("run");
        setCreatingNew(false);
        setContextOpen(false);
        toast.success("Template created");
      } catch (err) {
        toast.error("Failed to save prompt", {
          description: err instanceof Error ? err.message : "Could not save",
        });
      }
    },
    [active, canEditActive, workflows.length, applyServerWorkflow, creatingNew],
  );

  const handleTest = useCallback(async () => {
    if (!canTestWorkflow(tools)) {
      toast.error("Enable Voice or WhatsApp to test", {
        description: "Turn on a tool in the header and complete its configuration first.",
      });
      return;
    }

    if (tools.voice.enabled) {
      if (graphHasQaBlock(nodes) && !workflowContext.trim()) {
          toast.error("Add prompt for Q&A", {
            description: "Open Prompt in the header and add the prompt the agent should follow.",
        });
        return;
      }
      setVoiceTestOpen(true);
      return;
    }

    setTestOpen(true);
  }, [tools, nodes, edges, workflowContext]);

  const handleVoiceTest = useCallback(
    async (
      mode: VoiceTestMode,
      phoneNumber?: string,
      contactFields?: Record<string, string>,
    ) => {
      try {
        const token = getAccessToken();
        if (!token) {
          toast.error("Not signed in");
          return;
        }
        setVoiceTestLoading(true);
        const config = workflowToPrompt(nodes, edges, workflowContext);
        const fields = resolveContactFields(runnerContacts, phoneNumber, contactFields);
        const { sessionId } = await createVoiceSession({
          data: {
            ...config,
            workflowId: active?.id,
            accessToken: token,
            testMode: mode,
            phoneNumber: mode === "phone" ? phoneNumber : undefined,
            contactFields: fields,
          },
        });
        setVoiceTestOpen(false);
        if (mode === "browser") {
          window.open(buildVoiceMicUiUrl(sessionId), "_blank");
          toast.success("Voice test opened in browser");
        } else {
          toast.success(`Calling ${phoneNumber}…`, {
            description: "Answer your phone to talk to the agent.",
          });
        }
      } catch (err) {
        toast.error("Failed to start voice test", {
          description: err instanceof Error ? err.message : "Could not create voice session",
        });
      } finally {
        setVoiceTestLoading(false);
      }
    },
    [nodes, edges, workflowContext, active?.id, runnerContacts],
  );

  const handlePublish = useCallback(async () => {
    if (!active) return;
    try {
      const { version } = await publishTemplate(active.id);
      setWorkflows((ws) =>
        ws.map((w) => (w.id === active.id ? { ...w, status: "published" } : w)),
      );
      toast.success("Template published", {
        description: `Version ${version.versionNumber} is live.`,
      });
    } catch (err) {
      toast.error("Publish failed", {
        description: err instanceof Error ? err.message : "Could not publish template",
      });
    }
  }, [active]);

  const handleLogout = useCallback(async () => {
    await logout();
    window.location.href = "/login";
  }, [logout]);

  const copySelectedBlock = useCallback(() => {
    if (!selectedNode || selectedNode.type === "start") return;
    setClipboard({ node: structuredClone(selectedNode) });
    toast.success("Block copied");
  }, [selectedNode]);

  const pasteBlock = useCallback(() => {
    if (!active || !clipboard) return;
    const cloned = cloneNodeForPaste(clipboard.node);
    setNodes((nds) => [...nds, cloned]);
    setSelectedId(cloned.id);
    setSelectedEdgeId(null);
    setCenter(cloned.position.x + 140, cloned.position.y + 60, { zoom: 1, duration: 350 });
    toast.success("Block pasted");
  }, [active, clipboard, setNodes, setCenter]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;

    if (pendingDelete.kind === "workflow") {
      const deletedId = pendingDelete.id;
      try {
        await deleteTemplate(deletedId);
        const remaining = workflows.filter((w) => w.id !== deletedId);
        setWorkflows(remaining);
        if (activeId === deletedId) {
          setActiveId(remaining[0]?.id ?? null);
          setSelectedId(null);
          setSelectedEdgeId(null);
        }
      } catch (err) {
        toast.error("Failed to delete template", {
          description: err instanceof Error ? err.message : "Could not delete template",
        });
        setPendingDelete(null);
        return;
      }
    } else if (pendingDelete.kind === "node") {
      const node = nodes.find((n) => n.id === pendingDelete.id);
      if (node?.type === "start") {
        setPendingDelete(null);
        return;
      }
      setNodes((nds) => nds.filter((n) => n.id !== pendingDelete.id));
      setEdges((eds) =>
        eds.filter((e) => e.source !== pendingDelete.id && e.target !== pendingDelete.id),
      );
      if (selectedId === pendingDelete.id) setSelectedId(null);
    } else {
      setEdges((eds) => eds.filter((e) => e.id !== pendingDelete.id));
      if (selectedEdgeId === pendingDelete.id) setSelectedEdgeId(null);
    }
    setPendingDelete(null);
  }, [pendingDelete, nodes, workflows, setNodes, setEdges, selectedId, selectedEdgeId, activeId]);

  const requestDeleteSelected = useCallback(() => {
    if (selectedId) {
      const n = nodes.find((x) => x.id === selectedId);
      if (n && n.type === "start") return;
      setPendingDelete({ kind: "node", id: selectedId });
    } else if (selectedEdgeId) {
      setPendingDelete({ kind: "edge", id: selectedEdgeId });
    }
  }, [selectedId, selectedEdgeId, nodes]);

  const requestDeleteWorkflow = useCallback((id: string) => {
    setPendingDelete({ kind: "workflow", id });
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (isTypingTarget(e.target)) return;

      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        createWorkflow();
      } else if (key === "c") {
        e.preventDefault();
        copySelectedBlock();
      } else if (key === "v") {
        e.preventDefault();
        pasteBlock();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [createWorkflow, copySelectedBlock, pasteBlock]);

  const toolConfigInitialValue = tools.whatsapp.phoneNumber;

  const uploadExcel = useCallback(async (file: File) => {
    const token = getAccessToken();
    if (!token) throw new Error("Not signed in");
    const base = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${base}/api/campaigns/parse-excel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      credentials: "include",
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Excel parse failed (${res.status})`);
    }
    return (await res.json()) as { contacts: RunnerContact[] };
  }, []);

  const startBulkCalls = useCallback(
    async (contacts: RunnerContact[]) => {
      if (!contacts.length) return;
      if (!active) throw new Error("No template selected");

      const token = getAccessToken();
      if (!token) throw new Error("Not signed in");

      const sessionConfig = workflowToPrompt(nodes, edges, workflowContext);

      const base = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
      const res = await fetch(`${base}/api/campaigns/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          templateId: active.id,
          contacts,
          sessionConfig,
        }),
        credentials: "include",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Campaign start failed (${res.status})`);
      }
      const json = (await res.json()) as { campaignId: string };
      setCampaignId(json.campaignId);
    },
    [active, nodes, edges, workflowContext],
  );

  useEffect(() => {
    if (!campaignId) {
      setCampaignInfo(null);
      return;
    }
    const token = getAccessToken();
    if (!token) return;

    const base = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`${base}/api/campaigns/${campaignId}`, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: "include",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { campaign: any };
        if (cancelled) return;
        setCampaignInfo({
          status: body.campaign.status,
          total: body.campaign.total,
          succeeded: body.campaign.succeeded,
          failed: body.campaign.failed,
          lastError: body.campaign.lastError ?? null,
        });
        if (body.campaign.status === "completed" || body.campaign.status === "failed") {
          return;
        }
      } catch {
        /* ignore */
      }
      if (!cancelled) setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  if (loadingWorkflows) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Loading templates…
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        workflows={workflows.map((w) => ({
          id: w.id,
          name: w.name,
          updatedAt: w.updatedAt,
          createdByUserId: w.createdByUserId,
          createdByName: w.createdByName,
        }))}
        activeId={activeId}
        onSelect={selectWorkflow}
        onCreate={createWorkflow}
        onDelete={requestDeleteWorkflow}
        canCreate={canCreateWorkflow}
        canDeleteOwn={canDeleteOwn}
        currentUserId={user?.id}
        showCreator={showCreatorInSidebar}
        showDashboardLink={hasPermission("dashboard.access")}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopHeader
          title={active?.name ?? "No template selected"}
          status={active?.status ?? "draft"}
          canEdit={canEditActive}
          canTest={canTestActive}
          canPublish={canPublishActive}
          lockedByName={lockedByName}
          tools={tools}
          hasContext={workflowContext.trim().length > 0}
          saving={saving}
          onTitleChange={renameWorkflow}
          onTest={handleTest}
          onPublish={handlePublish}
          onLogout={handleLogout}
          onOpenContext={() => {
            setCreatingNew(false);
            setContextOpen(true);
          }}
          onToggleTool={handleToggleTool}
          onConfigureTool={handleConfigureTool}
        />

        <div className="relative flex min-h-0 flex-1 flex-col">
          {active && (
            <div className="flex shrink-0 gap-1 border-b border-border px-4 py-2">
              {(
                [
                  ["run", "Run"],
                  ["graph", "Graph"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setMainTab(id)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    mainTab === id
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          <div className="relative min-h-0 flex-1">
            {!active ? (
              <EmptyCanvas onCreate={createWorkflow} />
            ) : mainTab === "graph" ? (
              <WorkflowGraphView
                nodes={decoratedNodes}
                edges={decoratedEdges}
                readOnly={!canEditActive}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
              />
            ) : (
              <TemplateRunner
                templateName={active.name}
                systemPrompt={workflowContext}
                confirmationQuestion={workflowConfirmation}
                canEditPrompt={canEditActive}
                onEditPrompt={() => {
                  setCreatingNew(false);
                  setContextOpen(true);
                }}
                onBrowserTest={() => {
                  const fields = resolveContactFields(runnerContacts);
                  if (!fields || !Object.keys(fields).length) {
                    toast.error("Upload Excel first", {
                      description: "Browser test needs a contact row (name, phone, …).",
                    });
                    return;
                  }
                  void handleVoiceTest("browser", undefined, fields);
                }}
                onCallPhone={(phone, fields) => handleVoiceTest("phone", phone, fields)}
                onUploadExcel={uploadExcel}
                onStartBulkCalls={startBulkCalls}
                onContactsChange={setRunnerContacts}
                campaignInfo={campaignInfo}
              />
            )}
          </div>
        </div>
      </div>

      <TestModal
        open={testOpen}
        nodes={nodes}
        edges={edges}
        tools={tools}
        onClose={() => setTestOpen(false)}
      />

      <VoiceTestModal
        open={voiceTestOpen}
        loading={voiceTestLoading}
        onClose={() => setVoiceTestOpen(false)}
        onTest={handleVoiceTest}
      />

      <ContextConfigDialog
        open={contextOpen}
        initialValue={creatingNew ? "" : workflowContext}
        initialConfirmation={creatingNew ? "" : workflowConfirmation}
        onClose={() => {
          setContextOpen(false);
          setCreatingNew(false);
        }}
        onSave={handleSaveContext}
      />

      <ToolConfigDialog
        open={toolConfigOpen}
        initialValue={toolConfigInitialValue}
        onClose={() => setToolConfigOpen(false)}
        onSave={handleSaveToolConfig}
      />

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.kind === "workflow"
                ? "Delete template?"
                : pendingDelete?.kind === "edge"
                  ? "Delete connection?"
                  : "Delete block?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.kind === "workflow"
                ? "This template and all its blocks will be removed. This action cannot be undone."
                : pendingDelete?.kind === "edge"
                  ? "This connection will be removed from the workflow."
                  : "This block and any connections to it will be removed. This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

function CanvasActions({
  canCopy,
  canPaste,
  canDeleteBlock,
  canDeleteEdge,
  onCopy,
  onPaste,
  onDelete,
}: {
  canCopy: boolean;
  canPaste: boolean;
  canDeleteBlock: boolean;
  canDeleteEdge: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onDelete: () => void;
}) {
  const showDelete = canDeleteBlock || canDeleteEdge;
  if (!canCopy && !canPaste && !showDelete) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="absolute bottom-6 right-6 z-10 flex items-center gap-1.5"
    >
      {canCopy && (
        <button
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-2 text-xs font-medium shadow-sm transition hover:border-foreground/30"
        >
          <Copy className="h-3.5 w-3.5" />
          Copy
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            ⌘C
          </kbd>
        </button>
      )}
      {canPaste && (
        <button
          onClick={onPaste}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-2 text-xs font-medium shadow-sm transition hover:border-foreground/30"
        >
          <ClipboardPaste className="h-3.5 w-3.5" />
          Paste
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            ⌘V
          </kbd>
        </button>
      )}
      {showDelete && (
        <button
          onClick={onDelete}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-2 text-xs font-medium text-destructive shadow-sm transition hover:border-destructive/40"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete {canDeleteBlock ? "block" : "connection"}
          <kbd className="ml-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            ⌫
          </kbd>
        </button>
      )}
    </motion.div>
  );
}

function EmptyCanvas({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-[radial-gradient(circle_at_center,_#f4f4f5_1px,_transparent_1px)] [background-size:22px_22px]">
      <div className="max-w-sm rounded-2xl border border-border bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-foreground text-background">
          <Plus className="h-5 w-5" />
        </div>
        <h3 className="text-base font-semibold">No template selected</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a prompt to generate your first template.
        </p>
        <button
          onClick={onCreate}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New Template
        </button>
      </div>
    </div>
  );
}

function BlockPalette({
  onAddConversation,
  onAddUserInput,
  onAddReact,
  onAddQa,
  onAddEnd,
}: {
  onAddConversation: () => void;
  onAddUserInput: () => void;
  onAddReact: () => void;
  onAddQa: () => void;
  onAddEnd: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEnter = () => {
    if (collapseTimer.current) {
      clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
    setExpanded(true);
  };

  const handleLeave = () => {
    collapseTimer.current = setTimeout(() => setExpanded(false), 150);
  };

  useEffect(() => {
    return () => {
      if (collapseTimer.current) clearTimeout(collapseTimer.current);
    };
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      <motion.div
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0, width: expanded ? "auto" : 40 }}
        transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        className="absolute left-4 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1.5 overflow-hidden rounded-2xl border border-border bg-white/95 p-1.5 shadow-[0_4px_18px_-8px_rgba(0,0,0,0.15)] backdrop-blur"
      >
        <PaletteButton
          icon={MessageSquareText}
          label="Conversation"
          expanded={expanded}
          onClick={onAddConversation}
        />
        <PaletteButton icon={FileText} label="LLM" expanded={expanded} onClick={onAddUserInput} />
        <PaletteButton icon={Sparkles} label="React" expanded={expanded} onClick={onAddReact} />
        <PaletteButton icon={HelpCircle} label="Q&A" expanded={expanded} onClick={onAddQa} />
        <div className="my-0.5 h-px bg-border" />
        <PaletteButton icon={Square} label="End" expanded={expanded} onClick={onAddEnd} />
      </motion.div>
    </TooltipProvider>
  );
}

function PaletteButton({
  icon: Icon,
  label,
  expanded,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  expanded: boolean;
  onClick: () => void;
}) {
  const button = (
    <button
      onClick={onClick}
      title={label}
      className={`group flex items-center rounded-lg text-left text-[12px] font-medium text-foreground transition hover:bg-foreground hover:text-background ${
        expanded ? "gap-2 px-2 py-1.5" : "justify-center p-2"
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {expanded && <span className="pr-1 whitespace-nowrap">{label}</span>}
    </button>
  );

  if (expanded) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="pointer-events-auto rounded-lg border border-border bg-white/90 px-3 py-1.5 text-xs backdrop-blur">
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-2 font-semibold text-foreground tabular-nums">{value}</span>
    </div>
  );
}

function countBranches(nodes: Node<NodeData>[]) {
  return nodes.reduce((acc, n) => acc + (n.data?.responses?.length ?? 0), 0);
}

export function WorkflowBuilder() {
  return (
    <>
      <ReactFlowProvider>
        <Inner />
      </ReactFlowProvider>
      <Toaster />
    </>
  );
}
