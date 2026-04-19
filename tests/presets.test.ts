// =============================================================================
// agent-discover — Presets service
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { createContext, type AppContext } from '../src/context.js';

let ctx: AppContext;

beforeEach(() => {
  ctx = createContext({ path: ':memory:' });
});

describe('PresetsService', () => {
  it('persists and retrieves a tool preset', () => {
    const entry = ctx.presets.upsert({
      server: 'srv',
      kind: 'tool',
      target: 'search',
      preset: 'quick',
      payload: { query: 'hello' },
    });
    expect(entry.id).toBeGreaterThan(0);
    expect(entry.payload).toEqual({ query: 'hello' });
    const list = ctx.presets.list({ server: 'srv', kind: 'tool', target: 'search' });
    expect(list).toHaveLength(1);
    expect(list[0].preset_name).toBe('quick');
  });

  it('upsert overwrites payload for same (server,kind,target,preset)', () => {
    ctx.presets.upsert({
      server: 'srv',
      kind: 'tool',
      target: 'search',
      preset: 'p',
      payload: { q: 'a' },
    });
    const updated = ctx.presets.upsert({
      server: 'srv',
      kind: 'tool',
      target: 'search',
      preset: 'p',
      payload: { q: 'b' },
    });
    expect(updated.payload).toEqual({ q: 'b' });
    const list = ctx.presets.list({ server: 'srv' });
    expect(list).toHaveLength(1);
  });

  it('rejects invalid kind', () => {
    expect(() =>
      ctx.presets.upsert({
        server: 's',
        kind: 'bogus' as 'tool',
        target: 't',
        preset: 'p',
        payload: {},
      }),
    ).toThrow(/kind/);
  });

  it('delete removes the row', () => {
    const entry = ctx.presets.upsert({
      server: 's',
      kind: 'tool',
      target: 't',
      preset: 'p',
      payload: {},
    });
    expect(ctx.presets.delete(entry.id)).toBe(true);
    expect(ctx.presets.delete(entry.id)).toBe(false);
    expect(ctx.presets.list({ server: 's' })).toHaveLength(0);
  });

  it('filters by kind and target', () => {
    ctx.presets.upsert({ server: 's', kind: 'tool', target: 'a', preset: 'x', payload: {} });
    ctx.presets.upsert({ server: 's', kind: 'prompt', target: 'b', preset: 'y', payload: {} });
    expect(ctx.presets.list({ server: 's', kind: 'tool' })).toHaveLength(1);
    expect(ctx.presets.list({ server: 's', kind: 'prompt' })).toHaveLength(1);
    expect(ctx.presets.list({ server: 's', target: 'a' })).toHaveLength(1);
  });
});
