// =============================================================================
// agent-discover — Tool index
//
// Persisted catalog of every installed server's tools, independent of
// whether the server is enabled or connected. `save` is the ONLY write path:
// it diffs by tool_hash, computes embeddings for new/changed tools when a
// provider is configured (reusing any stored vector with the same hash and
// model), and upserts in one transaction. Reads are direct lookups; search
// delegates to a pluggable Ranker.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { IndexedTool, UpstreamTool } from '../types.js';
import { encodeEmbedding, getEmbeddingProvider, type EmbeddingProvider } from '../embeddings/index.js';
import { Bm25HybridRanker, type Ranker } from './ranker.js';
import { toolHash } from './tool-hash.js';

interface ToolRow {
  id: number;
  server_id: number;
  server: string;
  name: string;
  title: string | null;
  description: string;
  input_schema: string;
  output_schema: string | null;
  annotations: string | null;
  tool_hash: string;
}

const SELECT = `SELECT t.id, t.server_id, s.name AS server, t.name, t.title, t.description,
  t.input_schema, t.output_schema, t.annotations, t.tool_hash
  FROM server_tools t JOIN servers s ON s.id = t.server_id`;

function parse<T>(raw: string | null): T | null {
  return raw ? (JSON.parse(raw) as T) : null;
}

function rowToTool(row: ToolRow): IndexedTool {
  return {
    id: row.id,
    server_id: row.server_id,
    server: row.server,
    name: row.name,
    title: row.title,
    description: row.description ?? '',
    input_schema: parse<Record<string, unknown>>(row.input_schema) ?? { type: 'object' },
    output_schema: parse(row.output_schema),
    annotations: parse(row.annotations),
    tool_hash: row.tool_hash,
  };
}

export interface IndexDiff {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: number;
  embedded: number;
}

export interface ToolHit extends IndexedTool {
  readonly score: number;
}

export class ToolIndex {
  readonly ranker: Ranker;

  constructor(
    private readonly db: Db,
    private readonly embeddings: () => Promise<EmbeddingProvider> = () => getEmbeddingProvider(),
    ranker?: Ranker,
  ) {
    this.ranker = ranker ?? new Bm25HybridRanker(db, embeddings);
  }

