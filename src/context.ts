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

  proxy.setSecretsService(secrets);
  proxy.setMetricsService(metrics);
  proxy.setServerIdResolver((name: string) => {
    const server = registry.getByName(name);
    return server ? server.id : null;
  });

  // Hydrate the in-process proxy from servers marked active in the DB.
  // Activation lives in McpProxy.activeServers (in-memory) but the DB-backed
  // active flag is the cross-process source of truth, so each new instance
  // (e.g. a fresh stdio child spawned by an MCP client) re-establishes its
  // own proxy connections to the same set of child servers.
  void (async () => {
    const activeRows = db.queryAll<{ name: string }>(
      'SELECT name FROM servers WHERE active = 1 AND installed = 1',
    );
    for (const row of activeRows) {
      const server = registry.getByName(row.name);
      if (!server) continue;
      try {
        await proxy.activate({
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
        // Clear the stale active flag so we don't retry forever
        registry.setActive(server.name, false);
      }
    }
  })();

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
    close() {
      if (closed) return;
      closed = true;
      proxy.deactivateAll().catch(() => {});
      events.removeAll();
      db.close();
    },
  };
}
