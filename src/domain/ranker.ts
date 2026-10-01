// =============================================================================
// agent-discover — Tool ranking
//
// `Ranker` is the retrieval extension point (SPEC §4 W1): given a query it
// returns tool-row ids with scores normalized to 0..1 (1 = certain match).
// The ToolIndex owns persistence; a Ranker only reads.
//
// Bm25HybridRanker is the 1.x ranking moved behind the interface: FTS5 BM25
// (name weighted 4x description) with verb-synonym expansion, optionally
// fused with brute-force cosine over stored embeddings (70/30) when an
// embedding provider is configured.
// =============================================================================

import type { Db } from '../storage/database.js';
import { cosineSimilarity, decodeEmbedding, type EmbeddingProvider } from '../embeddings/index.js';

export interface RankedHit {
  /** server_tools.id */
  readonly id: number;
  /** Relevance in 0..1. */
  readonly score: number;
}

export interface Ranker {
  readonly name: string;
  rank(query: string, limit: number): Promise<RankedHit[]>;
}

// Natural-language verbs → canonical CRUD verbs used in tool names. Added to
// the token list (never replacing the original word).
const VERB_SYNONYMS: Record<string, string> = {
  add: 'create',
  make: 'create',
  new: 'create',
  open: 'create',
  provision: 'create',
  register: 'create',
  fetch: 'get',
  retrieve: 'get',
  read: 'get',
  load: 'get',
  pull: 'get',
  show: 'list',
  display: 'list',
  enumerate: 'list',
  browse: 'list',
  change: 'update',
  edit: 'update',
  modify: 'update',
  set: 'update',
  patch: 'update',
  cancel: 'delete',
  remove: 'delete',
  destroy: 'delete',
  drop: 'delete',
  find: 'search',
  query: 'search',
  lookup: 'search',
};

function singularize(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.endsWith('ses') || token.endsWith('xes')) return token.slice(0, -2);
  if (token.endsWith('ss')) return token;
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s_\-/]+/)
    .map((t) => t.replace(/["*]/g, ''))
    .filter((t) => t.length >= 2);
}

function expand(tokens: string[]): string[] {
  const out = new Set<string>();
  for (const t of tokens) {
    const sing = singularize(t);
    out.add(sing);
    const canonical = VERB_SYNONYMS[t] ?? VERB_SYNONYMS[sing];
    if (canonical) out.add(canonical);
  }
  return [...out];
}

/** Saturating map of a raw (positive) BM25 score into 0..1. */
function normalizeBm25(raw: number): number {
  return raw <= 0 ? 0 : raw / (raw + 5);
}

const LIKE_FALLBACK_SCORE = 0.1;

export class Bm25HybridRanker implements Ranker {
  readonly name = 'bm25-hybrid';

  constructor(
    private readonly db: Db,
    private readonly embeddings: () => Promise<EmbeddingProvider>,
  ) {}

  async rank(query: string, limit: number): Promise<RankedHit[]> {
    const provider = await this.embeddings();
    if (provider.name === 'none') return this.lexical(query, limit);

    let queryVec: Float32Array;
    try {
      const [vec] = await provider.embed([query]);
      if (!vec || vec.length === 0) return this.lexical(query, limit);
      queryVec = Float32Array.from(vec);
    } catch {
      return this.lexical(query, limit);
    }

    const pool = Math.max(limit * 4, 20);
    const semantic = this.db
      .queryAll<{ id: number; embedding: string }>(
        'SELECT id, embedding FROM server_tools WHERE embedding IS NOT NULL AND embedding_model = ?',
        [provider.model],
      )
      .map((r) => ({ id: r.id, cos: cosineSimilarity(queryVec, decodeEmbedding(r.embedding)) }))
      .sort((a, b) => b.cos - a.cos)
      .slice(0, pool);
    const lexical = new Map(this.lexical(query, pool).map((h) => [h.id, h.score]));

    const merged = new Map<number, number>();
    for (const { id, cos } of semantic) {
      merged.set(id, 0.7 * Math.max(0, cos) + 0.3 * (lexical.get(id) ?? 0));
    }
    for (const [id, lex] of lexical) if (!merged.has(id)) merged.set(id, 0.3 * lex);
    return [...merged.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private lexical(query: string, limit: number): RankedHit[] {
    const raw = tokenize(query);
    if (raw.length === 0) return [];
    const ftsQuery = expand(raw)
      .map((t) => `"${t}"*`)
      .join(' OR ');
    try {
      const rows = this.db.queryAll<{ id: number; score: number }>(
        `SELECT rowid AS id, -bm25(server_tools_fts, 4.0, 1.0) AS score
         FROM server_tools_fts WHERE server_tools_fts MATCH ? ORDER BY score DESC LIMIT ?`,
        [ftsQuery, limit],
      );
      if (rows.length > 0) return rows.map((r) => ({ id: r.id, score: normalizeBm25(r.score) }));
    } catch {
      /* malformed FTS query — fall through to LIKE */
    }
    const conds = raw.map(() => '(LOWER(name) LIKE ? OR LOWER(description) LIKE ?)').join(' AND ');
    const params = raw.flatMap((t) => [`%${t}%`, `%${t}%`]);
    return this.db
      .queryAll<{
        id: number;
      }>(`SELECT id FROM server_tools WHERE ${conds} ORDER BY length(name) LIMIT ?`, [
        ...params,
        limit,
      ])
      .map((r) => ({ id: r.id, score: LIKE_FALLBACK_SCORE }));
  }
}
