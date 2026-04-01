// =============================================================================
// agent-discover — End-to-end workflow tests
//
// Exercises the full stack: context → registry → proxy → marketplace
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createContext, type AppContext } from '../../src/context.js';

let ctx: AppContext;

beforeEach(() => {
  ctx = createContext({ path: ':memory:' });
});

afterEach(() => {
  ctx.close();
  vi.restoreAllMocks();
});

describe('E2E Workflows', () => {
  describe('register → list → verify', () => {
    it('should show registered server in list', () => {
      ctx.registry.register({
        name: 'e2e-server',
        command: 'node',
        args: ['index.js'],
        description: 'End-to-end test server',
        tags: ['test', 'e2e'],
      });

      const list = ctx.registry.list();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('e2e-server');
      expect(list[0].description).toBe('End-to-end test server');
      expect(list[0].command).toBe('node');
      expect(list[0].args).toEqual(['index.js']);
      expect(list[0].tags).toEqual(['test', 'e2e']);
      expect(list[0].installed).toBe(true);
      expect(list[0].active).toBe(false);
    });
  });

  describe('register → activate → status → deactivate → status', () => {
    it('should track active status through lifecycle', () => {
      const server = ctx.registry.register({
        name: 'lifecycle-srv',
        command: 'node',
        args: ['server.js'],
      });

      // Initially inactive
      expect(ctx.proxy.isActive('lifecycle-srv')).toBe(false);
      expect(ctx.proxy.getActiveServerNames()).toEqual([]);

      // Simulate activation by setting active flag (real activation needs a running process)
      ctx.registry.setActive('lifecycle-srv', true);
      const afterActivate = ctx.registry.getByName('lifecycle-srv');
      expect(afterActivate!.active).toBe(true);

      // Simulate deactivation
      ctx.registry.setActive('lifecycle-srv', false);
      const afterDeactivate = ctx.registry.getByName('lifecycle-srv');
      expect(afterDeactivate!.active).toBe(false);

      // Verify tools can be saved and cleared as part of lifecycle
      ctx.registry.saveTools(server.id, [
        { name: 'read_file', description: 'Read a file' },
        { name: 'write_file', description: 'Write a file' },
      ]);
      expect(ctx.registry.getTools(server.id)).toHaveLength(2);

      ctx.registry.clearTools(server.id);
      expect(ctx.registry.getTools(server.id)).toHaveLength(0);
    });
  });

  describe('register → unregister → list shows empty', () => {
    it('should remove server completely', () => {
      ctx.registry.register({ name: 'temp-srv', command: 'node' });
      expect(ctx.registry.list()).toHaveLength(1);

      ctx.registry.unregister('temp-srv');
      expect(ctx.registry.list()).toHaveLength(0);
      expect(ctx.registry.getByName('temp-srv')).toBeNull();
    });

    it('should also remove associated tools on unregister', () => {
      const server = ctx.registry.register({ name: 'tool-srv', command: 'node' });
      ctx.registry.saveTools(server.id, [
        { name: 'tool1', description: 'desc1' },
        { name: 'tool2', description: 'desc2' },
      ]);
      expect(ctx.registry.getTools(server.id)).toHaveLength(2);

      ctx.registry.unregister('tool-srv');
      // Tools should be cascade-deleted via FK constraint
      expect(ctx.registry.getTools(server.id)).toHaveLength(0);
    });
  });

  describe('register with duplicate name → error', () => {
    it('should reject duplicate registration', () => {
      ctx.registry.register({ name: 'unique-srv', command: 'node' });
      expect(() => ctx.registry.register({ name: 'unique-srv', command: 'python' })).toThrow(
        'already exists',
      );
    });
  });

  describe('FTS5 search', () => {
    it('should find servers by name via FTS', () => {
      ctx.registry.register({
        name: 'filesystem-tools',
        command: 'node',
        description: 'File system operations',
      });
      ctx.registry.register({
        name: 'github-api',
        command: 'node',
        description: 'GitHub integration',
      });
      ctx.registry.register({
        name: 'postgres-connector',
        command: 'node',
        description: 'Database tools',
      });

      const results = ctx.registry.list({ query: 'file' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((s) => s.name === 'filesystem-tools')).toBe(true);
    });

    it('should find servers by description via FTS', () => {
      ctx.registry.register({
        name: 'srv-a',
        command: 'a',
        description: 'Manages kubernetes clusters',
      });
      ctx.registry.register({
        name: 'srv-b',
        command: 'b',
        description: 'Simple calculator',
      });

      const results = ctx.registry.list({ query: 'kubernetes' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe('srv-a');
    });

    it('should return empty for no matches', () => {
      ctx.registry.register({ name: 'srv-x', command: 'x', description: 'test' });

      const results = ctx.registry.list({ query: 'zzzznonexistent' });
      expect(results).toHaveLength(0);
    });
  });

  describe('update server fields → verify changes persisted', () => {
    it('should persist updated description', () => {
      ctx.registry.register({ name: 'update-srv', command: 'old-cmd' });

      ctx.registry.update('update-srv', { description: 'Updated desc' });
      const server = ctx.registry.getByName('update-srv');
      expect(server!.description).toBe('Updated desc');
    });

    it('should persist updated command', () => {
      ctx.registry.register({ name: 'cmd-srv', command: 'old' });

      ctx.registry.update('cmd-srv', { command: 'new-cmd' });
      const server = ctx.registry.getByName('cmd-srv');
      expect(server!.command).toBe('new-cmd');
    });

    it('should persist updated args', () => {
      ctx.registry.register({ name: 'args-srv', command: 'node', args: ['old.js'] });

      ctx.registry.update('args-srv', { args: ['new.js', '--flag'] });
      const server = ctx.registry.getByName('args-srv');
      expect(server!.args).toEqual(['new.js', '--flag']);
    });

    it('should persist updated tags', () => {
      ctx.registry.register({ name: 'tags-srv', command: 'node', tags: ['old'] });

      ctx.registry.update('tags-srv', { tags: ['new', 'updated'] });
      const server = ctx.registry.getByName('tags-srv');
      expect(server!.tags).toEqual(['new', 'updated']);
    });

    it('should persist updated env', () => {
      ctx.registry.register({ name: 'env-srv', command: 'node' });

      ctx.registry.update('env-srv', { env: { API_KEY: 'secret' } });
      const server = ctx.registry.getByName('env-srv');
      expect(server!.env).toEqual({ API_KEY: 'secret' });
    });

    it('should persist updated transport', () => {
      ctx.registry.register({ name: 'transport-srv', command: 'node' });

      ctx.registry.update('transport-srv', { transport: 'sse' });
      const server = ctx.registry.getByName('transport-srv');
      expect(server!.transport).toBe('sse');
    });

    it('should return existing server unchanged when no fields provided', () => {
      ctx.registry.register({ name: 'noop-srv', command: 'node', description: 'original' });

      const result = ctx.registry.update('noop-srv', {});
      expect(result.description).toBe('original');
    });

    it('should throw for non-existent server', () => {
      expect(() => ctx.registry.update('ghost', { description: 'nope' })).toThrow('not found');
    });
  });

  describe('register from marketplace data (manual source)', () => {
    it('should register with full marketplace-like metadata', () => {
      const installConfig = ctx.installer.detectInstallConfig('mcp-server-git');
      const input = ctx.installer.buildServerInput('mcp-server-git', installConfig, {
        description: 'Git operations for MCP',
        repository: 'https://github.com/modelcontextprotocol/servers',
        version: '0.6.0',
        tags: ['git', 'vcs'],
      });

      const server = ctx.registry.register(input);

      expect(server.name).toBe('mcp-server-git');
      expect(server.description).toBe('Git operations for MCP');
      expect(server.source).toBe('registry');
      expect(server.command).toBe('npx');
      expect(server.args).toEqual(['-y', 'mcp-server-git']);
      expect(server.package_name).toBe('mcp-server-git');
      expect(server.package_version).toBe('0.6.0');
      expect(server.repository).toBe('https://github.com/modelcontextprotocol/servers');
      expect(server.tags).toEqual(['git', 'vcs']);
      expect(server.installed).toBe(true);

      // Verify it appears in the list
      const list = ctx.registry.list();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('mcp-server-git');
    });
  });

  describe('multiple servers with filtering', () => {
    beforeEach(() => {
      ctx.registry.register({ name: 'local-a', command: 'a', source: 'local' });
      ctx.registry.register({ name: 'local-b', command: 'b', source: 'local' });
      ctx.registry.register({ name: 'reg-c', command: 'c', source: 'registry' });
      ctx.registry.register({ name: 'no-cmd', source: 'manual' });
    });

    it('should filter by source', () => {
      const local = ctx.registry.list({ source: 'local' });
      expect(local).toHaveLength(2);
      expect(local.every((s) => s.source === 'local')).toBe(true);

      const registry = ctx.registry.list({ source: 'registry' });
      expect(registry).toHaveLength(1);
      expect(registry[0].name).toBe('reg-c');
    });

    it('should filter installed only', () => {
      const installed = ctx.registry.list({ installedOnly: true });
      // Servers with command are installed (3 of 4)
      expect(installed).toHaveLength(3);
      expect(installed.every((s) => s.installed)).toBe(true);
    });

    it('should combine source and installed filters', () => {
      const localInstalled = ctx.registry.list({
        source: 'local',
        installedOnly: true,
      });
      expect(localInstalled).toHaveLength(2);
    });

    it('should list all when no filters', () => {
      const all = ctx.registry.list();
      expect(all).toHaveLength(4);
    });
  });

  describe('events are emitted', () => {
    it('should emit server:registered on register', () => {
      const events: unknown[] = [];
      ctx.events.on('server:registered', (data) => events.push(data));

      ctx.registry.register({ name: 'evt-srv', command: 'node' });
      expect(events).toHaveLength(1);
    });

    it('should emit server:updated on update', () => {
      const events: unknown[] = [];
      ctx.events.on('server:updated', (data) => events.push(data));

      ctx.registry.register({ name: 'evt-upd', command: 'node' });
      ctx.registry.update('evt-upd', { description: 'new' });
      expect(events).toHaveLength(1);
    });

    it('should emit server:unregistered on unregister', () => {
      const events: unknown[] = [];
      ctx.events.on('server:unregistered', (data) => events.push(data));

      ctx.registry.register({ name: 'evt-del', command: 'node' });
      ctx.registry.unregister('evt-del');
      expect(events).toHaveLength(1);
    });
  });

  describe('context close is idempotent', () => {
    it('should not throw when closed twice', () => {
      const tempCtx = createContext({ path: ':memory:' });
      tempCtx.close();
      expect(() => tempCtx.close()).not.toThrow();
    });
  });
});
