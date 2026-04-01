// =============================================================================
// agent-discover — Installer tests
// =============================================================================

import { describe, it, expect } from 'vitest';
import { InstallerService } from '../src/domain/installer.js';

const installer = new InstallerService();

describe('InstallerService', () => {
  describe('detectInstallConfig — npm packages', () => {
    it('should default to npx for plain package names', () => {
      const config = installer.detectInstallConfig('@modelcontextprotocol/server-filesystem');
      expect(config.command).toBe('npx');
      expect(config.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem']);
      expect(config.transport).toBe('stdio');
      expect(config.package_name).toBe('@modelcontextprotocol/server-filesystem');
      expect(config.env).toEqual({});
    });

    it('should use npx for explicit node runtime', () => {
      const config = installer.detectInstallConfig('mcp-server-fetch', 'node');
      expect(config.command).toBe('npx');
      expect(config.args).toEqual(['-y', 'mcp-server-fetch']);
    });

    it('should handle scoped npm packages', () => {
      const config = installer.detectInstallConfig('@anthropic/mcp-server');
      expect(config.command).toBe('npx');
      expect(config.args).toContain('@anthropic/mcp-server');
    });
  });

  describe('detectInstallConfig — python packages (uvx)', () => {
    it('should use uvx for python runtime', () => {
      const config = installer.detectInstallConfig('mcp-server-git', 'python');
      expect(config.command).toBe('uvx');
      expect(config.args).toEqual(['mcp-server-git']);
      expect(config.transport).toBe('stdio');
    });

    it('should use uvx for uvx- prefixed packages', () => {
      const config = installer.detectInstallConfig('uvx-mcp-server-git');
      expect(config.command).toBe('uvx');
      expect(config.args).toEqual(['mcp-server-git']);
      expect(config.package_name).toBe('mcp-server-git');
    });

    it('should use uvx for pip-containing packages', () => {
      const config = installer.detectInstallConfig('pip-mcp-tools');
      expect(config.command).toBe('uvx');
    });
  });

  describe('detectInstallConfig — docker packages', () => {
    it('should use docker for docker runtime', () => {
      const config = installer.detectInstallConfig('mcp-server-postgres', 'docker');
      expect(config.command).toBe('docker');
      expect(config.args).toEqual(['run', '-i', '--rm', 'mcp-server-postgres']);
      expect(config.transport).toBe('stdio');
    });

    it('should use docker for docker- prefixed packages', () => {
      const config = installer.detectInstallConfig('docker-mcp-postgres');
      expect(config.command).toBe('docker');
      expect(config.args).toEqual(['run', '-i', '--rm', 'mcp-postgres']);
      expect(config.package_name).toBe('mcp-postgres');
    });
  });

  describe('detectInstallConfig — validation', () => {
    it('should reject empty string', () => {
      expect(() => installer.detectInstallConfig('')).toThrow('Invalid package name');
    });

    it('should reject shell injection via semicolon', () => {
      expect(() => installer.detectInstallConfig('; rm -rf /')).toThrow('Invalid package name');
    });

    it('should reject command substitution', () => {
      expect(() => installer.detectInstallConfig('$(cmd)')).toThrow('Invalid package name');
    });

    it('should reject backtick injection', () => {
      expect(() => installer.detectInstallConfig('`whoami`')).toThrow('Invalid package name');
    });

    it('should reject pipe injection', () => {
      expect(() => installer.detectInstallConfig('pkg | cat /etc/passwd')).toThrow(
        'Invalid package name',
      );
    });

    it('should reject ampersand injection', () => {
      expect(() => installer.detectInstallConfig('pkg && rm -rf /')).toThrow(
        'Invalid package name',
      );
    });

    it('should accept valid package names with dots, dashes, underscores', () => {
      expect(() => installer.detectInstallConfig('my.server-v2_beta')).not.toThrow();
    });
  });

  describe('buildServerInput', () => {
    it('should generate correct ServerCreateInput from npm config', () => {
      const config = installer.detectInstallConfig('mcp-git');
      const input = installer.buildServerInput('mcp-git', config, {
        description: 'Git tools for MCP',
        repository: 'https://github.com/test/mcp-git',
        version: '1.2.0',
        tags: ['git', 'vcs'],
      });

      expect(input.name).toBe('mcp-git');
      expect(input.description).toBe('Git tools for MCP');
      expect(input.source).toBe('registry');
      expect(input.command).toBe('npx');
      expect(input.args).toEqual(['-y', 'mcp-git']);
      expect(input.env).toEqual({});
      expect(input.tags).toEqual(['git', 'vcs']);
      expect(input.package_name).toBe('mcp-git');
      expect(input.package_version).toBe('1.2.0');
      expect(input.transport).toBe('stdio');
      expect(input.repository).toBe('https://github.com/test/mcp-git');
    });

    it('should use defaults when metadata is omitted', () => {
      const config = installer.detectInstallConfig('some-server');
      const input = installer.buildServerInput('some-server', config);

      expect(input.description).toBe('');
      expect(input.tags).toEqual([]);
      expect(input.package_version).toBeUndefined();
      expect(input.repository).toBeUndefined();
      expect(input.homepage).toBeUndefined();
    });

    it('should include homepage when provided', () => {
      const config = installer.detectInstallConfig('my-server');
      const input = installer.buildServerInput('my-server', config, {
        homepage: 'https://my-server.dev',
      });

      expect(input.homepage).toBe('https://my-server.dev');
    });
  });
});
