import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Plus,
  Settings,
  Workflow,
  PanelLeftClose,
  PanelLeftOpen,
  FileText,
  Inbox,
  Trash2,
} from "lucide-react";

type WorkflowSummary = { id: string; name: string; updatedAt: number };

type Props = {
  collapsed: boolean;
  onToggleCollapse: () => void;
  workflows: WorkflowSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
};

function relTime(ts: number) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function Sidebar({
  collapsed,
  onToggleCollapse,
  workflows,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: Props) {
  const [q, setQ] = useState("");
  const filtered = workflows.filter((w) => w.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 64 : 280 }}
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
      className="flex h-full shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar"
    >
      {/* Logo + collapse toggle */}
      <div className={`flex items-center gap-2.5 px-3 pt-4 pb-3 ${collapsed ? "justify-center" : ""}`}>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
          <Workflow className="h-4 w-4" />
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-semibold">Susha</div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Workflow Studio
            </div>
          </div>
        )}
        {!collapsed && (
          <button
            onClick={onToggleCollapse}
            title="Collapse sidebar"
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-sidebar-accent hover:text-foreground"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        )}
      </div>

      {collapsed && (
        <div className="flex flex-col items-center gap-1 px-2">
          <button
            onClick={onToggleCollapse}
            title="Expand sidebar"
            className="rounded-md p-2 text-muted-foreground transition hover:bg-sidebar-accent hover:text-foreground"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
          <button
            onClick={onCreate}
            title="New workflow"
            className="rounded-md bg-foreground p-2 text-background transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* New workflow + search (expanded) */}
      {!collapsed && (
        <>
          <div className="px-3">
            <button
              onClick={onCreate}
              className="group flex w-full items-center justify-between rounded-lg border border-border bg-white px-3 py-2 text-sm font-medium text-foreground transition hover:border-foreground/30 hover:shadow-sm"
            >
              <span className="flex items-center gap-2">
                <Plus className="h-4 w-4" />
                New Workflow
              </span>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                ⌘N
              </kbd>
            </button>
          </div>

          <div className="px-3 pt-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search workflows…"
                className="w-full rounded-lg border border-border bg-white pl-8 pr-2 py-2 text-sm outline-none transition focus:border-foreground/40"
              />
            </div>
          </div>
        </>
      )}

      {/* Workflow list */}
      <div className="mt-4 flex-1 overflow-y-auto px-2 pb-2">
        {!collapsed && (
          <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Recent
          </div>
        )}

        {workflows.length === 0 ? (
          !collapsed && (
            <div className="mx-2 mt-2 rounded-xl border border-dashed border-border bg-white/60 px-4 py-6 text-center">
              <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Inbox className="h-4 w-4" />
              </div>
              <p className="text-[12.5px] font-medium text-foreground">No workflows yet</p>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                Create your first workflow.
              </p>
              <button
                onClick={onCreate}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-2.5 py-1.5 text-[11.5px] font-medium hover:border-foreground/30"
              >
                <Plus className="h-3 w-3" />
                New workflow
              </button>
            </div>
          )
        ) : (
          <ul className="space-y-0.5">
            <AnimatePresence initial={false}>
              {filtered.map((w) => {
                const active = w.id === activeId;
                return (
                  <motion.li
                    key={w.id}
                    layout
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    <div
                      className={`group flex w-full items-center gap-1 rounded-md transition ${
                        active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"
                      }`}
                    >
                      <button
                        onClick={() => onSelect(w.id)}
                        title={w.name}
                        className={`flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left text-sm ${
                          active ? "text-foreground" : "text-foreground/80"
                        } ${collapsed ? "justify-center" : ""}`}
                      >
                        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        {!collapsed && (
                          <>
                            <span className="min-w-0 flex-1 truncate">{w.name}</span>
                            <span className="text-[10px] text-muted-foreground opacity-0 transition group-hover:opacity-100">
                              {relTime(w.updatedAt)}
                            </span>
                          </>
                        )}
                      </button>
                      {!collapsed && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(w.id);
                          }}
                          title="Delete workflow"
                          className="mr-1.5 rounded-md p-1.5 text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>

      {/* User & settings */}
      <div className="border-t border-sidebar-border p-3">
        <div className={`flex items-center gap-2.5 ${collapsed ? "justify-center" : ""}`}>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
            AR
          </div>
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-sm font-medium">Arjun Rao</div>
                <div className="truncate text-[11px] text-muted-foreground">arjun@xyzbank.com</div>
              </div>
              <button className="rounded-md p-1.5 text-muted-foreground transition hover:bg-sidebar-accent hover:text-foreground">
                <Settings className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </motion.aside>
  );
}
