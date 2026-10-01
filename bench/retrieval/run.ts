// =============================================================================
// Retrieval-only bench. Deterministic, offline, no LLM calls.
//
//   npm run bench:retrieval                       # all rankers, test split
//   npm run bench:retrieval -- --split=dev        # tune on dev ONLY
//   npm run bench:retrieval -- --ranker=bm25,regex
//
// Writes bench/retrieval/_results/<ranker>.json (both splits, per category,
// per-query ranks) and prints a table for the selected split.
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { Category, Hit, Query, Ranker, ToolDoc } from './types.js';
import { toolKey } from './types.js';
import { Bm25Ranker } from './baselines/bm25.js';
import { RegexRanker } from './baselines/regex.js';
import { AgentDiscoverV1Ranker } from './baselines/agent-discover-v1.js';
import { toJson } from './json.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const K = 10;

/** Register new rankers here. Factories so each run gets a fresh instance. */
export const RANKERS: Record<string, () => Ranker> = {
  bm25: () => new Bm25Ranker(false),
  'bm25-args': () => new Bm25Ranker(true),
  regex: () => new RegexRanker(),
  'agent-discover-v1': () => new AgentDiscoverV1Ranker(),
};

interface Catalog {
  servers: { server: string; provenance: string; tools: Omit<ToolDoc, 'server'>[] }[];
}

export function loadCatalog(): ToolDoc[] {
  const cat = JSON.parse(readFileSync(path.join(HERE, 'catalog.json'), 'utf8')) as Catalog;
  return cat.servers.flatMap((s) => s.tools.map((t) => ({ ...t, server: s.server })));
}

export function loadQueries(): Query[] {
  return (JSON.parse(readFileSync(path.join(HERE, 'queries.json'), 'utf8')) as { queries: Query[] })
    .queries;
}

// --- metrics ----------------------------------------------------------------

interface QueryScore {
  id: string;
  category: Category;
  split: Query['split'];
  /** 1-based rank of the first hit per step (null = not in top K). */
  stepRanks: (number | null)[];
  recall1: number;
  recall5: number;
  recall10: number;
  rr: number;
  ndcg10: number;
  ms: number;
}

function scoreQuery(q: Query, hits: Hit[], ms: number): QueryScore {
  const ranked = hits.slice(0, K).map((h) => toolKey(h.server, h.tool));
  const stepRanks = q.targets.map((alts) => {
    const i = ranked.findIndex((r) => alts.includes(r));
    return i < 0 ? null : i + 1;
  });
  const recallAt = (k: number) =>
    stepRanks.filter((r) => r !== null && r <= k).length / q.targets.length;
  const first = Math.min(...stepRanks.map((r) => r ?? Infinity));
  // nDCG: gain 1 at the first rank where each step is satisfied; alternatives
  // within one step never double-count. Ideal = all steps at ranks 1..n.
  const dcg = stepRanks.reduce<number>((s, r) => (r ? s + 1 / Math.log2(r + 1) : s), 0);
  let idcg = 0;
  for (let i = 1; i <= Math.min(q.targets.length, K); i++) idcg += 1 / Math.log2(i + 1);
  return {
    id: q.id,
    category: q.category,
    split: q.split,
    stepRanks,
    recall1: recallAt(1),
    recall5: recallAt(5),
    recall10: recallAt(10),
    rr: Number.isFinite(first) ? 1 / first : 0,
    ndcg10: dcg / idcg,
    ms,
  };
}

interface Agg {
  n: number;
  recall1: number;
  recall5: number;
  recall10: number;
  mrr: number;
  ndcg10: number;
  p50ms: number;
  p95ms: number;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function aggregate(rows: QueryScore[]): Agg {
  const n = rows.length || 1;
  const mean = (f: (r: QueryScore) => number) => rows.reduce((s, r) => s + f(r), 0) / n;
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  return {
    n: rows.length,
    recall1: mean((r) => r.recall1),
    recall5: mean((r) => r.recall5),
    recall10: mean((r) => r.recall10),
    mrr: mean((r) => r.rr),
    ndcg10: mean((r) => r.ndcg10),
    p50ms: pct(ms, 50),
    p95ms: pct(ms, 95),
  };
}

function breakdown(rows: QueryScore[]) {
  const cats = [...new Set(rows.map((r) => r.category))].sort();
  return {
    overall: aggregate(rows),
    byCategory: Object.fromEntries(
      cats.map((c) => [c, aggregate(rows.filter((r) => r.category === c))]),
    ),
  };
}

// --- runner -----------------------------------------------------------------

export async function evaluate(ranker: Ranker, tools: ToolDoc[], queries: Query[]) {
  const t0 = performance.now();
  await ranker.index(tools);
  const indexMs = performance.now() - t0;
  const scores: QueryScore[] = [];
  for (const q of queries) {
    const s = performance.now();
    const hits = await ranker.search(q.query, K);
    scores.push(scoreQuery(q, hits, performance.now() - s));
  }
  await ranker.close?.();
  return {
    ranker: ranker.name,
    corpus: { tools: tools.length, servers: new Set(tools.map((t) => t.server)).size },
    indexMs,
    dev: breakdown(scores.filter((s) => s.split === 'dev')),
    test: breakdown(scores.filter((s) => s.split === 'test')),
    queries: scores.map(({ id, split, stepRanks }) => ({ id, split, stepRanks })),
  };
}

const f3 = (x: number) => x.toFixed(3);
const f1 = (x: number) => x.toFixed(1);

function printTable(title: string, rows: [string, Agg][]) {
  const head = ['', 'n', 'R@1', 'R@5', 'R@10', 'MRR', 'nDCG@10', 'p50ms', 'p95ms'];
  const body = rows.map(([label, a]) => [
    label,
    String(a.n),
    f3(a.recall1),
    f3(a.recall5),
    f3(a.recall10),
    f3(a.mrr),
    f3(a.ndcg10),
    f1(a.p50ms),
    f1(a.p95ms),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i])));
  console.log(`\n${title}`);
  console.log(line(head).join('  '));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of body) console.log(line(r).join('  '));
}

async function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  const split = (arg('split') ?? 'test') as 'dev' | 'test';
  const names = arg('ranker')?.split(',') ?? Object.keys(RANKERS);
  const tools = loadCatalog();
  const queries = loadQueries();
  const outDir = path.join(HERE, '_results');
  mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const name of names) {
    const make = RANKERS[name];
    if (!make) throw new Error(`unknown ranker "${name}" (have: ${Object.keys(RANKERS)})`);
    const r = await evaluate(make(), tools, queries);
    writeFileSync(path.join(outDir, `${name}.json`), toJson(r));
    results.push(r);
  }

  console.log(
    `corpus: ${results[0].corpus.servers} servers / ${results[0].corpus.tools} tools; ` +
      `queries: ${queries.length} (dev ${queries.filter((q) => q.split === 'dev').length}, ` +
      `test ${queries.filter((q) => q.split === 'test').length}); split shown: ${split}`,
  );
  printTable(
    `overall (${split})`,
    results.map((r) => [r.ranker, r[split].overall]),
  );
  const cats = Object.keys(results[0][split].byCategory);
  for (const c of cats) {
    printTable(
      `${c} (${split})`,
      results.map((r) => [r.ranker, r[split].byCategory[c]]),
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
