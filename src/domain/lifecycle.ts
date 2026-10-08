// =============================================================================
// agent-discover — Server lifecycle
//
// The single authority over a server's states (SPEC §2):
//   installed → indexed → enabled → (connected, lazily) ; quarantined
// MCP tools, REST routes (the Claude Code pane) and the setup file all go
// through this service, so every path persists the same way and fires the
// same tools-changed events (which drive tools/list_changed).
//
// Indexing is independent of enablement: install probes the server once
// (connect → tools/list → persist → disconnect), disable never touches the
// index, and an upstream list_changed re-indexes.
//
// Trust extension point (SPEC §4 W2, implemented by trust/TrustService):
// `TrustHooks` run at install, after every index diff (whose verdict sets
// `quarantined`), around every proxied call, on approval, and receive an
// audit event for every state change made here.
// =============================================================================

import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/client';
import type { ServerEntry, ServerInput, ServerUpdate } from '../types.js';
import { NotFoundError, RegistryError } from '../types.js';
import { ServerStore, toConfig } from './servers.js';
import type { ToolIndex, IndexDiff } from './tool-index.js';
import type { SecretsService } from './secrets.js';
import type { AuditEvent } from './trust/audit.js';
import type { TrustReport } from './trust/index.js';
import type { MetricsService } from './metrics.js';
import type { LogService } from './log.js';
import type { SamplingProvider } from './sampling.js';
import { ConnectionPool, type CallOptions, type HealthResult } from './pool.js';
import type { RegistryMirror } from './registry.js';
import type { OAuthManager } from './oauth.js';
import type { RegistryStatus } from './install-plan.js';

export type CallResult = CallToolResult | InputRequiredResult;

export interface TrustHooks {
  /** Runs before a server row is created. Throw to refuse the install. */
  beforeInstall?(input: ServerInput): void | Promise<void>;
  /** Runs after each index diff is persisted; the verdict is whether to quarantine. */
  afterIndex?(server: ServerEntry, diff: IndexDiff): boolean | Promise<boolean>;
  /**
   * Wraps every proxied tools/call (throw to refuse). `next` performs the
   * upstream call with `meta` merged into params._meta (trace context).
   */
  aroundCall?(
    server: ServerEntry,
    tool: string,
    args: Record<string, unknown> | undefined,
    next: (meta: Record<string, string>) => Promise<CallResult>,
  ): Promise<CallResult>;
  /** Accept the server's current tools; throws unless `hashes` is exactly that set. */
  approve?(server: ServerEntry, hashes: string[]): void;
  /** Drift + hygiene facts for status views. */
  inspect?(server: ServerEntry): TrustReport;
  /** Audit sink for every lifecycle state change. */
  record?(event: AuditEvent): void;
}

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
  /** Present while quarantined: what changed since the last approval. */
  drift?: TrustReport['drift'];
  flagged_tools: TrustReport['flagged_tools'];
  /** Status of the MCP Registry entry the server was installed from (null: not from the registry or not mirrored). */
  registry_status: RegistryStatus | null;
}

export interface LifecycleDeps {
  servers: ServerStore;
  index: ToolIndex;
  secrets: SecretsService;
  metrics: MetricsService;
  logs: LogService;
  registry: RegistryMirror;
  roots: () => Array<{ uri: string; name?: string }>;
  sampling?: SamplingProvider;
  oauth?: OAuthManager;
  connIdleMs: number;
  hooks?: TrustHooks;
}

