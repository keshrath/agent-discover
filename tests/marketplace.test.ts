// =============================================================================
// MarketplaceClient: mirror-first search with npm/PyPI federation, exact-name
// resolve, and plan() pinning unversioned packages.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDb, type Db } from '../src/storage/database.js';
import { RegistryMirror } from '../src/domain/registry.js';
import { MarketplaceClient } from '../src/domain/marketplace.js';
import { entry, fakeRegistry, type FakeRegistry } from './fixtures/registry.js';

const BASE = 'https://registry.test';

let db: Db;
let reg: FakeRegistry;
let mirror: RegistryMirror;
let client: MarketplaceClient;
let routes: Array<[RegExp, () => Response]>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const npmHit = (name: string, description: string, keywords: string[] = ['mcp']) => ({
  package: { name, version: '0.1.0', description, keywords, links: {} },
});

beforeEach(() => {
  db = createDb({ path: ':memory:' });
  reg = fakeRegistry(
    [
      entry('io.github.acme/time', '1.0.0', {
        description: 'Time and timezone tools',
        packages: [
          { registryType: 'npm', identifier: '@acme/time-mcp', transport: { type: 'stdio' } },
        ],
      }),
    ],
    50,
  );
  routes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      if (url.origin === BASE) return reg.handle(url) ?? json({}, 404);
      for (const [re, fn] of routes) if (re.test(url.toString())) return fn();
      return new Response('', { status: 404, statusText: 'Not Found' });
    }),
  );
  mirror = new RegistryMirror(db, BASE);
  client = new MarketplaceClient(mirror);
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe('search', () => {
  it('answers live before the first sync and starts a background sync', async () => {
    const res = await client.search('time', 10);
    expect(res.registry).toBe('live');
    expect(res.servers.map((s) => s.name)).toEqual(['io.github.acme/time']);
    await vi.waitFor(() => expect(mirror.status().synced_at).not.toBeNull());
    expect((await client.search('time', 10)).registry).toBe('mirror');
  });

  it('merges npm and PyPI, dropping packages a registry entry already publishes', async () => {
    await mirror.sync();
    routes.push(
      [
        /registry\.npmjs\.org\/-\/v1\/search/,
        () =>
          json({
            objects: [
              npmHit('@acme/time-mcp', 'shadow of the registry entry'),
              npmHit('time-mcp-lite', 'Tiny MCP time server'),
              npmHit('left-pad-time', 'not related', []),
            ],
          }),
      ],
      [/pypi\.org\/search/, () => new Response('<html></html>')],
      [
        /pypi\.org\/pypi\/mcp-server-time\/json/,
        () => json({ info: { name: 'mcp-server-time', version: '0.6.2', summary: 'MCP time' } }),
      ],
    );
    const res = await client.search('time', 10);
    expect(res.errors).toEqual({});
    expect(res.servers.map((s) => `${s.source}:${s.name}`)).toEqual([
      'registry:io.github.acme/time',
      'npm:time-mcp-lite',
      'pypi:mcp-server-time',
    ]);
    expect(res.servers[0]).toMatchObject({
      status: 'active',
      packages: [
        { registry_type: 'npm', identifier: '@acme/time-mcp', version: null, transport: 'stdio' },
      ],
      remotes: [],
    });
  });

  it('federation failures are reported per source, registry results survive', async () => {
    await mirror.sync();
    routes.push(
      [/registry\.npmjs\.org/, () => new Response('<html>', { status: 200 })],
      [/pypi\.org\/search/, () => new Response('', { status: 500 })],
    );
    const res = await client.search('time', 10);
    expect(res.servers.map((s) => s.name)).toEqual(['io.github.acme/time']);
    expect(Object.keys(res.errors)).toEqual(['npm']);
  });

  it('respects the limit', async () => {
    await mirror.sync();
    routes.push([
      /registry\.npmjs\.org\/-\/v1\/search/,
      () => json({ objects: [npmHit('a-mcp', 'mcp'), npmHit('b-mcp', 'mcp')] }),
    ]);
    expect((await client.search('time', 2)).servers).toHaveLength(2);
  });

  it('interleaves the keyword and plain npm rankings so neither buries the other', async () => {
    await mirror.sync();
    routes.push(
      [
        /keywords%3Amcp/,
        () => json({ objects: ['k1', 'k2', 'k3'].map((n) => npmHit(`${n}-mcp`, 'mcp')) }),
      ],
      [
        /registry\.npmjs\.org\/-\/v1\/search/,
        () => json({ objects: [npmHit('@mcp/plain-top', 'MCP server', [])] }),
      ],
    );
    const names = (await client.search('everything', 3)).servers.map((s) => s.name);
    expect(names).toEqual(['k1-mcp', '@mcp/plain-top', 'k2-mcp']);
  });

  it('falls back to the partly synced mirror when the live search fails', async () => {
    await mirror.sync();
    db.run("DELETE FROM _meta WHERE key = 'registry_synced_at'");
    const handle = reg.handle;
    reg.handle = (url) =>
      url.searchParams.has('search') ? new Response('', { status: 503 }) : handle(url);
    const res = await client.search('time', 10);
    expect(res.servers.map((s) => s.name)).toContain('io.github.acme/time');
    expect(res.errors.registry).toBeUndefined();
  });
});

