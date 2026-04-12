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
|  +----------+ +----------+ +-------------+ |
|  |  Health  | | Metrics  | | Embeddings  | |
|  +----------+ +----------+ +-------------+ |
+---------------------------------------------+
|  Storage Layer                              |
|  +--------------------------------------+   |
|  |  SQLite (better-sqlite3, WAL mode)  |   |
|  +--------------------------------------+   |
+---------------------------------------------+
```

### Transport Layer

- **MCP (stdio)**: JSON-RPC over stdin/stdout. Entry point: `src/index.ts`. Handles `initialize`, `tools/list`, `tools/call`, `ping`. Sends `notifications/tools/list_changed` when servers are activated/deactivated. Package **name** and **version** for `initialize` (and related health payloads) come from **`src/package-meta.ts`** (cached read of `package.json`). **`src/version.ts`** re-exports the version string for REST, WebSocket, and MCP child `Client` identity.
- **REST (HTTP)**: Lightweight HTTP API using `node:http` (no Express). Serves both JSON API endpoints and static UI files. Entry point: `src/transport/rest.ts`.
- **WebSocket**: Real-time state streaming to dashboard clients. Sends full state snapshots, uses DB fingerprint polling for change detection. Entry point: `src/transport/ws.ts`.

### Domain Layer

- **RegistryService** (`src/domain/registry.ts`): CRUD operations for the local server registry. Handles registration, listing, FTS search (via SQLite FTS5), and tool metadata storage. Supports `update` and `updateById` for modifying server config.
- **McpProxy** (`src/domain/proxy.ts`): Manages child MCP server processes. Connects via `StdioClientTransport` from `@modelcontextprotocol/sdk`, discovers tools, and proxies tool calls. Tools are namespaced as `serverName__toolName`. On activation, merges secrets into the server environment. On each tool call, records metrics (latency, success/failure).
- **MarketplaceClient** (`src/domain/marketplace.ts`): Federated browse/search across three sources, merged into a single `MarketplaceResult`.
  - **Official MCP registry** (`registry.modelcontextprotocol.io/v0/servers`) — primary source, version-deduped by name.
  - **npm search** (`registry.npmjs.org/-/v1/search`) — two parallel variants (`keywords:mcp` and `<query> mcp`) so packages without the `keywords` field (e.g. `@playwright/mcp`) still surface; results filtered to those mentioning `mcp` / `model context protocol`.
  - **PyPI** (`pypi.org/pypi/<name>/json` + `pypi.org/search` HTML scrape) — curated list of well-known Python MCP servers (`mcp-server-fetch`, `mcp-server-git`, `mcp-server-time`, `mcp-server-postgres`, `mcp-server-sqlite`, `mcp-proxy`, …) resolved against the stable per-package JSON API for live metadata, plus a best-effort HTML scrape for anything beyond the curated list.
  - Cross-source dedupe key is `<source>:<name>` so npm/PyPI name collisions both stay visible.
- **InstallerService** (`src/domain/installer.ts`): Detects the install method for a package (npm/npx, Python/uvx, Docker) and builds the appropriate command configuration. Validates package names against `^[@a-zA-Z0-9._/-]+$`.
- **SecretsService** (`src/domain/secrets.ts`): Manages per-server secrets (API keys, tokens). Secrets are stored in the `server_secrets` table. Values are masked in API responses (first 4 chars visible). The `getEnvForServer()` method returns all secrets as a key-value map for env var injection on activation.
- **HealthService** (`src/domain/health.ts`): Monitors server health. For active servers, checks via `getServerTools()`. For inactive servers with a command, performs a quick activate/deactivate cycle with a 60-second timeout (matching `ACTIVATE_TIMEOUT_MS`). Updates `health_status`, `last_health_check`, and `error_count` in the database. Resets `error_count` to 0 on successful checks. Has a `checkAll()` method for batch health checks.
- **MetricsService** (`src/domain/metrics.ts`): Tracks per-tool call counts, error counts, and total latency in the `server_metrics` table. Called automatically by the proxy on each tool call. Provides `getServerMetrics()` for per-server detail and `getOverview()` for a cross-server summary.
- **LogService** (`src/domain/log.ts`): In-memory ring buffer of the last 500 proxied tool calls. Each entry records timestamp, server, tool, args, response text, latency, and success. Auto-prunes entries older than 30 days (configurable via `AGENT_DISCOVER_LOG_RETENTION_DAYS`). Exposes an `onEntry` callback used by the WS transport to broadcast new entries in real time.
- **EventBus** (`src/domain/events.ts`): In-process pub/sub with typed events and wildcard support. Used internally to emit lifecycle events (`server:registered`, `server:activated`, `server:installed`, etc.).
- **Embeddings subsystem** (`src/embeddings/`): Pluggable provider for semantic tool search. Mirrors agent-knowledge's pattern. Default provider is `none` (semantic search disabled, BM25-only ranking) so installs without an embedding key keep working unchanged. Selectable via `AGENT_DISCOVER_EMBEDDING_PROVIDER`:
  - **`none`** (`src/embeddings/none.ts`) — `NoopEmbeddingProvider`. Reports unavailable so callers fall back to BM25.
  - **`local`** (`src/embeddings/local.ts`) — `Xenova/all-MiniLM-L6-v2` (384 dims) via `@huggingface/transformers` (optional peer dep, dynamically imported via indirect string so the package isn't required at compile time). q8 quantized, configurable thread count + idle-unload timeout.
  - **`openai`** (`src/embeddings/openai.ts`) — `text-embedding-3-small` (1536 dims), native `fetch`, batched 256 inputs per request. No SDK dependency.
  - **Factory** (`src/embeddings/factory.ts`) caches the resolved provider, falls back to `NoopEmbeddingProvider` on any unavailable / API-key-missing / model-load-failure case so the registry never crashes on a misconfiguration.
  - **Math + encoding helpers** (`src/embeddings/index.ts`) — `cosineSimilarity`, base64 `encodeEmbedding` / `decodeEmbedding` for SQLite TEXT storage.

  `RegistryService` consumes the provider lazily via `getEmbeddings()` so the factory's dynamic imports only run when somebody actually saves or searches tools. `saveToolsWithEmbeddings()` and `searchToolsHybrid()` use the provider when available; both transparently fall back to BM25-only when the provider name is `none`.

### Hybrid retrieval pipeline (`searchToolsHybrid`)

When semantic search is enabled, `find_tool` and `find_tools` route through hybrid retrieval instead of pure BM25:

1. **Semantic candidates**: brute-force cosine similarity over the entire embedded catalog. Brute force is fast enough for any realistic catalog (~60ms at N=10k with 1536-dim float32 vectors) and avoids a native ANN dependency.
2. **BM25 candidates**: FTS5 over `server_tools_fts` with `name × 4 / description × 1` column weighting + a query preprocessor that expands verb synonyms (`fetch → get`, `cancel → delete`, …) and singularizes plurals (`subscriptions → subscription`).
3. **Hybrid re-rank**: union of both candidate sets, scored `0.7 × cosine + 0.3 × normalized_BM25`. Semantic gets the higher weight because BM25 misses paraphrased queries (e.g. "billing arrangement" never matches "subscription") whereas embeddings handle them naturally.
4. **Confidence label**: derived from the BM25 score gap between top-1 and top-2 — `high` (gap ≥ 0.5), `medium` (≥ 0.15), `low` otherwise.
5. **No-match threshold**: if the top hybrid score falls below `0.25`, `find_tool` returns `{ found: false, top_score, hint }` instead of a low-confidence garbage match. Real queries typically score > 0.4; garbage matches sit around 0.05–0.15.
6. **`did_you_mean` recovery**: when a proxied tool call fails, the proxy intercepts the error and runs a BM25 search by the failed tool name, attaching the top 3 alternatives so the agent can correct in one extra turn.

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
  readonly logs: LogService;
  close(): void;
}
```

