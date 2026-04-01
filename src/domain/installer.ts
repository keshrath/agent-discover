// =============================================================================
// agent-discover — Server installer
//
// Detects and configures MCP server install methods. Supports npm (npx),
// Python (pip/uvx), and Docker-based servers.
// =============================================================================

import type { ServerCreateInput } from '../types.js';
import { ValidationError } from '../types.js';

const SAFE_PACKAGE_NAME = /^[@a-zA-Z0-9._/-]+$/;

export interface InstallConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  package_name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
}

export class InstallerService {
  /**
   * Detect the install method for a package name and return a config
   * that can be used to register the server.
   */
  detectInstallConfig(packageName: string, runtime?: string): InstallConfig {
    if (!packageName || !SAFE_PACKAGE_NAME.test(packageName)) {
      throw new ValidationError(`Invalid package name: "${packageName}"`);
    }
    if (runtime === 'python' || packageName.includes('pip') || packageName.startsWith('uvx-')) {
      return this.pythonConfig(packageName);
    }

    if (runtime === 'docker' || packageName.startsWith('docker-')) {
      return this.dockerConfig(packageName);
    }

    // Default to npm/npx
    return this.npmConfig(packageName);
  }

  /**
   * Build a ServerCreateInput from marketplace data and install config.
   */
  buildServerInput(
    name: string,
    installConfig: InstallConfig,
    metadata?: {
      description?: string;
      repository?: string;
      homepage?: string;
      version?: string;
      tags?: string[];
    },
  ): ServerCreateInput {
    return {
      name,
      description: metadata?.description ?? '',
      source: 'registry',
      command: installConfig.command,
      args: installConfig.args,
      env: installConfig.env,
      tags: metadata?.tags ?? [],
      package_name: installConfig.package_name,
      package_version: metadata?.version,
      transport: installConfig.transport,
      repository: metadata?.repository,
      homepage: metadata?.homepage,
    };
  }

  private npmConfig(packageName: string): InstallConfig {
    return {
      command: 'npx',
      args: ['-y', packageName],
      env: {},
      package_name: packageName,
      transport: 'stdio',
    };
  }

  private pythonConfig(packageName: string): InstallConfig {
    const cleanName = packageName.replace(/^uvx-/, '');
    return {
      command: 'uvx',
      args: [cleanName],
      env: {},
      package_name: cleanName,
      transport: 'stdio',
    };
  }

  private dockerConfig(packageName: string): InstallConfig {
    const cleanName = packageName.replace(/^docker-/, '');
    return {
      command: 'docker',
      args: ['run', '-i', '--rm', cleanName],
      env: {},
      package_name: cleanName,
      transport: 'stdio',
    };
  }
}
