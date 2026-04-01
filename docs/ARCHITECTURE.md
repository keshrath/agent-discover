# Architecture

## Overview

agent-discover is an MCP server registry and marketplace. It lets AI agents discover, install, activate, and manage MCP tool servers on demand. Rather than statically configuring every MCP server upfront, agents can browse a marketplace, install servers, and activate them at runtime -- with tools appearing dynamically.

## Layered Architecture

```
+---------------------------------------------+
|  Transport Layer                            |
|  +----------+ +----------+ +-------------+ |
|  | MCP/stdio| | REST/HTTP| |  WebSocket  | |
|  +----------+ +----------+ +-------------+ |
+---------------------------------------------+
|  Domain Layer                               |
|  +----------+ +----------+ +-------------+ |
|  | Registry | |  Proxy   | | Marketplace | |
|  +----------+ +----------+ +-------------+ |
|  +----------+ +----------+ +-------------+ |
|  |Installer | |  Events  | |  Secrets    | |
|  +----------+ +----------+ +-------------+ |
|  +----------+ +----------+                  |
|  |  Health  | | Metrics  |                  |
|  +----------+ +----------+                  |
+---------------------------------------------+
|  Storage Layer                              |
|  +--------------------------------------+   |
|  |  SQLite (better-sqlite3, WAL mode)  |   |
|  +--------------------------------------+   |
+---------------------------------------------+
```

### Transport Layer

- **MCP (stdio)**: JSON-RPC over stdin/stdout. Entry point: `src/index.ts`. Handles `initialize`, `tools/list`, `tools/call`, `ping`. Sends `notifications/tools/list_changed` when servers are activated/deactivated.
- **REST (HTTP)**: Lightweight HTTP API using `node:http` (no Express). Serves both JSON API endpoints and static UI files. Entry point: `src/transport/rest.ts`.
- **WebSocket**: Real-time state streaming to dashboard clients. Sends full state snapshots, uses DB fingerprint polling for change detection. Entry point: `src/transport/ws.ts`.

### Domain Layer

- **RegistryService** (`src/domain/registry.ts`): CRUD operations for the local server registry. Handles registration, listing, FTS search (via SQLite FTS5), and tool metadata storage. Supports `update` and `updateById` for modifying server config.
- **McpProxy** (`src/domain/proxy.ts`): Manages child MCP server processes. Connects via `StdioClientTransport` from `@modelcontextprotocol/sdk`, discovers tools, and proxies tool calls. Tools are namespaced as `serverName__toolName`. On activation, merges secrets into the server environment. On each tool call, records metrics (latency, success/failure).
- **MarketplaceClient** (`src/domain/marketplace.ts`): HTTP client for the official MCP registry API at `registry.modelcontextprotocol.io`. Supports search, browse, and individual server lookup.
- **InstallerService** (`src/domain/installer.ts`): Detects the install method for a package (npm/npx, Python/uvx, Docker) and builds the appropriate command configuration. Validates package names against a safe regex pattern.
- **SecretsService** (`src/domain/secrets.ts`): Manages per-server secrets (API keys, tokens). Secrets are stored in the `server_secrets` table. Values are masked in API responses (first 4 chars visible). The `getEnvForServer()` method returns all secrets as a key-value map for env var injection on activation.
- **HealthService** (`src/domain/health.ts`): Monitors server health. For active servers, checks via `getServerTools()`. For inactive servers with a command, performs a quick activate/deactivate cycle with a 5-second timeout. Updates `health_status`, `last_health_check`, and `error_count` in the database. Has a `checkAll()` method for batch health checks.
- **MetricsService** (`src/domain/metrics.ts`): Tracks per-tool call counts, error counts, and total latency in the `server_metrics` table. Called automatically by the proxy on each tool call. Provides `getServerMetrics()` for per-server detail and `getOverview()` for a cross-server summary.
- **EventBus** (`src/domain/events.ts`): In-process pub/sub with typed events and wildcard support. Used internally to emit lifecycle events (`server:registered`, `server:activated`, `server:installed`, etc.).

### Storage Layer

- **Database** (`src/storage/database.ts`): Thin wrapper around `better-sqlite3`. WAL mode, foreign keys, busy timeout. Schema is versioned via SQLite's `user_version` pragma (current version: **V3**). Provides a simplified query interface (`run`, `queryAll`, `queryOne`, `transaction`).

### Dependency Injection

`src/context.ts` is the DI root. It creates all services and wires them together:

```typescript
interface AppContext {
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
```

The proxy receives references to `SecretsService` and `MetricsService` via setter methods, plus a `serverIdResolver` function that maps server names to database IDs via the registry.

Every layer receives its dependencies explicitly. No global state, no singletons.

## Database Schema (V3)

### servers

