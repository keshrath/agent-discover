// =============================================================================
// agent-discover — Server lifecycle
//
// The single authority over a server's states (SPEC §2):
//   installed → indexed → enabled → (connected, lazily) ; quarantined
// MCP tools, REST routes, the setup file and the dashboard all go through
// this service, so every path persists the same way and fires the same
// change events (which drive tools/list_changed and dashboard refreshes).
//
// Indexing is independent of enablement: install probes the server once
// (connect → tools/list → persist → disconnect), disable never touches the
// index, and an upstream list_changed re-indexes.
//
// Trust extension point (SPEC §4 W2): `TrustHooks` run at install, after
// every index diff, and before every proxied call.
// =============================================================================

import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/client';
import type { ServerEntry, ServerInput, ServerUpdate } from '../types.js';
import { NotFoundError, RegistryError } from '../types.js';
import { ServerStore, toConfig } from './servers.js';
import type { ToolIndex, IndexDiff } from './tool-index.js';
import type { SecretsService } from './secrets.js';
import type { MetricsService } from './metrics.js';
import type { LogService } from './log.js';
import type { SamplingProvider } from './sampling.js';
import { ConnectionPool, type CallOptions, type HealthResult } from './pool.js';

export interface TrustHooks {
  /** Runs before a server row is created. Throw to refuse the install. */
  beforeInstall?(input: ServerInput): void | Promise<void>;
  /** Runs after each index diff is persisted (e.g. pin hashes, quarantine on drift). */
  afterIndex?(
    server: ServerEntry,
    diff: IndexDiff,
    lifecycle: ServerLifecycle,
  ): void | Promise<void>;
  /** Runs before every proxied tools/call. Throw to refuse the call. */
  beforeCall?(
    server: ServerEntry,
    tool: string,
    args: Record<string, unknown> | undefined,
  ): void | Promise<void>;
}

export type LifecycleEvent =
  /** The set or shape of exposed tools may have changed → tools/list_changed. */
  | { type: 'tools' }
  /** Server rows or connection state changed (dashboard). */
  | { type: 'servers' };

export interface ServerStatus {
  name: string;
  description: string;
  source: string;
  transport: string;
  enabled: boolean;
  quarantined: boolean;
  indexed: boolean;
  indexed_at: string | null;
  connected: boolean;
  tool_count: number;
  health_status: string;
  last_health_check: string | null;
  error_count: number;
}

export interface LifecycleDeps {
  servers: ServerStore;
  index: ToolIndex;
  secrets: SecretsService;
  metrics: MetricsService;
  logs: LogService;
  roots: () => Array<{ uri: string; name?: string }>;
  sampling?: SamplingProvider;
  connIdleMs: number;
  hooks?: TrustHooks;
}

export class ServerLifecycle {
  readonly pool: ConnectionPool;
  private readonly servers: ServerStore;
  private readonly index: ToolIndex;
  private readonly listeners = new Set<(event: LifecycleEvent) => void>();
  private readonly indexing = new Map<string, Promise<IndexDiff>>();
  hooks: TrustHooks;

  constructor(private readonly deps: LifecycleDeps) {
    this.servers = deps.servers;
    this.index = deps.index;
    this.hooks = deps.hooks ?? {};
    this.pool = new ConnectionPool({
      resolveConfig: (name) => this.resolveConfig(name),
      getEraVerdict: (name) => this.servers.getEraVerdict(name),
      setEraVerdict: (name, era, discover) => this.servers.setEraVerdict(name, era, discover),
      onToolsChanged: (name) => {
        if (!this.servers.get(name)) return;
        this.reindex(name).catch((err) =>
          process.stderr.write(`[agent-discover] re-index of "${name}" failed: ${String(err)}\n`),
        );
      },
      onConnectionChange: () => this.emit({ type: 'servers' }),
      recordCall: (server, tool, latency, ok) => {
        const row = this.servers.get(server);
        if (row) deps.metrics.recordCall(row.id, tool, latency, ok);
      },
      logs: deps.logs,
      roots: deps.roots,
      sampling: deps.sampling,
      idleMs: deps.connIdleMs,
    });
  }

