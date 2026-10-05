// =============================================================================
// agent-discover — Upstream connection pool
//
// One SDK v2 Client per upstream server, opened lazily and shared by every
// caller in the daemon (MCP, REST). Responsibilities:
//   - connect with `versionNegotiation: 'auto'`, reusing the cached era
//     verdict as `prior` so npx-launched servers are not spawned twice;
//   - drop a connection the moment its transport closes (child crash) and
//     reconnect on the next use, with exponential backoff after failures;
//   - close connections idle longer than `idleMs`;
//   - forward tools/call verbatim (CallToolResult or MRTR input_required),
//     with SDK timeouts/abort instead of hand-rolled races;
//   - OAuth 2.1 for remote servers without their own Authorization header
//     (oauth.ts); a 401 surfaces as AuthRequiredError with the sign-in URL;
//   - real health probes (`ping` on 2025 connections, `server/discover` on
//     2026 ones);
//   - upstream elicitation/create pushes (2025 servers) go to the caller's
//     `onElicit` (the downstream client) when it is the only such call in
//     flight on that connection, else to the queue the Claude Code pane
//     answers (GET /api/elicitations); roots and
//     sampling handlers.
// =============================================================================

import { spawn } from 'node:child_process';
import {
  Client,
  SdkError,
  SdkErrorCode,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
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
import { AuthRequiredError, type OAuthManager } from './oauth.js';
import { version } from '../version.js';

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 5_000;
const LEGACY_VERDICT_TTL_MS = 7 * 86_400_000;
const MAX_BACKOFF_MS = 60_000;
const ELICITATION_TIMEOUT_MS = 2 * 60_000;

/**
 * Probes the era in place: the SDK spawns a disposable sibling process for the
 * `server/discover` probe only for its exact base class (16–35 s for an npx
 * server vs 3.6 s in place). Servers that exit on a pre-initialize request
 * close during the in-place probe; `open` then initializes them as legacy.
 */
class InPlaceStdioTransport extends StdioClientTransport {}

/** `match` holds for the error or one of its causes. */
function causedBy(err: unknown, match: (e: Error) => boolean): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) if (match(e)) return true;
  return false;
}

/** The in-place probe ended because the server closed the connection (a legacy server). */
const closedDuringProbe = (err: unknown) =>
  causedBy(
    err,
    (e) =>
      e instanceof SdkError &&
      e.code === SdkErrorCode.EraNegotiationFailed &&
      e.message.includes('probed in place'),
  );

export type EraVerdict = { era: 'modern' | 'legacy'; discover: unknown; checked_at: string };

export interface PoolDeps {
  /** Resolve a registered server name to its config (toConfig). Throws when unknown. */
  resolveConfig(name: string): ServerConfig;
  getEraVerdict(name: string): EraVerdict | null;
  setEraVerdict(name: string, era: 'modern' | 'legacy' | null, discover?: unknown): void;
  /** Upstream announced tools/list_changed. */
  onToolsChanged(name: string): void;
  recordCall(server: string, tool: string, latencyMs: number, success: boolean): void;
  logs: LogService;
  roots: () => Array<{ uri: string; name?: string }>;
  sampling?: SamplingProvider;
  /** OAuth for remote servers that do not send their own Authorization header. */
  oauth?: OAuthManager;
  idleMs: number;
}

interface Connection {
  client: Client;
  config: ServerConfig;
  lastUsed: number;
  inflight: number;
  /** In-flight calls whose caller can answer upstream elicitations itself. */
  elicitors: Set<Elicitor>;
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
export type ElicitationAnswer = { action: ElicitationAction; content?: ElicitationContent };
export type Elicitor = (request: {
  message: string;
  requestedSchema: Record<string, unknown>;
}) => Promise<ElicitationAnswer>;

export interface CallOptions {
  signal?: AbortSignal;
  onprogress?: (p: { progress: number; total?: number; message?: string }) => void;
  inputResponses?: InputResponses;
  requestState?: string;
  /** Extra params._meta for the upstream request (W3C trace context). */
  _meta?: Record<string, string>;
  /** Answers upstream elicitation/create pushes made during this call. */
  onElicit?: Elicitor;
}

export interface HealthResult {
  status: 'healthy' | 'unhealthy';
  latency_ms: number;
  error?: string;
}

/** Probes whether `cmd` resolves on PATH (shell so Windows .cmd shims count). Never blocks the loop. */
function isCommandOnPath(cmd: string): Promise<boolean> {
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
  private readonly elicitations = new Map<
    string,
    {
      resolve: (v: ElicitationAnswer) => void;
      timer: NodeJS.Timeout;
      request: PendingElicitation;
    }
  >();
  private seq = 0;
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly deps: PoolDeps) {
    this.sweeper = setInterval(() => this.sweepIdle(), Math.min(60_000, deps.idleMs || 60_000));
    this.sweeper.unref();
  }