describe('resolve / plan', () => {
  it('registry: exact name only, NotFound otherwise; falls back to the mirror offline', async () => {
    await expect(client.resolve('registry', 'io.github.acme/tim')).rejects.toThrow(/not found/i);
    const live = await client.resolve('registry', 'io.github.acme/time');
    expect(live.server.name).toBe('io.github.acme/time');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect((await client.resolve('registry', 'io.github.acme/time')).registry?.status).toBe(
      'active',
    );
    await expect(client.resolve('registry', 'io.github.acme/time', '0.1.0')).rejects.toThrow(
      'offline',
    );
  });

  it('npm / pypi: exact name match and package-name validation', async () => {
    routes.push(
      [
        /registry\.npmjs\.org\/@acme%2Ftime-mcp\/latest/,
        () => json({ name: '@acme/time-mcp', version: '2.1.0', description: 'time' }),
      ],
      [
        /pypi\.org\/pypi\/mcp-server-time\/json/,
        () => json({ info: { name: 'mcp_server_time', version: '0.6.2' } }),
      ],
    );
    const npm = await client.resolve('npm', '@acme/time-mcp');
    expect(npm.server.packages[0]).toMatchObject({
      identifier: '@acme/time-mcp',
      version: '2.1.0',
    });
    await expect(client.resolve('pypi', 'mcp-server-time')).rejects.toThrow(/not found/i);
    await expect(client.resolve('npm', 'x; rm -rf /')).rejects.toThrow(/Invalid package name/);
  });

  it('plan pins an unversioned registry package to the current release and runs checks', async () => {
    routes.push([
      /registry\.npmjs\.org\/@acme%2Ftime-mcp\/(latest|3\.0\.0)$/,
      () => json({ name: '@acme/time-mcp', version: '3.0.0', mcpName: 'io.github.acme/time' }),
    ]);
    const plan = await client.plan({ name: 'io.github.acme/time' });
    expect(plan.args).toEqual(['-y', '@acme/time-mcp@3.0.0']);
    expect(plan.provenance.pinned).toBe(true);
    expect(plan.provenance.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      'registry_namespace:pass',
      'npm_mcp_name:pass',
    ]);
  });

  it('plan survives a failed release lookup: unpinned, with a warning', async () => {
    routes.push([
      /registry\.npmjs\.org\/@acme%2Ftime-mcp/,
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    const plan = await client.plan({ name: 'io.github.acme/time' });
    expect(plan.args).toEqual(['-y', '@acme/time-mcp']);
    expect(plan.provenance.pinned).toBe(false);
    expect(plan.warnings).toContain(
      'could not look up the current npm release of @acme/time-mcp: fetch failed',
    );
  });
});
