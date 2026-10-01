// =============================================================================
// agent-discover — Core type definitions
// =============================================================================

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

export type ServerSource = 'local' | 'registry' | 'manual' | 'setup-file';
export type ServerTransport = 'stdio' | 'sse' | 'streamable-http';
export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

/**
 * A server row. States (SPEC §2): installed = the row exists; indexed =
 * `indexed_at` set (tools persisted); enabled = exposed to hosts;
 * quarantined = blocked by a trust hook. Connection state is live-only and
 * comes from the ConnectionPool, never from the DB.
 */
export interface ServerEntry {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly source: ServerSource;
  readonly transport: ServerTransport;
  readonly command: string | null;
  readonly args: string[];
  readonly env: Record<string, string>;
  /** Remote endpoint for sse / streamable-http transports. */
  readonly url: string | null;
  /** Declared HTTP headers for remote transports (secrets may fill values, never add names). */
  readonly headers: Record<string, string>;
  readonly tags: string[];
  readonly package_name: string | null;
  readonly package_version: string | null;
  readonly repository: string | null;
  readonly homepage: string | null;
  readonly enabled: boolean;
  readonly quarantined: boolean;
  readonly indexed_at: string | null;
  readonly health_status: HealthStatus;
  readonly last_health_check: string | null;
  readonly error_count: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ServerInput {
  name: string;
  description?: string;
  source?: ServerSource;
  transport?: ServerTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  tags?: string[];
  package_name?: string;
  package_version?: string;
  repository?: string;
  homepage?: string;
}

export type ServerUpdate = Partial<Omit<ServerInput, 'name' | 'source'>>;

/** Everything needed to open a connection to an upstream server. Built only by `toConfig`. */
export interface ServerConfig {
  readonly name: string;
  readonly transport: ServerTransport;
  readonly command?: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly url?: string;
  readonly headers: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Tool index
// ---------------------------------------------------------------------------

/** A tool as reported by an upstream `tools/list` (the persisted subset). */
export interface UpstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface IndexedTool {
  readonly id: number;
  readonly server_id: number;
  readonly server: string;
  readonly name: string;
  readonly title: string | null;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
  readonly output_schema: Record<string, unknown> | null;
  readonly annotations: Record<string, unknown> | null;
  /** sha256 over name + description + inputSchema + annotations (canonical JSON). */
  readonly tool_hash: string;
}

// ---------------------------------------------------------------------------
// Secrets / metrics
// ---------------------------------------------------------------------------

export interface SecretEntry {
  readonly key: string;
  readonly masked_value: string;
  readonly updated_at: string;
}

export interface MetricEntry {
  readonly tool_name: string;
  readonly call_count: number;
  readonly error_count: number;
  readonly avg_latency_ms: number;
  readonly last_called_at: string | null;
}

// ---------------------------------------------------------------------------
// Marketplace
// ---------------------------------------------------------------------------

export interface MarketplaceServer {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly repository: string | null;
  readonly packages: MarketplacePackage[];
}

export interface MarketplacePackage {
  readonly registry_name: string;
  readonly name: string;
  readonly version: string;
  readonly runtime: string;
  readonly license: string | null;
  readonly url: string | null;
}

export interface MarketplaceResult {
  readonly servers: MarketplaceServer[];
  readonly next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// Errors — `statusCode` is what the REST router answers with
// ---------------------------------------------------------------------------

export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 400,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NotFoundError extends RegistryError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, 'NOT_FOUND', 404);
  }
}

export class ValidationError extends RegistryError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

export class ConflictError extends RegistryError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
  }
}

/** An upstream MCP server failed (connect, timeout, protocol error). */
export class UpstreamError extends RegistryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'UPSTREAM_ERROR', 502, options);
  }
}
