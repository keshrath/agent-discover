// =============================================================================
// agent-discover — Preset REST endpoints
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

describe('Preset REST', () => {
  it('GET /api/presets starts empty', async () => {
    const res = await request('/api/presets');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual([]);
  });

  it('POST /api/presets persists and GET returns it', async () => {
    const postRes = await request('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server: 's',
        kind: 'tool',
        target: 'search',
        preset: 'quick',
        payload: { query: 'hi' },
      }),
    });
    expect(postRes.status).toBe(201);
    const post = await postRes.json();
    expect(post.id).toBeGreaterThan(0);
    const getRes = await request('/api/presets?server=s&kind=tool&target=search');
    const get = await getRes.json();
    expect(get.entries).toHaveLength(1);
    expect(get.entries[0].payload).toEqual({ query: 'hi' });
  });

  it('POST rejects invalid kind', async () => {
    const res = await request('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server: 's',
        kind: 'nope',
        target: 't',
        preset: 'p',
        payload: {},
      }),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE removes a preset', async () => {
    const postRes = await request('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server: 's',
        kind: 'tool',
        target: 't',
        preset: 'p',
        payload: {},
      }),
    });
    const post = await postRes.json();
    const delRes = await request(`/api/presets/${post.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const body = await delRes.json();
    expect(body.ok).toBe(true);
  });

  it('DELETE on unknown id returns ok:false', async () => {
    const res = await request('/api/presets/999999', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});

describe('Elicitation REST', () => {
  it('GET /api/elicitations returns empty list', async () => {
    const res = await request('/api/elicitations');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual([]);
  });

  it('POST /api/elicitations/:id/respond on unknown id returns 404', async () => {
    const res = await request('/api/elicitations/bogus/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    });
    expect(res.status).toBe(404);
  });

  it('POST validates action', async () => {
    const res = await request('/api/elicitations/any/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });
});
