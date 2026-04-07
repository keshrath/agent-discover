// =============================================================================
// agent-discover — MCP handler tests
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createContext, type AppContext } from '../src/context.js';
import { toolHandlers } from '../src/transport/mcp-handlers.js';

let ctx: AppContext;

beforeEach(() => {
  ctx = createContext({ path: ':memory:' });
});

afterEach(() => {
  ctx.close();
  vi.restoreAllMocks();
});

describe('MCP Handlers', () => {
  describe('registry({ action: "list" })', () => {
    it('should return empty array when no servers', async () => {
      const result = await toolHandlers.registry(ctx, { action: 'list' });
      expect(result).toEqual([]);
    });

    it('should list registered servers', async () => {
      ctx.registry.register({
        name: 'srv1',
        command: 'node',
        description: 'Server 1',
      });
      const result = (await toolHandlers.registry(ctx, { action: 'list' })) as Array<
        Record<string, unknown>
      >;
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('srv1');
    });

    it('should include active status', async () => {
      ctx.registry.register({ name: 'srv1', command: 'node' });
      const result = (await toolHandlers.registry(ctx, { action: 'list' })) as Array<
        Record<string, unknown>
      >;
      expect(result[0].active).toBe(false);
    });
  });

  describe('registry({ action: "install" })', () => {
    it('should install with manual command', async () => {
      const result = (await toolHandlers.registry(ctx, {
        action: 'install',
        name: 'manual-srv',
        command: 'node',
        args: ['index.js'],
      })) as Record<string, unknown>;

      expect(result.status).toBe('installed');
      expect(result.server).toBe('manual-srv');
    });

    it('should reject missing name', async () => {
      await expect(toolHandlers.registry(ctx, { action: 'install' })).rejects.toThrow(
        'name is required',
      );
    });

    it('should reject missing command for manual install', async () => {
      await expect(
        toolHandlers.registry(ctx, { action: 'install', name: 'no-cmd' }),
      ).rejects.toThrow('command is required');
    });

    it('should detect already registered', async () => {
      ctx.registry.register({ name: 'existing', command: 'node' });
      const result = (await toolHandlers.registry(ctx, {
        action: 'install',
        name: 'existing',
        command: 'node',
      })) as Record<string, unknown>;
      expect(result.status).toBe('already_registered');
    });
  });

  describe('registry({ action: "uninstall" })', () => {
    it('should uninstall a server', async () => {
      ctx.registry.register({ name: 'to-remove', command: 'node' });
      const result = (await toolHandlers.registry(ctx, {
        action: 'uninstall',
        name: 'to-remove',
      })) as Record<string, unknown>;
      expect(result.status).toBe('uninstalled');
      expect(ctx.registry.getByName('to-remove')).toBeNull();
    });

    it('should reject missing name', async () => {
      await expect(toolHandlers.registry(ctx, { action: 'uninstall' })).rejects.toThrow(
        'name is required',
      );
    });
  });

  describe('registry({ action: "activate" })', () => {
    it('should reject non-existent server', async () => {
      await expect(
        toolHandlers.registry(ctx, { action: 'activate', name: 'nonexistent' }),
      ).rejects.toThrow('not found');
    });

    it('should reject server without command', async () => {
      ctx.registry.register({ name: 'no-cmd' });
      await expect(
        toolHandlers.registry(ctx, { action: 'activate', name: 'no-cmd' }),
      ).rejects.toThrow('no command');
    });
  });

  describe('registry({ action: "deactivate" })', () => {
    it('should return not_active for inactive server', async () => {
      ctx.registry.register({ name: 'inactive', command: 'node' });
      const result = (await toolHandlers.registry(ctx, {
        action: 'deactivate',
        name: 'inactive',
      })) as Record<string, unknown>;
      expect(result.status).toBe('not_active');
    });
  });

  describe('registry({ action: "browse" })', () => {
    it('should call marketplace browse', async () => {
      vi.spyOn(ctx.marketplace, 'browse').mockResolvedValue({
        servers: [
          {
            name: 'mcp-git',
            description: 'Git tools',
            version: '1.0.0',
            repository: null,
            packages: [],
          },
        ],
        next_cursor: null,
      });

      const result = (await toolHandlers.registry(ctx, {
        action: 'browse',
        query: 'git',
      })) as Record<string, unknown>;
      const servers = result.servers as Array<Record<string, unknown>>;
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('mcp-git');
    });

    it('should pass limit and cursor to marketplace', async () => {
      const spy = vi.spyOn(ctx.marketplace, 'browse').mockResolvedValue({
        servers: [],
        next_cursor: null,
      });

      await toolHandlers.registry(ctx, {
        action: 'browse',
        query: 'test',
        limit: 5,
        cursor: 'abc123',
      });

      expect(spy).toHaveBeenCalledWith('test', 5, 'abc123');
    });

    it('should use default limit when not provided', async () => {
      const spy = vi.spyOn(ctx.marketplace, 'browse').mockResolvedValue({
        servers: [],
        next_cursor: null,
      });

      await toolHandlers.registry(ctx, { action: 'browse' });

      expect(spy).toHaveBeenCalledWith(undefined, 20, undefined);
    });

    it('should propagate marketplace errors', async () => {
      vi.spyOn(ctx.marketplace, 'browse').mockRejectedValue(new Error('Registry API error: 500'));

      await expect(toolHandlers.registry(ctx, { action: 'browse', query: 'test' })).rejects.toThrow(
        'Registry API error: 500',
      );
    });

    it('should include next_cursor in result', async () => {
      vi.spyOn(ctx.marketplace, 'browse').mockResolvedValue({
        servers: [],
        next_cursor: 'page2',
      });

      const result = (await toolHandlers.registry(ctx, { action: 'browse' })) as Record<
        string,
        unknown
      >;
      expect(result.next_cursor).toBe('page2');
    });

    it('should map package data in results', async () => {
      vi.spyOn(ctx.marketplace, 'browse').mockResolvedValue({
        servers: [
          {
            name: 'multi-pkg',
            description: 'desc',
            version: '2.0.0',
            repository: 'https://github.com/test/repo',
            packages: [
              {
                registry_name: 'npm',
                name: 'multi-pkg',
                version: '2.0.0',
                runtime: 'node',
                license: 'MIT',
              },
            ],
          },
        ],
        next_cursor: null,
      });

      const result = (await toolHandlers.registry(ctx, { action: 'browse' })) as Record<
        string,
        unknown
      >;
      const servers = result.servers as Array<Record<string, unknown>>;
      const packages = servers[0].packages as Array<Record<string, unknown>>;
      expect(packages).toHaveLength(1);
      expect(packages[0].runtime).toBe('node');
      expect(packages[0].name).toBe('multi-pkg');
    });
  });

  describe('registry({ action: "activate" }) — error cases', () => {
    it('should reject missing name', async () => {
      await expect(toolHandlers.registry(ctx, { action: 'activate', name: '' })).rejects.toThrow(
        'name is required',
      );
    });

    it('should return already_active for active server', async () => {
      ctx.registry.register({ name: 'active-srv', command: 'node' });
      vi.spyOn(ctx.proxy, 'isActive').mockReturnValue(true);

      const result = (await toolHandlers.registry(ctx, {
        action: 'activate',
        name: 'active-srv',
      })) as Record<string, unknown>;
      expect(result.status).toBe('already_active');
    });
  });

  describe('registry({ action: "deactivate" }) — additional cases', () => {
    it('should reject missing name', async () => {
      await expect(toolHandlers.registry(ctx, { action: 'deactivate', name: '' })).rejects.toThrow(
        'name is required',
      );
    });
  });

  describe('registry({ action: "uninstall" }) — additional cases', () => {
    it('should throw for non-existent server', async () => {
      await expect(
        toolHandlers.registry(ctx, { action: 'uninstall', name: 'nonexistent' }),
      ).rejects.toThrow('not found');
    });
  });

  describe('registry({ action: "install" }) — with source registry (mock)', () => {
    it('should install from marketplace when match found', async () => {
      vi.spyOn(ctx.marketplace, 'browse').mockResolvedValue({
        servers: [
          {
            name: 'mcp-fetch',
            description: 'HTTP fetch',
            version: '1.0.0',
            repository: 'https://github.com/test/fetch',
            packages: [
              {
                registry_name: 'npm',
                name: 'mcp-fetch',
                version: '1.0.0',
                runtime: 'node',
                license: 'MIT',
              },
            ],
          },
        ],
        next_cursor: null,
      });

      const result = (await toolHandlers.registry(ctx, {
        action: 'install',
        name: 'mcp-fetch',
        source: 'registry',
      })) as Record<string, unknown>;
      expect(result.status).toBe('installed');
      expect(result.source).toBe('registry');
    });

    it('should fall through to manual if marketplace fails', async () => {
      vi.spyOn(ctx.marketplace, 'browse').mockRejectedValue(new Error('Network error'));

      const result = (await toolHandlers.registry(ctx, {
        action: 'install',
        name: 'fallback-srv',
        source: 'registry',
        command: 'node',
        args: ['server.js'],
      })) as Record<string, unknown>;
      expect(result.status).toBe('installed');
    });
  });

  describe('registry({ action: "list" }) — with filters', () => {
    it('should pass source filter', async () => {
      ctx.registry.register({ name: 'local-a', command: 'a', source: 'local' });
      ctx.registry.register({ name: 'reg-b', command: 'b', source: 'registry' });

      const result = (await toolHandlers.registry(ctx, {
        action: 'list',
        source: 'registry',
      })) as Array<Record<string, unknown>>;
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('reg-b');
    });

    it('should pass installed_only filter', async () => {
      ctx.registry.register({ name: 'inst-a', command: 'a' });
      ctx.registry.register({ name: 'uninst-b' });

      const result = (await toolHandlers.registry(ctx, {
        action: 'list',
        installed_only: true,
      })) as Array<Record<string, unknown>>;
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('inst-a');
    });

    it('should include tool_count in results', async () => {
      const srv = ctx.registry.register({ name: 'tool-count-srv', command: 'node' });
      ctx.registry.saveTools(srv.id, [
        { name: 'tool1', description: 'T1' },
        { name: 'tool2', description: 'T2' },
      ]);

      const result = (await toolHandlers.registry(ctx, { action: 'list' })) as Array<
        Record<string, unknown>
      >;
      const entry = result.find((s) => s.name === 'tool-count-srv');
      expect(entry!.tool_count).toBe(2);
    });
  });

  describe('registry({ action: "status" })', () => {
    it('should return empty when no active servers', async () => {
      const result = (await toolHandlers.registry(ctx, { action: 'status' })) as Record<
        string,
        unknown
      >;
      expect(result.active_count).toBe(0);
      expect(result.servers).toEqual([]);
    });
  });

  describe('registry — invalid action', () => {
    it('should reject unknown action', async () => {
      await expect(toolHandlers.registry(ctx, { action: 'invalid' })).rejects.toThrow(
        'Unknown registry action',
      );
    });
  });
});
