// =============================================================================
// agent-discover — REST API tests
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
      if (addr && typeof addr === 'object') {
        baseUrl = `http://localhost:${addr.port}`;
      }
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  ctx.close();
});

describe('REST API', () => {
  describe('GET /health', () => {
    it('should return health info', async () => {
      const res = await request('/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.version).toBeDefined();
      expect(body.uptime).toBeTypeOf('number');
    });
  });

  describe('GET /api/servers', () => {
    it('should return empty array initially', async () => {
      const res = await request('/api/servers');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it('should list registered servers', async () => {
      ctx.registry.register({
        name: 'test-srv',
        command: 'node',
        description: 'Test',
      });
      const res = await request('/api/servers');
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('test-srv');
    });

    it('should filter by source', async () => {
      ctx.registry.register({
        name: 'local-srv',
        command: 'a',
        source: 'local',
      });
      ctx.registry.register({
        name: 'reg-srv',
        command: 'b',
        source: 'registry',
      });
      const res = await request('/api/servers?source=registry');
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('reg-srv');
    });
  });

  describe('GET /api/servers/:id', () => {
    it('should return server details', async () => {
      const srv = ctx.registry.register({
        name: 'detail-srv',
        command: 'node',
      });
      const res = await request(`/api/servers/${srv.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe('detail-srv');
      expect(body.tools).toBeDefined();
    });

    it('should return 404 for non-existent', async () => {
      const res = await request('/api/servers/999');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/servers', () => {
    it('should register a new server', async () => {
      const res = await request('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'new-srv', command: 'node' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe('new-srv');
    });
  });

  describe('DELETE /api/servers/:id', () => {
    it('should delete a server', async () => {
      const srv = ctx.registry.register({ name: 'del-srv', command: 'node' });
      const res = await request(`/api/servers/${srv.id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(ctx.registry.getByName('del-srv')).toBeNull();
    });
  });

  describe('GET /api/status', () => {
    it('should return active status', async () => {
      const res = await request('/api/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.active_count).toBe(0);
      expect(body.servers).toEqual([]);
    });
  });

  describe('404', () => {
    it('should return 404 for unknown routes', async () => {
      const res = await request('/unknown');
      expect(res.status).toBe(404);
    });
  });
});
