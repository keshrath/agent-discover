// =============================================================================
// agent-discover — Tool index
//
// Persisted catalog of every installed server's tools, independent of
// whether the server is enabled or connected. `save` is the ONLY write path:
// it diffs by tool_hash, builds each tool's search document (optionally
// enriched by an LLM, cached by tool hash), embeds new/changed documents when
// an embedding provider is configured (reusing any stored vector with the
// same document hash and model), and writes rows + FTS in one transaction.
// Reads are direct lookups; search delegates to a pluggable Ranker.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { IndexedTool, UpstreamTool } from '../types.js';
import {
  encodeEmbedding,
  getEmbeddingProvider,
  type EmbeddingProvider,
} from '../embeddings/index.js';
import { HybridRanker, type Ranker } from './ranker.js';
import { toolHash } from './tool-hash.js';
import { buildDocument, type DocServer, type Enrichment, type ToolDocument } from './tool-doc.js';
import { ENRICH_BATCH, enrichmentProviderFromEnv, type EnrichmentProvider } from './enrichment.js';

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

/** _meta key bumped on every index write; rankers rebuild their caches when it moves. */
export const GENERATION_KEY = 'tool_index_generation';

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

export interface ToolIndexOptions {
  embeddings?: () => Promise<EmbeddingProvider>;
  /** Index-time enrichment; default from AGENT_DISCOVER_ENRICH_PROVIDER (off when unset). */
  enrichment?: EnrichmentProvider | null;
  ranker?: Ranker;
}

interface Incoming {
  tool: UpstreamTool;
  hash: string;
  doc: ToolDocument;
}

export class ToolIndex {
  readonly ranker: Ranker;
  private readonly embeddings: () => Promise<EmbeddingProvider>;
  private readonly enrichment: EnrichmentProvider | null;

  constructor(
    private readonly db: Db,
    options: ToolIndexOptions = {},
  ) {
    this.embeddings = options.embeddings ?? (() => getEmbeddingProvider());
    this.enrichment =
      options.enrichment === undefined ? enrichmentProviderFromEnv() : options.enrichment;
    this.ranker = options.ranker ?? new HybridRanker(db, this.embeddings);
  }

