// =============================================================================
// Registry installs: GET /api/install/plan, POST /api/install,
// GET /api/registry, POST /api/registry/sync, and install_server over /mcp.
// The fake registry's remote entry points at the daemon's own /mcp, so the
// install really connects and indexes.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { connectClient, startTestDaemon, type TestDaemon } from './helpers.js';
import { entry, fakeRegistry, serveRegistry, type FakeRegistry } from './fixtures/registry.js';

let d: TestDaemon;
let reg: FakeRegistry;
let regServer: Server;

beforeAll(async () => {
  reg = fakeRegistry([]);
  const served = await serveRegistry(reg);
  regServer = served.server;
  d = await startTestDaemon({ registryUrl: served.url });
  reg.entries.push(
    entry('io.github.acme/self', '1.0.0', {
      description: 'agent-discover itself, over http',
      remotes: [{ type: 'streamable-http', url: `${d.base}/mcp` }],
    }),
    entry('io.github.other/self', '1.0.0', {
      remotes: [{ type: 'streamable-http', url: `${d.base}/mcp` }],
    }),
    entry('io.github.acme/bundle', '1.0.0', {
      packages: [
        { registryType: 'mcpb', identifier: 'https://x/b.mcpb', transport: { type: 'stdio' } },
      ],
    }),
  );
});
afterAll(async () => {
  await d.stop();
  regServer.close();
});

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  headers.set('x-agent-discover-token', d.restToken);
  return fetch(d.base + path, { ...init, headers });
}

describe('registry routes', () => {
  it('sync and status', async () => {
    const sync = await (await api('/api/registry/sync', { method: 'POST' })).json();
    expect(sync).toMatchObject({ mode: 'full', fetched: 3 });
    expect(await (await api('/api/registry')).json()).toMatchObject({ count: 3, syncing: false });
  });
});

describe('install routes', () => {
  it('plan shows the endpoint and provenance', async () => {
    const res = await api('/api/install/plan?name=io.github.acme/self');
    expect(res.status).toBe(200);
    const plan = await res.json();
    expect(plan).toMatchObject({
      server: 'self',
      transport: 'streamable-http',
      url: `${d.base}/mcp`,
      provenance: { registry: { publisher: 'github:acme' }, remote: { type: 'streamable-http' } },
    });
    expect(plan.warnings).toContain('remote endpoint is not served over https');
  });

  it('validates the request and refuses blocked plans', async () => {
    expect((await api('/api/install/plan?source=cargo&name=x')).status).toBe(400);
    expect((await api('/api/install/plan')).status).toBe(400);
    const blocked = await api('/api/install', {
      method: 'POST',
      body: JSON.stringify({ name: 'io.github.acme/bundle' }),
    });
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error).toMatch(/MCPB/);
    const missing = await api('/api/install', {
      method: 'POST',
      body: JSON.stringify({ name: 'io.github.acme/nope' }),
    });
    expect(missing.status).toBe(404);
  });

  it('installs, indexes and stores secrets; a second install conflicts', async () => {
    const res = await api('/api/install', {
      method: 'POST',
      body: JSON.stringify({
        name: 'io.github.acme/self',
        local_name: 'me',
        secrets: { API_KEY: 'k' },
      }),
    });
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(out).toMatchObject({ name: 'me', registry_name: 'io.github.acme/self' });
    expect(out.index_error).toBeUndefined();
    expect(out.tool_count).toBeGreaterThan(3);
    expect(out.plan.server).toBe('me');
    expect(d.ctx.secrets.list({ id: out.id, name: 'me' }).map((s) => s.key)).toEqual(['API_KEY']);
    expect(d.ctx.lifecycle.status('me')[0].registry_status).toBe('active');

    const again = await api('/api/install', {
      method: 'POST',
      body: JSON.stringify({ name: 'io.github.acme/self', local_name: 'me' }),
    });
    expect(again.status).toBe(409);
  });
});

describe('install_server over MCP', () => {
  it('reports already_installed only for the same server, not for a name clash', async () => {
    const c = await connectClient(d, { era: 'modern' });
    const install = async (args: Record<string, unknown>) =>
      (await c.callTool({ name: 'install_server', arguments: args })) as CallToolResult;
    try {
      expect((await install({ server: 'io.github.acme/self' })).structuredContent).toMatchObject({
        name: 'self',
        status: 'installed',
      });
      expect((await install({ server: 'io.github.acme/self' })).structuredContent).toMatchObject({
        status: 'already_installed',
      });
      const clash = await install({ server: 'io.github.other/self' });
      expect(clash.isError).toBe(true);
      expect(JSON.stringify(clash.content)).toMatch(/io\.github\.acme\/self.*pass `name`/);
      expect(d.ctx.servers.get('self')?.registry_name).toBe('io.github.acme/self');

      const rest = await api('/api/install', {
        method: 'POST',
        body: JSON.stringify({ name: 'io.github.other/self' }),
      });
      expect(rest.status).toBe(409);
      expect((await rest.json()).error).toMatch(/local_name/);
    } finally {
      await c.close();
    }
  });

  it('refuses env/headers for a registry install instead of dropping them', async () => {
    const c = await connectClient(d, { era: 'modern' });
    try {
      const res = (await c.callTool({
        name: 'install_server',
        arguments: { server: 'io.github.other/self', name: 'other', env: { TOKEN: 'x' } },
      })) as CallToolResult;
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(/env and headers/);
      expect(d.ctx.servers.get('other')).toBeNull();
    } finally {
      await c.close();
    }
  });
});