The proxy receives references to `SecretsService`, `MetricsService`, and `LogService` via setter methods, plus a `serverIdResolver` function that maps server names to database IDs via the registry.

Every layer receives its dependencies explicitly. No global state, no singletons.

### Cross-process activation hydration

`McpProxy.activeServers` is per-process in-memory state, but the `active` flag in the `servers` table is the cross-process source of truth. On startup, `createContext()` reads `WHERE active = 1 AND installed = 1` and re-activates each row in the local proxy. If hydration fails for any server (binary missing, child crashes), the stale `active` flag is cleared so the next startup doesn't retry forever.

This means a server activated via the dashboard UI in the leader process is automatically picked up by every freshly-spawned MCP client (each Claude Code / Cursor / Codex session that opens a new stdio child) without manual re-activation.

## Database Schema (V5)

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

| Column          | Type    | Description                                                                    |
| --------------- | ------- | ------------------------------------------------------------------------------ |
| id              | INTEGER | Primary key (autoincrement)                                                    |
| server_id       | INTEGER | FK to servers (ON DELETE CASCADE)                                              |
| name            | TEXT    | Tool name                                                                      |
| description     | TEXT    | Tool description                                                               |
| input_schema    | TEXT    | JSON schema for tool parameters                                                |
| embedding       | TEXT    | Base64-encoded float32 vector (V5+, nullable — set when semantic search is on) |
| embedding_model | TEXT    | Model id that produced the embedding (V5+, nullable)                           |

