# agent-discover

## Architecture

Layered architecture with explicit dependency injection (no global state):

```
src/
  domain/     registry (CRUD), proxy (MCP child servers), marketplace (API client),
              installer, secrets, health, metrics, events
  storage/    SQLite (better-sqlite3, WAL mode)
  transport/  REST (node:http), WebSocket (ws), MCP (stdio)
  ui/         Vanilla JS dashboard (no build step for UI)
```

- **No frameworks** -- no React, Vue, Express. Pure Node.js + TypeScript.
- `context.ts` is the DI root -- wires all services together.
- UI files (`index.html`, `app.js`, `styles.css`) are plain files copied to `dist/ui/` on build.

## UI / Dashboard

- **Icons**: Material Symbols Outlined (via Google Fonts CSS). No emojis.
- **Fonts**: Inter (UI text), JetBrains Mono (code/data)
- **Theme**: Light/dark toggle via `.theme-light` / `.theme-dark` class on `<body>`
- **Design tokens**: CSS custom properties (`--bg`, `--accent`, `--border`, `--shadow-*`, etc.)
- **Accent color**: `#5d8da8`
- **Port**: 3424 (configurable via `AGENT_DISCOVER_PORT`)
- **Tabs**: 2 tabs -- Servers (merged installed+active) and Browse
- **Server cards**: health dots, error counts, expandable Secrets/Metrics/Config sections
- **Theme sync**: Supports agent-desk postMessage theme injection + reverse sync

## Code Style

- ESLint + Prettier enforced via lint-staged (husky pre-commit)

## Versioning

- Version lives in `package.json` and is read at runtime (REST `/health`, WS state, UI sidebar)
- Never hardcode version strings
- Every commit must bump the patch version minimum
- Commit message format: `v1.0.x: short description`

## Build & Test

```
npm run build      # tsc + copy UI files to dist/
npm test           # vitest (unit + integration)
npm run check      # typecheck + lint + format + test
```

## Key APIs

- **REST**: `GET /health`, `GET /api/servers`, `GET /api/servers/:id`, `POST /api/servers`, `PUT /api/servers/:id`, `DELETE /api/servers/:id`, `POST /api/servers/:id/activate`, `POST /api/servers/:id/deactivate`, `GET /api/servers/:id/secrets`, `PUT /api/servers/:id/secrets/:key`, `DELETE /api/servers/:id/secrets/:key`, `POST /api/servers/:id/health`, `GET /api/servers/:id/metrics`, `GET /api/metrics`, `GET /api/browse`, `GET /api/status`
- **WebSocket**: Full state on connect, delta updates via DB polling
- **MCP**: 2 action-based tools (`registry` with actions: list/install/uninstall/browse/status, `registry_server` with actions: activate/deactivate) + proxied tools from active servers

## DB

- SQLite at `~/.claude/agent-discover.db` (configurable via `AGENT_DISCOVER_DB`)
- Schema version: **V3**
- Tables: `servers`, `server_tools`, `server_secrets`, `server_metrics`, `servers_fts` (FTS5 virtual table)
- V2 additions: `latest_version`, `last_health_check`, `health_status`, `error_count` columns on `servers`; `server_secrets` and `server_metrics` tables
- V3: dropped `approval_status` column from `servers`

## Domain Services

- **RegistryService** -- Server CRUD, FTS search, tool metadata storage
- **McpProxy** -- Child MCP server lifecycle, tool proxying with namespace, secrets merge on activation, metrics recording on tool calls
- **MarketplaceClient** -- Official MCP registry API client (search, browse)
- **InstallerService** -- Install method detection (npm/npx, Python/uvx, Docker) with package name validation
- **SecretsService** -- Per-server secret storage, masked listing, env var generation for activation
- **HealthService** -- Health probes (connect/disconnect for inactive, tool list check for active), error count tracking
- **MetricsService** -- Per-tool call/error/latency recording, server-level and global overview queries
- **EventBus** -- In-process pub/sub with typed events and wildcard support

## Proxy Pattern

Active MCP servers are connected via `StdioClientTransport`. Their tools are namespaced as `serverName__toolName` and merged into the tool list. Tool calls are proxied through to the child server.

On activation, secrets for the server are merged into the environment (overriding any existing env vars). On each tool call, latency and success/failure are recorded as metrics.
