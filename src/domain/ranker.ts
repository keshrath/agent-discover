// =============================================================================
// agent-discover — Tool ranking
//
// `Ranker` is the retrieval extension point (SPEC §4 W1): given a query it
// returns tool-row ids with scores in 0..1, best first. The ToolIndex owns persistence; a Ranker only reads.
//
// HybridRanker, stage by stage (every constant was tuned on the dev split of
// bench/retrieval and is reported on the held-out test split there):
//   1. query terms     unicode/diacritic folding, EN+DE stopwords, typo
//                      repair against the index vocabulary
//   2. lexical         FTS5 BM25 over name / description / args (porter-
//                      stemmed, weighted per field), saturated to 0..1
//   3. dense (opt.)    cosine over stored tool vectors, min-max rescaled per
//                      query; fused with the lexical score by weighted sum
//   4. routing         server-level evidence: tools of servers the query does
//                      not name are damped; tools of the best server win ties
//   5. usage prior     small capped boost for tools that are actually called
//
// No score floor: on the bench no signal (query coverage, BM25, cosine)
// separates unanswerable queries from answerable ones, so the ranker answers
// with nothing only when no query term matches (bench/retrieval/README.md).
// =============================================================================

import type { Db } from '../storage/database.js';
import {
  cosineSimilarity,
  decodeEmbedding,
  type Embedding,
  type EmbeddingProvider,
} from '../embeddings/index.js';
import { indexWords } from './tool-doc.js';

export interface RankedHit {
  /** server_tools.id */
  readonly id: number;
  /** Relevance in 0..1. */
  readonly score: number;
}

export interface Ranker {
  readonly name: string;
  /** Best hits first; empty when nothing in the index matches the query at all. */
  rank(query: string, limit: number): Promise<RankedHit[]>;
}

export interface HybridOptions {
  /** bm25() column weights: name, description, args. */
  readonly weights: readonly [number, number, number];
  /** raw BM25 → raw / (raw + saturation). */
  readonly saturation: number;
  /** Repair query terms missing from the index vocabulary (edit distance 1-2). */
  readonly fuzzy: boolean;
  /** Weight of the dense score in the fused score (0 = lexical only). */
  readonly denseWeight: number;
  /** Tools of servers other than the best one are scaled by (1 - serverBoost * gap). */
  readonly serverBoost: number;
  /** Tools of servers the query does not name are scaled by (1 - serverMention). */
  readonly serverMention: number;
  /** Usage prior: +min(cap, weight * ln(1 + calls)). */
  readonly usageWeight: number;
  readonly usageCap: number;
  /** Lexical candidates fetched before re-scoring. */
  readonly pool: number;
}

export const DEFAULT_HYBRID: HybridOptions = {
  weights: [6, 1.5, 0.5],
  saturation: 6,
  fuzzy: true,
  denseWeight: 0.5,
  serverBoost: 0.3,
  serverMention: 0.3,
  usageWeight: 0.01,
  usageCap: 0.05,
  pool: 200,
};

// Function words in English and German: they carry no intent and only add
// noise to an OR query over tool metadata.
const STOPWORDS = new Set(
  (
    'a an and any are as at be been but by can could do does for from get give had has have how i if in into ' +
    'is it its just let me my need of on or our out please same should so some that the their them then there ' +
    'these this those to up us use using via was we were what when where which who why will with would you your ' +
    'aber alle als am an auf aus bei bin bis bitte da das dass dem den der des die du ein eine einen einem einer ' +
    'es fur gibt hat habe ich ihr im in ist ja kann mal man mich mir mit nach nicht noch nur oder sich sie sind so ' +
    'uber um und uns von vom was welche wie wir wo zu zum zur'
  ).split(' '),
);

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '');

/** Index-side words of a text, as FTS5 unicode61 remove_diacritics sees them. */
function terms(text: string): string[] {
  return indexWords(fold(text)).split(' ').filter(Boolean);
}

/**
 * Content words of a query, as typed (no identifier splitting: "GitLab" stays
 * "gitlab", which the index also holds). A query of nothing but function
 * words ("do it" for a tool named do_it) keeps them.
 */
export function queryTerms(query: string): string[] {
  const words = fold(query)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
  const content = words.filter((t) => !STOPWORDS.has(t));
  return [...new Set(content.length > 0 ? content : words)];
}

