// =============================================================================
// Build bench/retrieval/queries.json from queries.src.json (the hand-labelled
// source). Assigns the dev/test split deterministically and validates every
// label against catalog.json, so a corpus refresh that renames/drops a tool
// fails loudly instead of silently zeroing a query.
//
//   npx tsx bench/retrieval/extract/build-queries.ts
//
// Split: within each category, queries are ordered by sha1(id) and the first
// 40% (rounded) go to dev, the rest to test. Adding a query can only move
// queries of its own category; ranker tuning may look at dev only.
// =============================================================================

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Category, Query } from '../types.js';
import { loadCatalog } from '../run.js';
import { toolKey } from '../types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV_FRACTION = 0.4;
const CATEGORIES: Category[] = [
  'paraphrase',
  'task',
  'cross-server',
  'multi-step',
  'short-typo',
  'german',
];

interface SrcQuery {
  query: string;
  /** "a/x|b/y" = one step with alternatives; several strings = several steps. */
  t: string[];
}

const src = JSON.parse(readFileSync(path.join(HERE, 'queries.src.json'), 'utf8')) as Record<
  Category,
  SrcQuery[]
>;

const known = new Set(loadCatalog().map((t) => toolKey(t.server, t.name)));
const errors: string[] = [];
const seen = new Set<string>();
const out: Query[] = [];

for (const category of CATEGORIES) {
  const items = (src[category] ?? []).map((q, i) => {
    const id = `${category}-${String(i + 1).padStart(3, '0')}`;
    const key = q.query.trim().toLowerCase();
    if (seen.has(key)) errors.push(`${id}: duplicate query "${q.query}"`);
    seen.add(key);
    const targets = q.t.map((step) => step.split('|').map((s) => s.trim()));
    for (const alt of targets.flat()) {
      if (!known.has(alt)) errors.push(`${id}: unknown tool "${alt}"`);
    }
    return { id, query: q.query, category, targets };
  });
  const order = [...items].sort((a, b) =>
    createHash('sha1')
      .update(a.id)
      .digest('hex')
      .localeCompare(createHash('sha1').update(b.id).digest('hex')),
  );
  const nDev = Math.round(items.length * DEV_FRACTION);
  const dev = new Set(order.slice(0, nDev).map((q) => q.id));
  for (const q of items) out.push({ ...q, split: dev.has(q.id) ? 'dev' : 'test' });
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
writeFileSync(
  path.join(HERE, '..', 'queries.json'),
  JSON.stringify({ version: 1, devFraction: DEV_FRACTION, queries: out }, null, 2) + '\n',
);
const by = (c: string) => out.filter((q) => q.category === c).length;
console.warn(
  `${out.length} queries (${CATEGORIES.map((c) => `${c} ${by(c)}`).join(', ')}); ` +
    `dev ${out.filter((q) => q.split === 'dev').length} / test ${out.filter((q) => q.split === 'test').length}`,
);
