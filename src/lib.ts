// =============================================================================
// agent-discover — Library API
//
// Public exports for programmatic use. Import from 'agent-discover/lib'.
// The default export (index.ts) is the CLI (stdio shim / daemon).
// =============================================================================

export { createContext, type AppContext, type ContextOptions } from './context.js';
export { startDaemon, type Daemon, type DaemonOptions } from './daemon.js';
export { ensureDaemon } from './shim.js';
export { loadConfig, type Config, type ExposureMode } from './config.js';
export { createDb, type Db, type DbOptions } from './storage/database.js';

export { ServerStore, toConfig, validateServerInput } from './domain/servers.js';
export {
  ToolIndex,
  type IndexDiff,
  type ToolHit,
  type ToolIndexOptions,
} from './domain/tool-index.js';
export {
  HybridRanker,
  DEFAULT_HYBRID,
  type HybridOptions,
  type Ranker,
  type RankedHit,
} from './domain/ranker.js';
export type { EnrichmentProvider } from './domain/enrichment.js';
export type { Enrichment } from './domain/tool-doc.js';
export { toolHash } from './domain/tool-hash.js';
export {
  ServerLifecycle,
  splitToolName,
  type TrustHooks,
  type LifecycleEvent,
  type ServerStatus,
} from './domain/lifecycle.js';
export { ConnectionPool, type HealthResult, type CallOptions } from './domain/pool.js';
export { MarketplaceClient } from './domain/marketplace.js';
export { InstallerService, type InstallConfig } from './domain/installer.js';
export { SecretsService } from './domain/secrets.js';
export { MetricsService } from './domain/metrics.js';
export { syncSetupFile, readSetupFile, getSetupFilePath } from './domain/setup.js';
export type { SetupFile, SetupServerEntry, SyncResult } from './domain/setup.js';

export type {
  ServerSource,
  ServerTransport,
  HealthStatus,
  ServerEntry,
  ServerInput,
  ServerUpdate,
  ServerConfig,
  UpstreamTool,
  IndexedTool,
  SecretEntry,
  MetricEntry,
  MarketplaceServer,
  MarketplacePackage,
  MarketplaceResult,
} from './types.js';
export {
  RegistryError,
  NotFoundError,
  ValidationError,
  ConflictError,
  UpstreamError,
} from './types.js';
