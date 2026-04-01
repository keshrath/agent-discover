// =============================================================================
// agent-discover — Marketplace client tests
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

describe('MarketplaceClient', () => {
  describe('browse', () => {
    it('should parse a valid response', async () => {
      const mockData = {
        servers: [
          {
            server: {
              name: 'test-server',
              description: 'A test MCP server',
              version: '1.0.0',
              repository: { url: 'https://github.com/test/server', source: 'github' },
              remotes: [
                {
                  type: 'streamable-http',
                  url: 'https://server.smithery.ai/test',
                },
              ],
            },
            _meta: {},
          },
        ],
        metadata: { nextCursor: 'abc123', count: 1 },
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData),
      } as Response);

      const result = await client.browse('test', 10);

      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].name).toBe('test-server');
      expect(result.servers[0].repository).toBe('https://github.com/test/server');
      expect(result.servers[0].packages).toHaveLength(1);
      expect(result.servers[0].packages[0].runtime).toBe('streamable-http');
      expect(result.next_cursor).toBe('abc123');
    });

    it('should handle empty response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

      const result = await client.browse();
      expect(result.servers).toEqual([]);
      expect(result.next_cursor).toBeNull();
    });

    it('should throw on HTTP error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      await expect(client.browse('test')).rejects.toThrow('Registry API error: 500');
    });
  });

  describe('getServer', () => {
    it('should return null for 404', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);

      const result = await client.getServer('nonexistent');
      expect(result).toBeNull();
    });

    it('should return server data', async () => {
      const mockData = { name: 'test', description: 'desc' };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
      } as Response);

      const result = await client.getServer('test');
      expect(result).toEqual(mockData);
    });
  });
});
