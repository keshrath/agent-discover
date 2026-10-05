// =============================================================================
// Fake MCP Registry (API v0.1) for tests: a fetch handler over a mutable
// list of `{server, _meta}` entries, plus an http server wrapper for daemon
// tests (registryUrl points at it).
// =============================================================================

import { createServer, type Server } from 'node:http';

export interface Entry {
  server: Record<string, unknown>;
  _meta: Record<string, unknown>;
}

export function entry(
  name: string,
  version: string,
  opts: {
    status?: 'active' | 'deprecated' | 'deleted';
    updatedAt?: string;
    isLatest?: boolean;
    description?: string;
    packages?: unknown[];
    remotes?: unknown[];
  } = {},
): Entry {
  return {
    server: {
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      name,
      description: opts.description ?? `${name} server`,
      version,
      ...(opts.packages ? { packages: opts.packages } : {}),
      ...(opts.remotes ? { remotes: opts.remotes } : {}),
    },
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        status: opts.status ?? 'active',
        publishedAt: '2026-01-01T00:00:00Z',
        updatedAt: opts.updatedAt ?? '2026-01-01T00:00:00Z',
        isLatest: opts.isLatest ?? true,
      },
    },
  };
}

export interface FakeRegistry {
  entries: Entry[];
  requests: URL[];
  handle(url: URL): Response | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** `pageSize` forces pagination so cursors are exercised. */
export function fakeRegistry(entries: Entry[], pageSize = 2): FakeRegistry {
  const reg: FakeRegistry = {
    entries,
    requests: [],
    handle(url) {
      if (!url.pathname.startsWith('/v0.1/servers')) return null;
      reg.requests.push(url);
      const facts = (e: Entry) =>
        e._meta['io.modelcontextprotocol.registry/official'] as {
          updatedAt: string;
          isLatest: boolean;
        };
      const exact = /^\/v0\.1\/servers\/([^/]+)\/versions\/([^/]+)$/.exec(url.pathname);
      if (exact) {
        const name = decodeURIComponent(exact[1]);
        const version = decodeURIComponent(exact[2]);
        const hit = reg.entries.find(
          (e) =>
            e.server.name === name &&
            (version === 'latest' ? facts(e).isLatest : e.server.version === version),
        );
        return hit ? json(hit) : json({ error: 'not found' }, 404);
      }
      const q = url.searchParams;
      let list = reg.entries;
      if (q.get('version') === 'latest') list = list.filter((e) => facts(e).isLatest);
      const since = q.get('updated_since');
      if (since) list = list.filter((e) => facts(e).updatedAt > since);
      const search = q.get('search');
      if (search) list = list.filter((e) => String(e.server.name).includes(search));
      const start = Number(q.get('cursor') ?? 0);
      const page = list.slice(start, start + pageSize);
      const next = start + pageSize < list.length ? String(start + pageSize) : undefined;
      return json({
        servers: page,
        metadata: { count: page.length, ...(next ? { nextCursor: next } : {}) },
      });
    },
  };
  return reg;
}

/** Serve a fake registry over http (for daemon tests); resolves its base URL. */
export async function serveRegistry(reg: FakeRegistry): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const out = reg.handle(new URL(req.url ?? '/', 'http://127.0.0.1')) ?? json({}, 404);
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(await out.text());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, server };
}
