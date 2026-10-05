// Thin adapter over the shipped agent-discover 2.0 search path, not a port:
// in-memory SQLite with every migration, one ServerStore row per catalog
// server, ToolIndex.save per server, then ToolIndex.search — the call behind
// the search_tools MCP tool.
//
// `enrichment` (bench only, not a shipped feature): appends the committed
// LLM enrichment cache (../enrichment.json, keyed by tool hash) to each
// tool's description before indexing — measures what index-time enrichment
// would buy, offline and deterministically.

import { readFileSync } from 'node:fs';
import type { Hit, Ranker, ToolDoc } from '../types.js';
import type { Db, ToolIndex } from '../../../src/lib.js';
import type { EmbeddingProvider } from '../../../src/embeddings/index.js';

interface Enrichment {
  whenToUse: string;
  queries: string[];
  keywords: string[];
}

export class AgentDiscoverV2Ranker implements Ranker {
  private db: Db | null = null;
  private tools: ToolIndex | null = null;

  constructor(
    readonly name: string,
    private readonly embeddings: () => Promise<EmbeddingProvider>,
    private readonly options: { enrichment?: boolean } = {},
  ) {}

  async index(tools: ToolDoc[]): Promise<void> {
    const { createDb, ServerStore, ToolIndex, toolHash } = await import('../../../src/lib.js');
    const cache = this.options.enrichment
      ? (
          JSON.parse(readFileSync(new URL('../enrichment.json', import.meta.url), 'utf8')) as {
            byToolHash: Record<string, Enrichment>;
          }
        ).byToolHash
      : {};
    const db = createDb({ path: ':memory:' });
    const index = new ToolIndex(db, { embeddings: this.embeddings });
    const store = new ServerStore(db);
    const byServer = new Map<string, ToolDoc[]>();
    for (const tool of tools) {
      const e = cache[toolHash(tool)];
      const t = e
        ? {
            ...tool,
            description: [tool.description, e.whenToUse, ...e.queries, ...e.keywords].join(' '),
          }
        : tool;
      byServer.set(t.server, [...(byServer.get(t.server) ?? []), t]);
    }
    for (const [server, list] of byServer) {
      const entry = store.create({ name: server, command: 'noop' });
      await index.save(entry.id, list);
    }
    this.db = db;
    this.tools = index;
  }

  async search(query: string, k: number): Promise<Hit[]> {
    const hits = await this.tools!.search(query, k);
    return hits.map((h) => ({ server: h.server, tool: h.name, score: h.score }));
  }

  async close(): Promise<void> {
    this.db?.close();
  }
}
