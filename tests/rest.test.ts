// =============================================================================
// REST adapter + request guard (Host / Origin / Content-Type on /api, /mcp, WS)
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';
import { FIXTURE, startTestDaemon, waitFor, type TestDaemon } from './helpers.js';

let d: TestDaemon;
beforeEach(async () => {
  d = await startTestDaemon();
});
afterEach(async () => d.stop());

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
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

    const call = await (
      await api(`/api/servers/${server.id}/call`, {
        method: 'POST',
        body: JSON.stringify({ tool: 'echo', args: { text: 'rest' } }),
      })
    ).json();
    expect(call.content).toEqual([{ type: 'text', text: 'rest' }]);

    expect(
      (await (await api(`/api/servers/${server.id}/disable`, { method: 'POST' })).json()).enabled,
    ).toBe(false);
    expect((await api(`/api/servers/${server.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(`/api/servers/${server.id}`)).status).toBe(404);
  });

  it('stores remote url and declared headers in their own fields', async () => {
    const res = await api('/api/servers', {
      method: 'POST',
      body: JSON.stringify({
        name: 'remote',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:9/mcp',
        headers: { 'X-Team': 'a' },
      }),
    });
    const s = await res.json();
    expect(s).toMatchObject({
      url: 'http://127.0.0.1:9/mcp',
      headers: { 'X-Team': 'a' },
      homepage: null,
    });
    expect(s.index_error).toMatch(/Failed to connect/);
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

  it('rejects foreign, null and look-alike Origins; reflects loopback ones', async () => {
    for (const origin of [
      'https://evil.com',
      'null',
      'http://localhost.evil.com',
      'http://127.0.0.1.evil.com',
    ]) {
      expect((await raw('/api/health', { Host: host(), Origin: origin })).status).toBe(403);
      expect((await raw('/mcp', { Host: host(), Origin: origin }, 'POST', '{}')).status).toBe(403);
    }
    const ok = await raw('/api/health', { Host: host(), Origin: 'http://localhost:5173' });
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const electron = await raw('/api/health', { Host: host(), Origin: 'file://' });
    expect(electron.status).toBe(200);
    const plain = await raw('/api/health', { Host: host() });
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

  it('applies Host/Origin to WebSocket upgrades and pushes state', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${d.port}/ws`, {
      headers: { Origin: 'https://evil.com' },
    });
    const badResult = await new Promise<string>((resolve) => {
      bad.on('open', () => resolve('open'));
      bad.on('error', () => resolve('rejected'));
    });
    expect(badResult).toBe('rejected');

    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
    const states: Array<{ servers: unknown[] }> = [];
    ws.on('message', (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.type === 'state') states.push(msg);
    });
    await waitFor(() => states.length === 1);
    expect(states[0].servers).toEqual([]);
    await d.ctx.lifecycle.install({ name: 'up', command: process.execPath, args: [FIXTURE] });
    await waitFor(() => states.some((s) => s.servers.length === 1));
    ws.close();
  });
});
