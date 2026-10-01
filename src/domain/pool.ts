// =============================================================================
// agent-discover — Upstream connection pool
//
// One SDK v2 Client per upstream server, opened lazily and shared by every
// caller in the daemon (MCP, REST, tester). Responsibilities:
//   - connect with `versionNegotiation: 'auto'`, reusing the cached era
//     verdict as `prior` so npx-launched servers are not spawned twice;
//   - drop a connection the moment its transport closes (child crash) and
//     reconnect on the next use, with exponential backoff after failures;
//   - close connections idle longer than `idleMs`;
//   - forward tools/call verbatim (CallToolResult or MRTR input_required),
//     with SDK timeouts/abort instead of hand-rolled races;
//   - real health probes (`ping` on 2025 connections, `server/discover` on
//     2026 ones);
//   - the dashboard-side elicitation queue, roots and sampling handlers.
// =============================================================================

import { spawn } from 'node:child_process';
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  withInputRequired,
  type CallToolResult,
  type InputRequiredResult,
  type InputResponses,
  type PriorDiscovery,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import type { ServerConfig } from '../types.js';
import { RegistryError, UpstreamError } from '../types.js';
import type { LogService } from './log.js';
import type { SamplingProvider } from './sampling.js';
import { version } from '../version.js';

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 5_000;
const LEGACY_VERDICT_TTL_MS = 7 * 86_400_000;
const MAX_BACKOFF_MS = 60_000;
const ELICITATION_TIMEOUT_MS = 2 * 60_000;
const TRANSIENT_TTL_MS = 15 * 60_000;
const TRANSIENT_PREFIX = '__transient__';

export type EraVerdict = { era: 'modern' | 'legacy'; discover: unknown; checked_at: string };

export interface PoolDeps {
  /** Resolve a registered server name to its config (toConfig). Throws when unknown. */
  resolveConfig(name: string): ServerConfig;
  getEraVerdict(name: string): EraVerdict | null;
  setEraVerdict(name: string, era: 'modern' | 'legacy' | null, discover?: unknown): void;
  /** Upstream announced tools/list_changed. */
  onToolsChanged(name: string): void;
  /** A connection opened or closed (dashboard refresh). */
  onConnectionChange(): void;
  recordCall(server: string, tool: string, latencyMs: number, success: boolean): void;
  logs: LogService;
  roots: () => Array<{ uri: string; name?: string }>;
  sampling?: SamplingProvider;
  idleMs: number;
}

interface Connection {
  client: Client;
  config: ServerConfig;
  lastUsed: number;
  inflight: number;
}

export interface PendingElicitation {
  id: string;
  serverName: string;
  message: string;
  requestedSchema: Record<string, unknown>;
  createdAt: number;
}

export type ElicitationAction = 'accept' | 'decline' | 'cancel';
export type ElicitationContent = Record<string, string | number | boolean | string[]>;

export interface CallOptions {
  signal?: AbortSignal;
  onprogress?: (p: { progress: number; total?: number; message?: string }) => void;
  inputResponses?: InputResponses;
  requestState?: string;
}

export interface HealthResult {
  status: 'healthy' | 'unhealthy';
  latency_ms: number;
  error?: string;
}

export interface TransientHandle {
  handle: string;
  serverName: string;
  tools: Tool[];
  capabilities: Record<string, unknown>;
  serverVersion?: { name: string; version: string };
  expiresAt: number;
}

