import { motion } from "framer-motion";
import { X, Plus, Trash2 } from "lucide-react";
import type { Node } from "reactflow";
import type { NodeData } from "./types";

type Props = {
  node: Node<NodeData>;
  onChange: (data: NodeData) => void;
  onClose: () => void;
  onDelete?: () => void;
};

export function PropertiesPanel({ node, onChange, onClose, onDelete }: Props) {
  const data = node.data;
  const displayTitle =
    data.title?.trim() ||
    (node.type === "conversation"
      ? "Conversation"
      : node.type === "qa"
        ? "Q&A"
        : node.type === "userInput"
          ? "User Input"
          : node.type === "end"
            ? "End"
            : "Properties");

  return (
    <motion.aside
      initial={{ x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 24, opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-white"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {node.type} block
          </div>
          <div className="text-sm font-semibold">{displayTitle}</div>
        </div>
        <div className="flex items-center gap-1">
          {onDelete && (
            <button
              onClick={onDelete}
              title="Delete block"
              className="rounded-md p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90"
          >
            Done
          </button>
          <button
            onClick={onClose}
            title="Close"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {node.type === "conversation" && (
          <ConversationForm data={data} onChange={onChange} />
        )}
        {node.type === "qa" && <QaForm data={data} onChange={onChange} />}
        {node.type === "userInput" && <UserInputForm data={data} onChange={onChange} />}
        {node.type === "end" && <EndForm data={data} onChange={onChange} />}
        {node.type === "start" && (
          <Field label="Trigger">
            <p className="text-xs text-muted-foreground">Workflow entry point. No configuration needed.</p>
          </Field>
        )}
      </div>
    </motion.aside>
  );
}

function ConversationForm({ data, onChange }: { data: NodeData; onChange: (d: NodeData) => void }) {
  const responses = data.responses ?? [];
  return (
    <div className="space-y-5">
      <Field label="Block title">
        <input
          value={data.title ?? ""}
          onChange={(e) => onChange({ ...data, title: e.target.value })}
          placeholder="Conversation title"
          className="input"
        />
      </Field>

      <Field label="AI message">
        <textarea
          rows={5}
          value={data.message ?? ""}
          onChange={(e) => onChange({ ...data, message: e.target.value })}
          placeholder="Type the AI message here…"
          className="input resize-none leading-relaxed"
        />
      </Field>

      <Field label="Tone">
        <select
          value={data.tone ?? "Professional"}
          onChange={(e) => onChange({ ...data, tone: e.target.value })}
          className="input"
        >
          {["Professional", "Polite", "Empathetic", "Friendly", "Concise", "Formal"].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Field>

      <BranchEditor
        data={data}
        onChange={onChange}
        responses={responses}
        branchLabel="User response branches"
        addLabel="Add"
      />

      <SilenceTimeoutField data={data} onChange={onChange} />

      <Field label="Notes">
        <textarea
          rows={3}
          value={data.notes ?? ""}
          onChange={(e) => onChange({ ...data, notes: e.target.value })}
          placeholder="Optional notes for this step…"
          className="input resize-none text-xs"
        />
      </Field>
    </div>
  );
}

function UserInputForm({ data, onChange }: { data: NodeData; onChange: (d: NodeData) => void }) {
  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        Uses workflow Context. On entry the AI speaks facts matching your instruction. Connect
        ai-out to the next block (e.g. Q&amp;A).
      </p>
      <Field label="Block title">
        <input
          value={data.title ?? ""}
          onChange={(e) => onChange({ ...data, title: e.target.value })}
          placeholder="User Input"
          className="input"
        />
      </Field>
      <Field label="Instruction">
        <textarea
          rows={5}
          value={data.instruction ?? ""}
          onChange={(e) => onChange({ ...data, instruction: e.target.value })}
          placeholder="Check context and tell the user all relevant details."
          className="input resize-none leading-relaxed"
        />
      </Field>
      <Field label="Wait for caller response">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={data.waitForResponse !== false}
            onChange={(e) => onChange({ ...data, waitForResponse: e.target.checked })}
            className="h-4 w-4 rounded border-border"
          />
          <span className="text-foreground/90">
            Pause after speaking until caller acknowledges or asks a question
          </span>
        </label>
      </Field>
      <SilenceTimeoutField data={data} onChange={onChange} />
      <Field label="Notes">
        <textarea
          rows={3}
          value={data.notes ?? ""}
          onChange={(e) => onChange({ ...data, notes: e.target.value })}
          placeholder="Optional notes for this step…"
          className="input resize-none text-xs"
        />
      </Field>
    </div>
  );
}

function QaForm({ data, onChange }: { data: NodeData; onChange: (d: NodeData) => void }) {
  const responses = data.responses ?? [];
  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        Place before End. Answers use workflow Context. Caller can ask factual questions; connect
        &quot;no questions&quot; to goodbye.
      </p>
      <Field label="Block title">
        <input
          value={data.title ?? ""}
          onChange={(e) => onChange({ ...data, title: e.target.value })}
          placeholder="Q&A"
          className="input"
        />
      </Field>
      <Field label="AI prompt">
        <textarea
          rows={4}
          value={data.message ?? ""}
          onChange={(e) => onChange({ ...data, message: e.target.value })}
          placeholder="Do you have any questions?"
          className="input resize-none leading-relaxed"
        />
      </Field>
      <BranchEditor
        data={data}
        onChange={onChange}
        responses={responses}
        branchLabel="No questions branch"
        addLabel="Add closing branch"
      />
      <SilenceTimeoutField data={data} onChange={onChange} />
    </div>
  );
}

function SilenceTimeoutField({
  data,
  onChange,
}: {
  data: NodeData;
  onChange: (d: NodeData) => void;
}) {
  return (
    <Field label="Silence timeout (seconds)">
      <input
        type="number"
        min={1}
        max={30}
        step={1}
        value={data.silenceTimeoutSec ?? 4}
        onChange={(e) => {
          const parsed = Number.parseInt(e.target.value, 10);
          onChange({
            ...data,
            silenceTimeoutSec: Number.isFinite(parsed) && parsed > 0 ? parsed : 4,
          });
        }}
        className="input"
      />
      <p className="mt-1 text-[11px] text-muted-foreground">
        If the caller says nothing after AI finishes, follow the No response wire.
      </p>
    </Field>
  );
}

function BranchEditor({
  data,
  onChange,
  responses,
  branchLabel,
  addLabel,
}: {
  data: NodeData;
  onChange: (d: NodeData) => void;
  responses: NonNullable<NodeData["responses"]>;
  branchLabel: string;
  addLabel: string;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {branchLabel}
        </label>
        <button
          onClick={() =>
            onChange({
              ...data,
              responses: [...responses, { id: `r-${Date.now()}`, label: "", examples: [] }],
            })
          }
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:border-foreground/30"
        >
          <Plus className="h-3 w-3" /> {addLabel}
        </button>
      </div>
      <div className="space-y-2.5">
        {responses.map((r, i) => (
          <div key={r.id} className="rounded-lg border border-border p-2.5">
            <div className="flex items-center gap-2">
              <input
                value={r.label}
                onChange={(e) => {
                  const next = [...responses];
                  next[i] = { ...r, label: e.target.value };
                  onChange({ ...data, responses: next });
                }}
                placeholder="no questions"
                className="input flex-1"
              />
              <button
                onClick={() =>
                  onChange({ ...data, responses: responses.filter((_, j) => j !== i) })
                }
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <textarea
              rows={2}
              placeholder='Examples per line — e.g. "no"'
              value={(r.examples ?? []).join("\n")}
              onChange={(e) => {
                const next = [...responses];
                next[i] = { ...r, examples: e.target.value.split("\n") };
                onChange({ ...data, responses: next });
              }}
              className="input mt-2 resize-none text-xs"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function EndForm({ data, onChange }: { data: NodeData; onChange: (d: NodeData) => void }) {
  return (
    <Field label="End status">
      <select
        value={data.status ?? "Completed"}
        onChange={(e) => onChange({ ...data, status: e.target.value as NodeData["status"] })}
        className="input"
      >
        {["Completed", "Uninterested", "Callback Needed"].map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
    </Field>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