  isConnected(name: string): boolean {
    return this.conns.has(name);
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
    const config = this.deps.resolveConfig(name);
    const cached = this.priorFor(name);
    let prior = cached;
    let client: Client;
    try {
      client = await this.handshake(config, prior);
    } catch (err) {
      // Retry once: a stale cached verdict must never wedge a server (negotiate fresh), and
      // a server that closed during the in-place probe is legacy.
      if (prior) prior = undefined;
      else if (closedDuringProbe(err)) prior = { kind: 'legacy' };
      else throw await this.recordFailure(name, config, err);
      if (cached) this.deps.setEraVerdict(name, null);
      try {
        client = await this.handshake(config, prior);
      } catch (retryErr) {
        throw await this.recordFailure(name, config, retryErr);
      }
    }
    this.failures.delete(name);

    const era = client.getProtocolEra();
    if (era === 'modern') this.deps.setEraVerdict(name, 'modern', client.getDiscoverResult());
    // Legacy verdicts are dated when found, so re-using one never extends its TTL.
    else if (prior !== cached || !cached) this.deps.setEraVerdict(name, 'legacy');
    if (era === 'modern' && prior && client.getServerCapabilities()?.tools?.listChanged) {
      // Connects that adopt a prior verdict are request-only until listen() is called.
      client.listen({ toolsListChanged: true }).catch(() => {});
    }

    const conn: Connection = {
      client,
      config,
      lastUsed: Date.now(),
      inflight: 0,
      elicitors: new Set(),
    };
    client.onclose = () => {
      if (this.conns.get(name)?.client === client) this.conns.delete(name);
    };
    this.conns.set(name, conn);
    return conn;
  }

  private priorFor(name: string): PriorDiscovery | undefined {
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
    // Sign-in is the user's move, not an outage: no backoff, hand out the authorization URL.
    const authorizeUrl = causedBy(err, (e) => e instanceof UnauthorizedError)
      ? this.deps.oauth?.authorizeUrl(name)
      : undefined;
    if (authorizeUrl) return new AuthRequiredError(name, authorizeUrl);
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
      const transport = new InPlaceStdioTransport({
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
    const ownAuth = Object.keys(config.headers).some((h) => h.toLowerCase() === 'authorization');
    const authProvider = ownAuth ? undefined : this.deps.oauth?.provider(config.name);
    const transport =
      config.transport === 'sse'
        ? new SSEClientTransport(url, { requestInit, authProvider })
        : new StreamableHTTPClientTransport(url, { requestInit, authProvider });
    return { transport, stderrTail: () => '' };
  }

  private wireHandlers(client: Client, serverName: string): void {
    client.setRequestHandler('roots/list', async () => ({ roots: this.deps.roots() }));
    client.setRequestHandler('elicitation/create', async (req) => {
      const params = req.params as { message?: string; requestedSchema?: Record<string, unknown> };
      const message = params.message ?? '';
      const requestedSchema = params.requestedSchema ?? { type: 'object', properties: {} };
      // A push carries no reference to the call it belongs to: route it to the caller only
      // when exactly one call that can answer is in flight.
      const elicitors = this.conns.get(serverName)?.elicitors;
      if (elicitors?.size === 1) {
        const [onElicit] = elicitors;
        this.deps.logs.push(
          serverName,
          'elicitation/create',
          requestedSchema,
          message,
          0,
          true,
          'elicitation',
        );
        return onElicit({ message, requestedSchema });
      }
      return this.queueElicitation(serverName, message, requestedSchema);
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
      if (opts.onElicit) conn.elicitors.add(opts.onElicit);
      const params: Record<string, unknown> = { name: tool, arguments: args ?? {} };
      if (opts.inputResponses) params.inputResponses = opts.inputResponses;
      if (opts.requestState !== undefined) params.requestState = opts.requestState;
      if (opts._meta) params._meta = opts._meta;
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
        if (opts.onElicit) conn.elicitors.delete(opts.onElicit);
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
      if (conn.inflight === 0 && conn.lastUsed < cutoff) void this.disconnect(name);
    }
  }

  // ---------------------------------------------------------------------------
  // Elicitation queue (upstream 2025 servers push elicitation/create; the pane answers)
  // ---------------------------------------------------------------------------

  private queueElicitation(
    serverName: string,
    message: string,
    requestedSchema: Record<string, unknown>,
  ): Promise<ElicitationAnswer> {
    const id = `elicit-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const request: PendingElicitation = {
      id,
      serverName,
      message,
      requestedSchema,
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
    });
  }

  listPendingElicitations(): PendingElicitation[] {
    return [...this.elicitations.values()].map((e) => e.request);
  }

  respondElicitation(id: string, response: ElicitationAnswer): boolean {
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
