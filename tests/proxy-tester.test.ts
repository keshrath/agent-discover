// =============================================================================
// agent-discover — Proxy tester surface
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { McpProxy } from '../src/domain/proxy.js';
import { LogService } from '../src/domain/log.js';

let proxy: McpProxy;
let logs: LogService;

beforeEach(() => {
  proxy = new McpProxy();
  logs = new LogService();
  proxy.setLogService(logs);
});

describe('McpProxy tester surface', () => {
  describe('getServerInfo', () => {
    it('returns null for inactive servers', () => {
      expect(proxy.getServerInfo('nope')).toBeNull();
    });
  });

  describe('listResources / readResource / prompts', () => {
    it('throws when server not active', async () => {
      await expect(proxy.listResources('nope')).rejects.toThrow('not active');
      await expect(proxy.readResource('nope', 'file:///x')).rejects.toThrow('not active');
      await expect(proxy.listPrompts('nope')).rejects.toThrow('not active');
      await expect(proxy.getPrompt('nope', 'p')).rejects.toThrow('not active');
    });
  });

  describe('ping', () => {
    it('throws when server not active', async () => {
      await expect(proxy.ping('nope')).rejects.toThrow('not active');
    });
  });

  describe('setLoggingLevel', () => {
    it('throws when server not active', async () => {
      await expect(proxy.setLoggingLevel('nope', 'info')).rejects.toThrow('not active');
    });
  });

  describe('exportConfig', () => {
    it('throws for unknown server', () => {
      expect(() => proxy.exportConfig('nope', 'mcp-json')).toThrow('not active');
    });
  });

  describe('transient handles', () => {
    it('resolveTransient returns null for unknown handle', () => {
      expect(proxy.resolveTransient('bogus')).toBeNull();
    });

    it('releaseTransient is a no-op for unknown handle', async () => {
      await expect(proxy.releaseTransient('bogus')).resolves.toBeUndefined();
    });
  });

  describe('roots provider', () => {
    it('accepts and defaults to empty', () => {
      proxy.setRootsProvider(() => [{ uri: 'file:///tmp', name: 'tmp' }]);
      expect(() => proxy.setRootsProvider(() => [])).not.toThrow();
    });
  });
});
