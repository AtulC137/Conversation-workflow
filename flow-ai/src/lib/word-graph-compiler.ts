/**
 * Client-side types for word-graph compilation.
 * Compilation runs on the backend via POST /api/templates/compile-script.
 */

export type WordGraphCompileResult = {
  nodes: unknown[];
  edges: unknown[];
  warnings: string[];
  errors: string[];
  attempts: number;
};
