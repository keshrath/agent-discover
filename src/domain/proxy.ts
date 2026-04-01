// =============================================================================
// agent-discover — MCP server proxy
//
// Connects to child MCP servers via StdioClientTransport, discovers their
// tools, and proxies tool calls through to them. Tools are namespaced as
// serverName__toolName to avoid collisions.
// =============================================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { SecretsService } from './secrets.js';
import type { MetricsService } from './metrics.js';
import { version } from '../version.js';

const ACTIVATE_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

interface ActiveServer {
  client: Client;
  transport: StdioClientTransport;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  config: ServerConfig;
}

export interface ServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ProxiedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ParsedToolName {
  serverName: string;
  toolName: string;
}

export class McpProxy {
  private readonly activeServers = new Map<string, ActiveServer>();
  private secretsService?: SecretsService;
  private metricsService?: MetricsService;
  private serverIdResolver?: (name: string) => number | null;

  setSecretsService(secrets: SecretsService): void {
    this.secretsService = secrets;
  }

  setMetricsService(metrics: MetricsService): void {
    this.metricsService = metrics;
  }

  setServerIdResolver(resolver: (name: string) => number | null): void {
    this.serverIdResolver = resolver;
  }

  async activate(config: ServerConfig): Promise<
    Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>
  > {
    if (this.activeServers.has(config.name)) {
      throw new Error(`Server "${config.name}" is already active`);
    }

    let mergedEnv = { ...process.env, ...(config.env ?? {}) } as Record<string, string>;

    if (this.secretsService && this.serverIdResolver) {
      const serverId = this.serverIdResolver(config.name);
      if (serverId !== null) {
        const secretsEnv = this.secretsService.getEnvForServer(serverId);
        mergedEnv = { ...mergedEnv, ...secretsEnv };
      }
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: mergedEnv,
    });

    const client = new Client({ name: 'agent-discover', version }, { capabilities: {} });

    try {
      await withTimeout(client.connect(transport), ACTIVATE_TIMEOUT_MS, 'connect');
      const result = await withTimeout(client.listTools(), ACTIVATE_TIMEOUT_MS, 'listTools');
      const tools = result.tools ?? [];

      this.activeServers.set(config.name, { client, transport, tools, config });
      return tools;
    } catch (err) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      throw new Error(
        `Failed to activate "${config.name}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  async deactivate(name: string): Promise<void> {
    const server = this.activeServers.get(name);
    if (!server) throw new Error(`Server "${name}" is not active`);
    try {
      await server.client.close();
    } catch {
      // Process may have already exited
    }
    this.activeServers.delete(name);
  }

  async callTool(
    serverName: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const server = this.activeServers.get(serverName);
    if (!server) throw new Error(`Server "${serverName}" is not active`);

    const start = Date.now();
    let success = true;

    try {
      const result = await withTimeout(
        server.client.callTool({ name: toolName, arguments: args ?? {} }),
        CALL_TIMEOUT_MS,
        `${serverName}/${toolName}`,
      );
      const typed = result as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      if (typed.isError) success = false;
      return typed;
    } catch (err) {
      success = false;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('timed out')) {
        throw new Error(`Tool call ${serverName}/${toolName} timed out`, {
          cause: err,
        });
      }
      throw err;
    } finally {
      const latency = Date.now() - start;
      this.recordMetrics(serverName, toolName, latency, success);
    }
  }

  private recordMetrics(
    serverName: string,
    toolName: string,
    latencyMs: number,
    success: boolean,
  ): void {
    if (!this.metricsService || !this.serverIdResolver) return;
    try {
      const serverId = this.serverIdResolver(serverName);
      if (serverId !== null) {
        this.metricsService.recordCall(serverId, toolName, latencyMs, success);
      }
    } catch {
      /* ignore metrics errors */
    }
  }

  getAllProxiedTools(): ProxiedTool[] {
    const tools: ProxiedTool[] = [];
    for (const [name, server] of this.activeServers) {
      for (const tool of server.tools) {
        tools.push({
          name: `${name}__${tool.name}`,
          description: `[${name}] ${tool.description ?? ''}`,
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        });
      }
    }
    return tools;
  }

  parseToolName(namespacedName: string): ParsedToolName | null {
    let bestMatch: ParsedToolName | null = null;
    for (const serverName of this.activeServers.keys()) {
      const prefix = `${serverName}__`;
      if (namespacedName.startsWith(prefix)) {
        if (!bestMatch || serverName.length > bestMatch.serverName.length) {
          bestMatch = {
            serverName,
            toolName: namespacedName.slice(prefix.length),
          };
        }
      }
    }
    return bestMatch;
  }

  getActiveServerNames(): string[] {
    return [...this.activeServers.keys()];
  }

  getServerTools(name: string): Array<{ name: string; description?: string }> {
    const server = this.activeServers.get(name);
    return server?.tools ?? [];
  }

  isActive(name: string): boolean {
    return this.activeServers.has(name);
  }

  async deactivateAll(): Promise<void> {
    const names = this.getActiveServerNames();
    for (const name of names) {
      try {
        await this.deactivate(name);
      } catch {
        /* ignore */
      }
    }
  }
}