  async save(serverId: number, tools: UpstreamTool[]): Promise<IndexDiff> {
    const provider = await this.embeddings();
    const server = this.db.queryOne<DocServer>(
      'SELECT name, description FROM servers WHERE id = ?',
      [serverId],
    ) ?? { name: '' };
    const existing = new Map(
      this.db
        .queryAll<{
          id: number;
          name: string;
          tool_hash: string;
          doc_hash: string | null;
          embedding_model: string | null;
        }>(
          'SELECT id, name, tool_hash, doc_hash, embedding_model FROM server_tools WHERE server_id = ?',
          [serverId],
        )
        .map((r) => [r.name, r]),
    );
    const hashed = tools.map((tool) => ({ tool, hash: toolHash(tool) }));
    const enrichments = await this.enrich(hashed, server);
    const incoming: Incoming[] = hashed.map(({ tool, hash }) => ({
      tool,
      hash,
      doc: buildDocument(tool, server, enrichments.get(hash)),
    }));
    // Dirty = new, changed definition, changed document, or no vector for the configured model.
    const dirty = incoming.filter(({ tool, hash, doc }) => {
      const prior = existing.get(tool.name);
      if (prior?.tool_hash !== hash || prior.doc_hash !== doc.docHash) return true;
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
      for (const { tool, hash, doc } of dirty) {
        const vec = vectors.get(doc.docHash);
        if (vec) diff.embedded++;
        const values = [
          tool.title ?? null,
          tool.description ?? '',
          JSON.stringify(tool.inputSchema ?? { type: 'object' }),
          tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
          tool.annotations ? JSON.stringify(tool.annotations) : null,
          hash,
          doc.docHash,
          vec?.embedding ?? null,
          vec?.model ?? null,
        ];
        const prior = existing.get(tool.name);
        let id: number;
        if (prior) {
          if (prior.tool_hash !== hash) diff.changed.push(tool.name);
          this.db.run(
            `UPDATE server_tools SET title = ?, description = ?, input_schema = ?, output_schema = ?,
               annotations = ?, tool_hash = ?, doc_hash = ?, embedding = ?, embedding_model = ?
             WHERE id = ?`,
            [...values, prior.id],
          );
          id = prior.id;
          this.db.run('DELETE FROM server_tools_fts WHERE rowid = ?', [id]);
        } else {
          id = Number(
            this.db.run(
              `INSERT INTO server_tools (title, description, input_schema, output_schema, annotations,
                 tool_hash, doc_hash, embedding, embedding_model, server_id, name)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [...values, serverId, tool.name],
            ).lastInsertRowid,
          );
          diff.added.push(tool.name);
        }
        this.db.run(
          'INSERT INTO server_tools_fts (rowid, name, description, args, enrichment, server) VALUES (?, ?, ?, ?, ?, ?)',
          [id, doc.name, doc.description, doc.args, doc.enrichment, doc.server],
        );
      }
      diff.unchanged = incoming.length - diff.added.length - diff.changed.length;
      if (dirty.length > 0 || diff.removed.length > 0) {
        this.db.run(
          `INSERT INTO _meta (key, value) VALUES (?, '1')
           ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`,
          [GENERATION_KEY],
        );
      }
    });
    return diff;
  }

  /** Enrichment per tool hash: cached rows first, the provider for the rest (in batches). */
  private async enrich(
    tools: Array<{ tool: UpstreamTool; hash: string }>,
    server: DocServer,
  ): Promise<Map<string, Enrichment>> {
    const out = new Map<string, Enrichment>();
    const provider = this.enrichment;
    if (!provider || tools.length === 0) return out;
    const missing: Array<{ tool: UpstreamTool; hash: string }> = [];
    for (const t of tools) {
      const row = this.db.queryOne<{ data: string }>(
        'SELECT data FROM tool_enrichment WHERE tool_hash = ? AND model = ?',
        [t.hash, provider.model],
      );
      if (row) out.set(t.hash, JSON.parse(row.data) as Enrichment);
      else missing.push(t);
    }
    for (let i = 0; i < missing.length; i += ENRICH_BATCH) {
      const batch = missing.slice(i, i + ENRICH_BATCH);
      try {
        const results = await provider.enrich(batch.map(({ tool }) => ({ tool, server })));
        batch.forEach(({ hash }, j) => {
          const e = results[j];
          if (!e) return;
          out.set(hash, e);
          this.db.run(
            'INSERT OR REPLACE INTO tool_enrichment (tool_hash, model, data) VALUES (?, ?, ?)',
            [hash, provider.model, JSON.stringify(e)],
          );
        });
      } catch (err) {
        process.stderr.write(
          `[agent-discover] enrichment failed (${provider.model}): ${(err as Error).message} — indexing without it\n`,
        );
      }
    }
    return out;
  }

  /** Vectors for dirty documents, keyed by doc hash. Reuses stored vectors with the same hash. */
  private async embed(
    provider: EmbeddingProvider,
    dirty: Incoming[],
  ): Promise<Map<string, { embedding: string; model: string }>> {
    const out = new Map<string, { embedding: string; model: string }>();
    if (dirty.length === 0 || provider.name === 'none') return out;

    const missing: Incoming[] = [];
    for (const d of dirty) {
      if (out.has(d.doc.docHash)) continue;
      const cached = this.db.queryOne<{ embedding: string }>(
        'SELECT embedding FROM server_tools WHERE doc_hash = ? AND embedding_model = ? AND embedding IS NOT NULL LIMIT 1',
        [d.doc.docHash, provider.model],
      );
      if (cached) out.set(d.doc.docHash, { embedding: cached.embedding, model: provider.model });
      else missing.push(d);
    }
    if (missing.length === 0) return out;
    try {
      const vectors = await provider.embed(
        missing.map((m) => m.doc.embedText),
        'document',
      );
      missing.forEach(({ doc }, i) => {
        const vec = vectors[i];
        if (vec && vec.length > 0) {
          out.set(doc.docHash, { embedding: encodeEmbedding(vec), model: provider.model });
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
      this.db.queryOne<{ n: number }>(
        'SELECT COUNT(*) AS n FROM server_tools WHERE server_id = ?',
        [serverId],
      )?.n ?? 0
    );
  }

  /**
   * Top `limit` tools for a query, scores in 0..1. Empty when even the best
   * hit is below the ranker's calibrated no-match threshold.
   */
  async search(query: string, limit = 5): Promise<ToolHit[]> {
    if (!query.trim()) return [];
    const hits = await this.ranker.rank(query.trim(), limit);
    if (hits.length === 0 || hits[0].score < this.ranker.noMatchBelow) return [];
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
