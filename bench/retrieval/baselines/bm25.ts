// Plain Okapi BM25 (k1=1.2, b=0.75) over one concatenated field. This is the
// "what Anthropic's tool_search_tool_bm25 does" reference point:
//   - bm25        → name + description
//   - bm25-args   → name + description + argument names/descriptions
// (the hosted tool also indexes arguments; we report both).

import type { Hit, Ranker, ToolDoc } from '../types.js';
import { schemaText, tokenize } from './text.js';

export class Bm25Ranker implements Ranker {
  readonly name: string;
  private docs: { server: string; tool: string; tf: Map<string, number>; len: number }[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(
    private readonly withArgs = false,
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {
    this.name = withArgs ? 'bm25-args' : 'bm25';
  }

  async index(tools: ToolDoc[]): Promise<void> {
    for (const t of tools) {
      const text = `${t.name} ${t.description} ${this.withArgs ? schemaText(t.inputSchema) : ''}`;
      const toks = tokenize(text);
      const tf = new Map<string, number>();
      for (const tok of toks) tf.set(tok, (tf.get(tok) ?? 0) + 1);
      for (const tok of tf.keys()) this.df.set(tok, (this.df.get(tok) ?? 0) + 1);
      this.docs.push({ server: t.server, tool: t.name, tf, len: toks.length });
    }
    this.avgLen = this.docs.reduce((n, d) => n + d.len, 0) / Math.max(this.docs.length, 1);
  }

  async search(query: string, k: number): Promise<Hit[]> {
    const qt = [...new Set(tokenize(query))];
    const N = this.docs.length;
    const idf = qt.map((t) => {
      const df = this.df.get(t) ?? 0;
      return Math.log(1 + (N - df + 0.5) / (df + 0.5));
    });
    const hits: Hit[] = [];
    for (const d of this.docs) {
      let s = 0;
      for (let i = 0; i < qt.length; i++) {
        const f = d.tf.get(qt[i]);
        if (!f) continue;
        s +=
          (idf[i] * f * (this.k1 + 1)) /
          (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen));
      }
      if (s > 0) hits.push({ server: d.server, tool: d.tool, score: s });
    }
    return hits.sort(byScore).slice(0, k);
  }
}

export function byScore(a: Hit, b: Hit): number {
  return b.score - a.score || a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool);
}
