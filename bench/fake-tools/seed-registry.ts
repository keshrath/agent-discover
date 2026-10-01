// =============================================================================
// Seed the bench-isolated agent-discover DB with the fake-tools server at N
// tools — through the real install path: ServerLifecycle.install connects to
// bench/fake-tools/server.mjs, lists its tools and persists them via the
// ToolIndex (embeddings included when AGENT_DISCOVER_EMBEDDING_PROVIDER is
// set). Both bench arms therefore see byte-identical tool definitions.
//
// Usage:
//   npm run bench:seed -- --n=100
//
// Idempotent: re-seeding replaces the prior `fake-tools-bench` server.
// =============================================================================

import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext } from '../../src/lib.js';
import { BENCH_DB } from '../drivers/cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_NAME = 'fake-tools-bench';
const SERVER_PATH = path.join(__dirname, 'server.mjs').replace(/\\/g, '/');

export async function seedRegistry(n: number): Promise<number> {
  if (!Number.isFinite(n) || n <= 0) throw new Error('n must be a positive integer');
  mkdirSync(path.dirname(BENCH_DB), { recursive: true });
  const ctx = createContext({ path: BENCH_DB });
  try {
    if (ctx.servers.get(SERVER_NAME)) await ctx.lifecycle.uninstall(SERVER_NAME);
    const { server, diff, index_error } = await ctx.lifecycle.install({
      name: SERVER_NAME,
      description: `Bench fake-tools server with ${n} stub tools (synthetic).`,
      command: process.execPath,
      args: [SERVER_PATH],
      env: { FAKE_TOOL_COUNT: String(n) },
      tags: ['bench', 'fake'],
    });
    if (index_error) throw new Error(`indexing ${SERVER_NAME} failed: ${index_error}`);
    if (diff && diff.embedded > 0) console.log(`embedded ${diff.embedded} tools`);
    return ctx.index.count(server.id);
  } finally {
    await ctx.close();
  }
}

if (process.argv[1]?.includes('seed-registry')) {
  const nArg = process.argv.find((a) => a.startsWith('--n='));
  const n = nArg ? parseInt(nArg.slice(4), 10) : 100;
  seedRegistry(n)
    .then((count) => console.log(`seeded ${count} tools under server "${SERVER_NAME}"`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