| Column            | Type    | Description                                            |
| ----------------- | ------- | ------------------------------------------------------ |
| id                | INTEGER | Primary key (autoincrement)                            |
| name              | TEXT    | Unique server name                                     |
| description       | TEXT    | Human-readable description                             |
| source            | TEXT    | `local`, `registry`, `smithery`, `manual`              |
| command           | TEXT    | Executable command (nullable)                          |
| args              | TEXT    | JSON array of command arguments                        |
| env               | TEXT    | JSON object of environment variables                   |
| tags              | TEXT    | JSON array of tags                                     |
| package_name      | TEXT    | npm/pip package name (nullable)                        |
| package_version   | TEXT    | Package version (nullable)                             |
| transport         | TEXT    | `stdio`, `sse`, `streamable-http`                      |
| repository        | TEXT    | Source repository URL (nullable)                       |
| homepage          | TEXT    | Homepage URL (nullable)                                |
| installed         | BOOLEAN | Whether the server is installed                        |
| active            | BOOLEAN | Whether the server is currently active                 |
| latest_version    | TEXT    | Latest known version (nullable)                        |
| last_health_check | TEXT    | ISO timestamp of last health check (nullable)          |
| health_status     | TEXT    | `healthy`, `unhealthy`, `unknown` (default: `unknown`) |
| error_count       | INTEGER | Cumulative error count (default: 0)                    |
| created_at        | TEXT    | ISO timestamp                                          |
| updated_at        | TEXT    | ISO timestamp                                          |

### server_tools

| Column       | Type    | Description                       |
| ------------ | ------- | --------------------------------- |
| id           | INTEGER | Primary key (autoincrement)       |
| server_id    | INTEGER | FK to servers (ON DELETE CASCADE) |
| name         | TEXT    | Tool name                         |
| description  | TEXT    | Tool description                  |
| input_schema | TEXT    | JSON schema for tool parameters   |

Unique constraint: `(server_id, name)`.

### server_secrets

| Column     | Type    | Description                         |
| ---------- | ------- | ----------------------------------- |
| id         | INTEGER | Primary key (autoincrement)         |
| server_id  | INTEGER | FK to servers (ON DELETE CASCADE)   |
| key        | TEXT    | Secret key name                     |
| value      | TEXT    | Secret value (stored plaintext)     |
| masked     | BOOLEAN | Whether to mask in API (default: 1) |
| created_at | TEXT    | ISO timestamp                       |
| updated_at | TEXT    | ISO timestamp                       |

Unique constraint: `(server_id, key)`. Upsert via `ON CONFLICT ... DO UPDATE`.

### server_metrics

| Column           | Type    | Description                           |
| ---------------- | ------- | ------------------------------------- |
| id               | INTEGER | Primary key (autoincrement)           |
| server_id        | INTEGER | FK to servers (ON DELETE CASCADE)     |
| tool_name        | TEXT    | Name of the tool                      |
| call_count       | INTEGER | Total call count (default: 0)         |
| error_count      | INTEGER | Total error count (default: 0)        |
| total_latency_ms | INTEGER | Cumulative latency in ms (default: 0) |
| last_called_at   | TEXT    | ISO timestamp of last call            |

Unique constraint: `(server_id, tool_name)`.

### servers_fts

FTS5 virtual table for full-text search across `name`, `description`, and `tags`. Kept in sync with the `servers` table via `AFTER INSERT`, `AFTER UPDATE`, and `AFTER DELETE` triggers.

## Proxy Pattern

The proxy is the core differentiator of agent-discover. When a server is activated:

1. `McpProxy.activate()` resolves the server's secrets via `SecretsService.getEnvForServer()` and merges them into the process environment (secrets override config env vars)
2. It spawns the child server process via `StdioClientTransport` with the merged environment
3. It connects as an MCP client and calls `tools/list` to discover available tools
4. Tools are stored in the database and added to the in-memory tool list
5. Each tool is namespaced as `serverName__toolName` to avoid collisions
6. When `tools/list` is called on agent-discover, the proxied tools are merged with the built-in 2 tools
7. When a proxied tool is called, `McpProxy.callTool()` forwards the call to the child server and records metrics (latency, success/failure) via `MetricsService`
8. A `notifications/tools/list_changed` notification tells the MCP client to refresh its tool list

On deactivation, the child process is stopped, tools are removed from the list, and another `tools/list_changed` notification is sent.

### Tool Name Resolution

Tool names are parsed by finding the longest matching server name prefix followed by `__`. This handles cases where server names contain dots or dashes.

### Timeouts

- Activation (connect + tool discovery): 30 seconds
- Tool calls: 60 seconds
- Marketplace API requests: 15 seconds
- Health check (inactive server activate/deactivate): 5 seconds

## Marketplace Integration

The `MarketplaceClient` talks to the official MCP registry API:

- `GET /v0/servers?search=...&limit=...&cursor=...` for browsing/searching
- `GET /v0/servers/:name` for individual server details

When installing from the registry (`source: "registry"`), the flow is:

1. Search the marketplace for the server name
2. Find a matching package (prefer Node.js, fall back to Python)
3. Use `InstallerService` to detect the install method and build the command
4. Register the server in the local database

## Leader Election (Dashboard)

Multiple MCP server instances can run simultaneously (one per MCP client). The first instance to bind port 3424 becomes the dashboard leader. Subsequent instances detect `EADDRINUSE` and skip the dashboard, operating in stdio-only mode. All instances share the same SQLite database (WAL mode supports concurrent readers).
