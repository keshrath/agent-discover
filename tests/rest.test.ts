// =============================================================================
// REST adapter + request guard (Host / Origin / Content-Type on /api, /mcp)
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { FIXTURE, startTestDaemon, type TestDaemon } from './helpers.js';

let d: TestDaemon;
beforeEach(async () => {
  d = await startTestDaemon();
});
afterEach(async () => d.stop());

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  headers.set('x-agent-discover-token', d.restToken);
  return fetch(d.base + path, { ...init, headers });
}

/** Raw request with arbitrary Host/Origin (fetch forbids overriding Host). */
function raw(
  path: string,
  headers: Record<string, string>,
  method = 'GET',
  body?: string,
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: d.port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('servers via REST', () => {
  it('install → enable → disable → uninstall through the lifecycle', async () => {
    const created = await api('/api/servers', {
      method: 'POST',
      body: JSON.stringify({ name: 'up', command: process.execPath, args: [FIXTURE] }),
    });
    expect(created.status).toBe(201);
    const server = await created.json();
    expect(server).toMatchObject({ name: 'up', enabled: false, connected: false });
    expect(server.tool_count).toBeGreaterThan(3);

    const enabled = await (
      await api(`/api/servers/${server.id}/enable`, { method: 'POST' })
    ).json();
    expect(enabled.enabled).toBe(true);
    const detail = await (await api(`/api/servers/${server.id}`)).json();
    expect(detail.tools.map((t: { name: string }) => t.name)).toContain('echo');

    expect(
      (await (await api(`/api/servers/${server.id}/disable`, { method: 'POST' })).json()).enabled,
    ).toBe(false);
    expect((await api(`/api/servers/${server.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(`/api/servers/${server.id}`)).status).toBe(404);
  });

  it('stores remote url and declared headers in their own fields, header values masked out', async () => {
    const res = await api('/api/servers', {
      method: 'POST',
      body: JSON.stringify({
        name: 'remote',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:9/mcp',
        headers: { Authorization: 'Bearer static-token', 'X-Team': 'a' },
      }),
    });
    const s = await res.json();
    expect(s).toMatchObject({
      url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: 'Bear****', 'X-Team': '****' },
      homepage: null,
    });
    expect(s.index_error).toMatch(/Failed to connect/);
    // A masked value sent back unchanged keeps the stored one.
    await api(`/api/servers/${s.id}`, {
      method: 'PUT',
      body: JSON.stringify({ headers: { ...s.headers, 'X-Team': 'b' } }),
    });
    expect(d.ctx.servers.get('remote')!.headers).toEqual({
      Authorization: 'Bearer static-token',
      'X-Team': 'b',
    });
  });

  it('lists declared headers that are empty and have no secret as missing_secrets', async () => {
    const s = d.ctx.servers.create({
      name: 'gated',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:9/mcp',
      headers: { 'X-Api-Key': '', 'X-Team': 'a' },
    });
    const missing = async () => (await (await api(`/api/servers/${s.id}`)).json()).missing_secrets;
    expect(await missing()).toEqual(['X-Api-Key']);
    await api(`/api/servers/${s.id}/secrets/x-api-key`, {
      method: 'PUT',
      body: JSON.stringify({ value: 'k' }),
    });
    expect(await missing()).toEqual([]);
  });

  it('lists declared env vars that are empty and have no secret as missing_secrets', async () => {
    const s = d.ctx.servers.create({
      name: 'gated-env',
      command: 'x',
      env: { GITHUB_TOKEN: '', REGION: 'eu' },
    });
    const missing = async () => (await (await api(`/api/servers/${s.id}`)).json()).missing_secrets;
    expect(await missing()).toEqual(['GITHUB_TOKEN']);
    await api(`/api/servers/${s.id}/secrets/GITHUB_TOKEN`, {
      method: 'PUT',
      body: JSON.stringify({ value: 'k' }),
    });
    expect(await missing()).toEqual([]);
  });

  it('masks env values and keeps the original when a masked value comes back', async () => {
    const s = d.ctx.servers.create({ name: 'm', command: 'x', env: { API_KEY: 'sk-123456' } });
    const got = await (await api(`/api/servers/${s.id}`)).json();
    expect(got.env).toEqual({ API_KEY: 'sk-1****' });
    await api(`/api/servers/${s.id}`, {
      method: 'PUT',
      body: JSON.stringify({ env: { ...got.env, NEW: 'n' } }),
    });
    expect(d.ctx.servers.get('m')!.env).toEqual({ API_KEY: 'sk-123456', NEW: 'n' });
  });

  it('maps validation and upstream errors to status codes', async () => {
    expect(
      (await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'x' }) })).status,
    ).toBe(400);
    expect((await api('/api/servers/999')).status).toBe(404);
    expect((await api('/api/nope')).status).toBe(404);
    expect((await api('/api/health')).status).toBe(200);
    expect((await api('/api/servers/1/secrets/%E0', { method: 'DELETE' })).status).toBe(400);
  });
});

describe('request guard', () => {
  const host = () => `127.0.0.1:${d.port}`;

  it('rejects foreign Host headers on REST and /mcp (DNS rebinding)', async () => {
    expect((await raw('/api/health', { Host: 'evil.com' })).status).toBe(403);
    expect((await raw('/api/health', { Host: `localhost:${d.port + 1}` })).status).toBe(403);
    expect((await raw('/mcp', { Host: `evil.com:${d.port}` }, 'POST', '{}')).status).toBe(403);
    expect((await raw('/api/health', { Host: `localhost:${d.port}` })).status).toBe(200);
  });

  it('rejects every request that carries an Origin (browser pages), loopback ones included', async () => {
    for (const origin of [
      'https://evil.com',
      'null',
      'file://',
      'http://localhost.evil.com',
      'http://localhost:5173',
      `http://${host()}`,
    ]) {
      const res = await raw('/api/servers', { Host: host(), Origin: origin });
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect((await raw('/mcp', { Host: host(), Origin: origin }, 'POST', '{}')).status).toBe(403);
      expect((await raw('/api/logs', { Host: host(), Origin: origin }, 'OPTIONS')).status).toBe(
        403,
      );
    }
    const plain = await raw('/api/health', { Host: host() });
    expect(plain.status).toBe(200);
    expect(plain.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('requires JSON bodies on mutating requests', async () => {
    const res = await raw(
      '/api/servers',
      { Host: host(), 'Content-Type': 'text/plain', 'Content-Length': '2' },
      'POST',
      '{}',
    );
    expect(res.status).toBe(415);
  });
});
