// =============================================================================
// agent-discover — Marketplace extra coverage
//
// Targets the v1.1.0 PyPI/npm augmentation paths inside MarketplaceClient.browse
// (the searchPypi + searchNpm helpers are private, so we drive them through the
// public browse() entry point with a fully mocked global fetch).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarketplaceClient } from '../src/domain/marketplace.js';

let client: MarketplaceClient;

beforeEach(() => {
  client = new MarketplaceClient();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MarketplaceClient — search augmentation', () => {
  it('augments registry results with npm and pypi candidates', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('registry.modelcontextprotocol.io')) {
        return jsonResponse({ servers: [], metadata: {} });
      }
      if (url.includes('registry.npmjs.org')) {
        return jsonResponse({
          objects: [
            {
              package: {
                name: '@playwright/mcp',
                version: '0.0.5',
                description: 'Playwright MCP server',
                keywords: ['mcp'],
                links: { repository: 'https://github.com/microsoft/playwright-mcp' },
              },
            },
          ],
        });
      }
      if (url.includes('pypi.org/search')) {
        return new Response('<html></html>', { status: 200 });
      }
      if (url.includes('pypi.org/pypi/')) {
        return jsonResponse({
          info: {
            name: 'mcp-server-time',
            version: '0.6.2',
            summary: 'MCP server for time',
            project_urls: { Repository: 'https://github.com/example/time' },
          },
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await client.browse('time', 5);
    const names = result.servers.map((s) => s.name);
    expect(names).toContain('@playwright/mcp');
    expect(names).toContain('mcp-server-time');
    const py = result.servers.find((s) => s.name === 'mcp-server-time');
    expect(py?.packages?.[0].registry_name).toBe('pypi');
    expect(py?.packages?.[0].runtime).toBe('python');
  });

  it('preserves registry results when npm + pypi both fail', async () => {
    // The registry result must survive even if every augmentation source
    // explodes. Otherwise a flaky npm/pypi outage would empty the marketplace.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('registry.modelcontextprotocol.io/v0/servers?')) {
          return jsonResponse({
            servers: [{ server: { name: 'official-srv', version: '1.0.0', remotes: [] } }],
            metadata: {},
          });
        }
        if (url.includes('registry.npmjs.org')) {
          return new Response('boom', { status: 503, statusText: 'Service Unavailable' });
        }
        if (url.includes('pypi.org/search')) return new Response('', { status: 500 });
        if (url.includes('pypi.org/pypi/')) return new Response('null', { status: 404 });
        return jsonResponse({});
      }),
    );

    const result = await client.browse('time', 5);
    expect(result.servers.map((s) => s.name)).toEqual(['official-srv']);
  });

  it('preserves registry results when npm returns malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('registry.modelcontextprotocol.io/v0/servers?')) {
          return jsonResponse({
            servers: [{ server: { name: 'official-srv', version: '1.0.0', remotes: [] } }],
            metadata: {},
          });
        }
        if (url.includes('registry.npmjs.org')) {
          // body is HTML, not JSON — fetch().json() will reject
          return new Response('<html>nope</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        if (url.includes('pypi.org/search')) return new Response('', { status: 200 });
        if (url.includes('pypi.org/pypi/')) return new Response('not json', { status: 200 });
        return jsonResponse({});
      }),
    );

    const result = await client.browse('time', 5);
    expect(result.servers.map((s) => s.name)).toEqual(['official-srv']);
  });

  it('filters npm packages that do not look MCP-related', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('registry.modelcontextprotocol.io')) {
          return jsonResponse({ servers: [], metadata: {} });
        }
        if (url.includes('registry.npmjs.org')) {
          return jsonResponse({
            objects: [
              {
                package: {
                  name: 'unrelated-lib',
                  version: '1.0.0',
                  description: 'has nothing to do with anything',
                },
              },
            ],
          });
        }
        return new Response('', { status: 404 });
      }),
    );

    const result = await client.browse('foo', 5);
    expect(result.servers.find((s) => s.name === 'unrelated-lib')).toBeUndefined();
  });

  it('honours dedupe across registry + npm + pypi by source:name key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('registry.modelcontextprotocol.io/v0/servers?')) {
          // Registry already knows about an mcp-server-sqlite python entry
          return jsonResponse({
            servers: [
              {
                server: {
                  name: 'mcp-server-sqlite',
                  description: 'sqlite mcp',
                  version: '1.0.0',
                  remotes: [{ type: 'python' }],
                },
              },
            ],
            metadata: {},
          });
        }
        if (url.includes('registry.npmjs.org')) {
          return jsonResponse({
            objects: [
              {
                package: {
                  name: 'mcp-server-sqlite', // npm-flavored shadow
                  version: '0.1.0',
                  description: 'mcp sqlite via npm',
                  keywords: ['mcp'],
                },
              },
            ],
          });
        }
        if (url.includes('pypi.org/search')) return new Response('', { status: 200 });
        if (url.includes('pypi.org/pypi/')) return new Response('null', { status: 404 });
        return jsonResponse({});
      }),
    );

    const result = await client.browse('sqlite', 5);
    const sqlite = result.servers.filter((s) => s.name === 'mcp-server-sqlite');
    // Cross-source dedupe key is `<source>:<name>`, so the registry's python
    // entry and the npm entry must BOTH survive — exactly two rows, not one,
    // not three. This locks in the v1.1.0 federation behavior.
    expect(sqlite).toHaveLength(2);
    const sources = sqlite.map((s) => s.packages?.[0].registry_name).sort();
    expect(sources).toEqual(['npm', 'python']);
  });

  it('handles a successful PyPI HTML scrape that adds new candidates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('registry.modelcontextprotocol.io')) {
          return jsonResponse({ servers: [], metadata: {} });
        }
        if (url.includes('registry.npmjs.org')) return jsonResponse({ objects: [] });
        if (url.includes('pypi.org/search')) {
          return new Response(
            `<html><a class="package-snippet" href="/project/mcp-extra-pkg/">x</a></html>`,
            { status: 200 },
          );
        }
        if (url.includes('pypi.org/pypi/')) {
          // Match any PyPI JSON lookup with a generic MCP-flavored payload
          return jsonResponse({
            info: {
              name: 'mcp-extra-pkg',
              version: '0.0.1',
              summary: 'an mcp test package',
            },
          });
        }
        return jsonResponse({});
      }),
    );

    const result = await client.browse('extra', 5);
    expect(result.servers.some((s) => s.name === 'mcp-extra-pkg')).toBe(true);
  });

  it('does not augment when no query is provided', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ servers: [], metadata: {} }));
    vi.stubGlobal('fetch', fetchMock);
    await client.browse(); // no query
    // exactly one network call: the registry browse
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps PyPI candidate lookups at the requested limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('registry.modelcontextprotocol.io')) {
          return jsonResponse({ servers: [], metadata: {} });
        }
        if (url.includes('registry.npmjs.org')) return jsonResponse({ objects: [] });
        if (url.includes('pypi.org/search')) return new Response('', { status: 200 });
        if (url.includes('pypi.org/pypi/')) {
          const m = /pypi\/([^/]+)\/json/.exec(url);
          const name = m ? decodeURIComponent(m[1]) : 'x';
          return jsonResponse({
            info: { name, version: '1.0.0', summary: 'mcp server' },
          });
        }
        return jsonResponse({});
      }),
    );
    const result = await client.browse('mcp', 3);
    // The PyPI augment branch should not exceed limit (curated list is large)
    const py = result.servers.filter((s) => s.packages?.[0].registry_name === 'pypi');
    expect(py.length).toBeLessThanOrEqual(3);
  });
});

describe('MarketplaceClient — registry parse edge cases', () => {
  it('dedupes registry results by name keeping the highest version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          servers: [
            { server: { name: 'dup', version: '1.0.0', remotes: [] } },
            { server: { name: 'dup', version: '1.2.5' } },
            { server: { name: 'dup', version: '1.1.9', remotes: [] } },
          ],
          metadata: { nextCursor: null },
        }),
      ),
    );
    const r = await client.browse();
    const dup = r.servers.filter((s) => s.name === 'dup');
    expect(dup).toHaveLength(1);
    expect(dup[0].version).toBe('1.2.5');
  });

  it('handles a totally non-object response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(null)),
    );
    const r = await client.browse();
    expect(r.servers).toEqual([]);
    expect(r.next_cursor).toBeNull();
  });

  it('translates an AbortError into a friendly timeout message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }),
    );
    await expect(client.browse('x')).rejects.toThrow(/timed out/);
  });
});