/** Damerau-Levenshtein distance, early exit above `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

interface Snapshot {
  generation: string;
  /** Unstemmed term → number of documents containing it. */
  vocab: Map<string, number>;
  docs: number;
  serverOf: Map<number, string>;
  /** Server → distinctive name terms (rare outside that server). */
  serverTerms: Map<string, Set<string>>;
  calls: Map<number, number>;
  vectors: { model: string; rows: Array<{ id: number; vec: Embedding }> } | null;
}

const QUERY_CACHE = 256;

export class HybridRanker implements Ranker {
  readonly name = 'hybrid';
  private snapshot: Snapshot | null = null;
  /** Query → vector, per model (LRU by insertion order). */
  private readonly queryVectors = new Map<string, Embedding>();

  constructor(
    private readonly db: Db,
    private readonly embeddings: () => Promise<EmbeddingProvider>,
    private readonly options: HybridOptions = DEFAULT_HYBRID,
  ) {}

  async rank(query: string, limit: number): Promise<RankedHit[]> {
    const provider = await this.embeddings();
    const snap = this.load(provider);
    if (snap.docs === 0) return [];
    const o = this.options;

    const qterms = queryTerms(query).map((t) => (o.fuzzy ? this.repair(t, snap) : t));
    const lexical = this.lexical(qterms);
    const dense =
      o.denseWeight > 0 && snap.vectors?.model === provider.model
        ? await this.dense(query, provider, snap.vectors.rows)
        : null;
    const w = dense ? o.denseWeight : 0;
    const scores = new Map<number, number>();
    for (const [id, s] of lexical) scores.set(id, (1 - w) * s);
    for (const [id, d] of dense ?? []) scores.set(id, (scores.get(id) ?? 0) + w * d);
    if (scores.size === 0) return [];

    this.route(scores, qterms, snap);
    for (const [id, s] of scores) {
      const calls = snap.calls.get(id);
      if (calls)
        scores.set(id, Math.min(1, s + Math.min(o.usageCap, o.usageWeight * Math.log1p(calls))));
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, limit)
      .map(([id, score]) => ({ id, score }));
  }

  /** The vocabulary term closest to an unknown query term, or the term itself. */
  private repair(term: string, snap: Snapshot): string {
    if (term.length < 4 || snap.vocab.has(term) || /\d/.test(term)) return term;
    const max = term.length >= 7 ? 2 : 1;
    let best = term;
    let bestDist = max + 1;
    let bestDf = 0;
    for (const [cand, df] of snap.vocab) {
      if (cand.length < 3 || cand[0] !== term[0]) continue;
      const dist = editDistance(term, cand, max);
      if (dist < bestDist || (dist === bestDist && df > bestDf)) {
        best = cand;
        bestDist = dist;
        bestDf = df;
      }
    }
    return best;
  }

  /** FTS5 BM25 over the fielded index, saturated to 0..1. */
  private lexical(qterms: string[]): Map<number, number> {
    const out = new Map<number, number>();
    if (qterms.length === 0) return out;
    const [wn, wd, wa] = this.options.weights;
    const rows = this.db.queryAll<{ id: number; raw: number }>(
      `SELECT rowid AS id, -bm25(server_tools_fts, ?, ?, ?) AS raw
       FROM server_tools_fts WHERE server_tools_fts MATCH ? ORDER BY raw DESC LIMIT ?`,
      [wn, wd, wa, qterms.map(quote).join(' OR '), this.options.pool],
    );
    for (const { id, raw } of rows) out.set(id, raw / (raw + this.options.saturation));
    return out;
  }

  /** Cosine min-max rescaled per query (a model's cosines sit in a narrow band). */
  private async dense(
    query: string,
    provider: EmbeddingProvider,
    rows: Array<{ id: number; vec: Embedding }>,
  ): Promise<Map<number, number> | null> {
    const key = `${provider.model}\n${query}`;
    let qv = this.queryVectors.get(key);
    if (!qv) {
      try {
        const [vec] = await provider.embed([query], 'query');
        if (!vec?.length) return null;
        qv = Float32Array.from(vec);
      } catch {
        return null;
      }
      if (this.queryVectors.size >= QUERY_CACHE) {
        this.queryVectors.delete(this.queryVectors.keys().next().value!);
      }
      this.queryVectors.set(key, qv);
    }
    const cos = rows.map((r) => ({ id: r.id, c: cosineSimilarity(qv, r.vec) }));
    let lo = Infinity;
    let hi = -Infinity;
    for (const { c } of cos) {
      lo = Math.min(lo, c);
      hi = Math.max(hi, c);
    }
    const out = new Map<number, number>();
    for (const { id, c } of cos) if (c > lo) out.set(id, (c - lo) / (hi - lo));
    return out;
  }

