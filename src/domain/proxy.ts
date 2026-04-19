// =============================================================================
// agent-discover — MCP server proxy
//
// Connects to child MCP servers via StdioClientTransport, discovers their
// tools, and proxies tool calls through to them. Tools are namespaced as
// serverName__toolName to avoid collisions.
// =============================================================================

import { spawnSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ElicitRequestSchema,
  CreateMessageRequestSchema,
  ListRootsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { SecretsService } from './secrets.js';
import type { MetricsService } from './metrics.js';
import type { LogService } from './log.js';
import { version } from '../version.js';

const ACTIVATE_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 60_000;

// Probes whether `cmd` resolves to an executable on PATH. We use `shell: true`
// so Windows .cmd / .bat shims (npx.cmd, uvx.cmd) are honored — same trick the
// /api/prereqs endpoint uses. Sync to keep the error-rewrite branch simple.
function isCommandOnPath(cmd: string): boolean {
  try {
    const result = spawnSync(`${cmd} --version`, { shell: true, stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

type AnyTransport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;

export type ResourceEntry = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  size?: number;
};

export type ResourceTemplateEntry = {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
};

export type PromptEntry = {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

export type ServerInfo = {
  name: string;
  version: string;
  instructions?: string;
  capabilities: Record<string, unknown>;
};

interface ActiveServer {
  client: Client;
  transport: AnyTransport;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  config: ServerConfig;
  capabilities?: Record<string, unknown>;
  serverVersion?: { name: string; version: string };
  instructions?: string;
  transient: boolean;
  interactive: boolean;
  lastPingMs?: number;
}

export interface PendingElicitation {
  id: string;
  serverName: string;
  message: string;
  requestedSchema: Record<string, unknown>;
  createdAt: number;
}

export type ElicitationAction = 'accept' | 'decline' | 'cancel';

export interface SamplingProvider {
  createMessage(request: {
    serverName: string;
    messages: Array<{ role: string; content: { type: string; text?: string } }>;
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
    modelPreferences?: Record<string, unknown>;
  }): Promise<{
    role: 'assistant';
    content: { type: 'text'; text: string };
    model: string;
    stopReason?: string;
  }>;
}

export interface ServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'sse' | 'streamable-http';
  url?: string;
  headers?: Record<string, string>;
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

const TRANSIENT_TTL_MS = 15 * 60_000;
const TRANSIENT_NAME_PREFIX = '__transient__';
const ELICITATION_TIMEOUT_MS = 2 * 60_000;

export interface TransientHandle {
  handle: string;
  serverName: string;
  tools: ActiveServer['tools'];
  capabilities: Record<string, unknown>;
  serverVersion?: { name: string; version: string };
  expiresAt: number;
}

export class McpProxy {
  private readonly activeServers = new Map<string, ActiveServer>();
  // Names currently mid-activation. Held only across the connect/listTools
  // await — prevents two parallel activate(name) calls from both spawning
  // child processes (the original `if (activeServers.has(name))` guard
  // races because both callers pass it before either awaits).
  private readonly activating = new Set<string>();
  private readonly transient = new Map<string, { serverName: string; expiresAt: number }>();
  private transientSeq = 0;
  private secretsService?: SecretsService;
  private metricsService?: MetricsService;
  private logService?: LogService;
  private serverIdResolver?: (name: string) => number | null;
  private rootsProvider: () => Array<{ uri: string; name?: string }> = () => [];
  private samplingProvider?: SamplingProvider;
  private readonly elicitations = new Map<
    string,
    {
      serverName: string;
      resolve: (value: { action: ElicitationAction; content?: Record<string, unknown> }) => void;
      timer: NodeJS.Timeout;
      request: PendingElicitation;
    }
  >();
  private elicitationListener?: (pending: PendingElicitation) => void;
  private elicitationSeq = 0;

  setSecretsService(secrets: SecretsService): void {
    this.secretsService = secrets;
  }

  setMetricsService(metrics: MetricsService): void {
    this.metricsService = metrics;
  }

  setLogService(logs: LogService): void {
    this.logService = logs;
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
    return this.activateInternal(config, false, false);
  }

  private async activateInternal(
    config: ServerConfig,
    transient: boolean,
    interactive: boolean,
  ): Promise<ActiveServer['tools']> {
    if (this.activeServers.has(config.name) || this.activating.has(config.name)) {
      throw new Error(`Server "${config.name}" is already active`);
    }
    // Reserve the name synchronously before any await so a parallel
    // activate(name) call can't slip past the guard above.
    this.activating.add(config.name);
    try {
      const transport = this.createTransport(config);
      const advertisedCapabilities: Record<string, unknown> = {
        roots: { listChanged: true },
        elicitation: {},
      };
      if (interactive) {
        advertisedCapabilities.sampling = {};
      }
      const client = new Client(
        { name: 'agent-discover', version },
        { capabilities: advertisedCapabilities },
      );
      this.wireRootsHandler(client);
      this.wireNotificationHandler(client, config.name);
      if (interactive) {
        this.wireElicitationHandler(client, config.name);
        this.wireSamplingHandler(client, config.name);
      }

      try {
        await withTimeout(client.connect(transport), ACTIVATE_TIMEOUT_MS, 'connect');
        const capabilities =
          typeof client.getServerCapabilities === 'function'
            ? client.getServerCapabilities()
            : undefined;
        const serverVersion =
          typeof client.getServerVersion === 'function' ? client.getServerVersion() : undefined;
        const instructions =
          typeof client.getInstructions === 'function' ? client.getInstructions() : undefined;
        const result = await withTimeout(client.listTools(), ACTIVATE_TIMEOUT_MS, 'listTools');
        const tools = result.tools ?? [];

        this.activeServers.set(config.name, {
          client,
          transport,
          tools,
          config,
          capabilities: capabilities as Record<string, unknown> | undefined,
          serverVersion: serverVersion
            ? { name: serverVersion.name, version: serverVersion.version }
            : undefined,
          instructions,
          transient,
          interactive,
        });
        return tools;
      } catch (err) {
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        // The MCP SDK reports both "command not on PATH" and "child crashed
        // before handshake" as the same opaque "MCP error -32000: Connection
        // closed". Rewrite into something the user can act on. We only add
        // the install-hint suffix if the command is *actually* missing from
        // PATH (probed sync via spawnSync) — otherwise the hint would be
        // misleading when the real issue is e.g. a non-existent package.
        const raw = err instanceof Error ? err.message : String(err);
        let friendly = raw;
        const cmd = config.command;
        const looksLikeChildExit =
          raw.includes('Connection closed') ||
          raw.includes('ENOENT') ||
          raw.includes('spawn') ||
          raw.includes('not found');
        if (cmd && looksLikeChildExit) {
          const onPath = isCommandOnPath(cmd);
          if (!onPath) {
            const hint =
              cmd === 'uvx' || cmd === 'uv'
                ? ' — install uv from https://docs.astral.sh/uv/getting-started/installation/'
                : cmd === 'npx'
                  ? ' — install Node.js from https://nodejs.org'
                  : cmd === 'docker'
                    ? ' — install Docker Desktop from https://docker.com'
                    : '';
            friendly = `command "${cmd}" not found on PATH${hint}. Original: ${raw}`;
          } else {
            friendly = `child process for "${cmd} ${(config.args ?? []).join(' ')}" exited before the MCP handshake completed — verify the package/args are correct and the server actually starts. Original: ${raw}`;
          }
        }
        throw new Error(`Failed to activate "${config.name}": ${friendly}`, { cause: err });
      }
    } finally {
      this.activating.delete(config.name);
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

    const logs = this.logService;
    const onprogress = (notification: {
      progress: number;
      total?: number;
      message?: string;
      progressToken?: string | number;
    }): void => {
      try {
        logs?.pushProgress(
          serverName,
          notification.progressToken ?? toolName,
          notification.progress ?? 0,
          notification.total,
          notification.message,
        );
      } catch {
        /* ignore */
      }
    };

    try {
      const result = await withTimeout(
        server.client.callTool({ name: toolName, arguments: args ?? {} }, undefined, {
          onprogress,
        }),
        CALL_TIMEOUT_MS,
        `${serverName}/${toolName}`,
      );
      const typed = result as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      const latency = Date.now() - start;
      const success = !typed.isError;
      const text = (typed.content || []).map((c) => c.text).join('\n');
      this.recordMetrics(serverName, toolName, latency, success);
      this.recordLog(serverName, toolName, args ?? {}, text, latency, success);
      return typed;
    } catch (err) {
      const latency = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      this.recordMetrics(serverName, toolName, latency, false);
      this.recordLog(serverName, toolName, args ?? {}, message, latency, false);
      if (message.includes('timed out')) {
        throw new Error(`Tool call ${serverName}/${toolName} timed out`, {
          cause: err,
        });
      }
      throw err;
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

  private recordLog(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    response: string,
    latencyMs: number,
    success: boolean,
  ): void {
    if (!this.logService) return;
    try {
      this.logService.push(serverName, toolName, args, response, latencyMs, success);
    } catch {
      /* ignore */
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

  // ---------------------------------------------------------------------------
  // Tester surface — server info, resources, prompts, ping, logging level
  // ---------------------------------------------------------------------------

  getServerInfo(name: string): ServerInfo | null {
    const server = this.activeServers.get(name);
    if (!server) return null;
    return {
      name: server.serverVersion?.name ?? server.config.name,
      version: server.serverVersion?.version ?? '',
      instructions: server.instructions,
      capabilities: server.capabilities ?? {},
    };
  }

  async listToolsLive(name: string): Promise<ActiveServer['tools']> {
    const server = this.requireActive(name);
    const result = await withTimeout(server.client.listTools(), CALL_TIMEOUT_MS, 'listTools');
    const tools = result.tools ?? [];
    server.tools = tools;
    return tools;
  }

  async listResources(
    name: string,
    cursor?: string,
  ): Promise<{ resources: ResourceEntry[]; nextCursor?: string }> {
    const server = this.requireActive(name);
    const params = cursor ? { cursor } : undefined;
    const result = await withTimeout(
      server.client.listResources(params),
      CALL_TIMEOUT_MS,
      'listResources',
    );
    return {
      resources: (result.resources ?? []).map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
        size: r.size,
      })),
      nextCursor: result.nextCursor,
    };
  }

  async listResourceTemplates(
    name: string,
    cursor?: string,
  ): Promise<{ resourceTemplates: ResourceTemplateEntry[]; nextCursor?: string }> {
    const server = this.requireActive(name);
    const params = cursor ? { cursor } : undefined;
    const result = await withTimeout(
      server.client.listResourceTemplates(params),
      CALL_TIMEOUT_MS,
      'listResourceTemplates',
    );
    return {
      resourceTemplates: (result.resourceTemplates ?? []).map((t) => ({
        uriTemplate: t.uriTemplate,
        name: t.name,
        description: t.description,
        mimeType: t.mimeType,
      })),
      nextCursor: result.nextCursor,
    };
  }

  async readResource(
    name: string,
    uri: string,
  ): Promise<{ contents: Array<Record<string, unknown>> }> {
    const server = this.requireActive(name);
    const start = Date.now();
    try {
      const result = await withTimeout(
        server.client.readResource({ uri }),
        CALL_TIMEOUT_MS,
        `${name}/readResource`,
      );
      const latency = Date.now() - start;
      this.logService?.push(
        name,
        uri,
        { uri },
        JSON.stringify(result.contents),
        latency,
        true,
        'resource-read',
      );
      return { contents: result.contents as Array<Record<string, unknown>> };
    } catch (err) {
      const latency = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      this.logService?.push(name, uri, { uri }, msg, latency, false, 'resource-read');
      throw err;
    }
  }

  async subscribeResource(name: string, uri: string): Promise<void> {
    const server = this.requireActive(name);
    await withTimeout(server.client.subscribeResource({ uri }), CALL_TIMEOUT_MS, 'subscribe');
  }

  async unsubscribeResource(name: string, uri: string): Promise<void> {
    const server = this.requireActive(name);
    await withTimeout(server.client.unsubscribeResource({ uri }), CALL_TIMEOUT_MS, 'unsubscribe');
  }

  async listPrompts(
    name: string,
    cursor?: string,
  ): Promise<{ prompts: PromptEntry[]; nextCursor?: string }> {
    const server = this.requireActive(name);
    const params = cursor ? { cursor } : undefined;
    const result = await withTimeout(
      server.client.listPrompts(params),
      CALL_TIMEOUT_MS,
      'listPrompts',
    );
    return {
      prompts: (result.prompts ?? []).map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      })),
      nextCursor: result.nextCursor,
    };
  }

  async getPrompt(
    name: string,
    promptName: string,
    args?: Record<string, string>,
  ): Promise<{ messages: Array<Record<string, unknown>>; description?: string }> {
    const server = this.requireActive(name);
    const start = Date.now();
    try {
      const result = await withTimeout(
        server.client.getPrompt({ name: promptName, arguments: args ?? {} }),
        CALL_TIMEOUT_MS,
        `${name}/getPrompt/${promptName}`,
      );
      const latency = Date.now() - start;
      this.logService?.push(
        name,
        promptName,
        (args ?? {}) as Record<string, unknown>,
        JSON.stringify(result.messages),
        latency,
        true,
        'prompt-get',
      );
      return {
        messages: result.messages as Array<Record<string, unknown>>,
        description: result.description,
      };
    } catch (err) {
      const latency = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      this.logService?.push(
        name,
        promptName,
        (args ?? {}) as Record<string, unknown>,
        msg,
        latency,
        false,
        'prompt-get',
      );
      throw err;
    }
  }

  async ping(name: string): Promise<{ ok: boolean; rtt_ms: number }> {
    const server = this.requireActive(name);
    const start = Date.now();
    try {
      await withTimeout(server.client.ping(), CALL_TIMEOUT_MS, 'ping');
      const rtt = Date.now() - start;
      server.lastPingMs = rtt;
      this.logService?.push(name, 'ping', {}, 'pong', rtt, true, 'ping');
      return { ok: true, rtt_ms: rtt };
    } catch (err) {
      const rtt = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      this.logService?.push(name, 'ping', {}, msg, rtt, false, 'ping');
      throw err;
    }
  }

  async setLoggingLevel(
    name: string,
    level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency',
  ): Promise<void> {
    const server = this.requireActive(name);
    await withTimeout(server.client.setLoggingLevel(level), CALL_TIMEOUT_MS, 'setLoggingLevel');
  }

  exportConfig(name: string, format: 'mcp-json' | 'agent-discover'): Record<string, unknown> {
    const server = this.activeServers.get(name);
    if (!server) throw new Error(`Server "${name}" is not active`);
    const cfg = server.config;
    const entry: Record<string, unknown> = {};
    if (cfg.transport === 'sse' || cfg.transport === 'streamable-http') {
      entry.type = cfg.transport === 'sse' ? 'sse' : 'http';
      if (cfg.url) entry.url = cfg.url;
      if (cfg.headers && Object.keys(cfg.headers).length > 0) entry.headers = cfg.headers;
    } else {
      if (cfg.command) entry.command = cfg.command;
      if (cfg.args && cfg.args.length > 0) entry.args = cfg.args;
      if (cfg.env && Object.keys(cfg.env).length > 0) entry.env = cfg.env;
    }
    if (format === 'agent-discover') {
      return { servers: [{ name: cfg.name, ...entry, auto_activate: true }] };
    }
    return { mcpServers: { [cfg.name]: entry } };
  }

  // ---------------------------------------------------------------------------
  // Transient (ad-hoc) servers
  // ---------------------------------------------------------------------------

  async activateTransient(
    config: ServerConfig,
    ttlMs: number = TRANSIENT_TTL_MS,
  ): Promise<TransientHandle> {
    this.pruneTransient();
    const handle = `${Date.now().toString(36)}-${(++this.transientSeq).toString(36)}`;
    const serverName = `${TRANSIENT_NAME_PREFIX}${handle}`;
    const merged: ServerConfig = { ...config, name: serverName };
    const tools = await this.activateInternal(merged, true, true);
    const expiresAt = Date.now() + ttlMs;
    this.transient.set(handle, { serverName, expiresAt });
    const active = this.activeServers.get(serverName)!;
    setTimeout(() => {
      this.releaseTransient(handle).catch(() => {});
    }, ttlMs).unref?.();
    return {
      handle,
      serverName,
      tools,
      capabilities: active.capabilities ?? {},
      serverVersion: active.serverVersion,
      expiresAt,
    };
  }

  async releaseTransient(handle: string): Promise<void> {
    const entry = this.transient.get(handle);
    if (!entry) return;
    this.transient.delete(handle);
    if (this.activeServers.has(entry.serverName)) {
      try {
        await this.deactivate(entry.serverName);
      } catch {
        /* ignore */
      }
    }
  }

  resolveTransient(handle: string): string | null {
    const entry = this.transient.get(handle);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.releaseTransient(handle).catch(() => {});
      return null;
    }
    return entry.serverName;
  }

  private pruneTransient(): void {
    const now = Date.now();
    for (const [handle, entry] of this.transient.entries()) {
      if (entry.expiresAt < now) {
        this.releaseTransient(handle).catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Roots provider (advertises client roots capability)
  // ---------------------------------------------------------------------------

  setRootsProvider(provider: () => Array<{ uri: string; name?: string }>): void {
    this.rootsProvider = provider;
  }

  private wireRootsHandler(client: Client): void {
    try {
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: this.rootsProvider(),
      }));
    } catch {
      /* roots handler is best-effort; failures don't block activation */
    }
  }

  private wireNotificationHandler(client: Client, serverName: string): void {
    const anyClient = client as unknown as {
      fallbackNotificationHandler?: (n: {
        method: string;
        params?: Record<string, unknown>;
      }) => Promise<void>;
    };
    const logs = this.logService;
    anyClient.fallbackNotificationHandler = async (n) => {
      try {
        if (!logs) return;
        if (n.method === 'notifications/progress' && n.params) {
          const p = n.params as {
            progressToken?: string | number;
            progress?: number;
            total?: number;
            message?: string;
          };
          logs.pushProgress(serverName, p.progressToken ?? 0, p.progress ?? 0, p.total, p.message);
        } else {
          logs.pushNotification(serverName, n.method, (n.params ?? {}) as Record<string, unknown>);
        }
      } catch {
        /* ignore */
      }
    };
  }

  private requireActive(name: string): ActiveServer {
    const server = this.activeServers.get(name);
    if (!server) throw new Error(`Server "${name}" is not active`);
    return server;
  }

  // ---------------------------------------------------------------------------
  // Elicitation — only wired on interactive (transient) clients
  // ---------------------------------------------------------------------------

  setElicitationListener(listener: (pending: PendingElicitation) => void): void {
    this.elicitationListener = listener;
  }

  listPendingElicitations(): PendingElicitation[] {
    return [...this.elicitations.values()].map((e) => e.request);
  }

  respondElicitation(
    id: string,
    response: { action: ElicitationAction; content?: Record<string, unknown> },
  ): boolean {
    const entry = this.elicitations.get(id);
    if (!entry) return false;
    this.elicitations.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(response);
    return true;
  }

  private wireElicitationHandler(client: Client, serverName: string): void {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const params = req.params as {
        message?: string;
        requestedSchema?: Record<string, unknown>;
      };
      const id = `elicit-${Date.now().toString(36)}-${(++this.elicitationSeq).toString(36)}`;
      const pending: PendingElicitation = {
        id,
        serverName,
        message: params.message ?? '',
        requestedSchema: params.requestedSchema ?? { type: 'object', properties: {} },
        createdAt: Date.now(),
      };
      this.logService?.push(
        serverName,
        'elicitation/create',
        pending.requestedSchema,
        pending.message,
        0,
        true,
        'elicitation',
      );
      return new Promise<{ action: ElicitationAction; content?: Record<string, unknown> }>(
        (resolve) => {
          const timer = setTimeout(() => {
            if (this.elicitations.has(id)) {
              this.elicitations.delete(id);
              resolve({ action: 'cancel' });
            }
          }, ELICITATION_TIMEOUT_MS);
          this.elicitations.set(id, { serverName, resolve, timer, request: pending });
          try {
            this.elicitationListener?.(pending);
          } catch {
            /* ignore listener errors */
          }
        },
      ).then((response) => {
        return response.action === 'accept' && response.content
          ? { action: 'accept', content: response.content }
          : { action: response.action };
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Sampling — only wired on interactive (transient) clients
  // ---------------------------------------------------------------------------

  setSamplingProvider(provider: SamplingProvider): void {
    this.samplingProvider = provider;
  }

  private wireSamplingHandler(client: Client, serverName: string): void {
    client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
      const params = req.params as {
        messages: Array<{ role: string; content: { type: string; text?: string } }>;
        maxTokens?: number;
        temperature?: number;
        systemPrompt?: string;
        modelPreferences?: Record<string, unknown>;
      };
      const start = Date.now();
      if (!this.samplingProvider) {
        const message =
          'sampling/createMessage: no sampling provider configured (set AGENT_DISCOVER_OPENAI_API_KEY or OPENAI_API_KEY to enable)';
        this.logService?.push(
          serverName,
          'sampling/createMessage',
          params as unknown as Record<string, unknown>,
          message,
          0,
          false,
          'sampling',
        );
        throw new Error(message);
      }
      try {
        const result = await this.samplingProvider.createMessage({
          serverName,
          messages: params.messages,
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          systemPrompt: params.systemPrompt,
          modelPreferences: params.modelPreferences,
        });
        const latency = Date.now() - start;
        this.logService?.push(
          serverName,
          'sampling/createMessage',
          params as unknown as Record<string, unknown>,
          result.content.text,
          latency,
          true,
          'sampling',
        );
        return result;
      } catch (err) {
        const latency = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        this.logService?.push(
          serverName,
          'sampling/createMessage',
          params as unknown as Record<string, unknown>,
          msg,
          latency,
          false,
          'sampling',
        );
        throw err;
      }
    });
  }

  private createTransport(config: ServerConfig): AnyTransport {
    const transportType = config.transport ?? 'stdio';

    if ((transportType === 'streamable-http' || transportType === 'sse') && config.url) {
      // Build headers from config + secrets (secrets used as HTTP headers for remote servers).
      // Reject any value containing CR/LF to prevent HTTP header injection.
      const safeHeader = (v: string): boolean => !/[\r\n]/.test(v);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(config.headers ?? {})) {
        if (safeHeader(v)) headers[k] = v;
      }
      if (this.secretsService && this.serverIdResolver) {
        const serverId = this.serverIdResolver(config.name);
        if (serverId !== null) {
          const secretsEnv = this.secretsService.getEnvForServer(serverId);
          if (secretsEnv.AUTHORIZATION && safeHeader(secretsEnv.AUTHORIZATION)) {
            headers['Authorization'] = secretsEnv.AUTHORIZATION;
          }
          if (secretsEnv.API_KEY && safeHeader(secretsEnv.API_KEY)) {
            headers['Authorization'] = 'Bearer ' + secretsEnv.API_KEY;
          }
          Object.entries(secretsEnv).forEach(([k, v]) => {
            if (!headers[k] && k !== 'AUTHORIZATION' && k !== 'API_KEY' && safeHeader(v)) {
              headers[k] = v;
            }
          });
        }
      }

      const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;

      if (transportType === 'streamable-http') {
        return new StreamableHTTPClientTransport(new URL(config.url), { requestInit });
      }
      return new SSEClientTransport(new URL(config.url), { requestInit });
    }

    // Default: stdio
    if (!config.command) {
      throw new Error(`Server "${config.name}" has no command configured for stdio transport`);
    }

    let mergedEnv = { ...process.env, ...(config.env ?? {}) } as Record<string, string>;

    if (this.secretsService && this.serverIdResolver) {
      const serverId = this.serverIdResolver(config.name);
      if (serverId !== null) {
        const secretsEnv = this.secretsService.getEnvForServer(serverId);
        mergedEnv = { ...mergedEnv, ...secretsEnv };
      }
    }

    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: mergedEnv,
    });
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