Unique constraint: `(server_id, name)`.

### server_tools_fts (V4+)

FTS5 virtual table over `server_tools(name, description)` with `tokenize='unicode61 remove_diacritics 1'`. Used by `searchTools()` for BM25 ranking with `name × 4 / description × 1` column weighting. Backed by `AFTER INSERT / UPDATE / DELETE` triggers on `server_tools` so it stays in sync automatically.

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
6. When `tools/list` is called on agent-discover, the proxied tools are merged with the single built-in `registry` tool
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

The `MarketplaceClient` performs a federated search across three sources:

| Source                | Endpoint                                               | Notes                                                                                                                                   |
| --------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Official MCP registry | `registry.modelcontextprotocol.io/v0/servers`          | Primary; one row per version → version-deduped by name with semver-ish comparison. `GET /v0/servers/:name` available for direct lookup. |
| npm                   | `registry.npmjs.org/-/v1/search`                       | Two parallel queries: `<q> keywords:mcp` and `<q> mcp`; merged + filtered to mcp-related entries. Tagged `runtime: node`.               |
| PyPI                  | `pypi.org/pypi/<name>/json` + `pypi.org/search` (HTML) | Curated package list resolved against the stable per-package JSON API; HTML scrape augments. Tagged `runtime: python`.                  |

Results merge with cross-source dedupe key `<source>:<name>` so same-named packages on different sources both stay visible. Both fallback queries are best-effort and never block the official-registry response.

When installing from the registry (`source: "registry"`), the flow is:

1. Search the marketplace for the server name.
2. Pick the matching package and use `InstallerService.detectInstallConfig()` to build the command — `npx -y <pkg>` for `runtime: node`, `uvx <pkg>` for `runtime: python`, `docker run -i --rm <image>` for `runtime: docker`.
3. Register the server in the local database.
4. Asynchronously warm the cache: `npm cache add <pkg>` for npx servers, `uv tool install <pkg>` for uvx servers.

### Prereqs probe

`GET /api/prereqs` spawns `<tool> --version` for `npx`, `uvx`, `docker`, and `uv` (using `spawn` with `shell: true` so Windows `.cmd` shims resolve) and returns `{ npx, uvx, docker, uv }`. The dashboard fetches this on load and renders an orange banner above the Browse tab when an install method is unavailable on the host.

## Leader Election (Dashboard)

Multiple MCP server instances can run simultaneously (one per MCP client). The first instance to bind port 3424 becomes the dashboard leader. Subsequent instances detect `EADDRINUSE` and skip the dashboard, operating in stdio-only mode. All instances share the same SQLite database (WAL mode supports concurrent readers).
