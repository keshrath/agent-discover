// =============================================================================
// Upstream era negotiation: in-place stdio probe (one spawn), legacy retry for
// servers that die on server/discover, cached verdicts reused as `prior`.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createContext, type AppContext } from '../src/context.js';
import { FIXTURE } from './helpers.js';

const STRICT = resolve(__dirname, 'fixtures', 'strict-legacy.mjs');

let ctx: AppContext;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-discover-neg-'));
  ctx = createContext({ path: ':memory:', config: { connIdleMs: 0 } });
});
afterEach(async () => {
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

const spawns = (log: string) => readFileSync(log, 'utf8').split('\n').filter(Boolean).length;

describe('stdio negotiation', () => {
  it('a server that exits on server/discover is initialized as legacy, then reconnects with one spawn', async () => {
    const log = join(dir, 'spawns.log');
    const { index_error } = await ctx.lifecycle.install({
      name: 'strict',
      command: process.execPath,
      args: [STRICT],
      env: { SPAWN_LOG: log },
    });
    expect(index_error).toBeUndefined();
    expect(spawns(log)).toBe(2); // in-place probe (dies) + legacy initialize
    const verdict = ctx.servers.getEraVerdict('strict');
    expect(verdict?.era).toBe('legacy');

    const result = await ctx.lifecycle.callTool('strict', 'hello', {});
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'hi' }] });
    expect(spawns(log)).toBe(3); // cached legacy verdict: no probe
    expect(ctx.lifecycle.pool.info('strict')?.era).toBe('legacy');
    expect(ctx.servers.getEraVerdict('strict')?.checked_at).toBe(verdict?.checked_at);
  });

  it('a modern server negotiates 2026 in place and caches the discover result', async () => {
    const start = Date.now();
    await ctx.lifecycle.install({ name: 'up', command: process.execPath, args: [FIXTURE] });
    expect(ctx.servers.getEraVerdict('up')).toMatchObject({ era: 'modern' });
    await ctx.lifecycle.pool.connect('up');
    expect(ctx.lifecycle.pool.info('up')).toMatchObject({ era: 'modern' });
    expect(Date.now() - start).toBeLessThan(15_000);
  });
});
