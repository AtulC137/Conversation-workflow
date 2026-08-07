import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { compileScript } from "@/lib/api/templates";
import { ApiError } from "@/lib/api/client";
import { EXAMPLE_WORD_GRAPH } from "@/lib/word-graph-example";
import type { Edge, Node } from "reactflow";
import type { NodeData } from "./types";

type WordGraphEditorProps = {
  script: string;
  canEdit: boolean;
  onScriptChange: (script: string) => void;
  onCompiled: (nodes: Node<NodeData>[], edges: Edge[]) => void;
};

export function WordGraphEditor({
  script,
  canEdit,
  onScriptChange,
  onCompiled,
}: WordGraphEditorProps) {
  const [compiling, setCompiling] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  const handleCompile = async () => {
    const trimmed = script.trim();
    if (!trimmed) {
      toast.error("Write a word-graph script first");
      return;
    }
    setCompiling(true);
    setErrors([]);
    setWarnings([]);
    try {
      const result = await compileScript(trimmed);
      if (result.errors.length > 0) {
        setErrors(result.errors);
        setWarnings(result.warnings);
        toast.error("Script has errors", {
          description: result.errors[0],
        });
        return;
      }
      setWarnings(result.warnings);
      onCompiled(result.nodes, result.edges);
      toast.success("Workflow graph compiled", {
        description:
          result.warnings.length > 0
            ? `${result.warnings.length} warning(s)`
            : `${result.nodes.length} nodes`,
      });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? (err.body as { error?: string })?.error ?? err.message
          : err instanceof Error
            ? err.message
            : "Compile failed";
      toast.error("Compile failed", { description: msg });
    } finally {
      setCompiling(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Word graph</h2>
          <p className="text-xs text-muted-foreground">
            Describe the call flow in plain English. Compile to build the visual graph.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <button
              type="button"
              onClick={() => onScriptChange(EXAMPLE_WORD_GRAPH)}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              Load example
            </button>
          )}
          <button
            type="button"
            onClick={handleCompile}
            disabled={!canEdit || compiling}
            className="inline-flex items-center gap-2 rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {compiling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            Compile
          </button>
        </div>
      </div>

      <textarea
        value={script}
        onChange={(e) => onScriptChange(e.target.value)}
        readOnly={!canEdit}
        placeholder={`Example:\n${EXAMPLE_WORD_GRAPH}`}
        className="min-h-0 flex-1 resize-none border-0 bg-transparent p-4 font-mono text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70"
      />

      {(errors.length > 0 || warnings.length > 0) && (
        <div className="max-h-40 overflow-auto border-t border-border p-4 text-xs">
          {errors.map((e) => (
            <p key={e} className="text-destructive">
              {e}
            </p>
          ))}
          {warnings.map((w) => (
            <p key={w} className="text-amber-700">
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
