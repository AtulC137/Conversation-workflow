import { useState } from "react";
import { useReactFlow } from "reactflow";
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Play,
  Rocket,
  ChevronDown,
  Phone,
  Pencil,
  BookOpen,
} from "lucide-react";
import type { WorkflowTools } from "./types";

type Props = {
  title: string;
  status?: string;
  canEdit?: boolean;
  canTest?: boolean;
  canPublish?: boolean;
  lockedByName?: string | null;
  tools: WorkflowTools;
  hasContext: boolean;
  saving?: boolean;
  onTitleChange: (v: string) => void;
  onTest: () => void;
  onPublish: () => void;
  onLogout: () => void;
  onOpenContext: () => void;
  onToggleTool: (tool: "voice" | "whatsapp") => void;
  onConfigureTool: (tool: "whatsapp") => void;
};

export function TopHeader({
  title,
  status = "draft",
  canEdit = true,
  canTest = true,
  canPublish = true,
  lockedByName = null,
  tools,
  hasContext,
  saving = false,
  onTitleChange,
  onTest,
  onPublish,
  onLogout,
  onOpenContext,
  onToggleTool,
  onConfigureTool,
}: Props) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const [editing, setEditing] = useState(false);

  return (
    <>
      {lockedByName && (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          Being edited by <span className="font-semibold">{lockedByName}</span> — view only
        </div>
      )}
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
      {/* Title */}
      <div className="flex min-w-0 items-center gap-2">
        {editing && canEdit ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => e.key === "Enter" && setEditing(false)}
            className="rounded-md border border-foreground/20 bg-white px-2 py-1 text-sm font-semibold outline-none"
          />
        ) : (
          <button
            onClick={() => canEdit && setEditing(true)}
            disabled={!canEdit}
            className="truncate rounded-md px-2 py-1 text-sm font-semibold hover:bg-muted disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent"
          >
            {title}
          </button>
        )}
        <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium capitalize text-muted-foreground">
          {status}
        </span>
      </div>

      {/* Status */}
      <div className="ml-2 flex items-center gap-1.5">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        <span className="text-xs text-muted-foreground">{saving ? "Saving…" : "Saved"}</span>
      </div>

      <div className="flex-1" />

      {/* Context + tool toggles */}
      <div className="hidden items-center gap-1.5 md:flex">
        <button
          onClick={onOpenContext}
          disabled={!canEdit}
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
            hasContext
              ? "border-violet-600 bg-violet-500 text-white shadow-sm"
              : "border-border bg-muted/40 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          }`}
        >
          <BookOpen className="h-3 w-3" /> Call info
        </button>
        <ToolToggle
          icon={Phone}
          label="Voice"
          enabled={tools.voice.enabled}
          disabled={!canEdit}
          onToggle={() => onToggleTool("voice")}
        />
      </div>

      {/* Zoom */}
      <div className="flex items-center rounded-lg border border-border bg-white">
        <button onClick={() => zoomOut({ duration: 200 })} className="p-1.5 text-muted-foreground hover:text-foreground">
          <ZoomOut className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => fitView({ duration: 300, padding: 0.2 })} className="border-x border-border p-1.5 text-muted-foreground hover:text-foreground">
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => zoomIn({ duration: 200 })} className="p-1.5 text-muted-foreground hover:text-foreground">
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
      </div>

      <button
        onClick={onTest}
        disabled={!canTest}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-foreground/30 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Play className="h-3.5 w-3.5" /> Test Template
      </button>
      <button
        onClick={onPublish}
        disabled={!canPublish}
        className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Rocket className="h-3.5 w-3.5" /> Publish
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>
      <button
        onClick={onLogout}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
      >
        Log out
      </button>
    </header>
    </>
  );
}

function ToolToggle({
  icon: Icon,
  label,
  enabled,
  disabled,
  onToggle,
  onConfigure,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  enabled: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onConfigure?: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <button
        onClick={onToggle}
        disabled={disabled}
        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
          enabled
            ? "border-emerald-600 bg-emerald-500 text-white shadow-sm"
            : "border-border bg-muted/40 text-muted-foreground hover:border-foreground/30 hover:text-foreground"
        }`}
      >
        <Icon className="h-3 w-3" /> {label}
      </button>
      {enabled && onConfigure && (
        <button
          onClick={onConfigure}
          title={`Edit ${label} settings`}
          className="rounded-md p-1 text-emerald-700 transition hover:bg-emerald-50"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