/** Probes whether `cmd` resolves on PATH (shell so Windows .cmd shims count). Never blocks the loop. */
export function isCommandOnPath(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(`${cmd} --version`, { shell: true, stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, 5_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

const INSTALL_HINTS: Record<string, string> = {
  uvx: ' — install uv from https://docs.astral.sh/uv/getting-started/installation/',
  uv: ' — install uv from https://docs.astral.sh/uv/getting-started/installation/',
  npx: ' — install Node.js from https://nodejs.org',
  docker: ' — install Docker Desktop from https://docker.com',
};

export class ConnectionPool {
  private readonly conns = new Map<string, Connection>();
  private readonly pending = new Map<string, Promise<Connection>>();
  private readonly failures = new Map<string, { count: number; retryAt: number }>();
  private readonly transient = new Map<string, { config: ServerConfig; expiresAt: number }>();
  private readonly elicitations = new Map<
    string,
    {
      resolve: (v: { action: ElicitationAction; content?: ElicitationContent }) => void;
      timer: NodeJS.Timeout;
      request: PendingElicitation;
    }
  >();
  private seq = 0;
  private readonly sweeper: NodeJS.Timeout;
  elicitationListener?: (pending: PendingElicitation) => void;

  constructor(private readonly deps: PoolDeps) {
    this.sweeper = setInterval(() => this.sweepIdle(), Math.min(60_000, deps.idleMs || 60_000));
    this.sweeper.unref();
  }

  isConnected(name: string): boolean {
    return this.conns.has(name);
  }

  connectedNames(): string[] {
    return [...this.conns.keys()].filter((n) => !n.startsWith(TRANSIENT_PREFIX)).sort();
  }

  /** Open (or reuse) the connection for `name`. */
  async connect(name: string): Promise<Client> {
    const existing = this.conns.get(name);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing.client;
    }
    let pending = this.pending.get(name);
    if (!pending) {
      pending = this.open(name).finally(() => this.pending.delete(name));
      this.pending.set(name, pending);
    }
    return (await pending).client;
  }

  /** Run `fn` against a connection; closes it afterwards when this call opened it. */
  async probe<T>(name: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const wasConnected = this.conns.has(name);
    const client = await this.connect(name);
    try {
      return await fn(client);
    } finally {
      if (!wasConnected) await this.disconnect(name);
    }
  }

  async disconnect(name: string): Promise<void> {
    const conn = this.conns.get(name);
    if (!conn) return;
    this.conns.delete(name);
    try {
      await conn.client.close();
    } catch {
      /* already gone */
    }
    this.deps.onConnectionChange();
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.conns.keys()].map((n) => this.disconnect(n)));
  }

  private async open(name: string): Promise<Connection> {
    const failure = this.failures.get(name);
    if (failure && Date.now() < failure.retryAt) {
      throw new UpstreamError(
        `"${name}" failed to connect ${failure.count}x; retrying in ${Math.ceil((failure.retryAt - Date.now()) / 1000)}s`,
      );
    }
    const config = this.transient.get(name)?.config ?? this.deps.resolveConfig(name);
    const prior = this.priorFor(name);
    let client: Client;
    try {
      client = await this.handshake(config, prior);
    } catch (err) {
      if (!prior) throw await this.recordFailure(name, config, err);
      // A stale cached verdict must never wedge a server: retry once negotiating fresh.
      this.deps.setEraVerdict(name, null);
      try {
        client = await this.handshake(config, undefined);
      } catch (retryErr) {
        throw await this.recordFailure(name, config, retryErr);
      }
    }
    this.failures.delete(name);

    const era = client.getProtocolEra();
    if (era === 'modern') this.deps.setEraVerdict(name, 'modern', client.getDiscoverResult());
    else if (!prior) this.deps.setEraVerdict(name, 'legacy');
    if (era === 'modern' && prior && client.getServerCapabilities()?.tools?.listChanged) {
      // Connects that adopt a prior verdict are request-only until listen() is called.
      client.listen({ toolsListChanged: true }).catch(() => {});
    }

    const conn: Connection = { client, config, lastUsed: Date.now(), inflight: 0 };
    client.onclose = () => {
      if (this.conns.get(name)?.client !== client) return;
      this.conns.delete(name);
      this.deps.onConnectionChange();
    };
    this.conns.set(name, conn);
    this.deps.onConnectionChange();
    return conn;
  }

  private priorFor(name: string): PriorDiscovery | undefined {
    if (name.startsWith(TRANSIENT_PREFIX)) return undefined;
    const verdict = this.deps.getEraVerdict(name);
    if (!verdict) return undefined;
    if (verdict.era === 'modern' && verdict.discover) {
      return { kind: 'modern', discover: verdict.discover as never };
    }
    const age = Date.now() - new Date(verdict.checked_at + 'Z').getTime();
    return verdict.era === 'legacy' && age < LEGACY_VERDICT_TTL_MS ? { kind: 'legacy' } : undefined;
  }

  private async handshake(
    config: ServerConfig,
    prior: PriorDiscovery | undefined,
  ): Promise<Client> {
    const client = new Client(
      { name: 'agent-discover', version },
      {
        capabilities: {
          elicitation: { form: {} },
          roots: { listChanged: true },
          ...(this.deps.sampling ? { sampling: {} } : {}),
        },
        versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5_000 } },
        inputRequired: { autoFulfill: false },
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: () => this.deps.onToolsChanged(config.name),
          },
        },
      },
    );
    this.wireHandlers(client, config.name);
    const { transport, stderrTail } = this.createTransport(config);
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS, prior });
      return client;
    } catch (err) {
      await client.close().catch(() => {});
      const tail = stderrTail();
      if (tail) {
        throw new Error(`${err instanceof Error ? err.message : String(err)} — stderr: ${tail}`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  private async recordFailure(name: string, config: ServerConfig, err: unknown): Promise<Error> {
    const count = (this.failures.get(name)?.count ?? 0) + 1;
    this.failures.set(name, {
      count,
      retryAt: Date.now() + Math.min(1_000 * 2 ** (count - 1), MAX_BACKOFF_MS),
    });
    const raw = err instanceof Error ? err.message : String(err);
    let friendly = raw;
    if (config.command && /Connection closed|ENOENT|spawn|not found/.test(raw)) {
      friendly = (await isCommandOnPath(config.command))
        ? `child process "${config.command} ${config.args.join(' ')}" exited before the MCP handshake completed — verify the package/args. Original: ${raw}`
        : `command "${config.command}" not found on PATH${INSTALL_HINTS[config.command] ?? ''}. Original: ${raw}`;
    }
    return new UpstreamError(`Failed to connect "${name}": ${friendly}`, { cause: err });
  }

  private createTransport(config: ServerConfig): {
    transport: Transport;
    stderrTail: () => string;
  } {
    if (config.transport === 'stdio') {
      if (!config.command) throw new Error(`Server "${config.name}" has no command configured`);
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...(process.env as Record<string, string>), ...config.env },
        stderr: 'pipe',
      });
      let tail = '';
      transport.stderr?.on('data', (chunk: Buffer) => {
        tail = (tail + chunk.toString('utf8')).slice(-2_000);
      });
      return { transport, stderrTail: () => tail.trim() };
    }
    if (!config.url) throw new Error(`Server "${config.name}" has no url configured`);
    const requestInit =
      Object.keys(config.headers).length > 0 ? { headers: config.headers } : undefined;
    const url = new URL(config.url);
    const transport =
      config.transport === 'sse'
        ? new SSEClientTransport(url, { requestInit })
        : new StreamableHTTPClientTransport(url, { requestInit });
    return { transport, stderrTail: () => '' };
  }

  private wireHandlers(client: Client, serverName: string): void {
    client.setRequestHandler('roots/list', async () => ({ roots: this.deps.roots() }));
    client.setRequestHandler('elicitation/create', async (req) => {
      const params = req.params as { message?: string; requestedSchema?: Record<string, unknown> };
      return this.queueElicitation(serverName, params.message ?? '', params.requestedSchema);
    });
    const sampling = this.deps.sampling;
    if (sampling) {
      client.setRequestHandler('sampling/createMessage', async (req) => {
        const p = req.params as Parameters<SamplingProvider['createMessage']>[0];
        return sampling.createMessage({ ...p, serverName });
      });
    }
    client.fallbackNotificationHandler = async (n) => {
      const params = (n.params ?? {}) as Record<string, unknown>;
      if (n.method === 'notifications/progress') {
        this.deps.logs.pushProgress(
          serverName,
          (params.progressToken as string | number) ?? 0,
          Number(params.progress ?? 0),
          params.total as number | undefined,
          params.message as string | undefined,
        );
      } else {
        this.deps.logs.pushNotification(serverName, n.method, params);
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Calls
  // ---------------------------------------------------------------------------

  /** tools/call passthrough: returns the upstream result verbatim (incl. input_required). */
  async callTool(
    name: string,
    tool: string,
    args: Record<string, unknown> | undefined,
    opts: CallOptions = {},
  ): Promise<CallToolResult | InputRequiredResult> {
    const start = Date.now();
    let conn: Connection | undefined;
    try {
      await this.connect(name);
      conn = this.conns.get(name)!;
      conn.inflight++;
      const params: Record<string, unknown> = { name: tool, arguments: args ?? {} };
      if (opts.inputResponses) params.inputResponses = opts.inputResponses;
      if (opts.requestState !== undefined) params.requestState = opts.requestState;
      const result = (await conn.client.request(
        { method: 'tools/call', params },
        withInputRequired(CallToolResultSchema),
        {
          allowInputRequired: true,
          timeout: CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          signal: opts.signal,
          onprogress: (p) => {
            this.deps.logs.pushProgress(name, tool, p.progress, p.total, p.message);
            opts.onprogress?.(p);
          },
        },
      )) as CallToolResult | InputRequiredResult;
      const latency = Date.now() - start;
      const ok = !('isError' in result && result.isError);
      this.deps.recordCall(name, tool, latency, ok);
      this.deps.logs.push(name, tool, args ?? {}, summarize(result), latency, ok);
      return result;
    } catch (err) {
      const latency = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      this.deps.recordCall(name, tool, latency, false);
      this.deps.logs.push(name, tool, args ?? {}, message, latency, false);
      throw err instanceof RegistryError ? err : new UpstreamError(message, { cause: err });
    } finally {
      if (conn) {
        conn.inflight--;
        conn.lastUsed = Date.now();
      }
    }
  }

  /** Live tools/list straight from the upstream (bypasses the response cache). */
  async listTools(name: string): Promise<Tool[]> {
    const client = await this.connect(name);
    return (await client.listTools(undefined, { cacheMode: 'bypass' })).tools;
  }

  async health(name: string): Promise<HealthResult> {
    const start = Date.now();
    try {
      const client = await this.connect(name);
      if (client.getProtocolEra() === 'modern')
        await client.discover({ timeout: HEALTH_TIMEOUT_MS });
      else await client.ping({ timeout: HEALTH_TIMEOUT_MS });
      return { status: 'healthy', latency_ms: Date.now() - start };
    } catch (err) {
      return {
        status: 'unhealthy',
        latency_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  info(name: string): Record<string, unknown> | null {
    const conn = this.conns.get(name);
    if (!conn) return null;
    const v = conn.client.getServerVersion();
    return {
      name: v?.name ?? name,
      version: v?.version ?? '',
      instructions: conn.client.getInstructions(),
      capabilities: conn.client.getServerCapabilities() ?? {},
      era: conn.client.getProtocolEra(),
      protocolVersion: conn.client.getNegotiatedProtocolVersion(),
    };
  }

  private sweepIdle(): void {
    if (!this.deps.idleMs) return;
    const cutoff = Date.now() - this.deps.idleMs;
    for (const [name, conn] of this.conns) {
      if (conn.inflight === 0 && conn.lastUsed < cutoff && !name.startsWith(TRANSIENT_PREFIX)) {
        void this.disconnect(name);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Transient (ad-hoc, dashboard tester) servers
  // ---------------------------------------------------------------------------

  async openTransient(
    config: Omit<ServerConfig, 'name'>,
    ttlMs = TRANSIENT_TTL_MS,
  ): Promise<TransientHandle> {
    const handle = `${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const serverName = `${TRANSIENT_PREFIX}${handle}`;
    const expiresAt = Date.now() + ttlMs;
    this.transient.set(handle, { config: { ...config, name: serverName }, expiresAt });
    this.transient.set(serverName, { config: { ...config, name: serverName }, expiresAt });
    try {
      await this.connect(serverName);
    } catch (err) {
      this.transient.delete(handle);
      this.transient.delete(serverName);
      throw err;
    }
    setTimeout(() => void this.releaseTransient(handle), ttlMs).unref();
    const client = this.conns.get(serverName)!.client;
    const v = client.getServerVersion();
    return {
      handle,
      serverName,
      tools: await this.listTools(serverName),
      capabilities: (client.getServerCapabilities() ?? {}) as Record<string, unknown>,
      serverVersion: v ? { name: v.name, version: v.version } : undefined,
      expiresAt,
    };
  }

  resolveTransient(handle: string): string | null {
    const entry = this.transient.get(handle);
    if (!entry || handle.startsWith(TRANSIENT_PREFIX)) return null;
    if (entry.expiresAt < Date.now()) {
      void this.releaseTransient(handle);
      return null;
    }
    return entry.config.name;
  }

  transientConfig(serverName: string): ServerConfig | null {
    return serverName.startsWith(TRANSIENT_PREFIX)
      ? (this.transient.get(serverName)?.config ?? null)
      : null;
  }

  async releaseTransient(handle: string): Promise<void> {
    const entry = this.transient.get(handle);
    if (!entry) return;
    this.transient.delete(handle);
    this.transient.delete(entry.config.name);
    await this.disconnect(entry.config.name);
  }

  // ---------------------------------------------------------------------------
  // Dashboard elicitation queue (upstream 2025 servers push elicitation/create)
  // ---------------------------------------------------------------------------

  private queueElicitation(
    serverName: string,
    message: string,
    requestedSchema: Record<string, unknown> | undefined,
  ): Promise<{ action: ElicitationAction; content?: ElicitationContent }> {
    const id = `elicit-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const request: PendingElicitation = {
      id,
      serverName,
      message,
      requestedSchema: requestedSchema ?? { type: 'object', properties: {} },
      createdAt: Date.now(),
    };
    this.deps.logs.push(
      serverName,
      'elicitation/create',
      request.requestedSchema,
      message,
      0,
      true,
      'elicitation',
    );
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.elicitations.delete(id)) resolve({ action: 'cancel' });
      }, ELICITATION_TIMEOUT_MS);
      timer.unref();
      this.elicitations.set(id, { resolve, timer, request });
      this.elicitationListener?.(request);
    });
  }

  listPendingElicitations(): PendingElicitation[] {
    return [...this.elicitations.values()].map((e) => e.request);
  }

  respondElicitation(
    id: string,
    response: { action: ElicitationAction; content?: ElicitationContent },
  ): boolean {
    const entry = this.elicitations.get(id);
    if (!entry) return false;
    this.elicitations.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(
      response.action === 'accept' && response.content
        ? { action: 'accept', content: response.content }
        : { action: response.action },
    );
    return true;
  }
}

function summarize(result: CallToolResult | InputRequiredResult): string {
  if (!('content' in result) || !Array.isArray(result.content)) return JSON.stringify(result);
  return result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
}
