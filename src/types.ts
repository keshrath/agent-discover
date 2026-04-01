// =============================================================================
// agent-discover — Core type definitions
// =============================================================================

// ---------------------------------------------------------------------------
// Server Registry
// ---------------------------------------------------------------------------

export type ServerSource = 'local' | 'registry' | 'smithery' | 'manual';
export type ServerTransport = 'stdio' | 'sse' | 'streamable-http';
export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

export interface ServerEntry {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly source: ServerSource;
  readonly command: string | null;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly tags: string[];
  readonly package_name: string | null;
  readonly package_version: string | null;
  readonly transport: ServerTransport;
  readonly repository: string | null;
  readonly homepage: string | null;
  readonly installed: boolean;
  readonly active: boolean;
  readonly latest_version: string | null;
  readonly last_health_check: string | null;
  readonly health_status: HealthStatus;
  readonly error_count: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ServerCreateInput {
  name: string;
  description?: string;
  source?: ServerSource;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  tags?: string[];
  package_name?: string;
  package_version?: string;
  transport?: ServerTransport;
  repository?: string;
  homepage?: string;
}

export interface ServerTool {
  readonly id: number;
  readonly server_id: number;
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface ServerUpdateInput {
  description?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  tags?: string[];
  transport?: ServerTransport;
  homepage?: string;
}

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
// Events
// ---------------------------------------------------------------------------

export type EventType =
  | 'server:registered'
  | 'server:updated'
  | 'server:unregistered'
  | 'server:activated'
  | 'server:deactivated'
  | 'server:installed'
  | 'server:uninstalled';

export interface RegistryEvent {
  readonly type: EventType;
  readonly timestamp: string;
  readonly data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

export class NotFoundError extends RegistryError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends RegistryError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 422);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends RegistryError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
    this.name = 'ConflictError';
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC (MCP transport)
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}
