// =============================================================================
// agent-discover — Application context
//
// Dependency injection root. Creates and wires together all services.
// Every layer receives its dependencies explicitly — no global state.
// =============================================================================

import { createDb, type Db, type DbOptions } from './storage/database.js';
import { EventBus } from './domain/events.js';
import { RegistryService } from './domain/registry.js';
import { McpProxy } from './domain/proxy.js';
import { MarketplaceClient } from './domain/marketplace.js';
import { InstallerService } from './domain/installer.js';
import { SecretsService } from './domain/secrets.js';
import { HealthService } from './domain/health.js';
import { MetricsService } from './domain/metrics.js';
import { LogService } from './domain/log.js';
import { syncSetupFile, type SyncResult } from './domain/setup.js';

export interface AppContext {
  readonly db: Db;
  readonly events: EventBus;
  readonly registry: RegistryService;
  readonly proxy: McpProxy;
  readonly marketplace: MarketplaceClient;
  readonly installer: InstallerService;
  readonly secrets: SecretsService;
  readonly health: HealthService;
  readonly metrics: MetricsService;
  readonly logs: LogService;
  syncSetup(filePath?: string): Promise<SyncResult>;
  close(): void;
}

export function createContext(dbOptions?: DbOptions): AppContext {
  const db = createDb(dbOptions);
  const events = new EventBus();
  let closed = false;

  const registry = new RegistryService(db, events);
  const proxy = new McpProxy();
  const marketplace = new MarketplaceClient();
  const installer = new InstallerService();
  const secrets = new SecretsService(db);
  const metrics = new MetricsService(db);
  const health = new HealthService(db, proxy);
  const logs = new LogService();

  proxy.setSecretsService(secrets);
  proxy.setMetricsService(metrics);
  proxy.setLogService(logs);
  proxy.setServerIdResolver((name: string) => {
    const server = registry.getByName(name);
    return server ? server.id : null;
  });

  return {
    db,
    events,
    registry,
    proxy,
    marketplace,
    installer,
    secrets,
    health,
    metrics,
    logs,
    syncSetup(filePath?: string) {
      return syncSetupFile(registry, secrets, proxy, filePath);
    },
    close() {
      if (closed) return;
      closed = true;
      proxy.deactivateAll().catch(() => {});
      events.removeAll();
      db.close();
    },
  };
}

// Hydrate the in-process proxy from servers marked active in the DB. The
// McpProxy.activeServers map is per-process, but the DB-backed `active` flag
// is the cross-process source of truth, so a fresh process can rebuild its
// live children by replaying it.
//
// Only the primary process (the one that successfully binds the dashboard
// port) should call this. Running hydrate in every stdio child — which is
// what happened before v1.2.5 — races on duplicate child spawning, and the
// losers used to flip the DB flag to 0 on failure, which surfaced as a
// dashboard server that flickered between Active and Inactive depending on
// which stdio child ran last.
//
// Hydrate failures here are logged but never flip the DB flag. The health
// probe is the one responsible for surfacing a dead child, and a failed
// hydrate in a secondary process is informational only — another process
// may already hold a live bridge.
export async function hydrateActiveServers(ctx: AppContext): Promise<void> {
  const activeRows = ctx.db.queryAll<{ name: string }>(
    'SELECT name FROM servers WHERE active = 1 AND installed = 1',
  );
  for (const row of activeRows) {
    const server = ctx.registry.getByName(row.name);
    if (!server) continue;
    if (ctx.proxy.isActive(server.name)) continue;
    try {
      await ctx.proxy.activate({
        name: server.name,
        command: server.command ?? undefined,
        args: server.args,
        env: server.env,
        transport: server.transport,
        url: server.homepage ?? undefined,
      });
    } catch (err) {
      process.stderr.write(
        `[agent-discover] failed to hydrate active server "${server.name}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}
