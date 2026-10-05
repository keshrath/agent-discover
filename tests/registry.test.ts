// =============================================================================
// RegistryMirror: full + incremental sync, status handling, live lookups,
// and flagging installed servers whose registry entry was deleted.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDb, type Db } from '../src/storage/database.js';
import { RegistryMirror, STALE_AFTER_MS } from '../src/domain/registry.js';
import { createContext, type AppContext } from '../src/context.js';
import { entry, fakeRegistry, type FakeRegistry } from './fixtures/registry.js';

const BASE = 'https://registry.test';

let db: Db;
let reg: FakeRegistry;
let mirror: RegistryMirror;

function stubFetch(r: FakeRegistry) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      return r.handle(url) ?? new Response('{}', { status: 404 });
    }),
  );
}

beforeEach(() => {
  db = createDb({ path: ':memory:' });
  reg = fakeRegistry([
    entry('io.github.acme/weather', '1.0.0', { description: 'Weather forecasts' }),
    entry('io.github.acme/old-weather', '0.9.0', {
      status: 'deprecated',
      description: 'Weather (old)',
    }),
    entry('com.example/files', '2.0.0', { description: 'File access' }),
  ]);
  stubFetch(reg);
  mirror = new RegistryMirror(db, BASE);
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe('sync', () => {
  it('full sync pages through version=latest, then syncs incrementally via updated_since', async () => {
    const full = await mirror.sync();
    expect(full).toMatchObject({ mode: 'full', fetched: 3, pages: 2 });
    expect(reg.requests.every((u) => u.searchParams.get('version') === 'latest')).toBe(true);
    expect(reg.requests[1].searchParams.get('cursor')).toBe('2');
    expect(mirror.status()).toMatchObject({ count: 3, syncing: false, last_error: null });
    expect(mirror.isStale()).toBe(false);
    expect(mirror.isStale(Date.now() + STALE_AFTER_MS + 1)).toBe(true);

    reg.entries.push(
      entry('io.github.acme/weather', '1.1.0', { updatedAt: '2026-02-01T00:00:00Z' }),
      entry('com.example/files', '2.0.0', { status: 'deleted', updatedAt: '2026-02-02T00:00:00Z' }),
    );
    reg.requests.length = 0;
    const inc = await mirror.sync();
    expect(inc).toMatchObject({ mode: 'incremental', fetched: 2 });
    expect(reg.requests[0].searchParams.get('updated_since')).toBe('2026-01-01T00:00:00Z');
    expect(reg.requests[0].searchParams.has('version')).toBe(false);
    expect(mirror.get('io.github.acme/weather')?.server.version).toBe('1.1.0');
    expect(mirror.get('com.example/files')?.registry?.status).toBe('deleted');
    expect(mirror.status().count).toBe(2);

    reg.requests.length = 0;
    await mirror.sync();
    expect(reg.requests[0].searchParams.get('updated_since')).toBe('2026-02-02T00:00:00Z');
  });

  it('a non-latest version never replaces the stored latest; a status change on it does', async () => {
    await mirror.sync();
    reg.entries.push(
      entry('io.github.acme/weather', '0.5.0', {
        isLatest: false,
        updatedAt: '2026-03-01T00:00:00Z',
      }),
    );
    await mirror.sync();
    expect(mirror.get('io.github.acme/weather')?.server.version).toBe('1.0.0');
    reg.entries.push(
      entry('io.github.acme/weather', '1.0.0', {
        status: 'deprecated',
        updatedAt: '2026-03-02T00:00:00Z',
        isLatest: false,
      }),
    );
    await mirror.sync();
    expect(mirror.get('io.github.acme/weather')?.registry?.status).toBe('deprecated');
  });

  it('records the error of a failed sync and joins concurrent syncs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503, statusText: 'Unavailable' })),
    );
    const a = mirror.sync();
    const b = mirror.sync();
    expect(a).toBe(b);
    await expect(a).rejects.toThrow(/503/);
    expect(mirror.status().last_error).toMatch(/503/);
    expect(mirror.status().synced_at).toBeNull();
  });

  it('syncIfStale runs in the background only when stale', async () => {
    mirror.syncIfStale();
    expect(mirror.status().syncing).toBe(true);
    await vi.waitFor(() => expect(mirror.status().syncing).toBe(false));
    expect(mirror.status().count).toBe(3);
    reg.requests.length = 0;
    mirror.syncIfStale();
    expect(reg.requests).toHaveLength(0);
  });
});

describe('search and lookups', () => {
  beforeEach(async () => {
    reg.entries.push(entry('io.github.evil/weather-pro', '1.0.0', { status: 'deleted' }));
    await mirror.sync();
  });

  it('full-text search hides deleted entries and ranks deprecated ones last', () => {
    const names = mirror.search('weather', 10).map((c) => c.server.name);
    expect(names).toEqual(['io.github.acme/weather', 'io.github.acme/old-weather']);
    expect(mirror.search('  ', 10)).toEqual([]);
  });

  it('get returns deleted entries, statuses maps names', () => {
    expect(mirror.get('io.github.evil/weather-pro')?.registry?.status).toBe('deleted');
    const s = mirror.statuses(['io.github.evil/weather-pro', 'io.github.acme/weather', 'nope']);
    expect(Object.fromEntries(s)).toEqual({
      'io.github.evil/weather-pro': 'deleted',
      'io.github.acme/weather': 'active',
    });
  });

  it('fetchVersion fetches an exact version live and refreshes the row for latest', async () => {
    reg.entries.push(entry('io.github.acme/weather', '0.1.0', { isLatest: false }));
    const old = await mirror.fetchVersion('io.github.acme/weather', '0.1.0');
    expect(old?.server.version).toBe('0.1.0');
    expect(mirror.get('io.github.acme/weather')?.server.version).toBe('1.0.0');
    expect(await mirror.fetchVersion('io.github.acme/missing')).toBeNull();
  });

  it('searchLive filters deleted entries', async () => {
    const live = await mirror.searchLive('weather', 10);
    expect(live.map((c) => c.server.name)).toEqual([
      'io.github.acme/weather',
      'io.github.acme/old-weather',
    ]);
  });
});

describe('installed servers whose registry entry was deleted', () => {
  let ctx: AppContext;
  afterEach(async () => ctx.close());

  it('server_status reports registry_status', async () => {
    ctx = createContext({ path: ':memory:', config: { registryUrl: BASE } });
    reg.entries.push(entry('io.github.evil/miner', '1.0.0'));
    await ctx.registry.sync();
    const store = ctx.servers;
    store.create({ name: 'miner', command: 'x', registry_name: 'io.github.evil/miner' });
    store.create({ name: 'local', command: 'x' });
    expect(ctx.lifecycle.status('miner')[0].registry_status).toBe('active');

    reg.entries.push(
      entry('io.github.evil/miner', '1.0.0', {
        status: 'deleted',
        updatedAt: '2026-05-01T00:00:00Z',
      }),
    );
    await ctx.registry.sync();
    const byName = Object.fromEntries(
      ctx.lifecycle.status().map((s) => [s.name, s.registry_status]),
    );
    expect(byName).toEqual({ miner: 'deleted', local: null });
  });
});
