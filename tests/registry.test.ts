// =============================================================================
// agent-discover — Registry CRUD tests
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createContext, type AppContext } from '../src/context.js';

let ctx: AppContext;

beforeEach(() => {
  ctx = createContext({ path: ':memory:' });
});

afterEach(() => {
  ctx.close();
});

describe('RegistryService', () => {
  describe('register', () => {
    it('should register a new server', () => {
      const server = ctx.registry.register({
        name: 'test-server',
        description: 'A test server',
        command: 'node',
        args: ['server.js'],
        tags: ['test'],
      });

      expect(server.name).toBe('test-server');
      expect(server.description).toBe('A test server');
      expect(server.command).toBe('node');
      expect(server.args).toEqual(['server.js']);
      expect(server.tags).toEqual(['test']);
      expect(server.installed).toBe(true);
      expect(server.active).toBe(false);
    });

    it('should reject duplicate names', () => {
      ctx.registry.register({ name: 'dup', command: 'node' });
      expect(() => ctx.registry.register({ name: 'dup', command: 'node' })).toThrow(
        'already exists',
      );
    });

    it('should reject invalid names', () => {
      expect(() => ctx.registry.register({ name: '', command: 'node' })).toThrow();
      expect(() => ctx.registry.register({ name: 'bad name!', command: 'node' })).toThrow();
      expect(() => ctx.registry.register({ name: 'has__double', command: 'node' })).toThrow('__');
    });
  });

  describe('list', () => {
    it('should list all servers', () => {
      ctx.registry.register({ name: 'srv-a', command: 'a' });
      ctx.registry.register({ name: 'srv-b', command: 'b' });

      const list = ctx.registry.list();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.name)).toContain('srv-a');
      expect(list.map((s) => s.name)).toContain('srv-b');
    });

    it('should filter by source', () => {
      ctx.registry.register({
        name: 'local-srv',
        command: 'a',
        source: 'local',
      });
      ctx.registry.register({
        name: 'registry-srv',
        command: 'b',
        source: 'registry',
      });

      const list = ctx.registry.list({ source: 'registry' });
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('registry-srv');
    });

    it('should filter installed only', () => {
      ctx.registry.register({ name: 'installed', command: 'a' });
      ctx.registry.register({ name: 'not-installed' });

      const list = ctx.registry.list({ installedOnly: true });
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('installed');
    });
  });

  describe('search', () => {
    it('should find servers by name', () => {
      ctx.registry.register({
        name: 'filesystem',
        command: 'fs',
        description: 'File ops',
      });
      ctx.registry.register({
        name: 'github',
        command: 'gh',
        description: 'GitHub API',
      });

      const results = ctx.registry.list({ query: 'file' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe('filesystem');
    });
  });

  describe('unregister', () => {
    it('should remove a server', () => {
      ctx.registry.register({ name: 'to-remove', command: 'x' });
      expect(ctx.registry.getByName('to-remove')).not.toBeNull();

      ctx.registry.unregister('to-remove');
      expect(ctx.registry.getByName('to-remove')).toBeNull();
    });

    it('should throw for non-existent server', () => {
      expect(() => ctx.registry.unregister('nonexistent')).toThrow('not found');
    });
  });

  describe('tools', () => {
    it('should save and retrieve server tools', () => {
      const server = ctx.registry.register({
        name: 'tool-srv',
        command: 'node',
      });
      ctx.registry.saveTools(server.id, [
        {
          name: 'read',
          description: 'Read a file',
          inputSchema: { type: 'object' },
        },
        { name: 'write', description: 'Write a file' },
      ]);

      const tools = ctx.registry.getTools(server.id);
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('read');
      expect(tools[1].name).toBe('write');
    });

    it('should clear tools', () => {
      const server = ctx.registry.register({
        name: 'clear-srv',
        command: 'node',
      });
      ctx.registry.saveTools(server.id, [{ name: 'tool1' }]);
      expect(ctx.registry.getTools(server.id)).toHaveLength(1);

      ctx.registry.clearTools(server.id);
      expect(ctx.registry.getTools(server.id)).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('should update server fields', () => {
      ctx.registry.register({ name: 'updatable', command: 'old' });
      const updated = ctx.registry.update('updatable', {
        description: 'New description',
        command: 'new',
      });

      expect(updated.description).toBe('New description');
      expect(updated.command).toBe('new');
    });

    it('should update args as JSON', () => {
      ctx.registry.register({ name: 'args-upd', command: 'node', args: ['old.js'] });
      const updated = ctx.registry.update('args-upd', { args: ['new.js', '--verbose'] });
      expect(updated.args).toEqual(['new.js', '--verbose']);
    });

    it('should update env as JSON', () => {
      ctx.registry.register({ name: 'env-upd', command: 'node' });
      const updated = ctx.registry.update('env-upd', { env: { PORT: '3000' } });
      expect(updated.env).toEqual({ PORT: '3000' });
    });

    it('should update tags as JSON', () => {
      ctx.registry.register({ name: 'tags-upd', command: 'node' });
      const updated = ctx.registry.update('tags-upd', { tags: ['new-tag'] });
      expect(updated.tags).toEqual(['new-tag']);
    });

    it('should update transport', () => {
      ctx.registry.register({ name: 'trans-upd', command: 'node' });
      const updated = ctx.registry.update('trans-upd', { transport: 'sse' });
      expect(updated.transport).toBe('sse');
    });

    it('should return unchanged server when no updates provided', () => {
      ctx.registry.register({ name: 'noop-upd', command: 'node', description: 'original' });
      const result = ctx.registry.update('noop-upd', {});
      expect(result.description).toBe('original');
    });

    it('should throw for non-existent server', () => {
      expect(() => ctx.registry.update('ghost', { description: 'x' })).toThrow('not found');
    });

    it('should update the updated_at timestamp', () => {
      ctx.registry.register({ name: 'ts-upd', command: 'node' });
      ctx.registry.update('ts-upd', { description: 'changed' });
      const after = ctx.registry.getByName('ts-upd')!.updated_at;
      expect(after).toBeDefined();
      expect(typeof after).toBe('string');
    });
  });

  describe('clearTools', () => {
    it('should clear all tools for a server', () => {
      const server = ctx.registry.register({ name: 'clear-test', command: 'node' });
      ctx.registry.saveTools(server.id, [
        { name: 'tool-a', description: 'A' },
        { name: 'tool-b', description: 'B' },
      ]);
      expect(ctx.registry.getTools(server.id)).toHaveLength(2);

      ctx.registry.clearTools(server.id);
      expect(ctx.registry.getTools(server.id)).toHaveLength(0);
    });

    it('should not affect tools of other servers', () => {
      const srv1 = ctx.registry.register({ name: 'srv1-tools', command: 'a' });
      const srv2 = ctx.registry.register({ name: 'srv2-tools', command: 'b' });
      ctx.registry.saveTools(srv1.id, [{ name: 'tool1' }]);
      ctx.registry.saveTools(srv2.id, [{ name: 'tool2' }]);

      ctx.registry.clearTools(srv1.id);
      expect(ctx.registry.getTools(srv1.id)).toHaveLength(0);
      expect(ctx.registry.getTools(srv2.id)).toHaveLength(1);
    });
  });

  describe('getTools', () => {
    it('should return empty array for server with no tools', () => {
      const server = ctx.registry.register({ name: 'no-tools', command: 'node' });
      expect(ctx.registry.getTools(server.id)).toEqual([]);
    });

    it('should return tools sorted by name', () => {
      const server = ctx.registry.register({ name: 'sorted-tools', command: 'node' });
      ctx.registry.saveTools(server.id, [
        { name: 'zebra', description: 'Z tool' },
        { name: 'alpha', description: 'A tool' },
        { name: 'middle', description: 'M tool' },
      ]);

      const tools = ctx.registry.getTools(server.id);
      expect(tools).toHaveLength(3);
      expect(tools[0].name).toBe('alpha');
      expect(tools[1].name).toBe('middle');
      expect(tools[2].name).toBe('zebra');
    });

    it('should return tools with input_schema', () => {
      const server = ctx.registry.register({ name: 'schema-tools', command: 'node' });
      ctx.registry.saveTools(server.id, [
        {
          name: 'read',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      ]);

      const tools = ctx.registry.getTools(server.id);
      expect(tools[0].input_schema).toEqual({
        type: 'object',
        properties: { path: { type: 'string' } },
      });
    });

    it('should return empty array for non-existent server id', () => {
      expect(ctx.registry.getTools(99999)).toEqual([]);
    });
  });

  describe('FTS search', () => {
    beforeEach(() => {
      ctx.registry.register({
        name: 'filesystem-server',
        command: 'node',
        description: 'Read and write files',
        tags: ['fs', 'io'],
      });
      ctx.registry.register({
        name: 'github-api',
        command: 'node',
        description: 'GitHub integration tools',
        tags: ['git', 'api'],
      });
      ctx.registry.register({
        name: 'database-connector',
        command: 'node',
        description: 'PostgreSQL database operations',
        tags: ['db', 'sql'],
      });
    });

    it('should find by partial name', () => {
      const results = ctx.registry.list({ query: 'file' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe('filesystem-server');
    });

    it('should find by description keyword', () => {
      const results = ctx.registry.list({ query: 'PostgreSQL' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe('database-connector');
    });

    it('should combine search with source filter', () => {
      ctx.registry.register({
        name: 'file-registry',
        command: 'x',
        source: 'registry',
        description: 'Another file tool',
      });

      const results = ctx.registry.list({ query: 'file', source: 'registry' });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('file-registry');
    });

    it('should combine search with installedOnly filter', () => {
      ctx.registry.register({
        name: 'file-noinstall',
        description: 'Uninstalled file tool',
      });

      const results = ctx.registry.list({ query: 'file', installedOnly: true });
      // Only the installed filesystem-server should match
      expect(results.every((s) => s.installed)).toBe(true);
    });
  });

  describe('setActive / setInstalled', () => {
    it('should toggle active flag', () => {
      ctx.registry.register({ name: 'toggle', command: 'x' });

      ctx.registry.setActive('toggle', true);
      expect(ctx.registry.getByName('toggle')!.active).toBe(true);

      ctx.registry.setActive('toggle', false);
      expect(ctx.registry.getByName('toggle')!.active).toBe(false);
    });

    it('should toggle installed flag', () => {
      ctx.registry.register({ name: 'install-toggle', command: 'node' });
      expect(ctx.registry.getByName('install-toggle')!.installed).toBe(true);

      ctx.registry.setInstalled('install-toggle', false);
      expect(ctx.registry.getByName('install-toggle')!.installed).toBe(false);

      ctx.registry.setInstalled('install-toggle', true);
      expect(ctx.registry.getByName('install-toggle')!.installed).toBe(true);
    });
  });

  describe('getById', () => {
    it('should return server by id', () => {
      const created = ctx.registry.register({ name: 'by-id', command: 'node' });
      const found = ctx.registry.getById(created.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('by-id');
    });

    it('should return null for non-existent id', () => {
      expect(ctx.registry.getById(99999)).toBeNull();
    });
  });

  describe('saveTools replaces existing', () => {
    it('should replace all tools on subsequent save', () => {
      const server = ctx.registry.register({ name: 'replace-tools', command: 'node' });

      ctx.registry.saveTools(server.id, [{ name: 'old-tool-1' }, { name: 'old-tool-2' }]);
      expect(ctx.registry.getTools(server.id)).toHaveLength(2);

      ctx.registry.saveTools(server.id, [{ name: 'new-tool-only' }]);
      const tools = ctx.registry.getTools(server.id);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('new-tool-only');
    });
  });
});
