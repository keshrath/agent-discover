// Thin adapter over the CURRENT agent-discover ranker (main, v1.4.x): the real
// RegistryService against an in-memory SQLite, so the exact FTS5 schema,
// bm25(4.0, 1.0) weighting, VERB_SYNONYMS/singularize expansion and LIKE
// fallback are exercised — no port. Uses searchToolsHybrid(), the path the
// find_tool/registry handlers call; with the default embedding provider
// ('none') that resolves to the BM25 path. Set
// AGENT_DISCOVER_EMBEDDING_PROVIDER=local|openai to measure the hybrid path.
//
// When src/ moves (2.0 core rewrite) this adapter is the one file to update.

import type { Hit, Ranker, ToolDoc } from '../types.js';

process.env.AGENT_DISCOVER_EMBEDDING_PROVIDER ??= 'none';

type Registry = InstanceType<typeof import('../../../src/domain/registry.js').RegistryService>;

export class AgentDiscoverV1Ranker implements Ranker {
  readonly name = 'agent-discover-v1';
  private registry: Registry | null = null;
  private closeDb: (() => void) | null = null;

  async index(tools: ToolDoc[]): Promise<void> {
    const { createDb } = await import('../../../src/storage/database.js');
    const { RegistryService } = await import('../../../src/domain/registry.js');
    const { EventBus } = await import('../../../src/domain/events.js');
    const db = createDb({ path: ':memory:' });
    this.closeDb = () => db.close();
    const registry = new RegistryService(db, new EventBus());
    const byServer = new Map<string, ToolDoc[]>();
    for (const t of tools) byServer.set(t.server, [...(byServer.get(t.server) ?? []), t]);
    for (const [server, list] of byServer) {
      const entry = registry.register({ name: server, command: 'noop' });
      await registry.saveToolsWithEmbeddings(entry.id, list);
    }
    this.registry = registry;
  }

  async search(query: string, k: number): Promise<Hit[]> {
    const rows = await this.registry!.searchToolsHybrid(query, k);
    return rows.map((r) => ({ server: r.server_name, tool: r.name, score: r.score }));
  }

  async close(): Promise<void> {
    this.closeDb?.();
  }
}
