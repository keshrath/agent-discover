// =============================================================================
// Retrieval bench — shared types. A Ranker sees only the catalog at index time
// and only the query string at search time. No LLM calls, no network.
// =============================================================================

export interface ToolDoc {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Hit {
  server: string;
  tool: string;
  score: number;
}

export interface Ranker {
  name: string;
  index(tools: ToolDoc[]): Promise<void>;
  search(query: string, k: number): Promise<Hit[]>;
  close?(): Promise<void>;
}

export type Category =
  | 'paraphrase'
  | 'task'
  | 'cross-server'
  | 'multi-step'
  | 'short-typo'
  | 'german';

export interface Query {
  id: string;
  query: string;
  category: Category;
  /**
   * Required steps; each step lists acceptable alternatives as "server/tool".
   * Single-step queries have exactly one step. A step counts as retrieved when
   * ANY of its alternatives appears in the top-k.
   */
  targets: string[][];
  split: 'dev' | 'test';
}

export const toolKey = (server: string, tool: string) => `${server}/${tool}`;
