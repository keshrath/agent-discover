// Regex/substring baseline ≈ Anthropic's tool_search_tool_regex. The hosted
// variant has Claude write a Python regex; with no LLM at eval time we use the
// mechanical stand-in a model most often emits: a case-insensitive
// alternation of the query's content words, matched as substrings against
// name + description + argument names. Score = number of distinct words
// matched (name matches count double), ties → shorter tool name. Treat this as
// a lower bound for the LLM-authored regex.

import type { Hit, Ranker, ToolDoc } from '../types.js';
import { byScore } from './bm25.js';
import { schemaText, tokenize } from './text.js';

export class RegexRanker implements Ranker {
  readonly name = 'regex';
  private docs: { server: string; tool: string; name: string; body: string }[] = [];

  async index(tools: ToolDoc[]): Promise<void> {
    this.docs = tools.map((t) => ({
      server: t.server,
      tool: t.name,
      name: t.name.toLowerCase(),
      body: `${t.description} ${schemaText(t.inputSchema)}`.toLowerCase(),
    }));
  }

  async search(query: string, k: number): Promise<Hit[]> {
    const words = [...new Set(tokenize(query))].filter((w) => w.length >= 3);
    if (words.length === 0) return [];
    const res = words.map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    const hits: Hit[] = [];
    for (const d of this.docs) {
      let s = 0;
      for (const re of res) {
        if (re.test(d.name)) s += 2;
        else if (re.test(d.body)) s += 1;
      }
      // Tiny length penalty breaks ties toward the more specific (shorter) name.
      if (s > 0) hits.push({ server: d.server, tool: d.tool, score: s - d.name.length / 1e4 });
    }
    return hits.sort(byScore).slice(0, k);
  }
}
