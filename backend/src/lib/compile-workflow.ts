import {
  compileSemanticGraph,
  buildEmptyGraph,
  type CompileResult,
} from "./word-graph-compiler.js";
import { compileScriptToGraph } from "./llm-compile.js";

export async function compileWordGraph(script: string): Promise<CompileResult & { attempts: number }> {
  const trimmed = script.trim();
  if (!trimmed) {
    const empty = buildEmptyGraph();
    return { ...empty, attempts: 0 };
  }

  const { semantic, attempts } = await compileScriptToGraph(trimmed);
  const result = compileSemanticGraph(semantic);
  return { ...result, attempts };
}
