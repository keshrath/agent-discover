// =============================================================================
// agent-discover — Library API
//
// Public exports for programmatic use. Import from 'agent-discover/lib'.
// The default export (index.ts) is the MCP stdio server.
// =============================================================================

// Context (entry point for library consumers)
export { createContext, type AppContext } from './context.js';

// Storage
export { createDb, type Db, type DbOptions } from './storage/database.js';

// Domain services
export { RegistryService } from './domain/registry.js';
export { McpProxy } from './domain/proxy.js';
export { MarketplaceClient } from './domain/marketplace.js';
export { InstallerService } from './domain/installer.js';
export { SecretsService } from './domain/secrets.js';
export { HealthService } from './domain/health.js';
export { MetricsService } from './domain/metrics.js';
export { EventBus } from './domain/events.js';

// Domain-level types
export type { ServerConfig, ProxiedTool, ParsedToolName } from './domain/proxy.js';
export type { InstallConfig } from './domain/installer.js';
export type { HealthCheckResult, HealthInfo } from './domain/health.js';

// Types
export type {
  ServerSource,
  ServerTransport,
  HealthStatus,
  ServerEntry,
  ServerCreateInput,
  ServerTool,
  ServerUpdateInput,
  SecretEntry,
  MetricEntry,
  MarketplaceServer,
  MarketplacePackage,
  MarketplaceResult,
  EventType,
  RegistryEvent,
  JsonRpcRequest,
  JsonRpcResponse,
  ToolDefinition,
} from './types.js';

// Setup file
export { syncSetupFile, readSetupFile, getSetupFilePath } from './domain/setup.js';
export type { SetupFile, SetupServerEntry, SyncResult } from './domain/setup.js';

// Error classes
export { RegistryError, NotFoundError, ValidationError, ConflictError } from './types.js';
