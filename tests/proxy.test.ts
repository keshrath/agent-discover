// =============================================================================
// agent-discover — Proxy tests
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { McpProxy } from '../src/domain/proxy.js';

let proxy: McpProxy;

beforeEach(() => {
  proxy = new McpProxy();
});

describe('McpProxy', () => {
  describe('parseToolName', () => {
    it('should return null for unknown tools', () => {
      expect(proxy.parseToolName('unknown__tool')).toBeNull();
    });
  });

  describe('isActive', () => {
    it('should return false for inactive servers', () => {
      expect(proxy.isActive('nonexistent')).toBe(false);
    });
  });

  describe('getActiveServerNames', () => {
    it('should return empty array initially', () => {
      expect(proxy.getActiveServerNames()).toEqual([]);
    });
  });

  describe('getAllProxiedTools', () => {
    it('should return empty array when no servers active', () => {
      expect(proxy.getAllProxiedTools()).toEqual([]);
    });
  });

  describe('getServerTools', () => {
    it('should return empty array for inactive server', () => {
      expect(proxy.getServerTools('nonexistent')).toEqual([]);
    });
  });

  describe('deactivate', () => {
    it('should throw for non-active server', async () => {
      await expect(proxy.deactivate('nonexistent')).rejects.toThrow('not active');
    });
  });

  describe('callTool', () => {
    it('should throw for non-active server', async () => {
      await expect(proxy.callTool('nonexistent', 'tool', {})).rejects.toThrow('not active');
    });
  });

  describe('deactivateAll', () => {
    it('should not throw when no servers active', async () => {
      await expect(proxy.deactivateAll()).resolves.toBeUndefined();
    });
  });
});
