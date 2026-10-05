// =============================================================================
// Retrieval-only bench. Deterministic, offline, no LLM calls.
//
//   npm run bench:retrieval                       # zero-config rankers, test split
//   npm run bench:retrieval -- --split=dev        # tune on dev ONLY
//   npm run bench:retrieval -- --ranker=bm25,regex
//   npm run bench:retrieval -- --ranker=agent-discover-v2-e5   # opt-in, see README
//   npm run bench:retrieval -- --check            # CI: fail if R@10 or MRR fell
//                                                 # below the committed _results
//
// Writes bench/retrieval/_results/<ranker>.json (both splits, per category,
// per-query ranks) and prints a table for the selected split. Frozen results
// (_results/*.frozen.json: rankers whose code no longer exists) are printed
// as rows too.
// =============================================================================

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { Category, Hit, Query, Ranker, ToolDoc } from './types.js';
import { toolKey } from './types.js';
import { Bm25Ranker } from './baselines/bm25.js';
import { RegexRanker } from './baselines/regex.js';
import { AgentDiscoverV2Ranker } from './baselines/agent-discover-v2.js';
import { toJson } from './json.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const K = 10;

/** Register new rankers here. Factories so each run gets a fresh instance. */
export const RANKERS: Record<string, () => Ranker> = {
  bm25: () => new Bm25Ranker(false),
  'bm25-args': () => new Bm25Ranker(true),
  regex: () => new RegexRanker(),
  'agent-discover-v2': () =>
    new AgentDiscoverV2Ranker('agent-discover-v2', async () => {
      const { NoopEmbeddingProvider } = await import('../../src/embeddings/index.js');
      return new NoopEmbeddingProvider();
    }),
  'agent-discover-v2-enriched': () =>
    new AgentDiscoverV2Ranker(
      'agent-discover-v2-enriched',
      async () => {
        const { NoopEmbeddingProvider } = await import('../../src/embeddings/index.js');
        return new NoopEmbeddingProvider();
      },
      { enrichment: true },
    ),
  'agent-discover-v2-e5': () => {
    // One provider (one model load) per run, shared by every save and search.
    const provider = (async () => {
      const { createProvider } = await import('../../src/embeddings/index.js');
      const p = await createProvider({ provider: 'local' });
      if (p.name === 'none') throw new Error('local embeddings unavailable (see README)');
      return p;
    })();
    return new AgentDiscoverV2Ranker('agent-discover-v2-e5', () => provider);
  },
};

/** Run when no --ranker is given: no model download, no key — what CI runs. */
const ZERO_CONFIG = [
  'bm25',
  'bm25-args',
  'regex',
  'agent-discover-v2',
  'agent-discover-v2-enriched',
];

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
  /** The ranker answered with nothing. */
  empty: boolean;
}