  async save(serverId: number, tools: UpstreamTool[]): Promise<IndexDiff> {
    const provider = await this.embeddings();
    const existing = new Map(
      this.db
        .queryAll<{ id: number; name: string; tool_hash: string; embedding_model: string | null }>(
          'SELECT id, name, tool_hash, embedding_model FROM server_tools WHERE server_id = ?',
          [serverId],
        )
        .map((r) => [r.name, r]),
    );
    const incoming = tools.map((t) => ({ tool: t, hash: toolHash(t) }));
    // Dirty = new, changed, or missing a vector for the configured provider.
    const dirty = incoming.filter(({ tool, hash }) => {
      const prior = existing.get(tool.name);
      if (prior?.tool_hash !== hash) return true;
      return provider.name !== 'none' && prior.embedding_model !== provider.model;
    });
    const vectors = await this.embed(provider, dirty);

    const diff: IndexDiff = { added: [], changed: [], removed: [], unchanged: 0, embedded: 0 };
    const seen = new Set(incoming.map((i) => i.tool.name));
    this.db.transaction(() => {
      for (const [name, row] of existing) {
        if (!seen.has(name)) {
          this.db.run('DELETE FROM server_tools WHERE id = ?', [row.id]);
          diff.removed.push(name);
        }
      }
      for (const { tool, hash } of dirty) {
        const vec = vectors.get(hash);
        if (vec) diff.embedded++;
        const values = [
          tool.title ?? null,
          tool.description ?? '',
          JSON.stringify(tool.inputSchema ?? { type: 'object' }),
          tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
          tool.annotations ? JSON.stringify(tool.annotations) : null,
          hash,
          vec?.embedding ?? null,
          vec?.model ?? null,
        ];
        const prior = existing.get(tool.name);
        if (prior) {
          if (prior.tool_hash !== hash) diff.changed.push(tool.name);
          this.db.run(
            `UPDATE server_tools SET title = ?, description = ?, input_schema = ?, output_schema = ?,
               annotations = ?, tool_hash = ?, embedding = ?, embedding_model = ? WHERE id = ?`,
            [...values, prior.id],
          );
        } else {
          this.db.run(
            `INSERT INTO server_tools (title, description, input_schema, output_schema, annotations,
               tool_hash, embedding, embedding_model, server_id, name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [...values, serverId, tool.name],
          );
          diff.added.push(tool.name);
        }
      }
      diff.unchanged = incoming.length - diff.added.length - diff.changed.length;
    });
    return diff;
  }

  /** Embeddings for dirty tools, keyed by tool hash. Reuses stored vectors with the same hash. */
  private async embed(
    provider: EmbeddingProvider,
    dirty: Array<{ tool: UpstreamTool; hash: string }>,
  ): Promise<Map<string, { embedding: string; model: string }>> {
    const out = new Map<string, { embedding: string; model: string }>();
    if (dirty.length === 0 || provider.name === 'none') return out;

    const missing: Array<{ tool: UpstreamTool; hash: string }> = [];
    for (const d of dirty) {
      const cached = this.db.queryOne<{ embedding: string }>(
        'SELECT embedding FROM server_tools WHERE tool_hash = ? AND embedding_model = ? AND embedding IS NOT NULL LIMIT 1',
        [d.hash, provider.model],
      );
      if (cached) out.set(d.hash, { embedding: cached.embedding, model: provider.model });
      else missing.push(d);
    }
    if (missing.length === 0) return out;
    try {
      const vectors = await provider.embed(
        missing.map(({ tool }) =>
          `${tool.name}\n${tool.name}\n${tool.description ?? ''}`.slice(0, 2000),
        ),
      );
      missing.forEach(({ hash }, i) => {
        const vec = vectors[i];
        if (vec && vec.length > 0) {
          out.set(hash, { embedding: encodeEmbedding(vec), model: provider.model });
        }
      });
    } catch (err) {
      process.stderr.write(
        `[agent-discover] embedding failed (${provider.name}): ${(err as Error).message} — indexing without vectors\n`,
      );
    }
    return out;
  }

  get(server: string, tool: string): IndexedTool | null {
    const row = this.db.queryOne<ToolRow>(`${SELECT} WHERE s.name = ? AND t.name = ?`, [
      server,
      tool,
    ]);
    return row ? rowToTool(row) : null;
  }

  list(serverId: number): IndexedTool[] {
    return this.db
      .queryAll<ToolRow>(`${SELECT} WHERE t.server_id = ? ORDER BY t.name`, [serverId])
      .map(rowToTool);
  }

  /** Tools of enabled, non-quarantined servers — what native mode exposes. */
  listEnabled(): IndexedTool[] {
    return this.db
      .queryAll<ToolRow>(
        `${SELECT} WHERE s.enabled = 1 AND s.quarantined = 0 ORDER BY s.name, t.name`,
      )
      .map(rowToTool);
  }

  count(serverId: number): number {
    return (
      this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM server_tools WHERE server_id = ?', [
        serverId,
      ])?.n ?? 0
    );
  }

  async search(query: string, limit = 5): Promise<ToolHit[]> {
    if (!query.trim()) return [];
    const hits = await this.ranker.rank(query.trim(), limit);
    if (hits.length === 0) return [];
    const rows = new Map(
      this.db
        .queryAll<ToolRow>(
          `${SELECT} WHERE t.id IN (${hits.map(() => '?').join(',')}) AND s.quarantined = 0`,
          hits.map((h) => h.id),
        )
        .map((r) => [r.id, r]),
    );
    return hits.flatMap((h) => {
      const row = rows.get(h.id);
      return row ? [{ ...rowToTool(row), score: Math.round(h.score * 1000) / 1000 }] : [];
    });
  }
}
