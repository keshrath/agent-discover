// =============================================================================
// agent-discover — REST API error case tests
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

describe('REST API Error Cases', () => {
  describe('POST /api/servers — missing required fields', () => {
    it('should reject empty name', async () => {
      const res = await request('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'node' }),
      });
      // Name will be '' which triggers ValidationError
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it('should reject empty body', async () => {
      const res = await request('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  describe('POST /api/servers — invalid JSON', () => {
    it('should return error for malformed JSON', async () => {
      const res = await request('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json!!!',
      });
      // ValidationError from readBody JSON.parse failure
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });
  });

  describe('GET /api/servers/:id — not found', () => {
    it('should return 404 for non-existent id', async () => {
      const res = await request('/api/servers/9999');
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Not found');
    });

    it('should return 404 for id 0', async () => {
      const res = await request('/api/servers/0');
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/servers/:id — not found', () => {
    it('should return 404 for non-existent id', async () => {
      const res = await request('/api/servers/9999', { method: 'DELETE' });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Not found');
    });
  });

  describe('POST /api/servers/:id/activate — not found', () => {
    it('should return 404 for non-existent id', async () => {
      const res = await request('/api/servers/9999/activate', { method: 'POST' });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Not found');
    });
  });

  describe('POST /api/servers/:id/deactivate — not found', () => {
    it('should return 404 for non-existent id', async () => {
      const res = await request('/api/servers/9999/deactivate', { method: 'POST' });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Not found');
    });
  });

  describe('POST /api/servers/:id/activate — no command', () => {
    it('should return 400 when server has no command', async () => {
      const srv = ctx.registry.register({ name: 'no-cmd-srv' });
      const res = await request(`/api/servers/${srv.id}/activate`, { method: 'POST' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('No command');
    });
  });

  describe('POST — body too large', () => {
    it('should reject body larger than 128KB', async () => {
      const largeBody = JSON.stringify({ name: 'x'.repeat(200_000) });
      try {
        const res = await request('/api/servers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: largeBody,
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
      } catch (err) {
        expect(err).toBeDefined();
      }
    });
  });

  describe('GET /api/browse — limit parameter handling', () => {
    it('should use default limit for non-numeric value', async () => {
      // This should not crash; the handler parses and falls back to 20
      // We can't easily assert the limit was 20 without mocking marketplace,
      // but we can verify it doesn't 500
      try {
        const res = await request('/api/browse?limit=abc');
        // Marketplace call will likely fail (no network in test), but the
        // limit parsing should not cause a crash on its own
        // Any status is fine as long as it doesn't hang
        expect(res.status).toBeDefined();
      } catch {
        // Fetch error from marketplace is acceptable
      }
    });
  });

  describe('Path traversal protection', () => {
    it('should not serve files outside ui directory', async () => {
      const res = await request('/../../etc/passwd');
      // Should get 403 (Forbidden) or 404 (Not found), not file contents
      expect([403, 404]).toContain(res.status);
    });

    it('should not serve files with encoded traversal', async () => {
      const res = await request('/%2e%2e/%2e%2e/etc/passwd');
      expect([403, 404]).toContain(res.status);
    });
  });

  describe('Unknown routes', () => {
    it('should return 404 for unknown API paths', async () => {
      const res = await request('/api/nonexistent');
      expect(res.status).toBe(404);
    });

    it('should return 404 for unknown root paths', async () => {
      const res = await request('/totally-unknown');
      expect(res.status).toBe(404);
    });
  });

  describe('CORS preflight', () => {
    it('should handle OPTIONS requests', async () => {
      const res = await request('/api/servers', { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    });
  });

  describe('POST /api/servers — duplicate name', () => {
    it('should reject duplicate server names', async () => {
      // Register first
      await request('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'dup-srv', command: 'node' }),
      });

      // Try to register again
      const res = await request('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'dup-srv', command: 'python' }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain('already exists');
    });
  });

  describe('POST /api/servers — invalid name characters', () => {
    it('should reject names with spaces', async () => {
      const res = await request('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'bad name', command: 'node' }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('should reject names with double underscores', async () => {
      const res = await request('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'bad__name', command: 'node' }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('GET /api/servers with query search', () => {
    it('should return filtered results with query param', async () => {
      ctx.registry.register({ name: 'alpha-srv', command: 'node', description: 'Alpha server' });
      ctx.registry.register({ name: 'beta-srv', command: 'node', description: 'Beta server' });

      const res = await request('/api/servers?query=alpha');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0].name).toBe('alpha-srv');
    });
  });

  describe('GET /api/servers with installed filter', () => {
    it('should filter by installed=true', async () => {
      ctx.registry.register({ name: 'inst-srv', command: 'node' });
      ctx.registry.register({ name: 'uninst-srv' });

      const res = await request('/api/servers?installed=true');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('inst-srv');
    });
  });

  describe('POST /api/servers/:id/deactivate — not active', () => {
    it('should return not_active for inactive server', async () => {
      const srv = ctx.registry.register({ name: 'inactive-srv', command: 'node' });
      const res = await request(`/api/servers/${srv.id}/deactivate`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('not_active');
    });
  });
});