  /** Server-level routing: explicit server mentions, then a nudge toward the best server. */
  private route(scores: Map<number, number>, qterms: string[], snap: Snapshot): void {
    const o = this.options;
    const named = new Set<string>();
    for (const [server, ts] of snap.serverTerms) {
      if (qterms.some((t) => ts.has(t))) named.add(server);
    }
    const best = new Map<string, number>();
    for (const [id, s] of scores) {
      const server = snap.serverOf.get(id)!;
      best.set(server, Math.max(best.get(server) ?? 0, s));
    }
    const top = Math.max(...best.values());
    for (const [id, s] of scores) {
      const server = snap.serverOf.get(id)!;
      let f = 1 - o.serverBoost * (1 - (best.get(server) ?? 0) / (top || 1));
      if (named.size > 0 && !named.has(server)) f *= 1 - o.serverMention;
      scores.set(id, s * f);
    }
  }

  /** Per-generation caches: vocabulary, server terms, usage counts, decoded vectors. */
  private load(provider: EmbeddingProvider): Snapshot {
    const generation =
      this.db.queryOne<{ value: string }>(
        "SELECT value FROM _meta WHERE key = 'tool_index_generation'",
      )?.value ?? '0';
    const usage = this.db.queryAll<{ id: number; calls: number }>(
      `SELECT t.id, m.call_count AS calls FROM server_metrics m
       JOIN server_tools t ON t.server_id = m.server_id AND t.name = m.tool_name`,
    );
    const calls = new Map(usage.map((u) => [u.id, u.calls]));
    const model = provider.name === 'none' ? null : provider.model;
    const cached = this.snapshot;
    if (cached && cached.generation === generation && (cached.vectors?.model ?? null) === model) {
      cached.calls = calls;
      return cached;
    }

    const docs = this.db.queryAll<{
      id: number;
      server: string;
      name: string;
      description: string;
      args: string;
    }>(
      `SELECT f.rowid AS id, s.name AS server, f.name, f.description, f.args
       FROM server_tools_fts f JOIN server_tools t ON t.id = f.rowid JOIN servers s ON s.id = t.server_id`,
    );
    const vocab = new Map<string, number>();
    const serverOf = new Map<number, string>();
    const termServers = new Map<string, Set<string>>();
    for (const d of docs) {
      serverOf.set(d.id, d.server);
      for (const t of new Set(`${d.name} ${d.description} ${d.args}`.split(' '))) {
        if (!t) continue;
        vocab.set(t, (vocab.get(t) ?? 0) + 1);
        let set = termServers.get(t);
        if (!set) termServers.set(t, (set = new Set()));
        set.add(d.server);
      }
    }
    // A server-name term is "distinctive" when it is not common vocabulary of
    // other servers ("github" yes; "search" in "brave-search" no).
    const servers = new Set(serverOf.values());
    const serverTerms = new Map<string, Set<string>>();
    for (const server of servers) {
      const own = terms(server).filter((t) => t.length >= 3);
      for (const t of own) vocab.set(t, (vocab.get(t) ?? 0) + 1);
      const distinctive = own.filter((t) => {
        const others = [...(termServers.get(t) ?? [])].filter((s) => s !== server).length;
        return others <= Math.max(1, servers.size * 0.1);
      });
      if (distinctive.length > 0) serverTerms.set(server, new Set(distinctive));
    }

    const vectors = model
      ? {
          model,
          rows: this.db
            .queryAll<{
              id: number;
              embedding: string;
            }>(
              'SELECT id, embedding FROM server_tools WHERE embedding IS NOT NULL AND embedding_model = ?',
              [model],
            )
            .map((r) => ({ id: r.id, vec: decodeEmbedding(r.embedding) })),
        }
      : null;

    this.snapshot = { generation, vocab, docs: docs.length, serverOf, serverTerms, calls, vectors };
    return this.snapshot;
  }
}

const quote = (t: string) => `"${t.replace(/"/g, '')}"`;