/** An unanswerable query (category `none`): right when the ranker answers with nothing. */
interface NoneScore {
  id: string;
  split: Query['split'];
  rejected: boolean;
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
    empty: hits.length === 0,
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

interface NoMatch {
  /** Unanswerable queries in the split. */
  n: number;
  /** Share of unanswerable queries answered with nothing (higher is better). */
  rejected: number;
  /** Share of answerable queries answered with nothing (lower is better). */
  falseRejected: number;
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

function breakdown(rows: QueryScore[], none: NoneScore[]) {
  const cats = [...new Set(rows.map((r) => r.category))].sort();
  const noMatch: NoMatch = {
    n: none.length,
    rejected: none.filter((r) => r.rejected).length / (none.length || 1),
    falseRejected: rows.filter((r) => r.empty).length / (rows.length || 1),
  };
  return {
    overall: aggregate(rows),
    noMatch,
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
  const none: NoneScore[] = [];
  for (const q of queries) {
    const s = performance.now();
    const hits = await ranker.search(q.query, K);
    const ms = performance.now() - s;
    if (q.targets.length === 0)
      none.push({ id: q.id, split: q.split, rejected: hits.length === 0 });
    else scores.push(scoreQuery(q, hits, ms));
  }
  await ranker.close?.();
  const split = (s: Query['split']) =>
    breakdown(
      scores.filter((r) => r.split === s),
      none.filter((r) => r.split === s),
    );
  return {
    ranker: ranker.name,
    corpus: { tools: tools.length, servers: new Set(tools.map((t) => t.server)).size },
    indexMs,
    dev: split('dev'),
    test: split('test'),
    queries: [
      ...scores.map(({ id, split, stepRanks }) => ({ id, split, stepRanks })),
      ...none.map(({ id, split, rejected }) => ({ id, split, rejected })),
    ],
  };
}

type Result = Awaited<ReturnType<typeof evaluate>>;

const f3 = (x: number) => x.toFixed(3);
const f1 = (x: number) => x.toFixed(1);

function printTable(title: string, rows: [string, Agg, NoMatch?][]) {
  const head = ['', 'n', 'R@1', 'R@5', 'R@10', 'MRR', 'nDCG@10', 'p50ms', 'p95ms'];
  const withNoMatch = rows.some(([, , nm]) => nm);
  if (withNoMatch) head.push('none-rejected', 'false-rejected');
  const body = rows.map(([label, a, nm]) => {
    const cells = [
      label,
      String(a.n),
      f3(a.recall1),
      f3(a.recall5),
      f3(a.recall10),
      f3(a.mrr),
      f3(a.ndcg10),
      f1(a.p50ms),
      f1(a.p95ms),
    ];
    if (withNoMatch) cells.push(nm ? f3(nm.rejected) : '-', nm ? f3(nm.falseRejected) : '-');
    return cells;
  });
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
  const names = arg('ranker')?.split(',') ?? ZERO_CONFIG;
  const check = process.argv.includes('--check');
  const regressions: string[] = [];
  const tools = loadCatalog();
  const queries = loadQueries();
  const outDir = path.join(HERE, '_results');
  mkdirSync(outDir, { recursive: true });

  const results: Result[] = [];
  for (const name of names) {
    const make = RANKERS[name];
    if (!make) throw new Error(`unknown ranker "${name}" (have: ${Object.keys(RANKERS)})`);
    const r = await evaluate(make(), tools, queries);
    const file = path.join(outDir, `${name}.json`);
    if (check) {
      const prior = JSON.parse(readFileSync(file, 'utf8')) as Result;
      for (const s of ['dev', 'test'] as const) {
        for (const m of ['recall10', 'mrr'] as const) {
          if (r[s].overall[m] < prior[s].overall[m] - 1e-9) {
            regressions.push(
              `${name} ${s} ${m}: ${f3(r[s].overall[m])} < ${f3(prior[s].overall[m])}`,
            );
          }
        }
      }
    }
    writeFileSync(file, toJson(r));
    results.push(r);
  }
  const frozen = readdirSync(outDir)
    .filter((f) => f.endsWith('.frozen.json'))
    .map((f) => JSON.parse(readFileSync(path.join(outDir, f), 'utf8')) as Result);
  const rows = [...frozen, ...results];

  const count = (f: (q: Query) => boolean) => queries.filter(f).length;
  console.log(
    `corpus: ${results[0].corpus.servers} servers / ${results[0].corpus.tools} tools; ` +
      `queries: ${queries.length} (dev ${count((q) => q.split === 'dev')}, ` +
      `test ${count((q) => q.split === 'test')}; ${count((q) => q.targets.length === 0)} unanswerable); ` +
      `split shown: ${split}`,
  );
  printTable(
    `overall (${split}) — recall over answerable queries; none-rejected / false-rejected: ` +
      'share of unanswerable / answerable queries answered with nothing',
    rows.map((r) => [r.ranker, r[split].overall, r[split].noMatch]),
  );
  for (const c of Object.keys(results[0][split].byCategory)) {
    printTable(
      `${c} (${split})`,
      rows.map((r) => [r.ranker, r[split].byCategory[c]]),
    );
  }
  if (regressions.length > 0) {
    console.error(['', 'retrieval regressed vs committed _results:', ...regressions].join('\n  '));
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
