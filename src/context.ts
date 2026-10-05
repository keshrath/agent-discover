// =============================================================================
// agent-discover — Application context
//
// Dependency injection root. Creates and wires together all services. One
// context lives in the daemon; every transport (MCP, REST, WS) shares it.
// =============================================================================

import { createDb, resolveDbPath, type Db, type DbOptions } from './storage/database.js';
import { loadConfig, type Config } from './config.js';
import { ServerStore } from './domain/servers.js';
import { ToolIndex } from './domain/tool-index.js';
import { ServerLifecycle, type TrustHooks } from './domain/lifecycle.js';
import { MarketplaceClient } from './domain/marketplace.js';
import { RegistryMirror } from './domain/registry.js';
import { OAuthManager } from './domain/oauth.js';
import { SecretsService } from './domain/secrets.js';
import { MetricsService } from './domain/metrics.js';
import { LogService } from './domain/log.js';
import { PresetsService } from './domain/presets.js';
import { maybeCreateDefaultSamplingProvider } from './domain/sampling.js';
import { syncSetupFile, type SyncResult } from './domain/setup.js';
import { TrustService } from './domain/trust/index.js';
import { resolveSecretBackend, type SecretBackend } from './domain/trust/secret-store.js';
import type { Telemetry } from './domain/trust/telemetry.js';

export interface AppContext {
  readonly config: Config;
  readonly db: Db;
  readonly servers: ServerStore;
  readonly index: ToolIndex;
  readonly lifecycle: ServerLifecycle;
  readonly marketplace: MarketplaceClient;
  readonly registry: RegistryMirror;
  readonly oauth: OAuthManager;
  readonly secrets: SecretsService;
  readonly metrics: MetricsService;
  readonly logs: LogService;
  readonly presets: PresetsService;
  readonly trust: TrustService;
  syncSetup(filePath?: string): Promise<SyncResult>;
  close(): Promise<void>;
}

export interface ContextOptions extends DbOptions {
  config?: Partial<Config>;
  /** Replace the TrustService hooks (tests). */
  hooks?: TrustHooks;
  /** Secret value store (default: keychain / encrypted file / memory, see trust/secret-store.ts). */
  secretBackend?: SecretBackend;
  telemetry?: Telemetry;
  /** Override the tool index (tests, alternative rankers). */
  index?: (db: Db) => ToolIndex;
}

/** Roots advertised to upstream servers (AGENT_DISCOVER_ROOTS, comma-separated URIs). */
export function configuredRoots(): Array<{ uri: string; name: string }> {
  return (process.env.AGENT_DISCOVER_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((uri) => ({ uri, name: uri }));
}

export function createContext(options: ContextOptions = {}): AppContext {
  const config = { ...loadConfig(), ...options.config };
  const path = resolveDbPath(options.path);
  const db = createDb({ path });
  const servers = new ServerStore(db);
  const index = options.index?.(db) ?? new ToolIndex(db);
  const secrets = new SecretsService(db, options.secretBackend ?? resolveSecretBackend(path));
  const trust = new TrustService({ db, config, index, secrets, telemetry: options.telemetry });
  const metrics = new MetricsService(db);
  const logs = new LogService();
  const registry = new RegistryMirror(db, config.registryUrl);
  // The loopback redirect is the daemon's own callback route (config.port is the bound port).
  const oauth = new OAuthManager(
    servers,
    secrets,
    `http://127.0.0.1:${config.port}/oauth/callback`,
    config.oauthClientMetadataUrl,
  );
  const lifecycle = new ServerLifecycle({
    servers,
    index,
    secrets,
    metrics,
    logs,
    registry,
    oauth,
    roots: configuredRoots,
    sampling: maybeCreateDefaultSamplingProvider(),
    connIdleMs: config.connIdleMs,
    hooks: options.hooks ?? trust,
  });
  let closed = false;

  return {
    config,
    db,
    servers,
    index,
    lifecycle,
    marketplace: new MarketplaceClient(registry),
    registry,
    oauth,
    secrets,
    metrics,
    logs,
    presets: new PresetsService(db),
    trust,
    syncSetup: (filePath) => syncSetupFile(lifecycle, filePath),
    async close() {
      if (closed) return;
      closed = true;
      await lifecycle.close().catch(() => {});
      await trust.telemetry.shutdown().catch(() => {});
      db.close();
    },
  };
}