export class ServerLifecycle {
  readonly pool: ConnectionPool;
  private readonly servers: ServerStore;
  private readonly index: ToolIndex;
  /** Called when the set or shape of exposed tools may have changed → tools/list_changed. */
  private readonly listeners = new Set<() => void>();
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
      recordCall: (server, tool, latency, ok) => {
        const row = this.servers.get(server);
        if (row) deps.metrics.recordCall(row.id, tool, latency, ok);
      },
      logs: deps.logs,
      roots: deps.roots,
      sampling: deps.sampling,
      oauth: deps.oauth,
      idleMs: deps.connIdleMs,
    });
  }

  onToolsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fires tools/list_changed when `exposed` (the change touched an enabled server's tools). */
  private changed(exposed: boolean): void {
    if (!exposed) return;
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* listener failures never break the lifecycle */
      }
    }
  }

  resolveConfig(name: string) {
    const server = this.servers.require(name);
    return toConfig(server, this.deps.secrets.getEnvForServer(server));
  }

  get(name: string): ServerEntry | null {
    return this.servers.get(name);
  }

  // ---------------------------------------------------------------------------
  // install → index → enable / disable → uninstall
  // ---------------------------------------------------------------------------

  /**
   * Persist a server and index it. Consent is the caller's job (MCP elicits,
   * REST (the pane) and the setup file are user/operator driven). An index
   * failure leaves the server installed-but-unindexed and is reported.
   */
  async install(
    input: ServerInput,
    opts: { enable?: boolean; secrets?: Record<string, string> } = {},
  ): Promise<{ server: ServerEntry; diff?: IndexDiff; index_error?: string }> {
    await this.hooks.beforeInstall?.(input);
    let server = this.servers.create(input);
    for (const [key, value] of Object.entries(opts.secrets ?? {})) {
      this.deps.secrets.set(server, key, value);
    }
    this.record({
      action: 'install',
      server: server.name,
      detail: {
        source: server.source,
        transport: server.transport,
        ...(server.transport === 'stdio'
          ? { command: [server.command, ...server.args].join(' ') }
          : { url: server.url }),
        ...(opts.secrets ? { secrets: Object.keys(opts.secrets) } : {}),
      },
    });
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
    const quarantine = await this.hooks.afterIndex?.(this.servers.require(name), diff);
    if (quarantine !== undefined) this.setQuarantined(name, quarantine);
    const after = this.servers.require(name);
    const shapeChanged = diff.added.length + diff.changed.length + diff.removed.length > 0;
    this.changed(after.enabled && shapeChanged);
    return diff;
  }

  async enable(name: string): Promise<ServerEntry> {
    const server = this.servers.require(name);
    if (server.quarantined) throw this.quarantineError(server);
    if (!server.indexed_at) await this.reindex(name);
    if (!server.enabled) {
      this.servers.setEnabled(server.id, true);
      this.record({ action: 'enable', server: name });
      this.changed(true);
    }
    return this.servers.require(name);
  }

  async disable(name: string): Promise<ServerEntry> {
    const server = this.servers.require(name);
    if (server.enabled) {
      this.servers.setEnabled(server.id, false);
      this.record({ action: 'disable', server: name });
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
    this.deps.secrets.deleteAll(server);
    this.index.remove(server.id);
    this.servers.remove(name);
    this.record({ action: 'uninstall', server: name });
    this.changed(server.enabled);
  }

  async setSecret(name: string, key: string, value: string): Promise<void> {
    const server = this.servers.require(name);
    if (!this.deps.secrets.set(server, key, value)) return;
    this.record({ action: 'secret-set', server: name, detail: { key } });
    await this.pool.disconnect(name); // next use reconnects with the new secret
  }

  async deleteSecret(name: string, key: string): Promise<void> {
    const server = this.servers.require(name);
    this.deps.secrets.delete(server, key);
    this.record({ action: 'secret-delete', server: name, detail: { key } });
    await this.pool.disconnect(name);
  }

  resetErrors(name: string): void {
    this.servers.resetErrorCount(this.servers.require(name).id);
  }

  setQuarantined(name: string, quarantined: boolean): void {
    const server = this.servers.require(name);
    if (server.quarantined === quarantined) return;
    this.servers.setQuarantined(server.id, quarantined);
    const drift = quarantined ? this.hooks.inspect?.(server).drift : undefined;
    this.record({
      action: quarantined ? 'quarantine' : 'release',
      server: name,
      ...(drift ? { detail: { drift } } : {}),
    });
    this.changed(server.enabled);
  }

  /**
   * Re-approve a quarantined server's current tools (`hashes` = the exact
   * tool hash set the user reviewed) and lift the quarantine.
   */
  approve(name: string, hashes: string[]): ServerEntry {
    const server = this.servers.require(name);
    this.hooks.approve?.(server, hashes);
    this.record({ action: 'approve', server: name, detail: { tools: hashes.length } });
    this.setQuarantined(name, false);
    return this.servers.require(name);
  }

  private quarantineError(server: ServerEntry): RegistryError {
    const drift = this.hooks.inspect?.(server).drift;
    const parts = drift
      ? [
          drift.changed.length ? `changed: ${drift.changed.map((c) => c.tool).join(', ')}` : '',
          drift.added.length ? `added: ${drift.added.join(', ')}` : '',
          drift.removed.length ? `removed: ${drift.removed.join(', ')}` : '',
        ].filter(Boolean)
      : [];
    return new RegistryError(
      `Server "${server.name}" is quarantined: its tools changed since they were approved${parts.length ? ` (${parts.join('; ')})` : ''}. Review and re-approve with enable_server or the Claude Code /discover pane (POST /api/servers/${server.id}/approve).`,
      'QUARANTINED',
      409,
    );
  }

  private record(event: AuditEvent): void {
    try {
      this.hooks.record?.(event);
    } catch (err) {
      process.stderr.write(`[agent-discover] audit write failed: ${String(err)}\n`);
    }
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
    if (server.quarantined) throw this.quarantineError(server);
    // Once indexed, only indexed tools were pinned and approved. A server not indexed yet
    // (sign-in pending) is first pinned by the index that follows this call.
    if (server.indexed_at && !this.index.get(serverName, tool)) {
      throw new NotFoundError('Tool', `${serverName}/${tool}`);
    }
    const call = (meta: Record<string, string>) =>
      this.pool.callTool(serverName, tool, args, {
        ...opts,
        ...(Object.keys(meta).length ? { _meta: meta } : {}),
      });
    return this.hooks.aroundCall ? this.hooks.aroundCall(server, tool, args, call) : call({});
  }

  async health(name: string): Promise<HealthResult> {
    const server = this.servers.require(name);
    const result = await this.pool.health(name);
    this.servers.recordHealth(server.id, result.status);
    return result;
  }

  status(name?: string): ServerStatus[] {
    const rows = name ? [this.servers.require(name)] : this.servers.list();
    const registry = this.deps.registry.statuses(
      rows.flatMap((s) => (s.registry_name ? [s.registry_name] : [])),
    );
    return rows.map((s) => {
      const trust = this.hooks.inspect?.(s);
      return {
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
        ...(s.quarantined && trust?.drift ? { drift: trust.drift } : {}),
        flagged_tools: trust?.flagged_tools ?? [],
        registry_status: (s.registry_name && registry.get(s.registry_name)) || null,
      };
    });
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