  onChange(listener: (event: LifecycleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: LifecycleEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* listener failures never break the lifecycle */
      }
    }
  }

  private changed(exposed: boolean): void {
    this.emit({ type: 'servers' });
    if (exposed) this.emit({ type: 'tools' });
  }

  resolveConfig(name: string) {
    const server = this.servers.require(name);
    return toConfig(server, this.deps.secrets.getEnvForServer(server.id));
  }

  get(name: string): ServerEntry | null {
    return this.servers.get(name);
  }

  // ---------------------------------------------------------------------------
  // install → index → enable / disable → uninstall
  // ---------------------------------------------------------------------------

  /**
   * Persist a server and index it. Consent is the caller's job (MCP elicits,
   * REST/dashboard and the setup file are user/operator driven). An index
   * failure leaves the server installed-but-unindexed and is reported.
   */
  async install(
    input: ServerInput,
    opts: { enable?: boolean; secrets?: Record<string, string> } = {},
  ): Promise<{ server: ServerEntry; diff?: IndexDiff; index_error?: string }> {
    await this.hooks.beforeInstall?.(input);
    let server = this.servers.create(input);
    for (const [key, value] of Object.entries(opts.secrets ?? {})) {
      this.deps.secrets.set(server.id, key, value);
    }
    this.changed(false);
    let diff: IndexDiff | undefined;
    let indexError: string | undefined;
    try {
      diff = await this.reindex(server.name);
    } catch (err) {
      indexError = err instanceof Error ? err.message : String(err);
    }
    if (opts.enable && !indexError) await this.enable(server.name);
    server = this.servers.require(server.name);
    return { server, diff, ...(indexError ? { index_error: indexError } : {}) };
  }

  /** connect → tools/list → persist diff → (disconnect if this call opened it). */
  reindex(name: string): Promise<IndexDiff> {
    let running = this.indexing.get(name);
    if (!running) {
      running = this.doIndex(name).finally(() => this.indexing.delete(name));
      this.indexing.set(name, running);
    }
    return running;
  }

  private async doIndex(name: string): Promise<IndexDiff> {
    const server = this.servers.require(name);
    const tools = await this.pool.probe(name, async () => this.pool.listTools(name));
    const diff = await this.index.save(server.id, tools);
    this.servers.markIndexed(server.id);
    await this.hooks.afterIndex?.(this.servers.require(name), diff, this);
    const after = this.servers.require(name);
    const shapeChanged = diff.added.length + diff.changed.length + diff.removed.length > 0;
    this.changed(after.enabled && shapeChanged);
    return diff;
  }

  async enable(name: string): Promise<ServerEntry> {
    const server = this.servers.require(name);
    if (server.quarantined) {
      throw new RegistryError(`Server "${name}" is quarantined`, 'QUARANTINED', 409);
    }
    if (!server.indexed_at) await this.reindex(name);
    if (!server.enabled) {
      this.servers.setEnabled(server.id, true);
      this.changed(true);
    }
    return this.servers.require(name);
  }

  async disable(name: string): Promise<ServerEntry> {
    const server = this.servers.require(name);
    if (server.enabled) {
      this.servers.setEnabled(server.id, false);
      this.changed(true);
    }
    return this.servers.require(name);
  }

  async update(name: string, updates: ServerUpdate): Promise<ServerEntry> {
    const before = this.servers.require(name);
    const server = this.servers.update(name, updates);
    await this.pool.disconnect(name);
    this.changed(before.enabled && before.description !== server.description);
    return server;
  }

  async uninstall(name: string): Promise<void> {
    const server = this.servers.require(name);
    await this.pool.disconnect(name);
    this.servers.remove(name);
    this.changed(server.enabled);
  }

  resetErrors(name: string): void {
    this.servers.resetErrorCount(this.servers.require(name).id);
    this.emit({ type: 'servers' });
  }

  setQuarantined(name: string, quarantined: boolean): void {
    const server = this.servers.require(name);
    if (server.quarantined === quarantined) return;
    this.servers.setQuarantined(server.id, quarantined);
    this.changed(server.enabled);
  }

  /** Index every installed server that has never been indexed (1.x upgrades, setup file). */
  async indexPending(concurrency = 2): Promise<void> {
    const queue = this.servers.list().filter((s) => !s.indexed_at && !s.quarantined);
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        await this.reindex(s.name).catch((err) =>
          process.stderr.write(`[agent-discover] indexing "${s!.name}" failed: ${String(err)}\n`),
        );
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  // ---------------------------------------------------------------------------
  // Calls, status, health
  // ---------------------------------------------------------------------------

  async callTool(
    serverName: string,
    tool: string,
    args: Record<string, unknown> | undefined,
    opts?: CallOptions,
  ): Promise<CallToolResult | InputRequiredResult> {
    const server = this.servers.get(serverName);
    if (!server) throw new NotFoundError('Server', serverName);
    if (server.quarantined) {
      throw new RegistryError(`Server "${serverName}" is quarantined`, 'QUARANTINED', 409);
    }
    await this.hooks.beforeCall?.(server, tool, args);
    return this.pool.callTool(serverName, tool, args, opts);
  }

  async health(name: string): Promise<HealthResult> {
    const server = this.servers.require(name);
    const result = await this.pool.health(name);
    this.servers.recordHealth(server.id, result.status);
    this.emit({ type: 'servers' });
    return result;
  }

  status(name?: string): ServerStatus[] {
    const rows = name ? [this.servers.require(name)] : this.servers.list();
    return rows.map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      transport: s.transport,
      enabled: s.enabled,
      quarantined: s.quarantined,
      indexed: s.indexed_at !== null,
      indexed_at: s.indexed_at,
      connected: this.pool.isConnected(s.name),
      tool_count: this.index.count(s.id),
      health_status: s.health_status,
      last_health_check: s.last_health_check,
      error_count: s.error_count,
    }));
  }

  async close(): Promise<void> {
    await this.pool.closeAll();
  }
}

/** Split an exposed `<server>__<tool>` name. Server names never contain `__`. */
export function splitToolName(name: string): { server: string; tool: string } | null {
  const i = name.indexOf('__');
  if (i <= 0 || i + 2 >= name.length) return null;
  return { server: name.slice(0, i), tool: name.slice(i + 2) };
}
