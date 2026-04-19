// =============================================================================
// agent-discover — REST tester endpoints
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { createContext, type AppContext } from '../src/context.js';
import { createRouter } from '../src/transport/rest.js';

let ctx: AppContext;
let server: Server;
let baseUrl: string;

function request(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, options);
}

beforeEach(async () => {
  ctx = createContext({ path: ':memory:' });
  const router = createRouter(ctx);
  server = createServer(router);
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  ctx.close();
});

describe('Tester REST endpoints', () => {
  it('returns 404 for unknown server id on /info', async () => {
    const res = await request('/api/servers/9999/info');
    expect(res.status).toBe(404);
  });

  it('returns 400 when server is registered but not active on /info', async () => {
    const s = ctx.registry.register({ name: 's', command: 'node' });
    const res = await request(`/api/servers/${s.id}/info`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not active/);
  });

  it('returns 400 for /call on inactive server', async () => {
    const s = ctx.registry.register({ name: 's2', command: 'node' });
    const res = await request(`/api/servers/${s.id}/resource/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: 'file:///x' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects bad logging-level', async () => {
    const s = ctx.registry.register({ name: 's3', command: 'node' });
    const res = await request(`/api/servers/${s.id}/logging-level`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'bogus' }),
    });
    // 400 from server-not-active or validation; both acceptable as rejection
    expect([400, 403]).toContain(res.status);
  });

  it('rejects bad export format', async () => {
    const s = ctx.registry.register({ name: 's4', command: 'node' });
    const res = await request(`/api/servers/${s.id}/export?format=xml`);
    expect([400, 403]).toContain(res.status);
  });

  it('returns roots config from env', async () => {
    const original = process.env.AGENT_DISCOVER_ROOTS;
    process.env.AGENT_DISCOVER_ROOTS = 'file:///a,file:///b';
    try {
      const res = await request('/api/roots');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.roots).toEqual([
        { uri: 'file:///a', name: 'file:///a' },
        { uri: 'file:///b', name: 'file:///b' },
      ]);
    } finally {
      if (original === undefined) delete process.env.AGENT_DISCOVER_ROOTS;
      else process.env.AGENT_DISCOVER_ROOTS = original;
    }
  });

  it('returns empty roots when env unset', async () => {
    const original = process.env.AGENT_DISCOVER_ROOTS;
    delete process.env.AGENT_DISCOVER_ROOTS;
    try {
      const res = await request('/api/roots');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.roots).toEqual([]);
    } finally {
      if (original !== undefined) process.env.AGENT_DISCOVER_ROOTS = original;
    }
  });

  it('rejects transient without command for stdio', async () => {
    const res = await request('/api/transient', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transport: 'stdio' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects transient with unsafe command', async () => {
    const res = await request('/api/transient', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transport: 'stdio', command: 'rm; ls' }),
    });
    expect(res.status).toBe(400);
  });

  it('transient delete is idempotent for unknown handle', async () => {
    const res = await request('/api/transient/nope', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('logs/notifications endpoint returns entries array', async () => {
    const res = await request('/api/logs/notifications');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it('logs/progress endpoint returns entries array', async () => {
    const res = await request('/api/logs/progress');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
  });
});
