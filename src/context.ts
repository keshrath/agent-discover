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

  db.run('UPDATE servers SET active = 0');

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
