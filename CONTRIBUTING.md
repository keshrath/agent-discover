# Contributing to agent-discover

## Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/keshrath/agent-discover.git
   cd agent-discover
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build:
   ```bash
   npm run build
   ```

## Development Setup

### Prerequisites

- **Node.js >= 20** (LTS recommended)
- **npm >= 10**
- **Git**

### Development Mode

```bash
# Build the project
npm run build

# Start dashboard standalone (port 3424)
npm run start:server

# Run tests
npm test
npm run test:watch

# Full check pipeline
npm run check
```

### Environment

The dashboard auto-starts on port 3424 when the MCP server launches. Override with `AGENT_DISCOVER_PORT`.

## Project Structure

```
agent-discover/
  src/
    index.ts              Entry point (MCP stdio + dashboard auto-start)
    context.ts            DI root — wires all services (no global state)
    server.ts             HTTP + WebSocket standalone server
    types.ts              Shared types (ServerEntry, errors, JSON-RPC)
    version.ts            Runtime version reader from package.json
    domain/
      registry.ts         Server CRUD, FTS search, tool management
      proxy.ts            MCP child server lifecycle + tool proxying + secrets merge + metrics recording
      marketplace.ts      Official MCP registry API client
      installer.ts        Install method detection (npm, python, docker)
      secrets.ts          Per-server secret storage + env var generation
      health.ts           Health check probes + status tracking
      metrics.ts          Per-tool call/error/latency tracking
      events.ts           In-process event bus
    storage/
      database.ts         SQLite (WAL mode, schema versioning V2, FTS5)
    transport/
      mcp.ts              7 MCP tool definitions + proxied tool merge
      mcp-handlers.ts     Tool handler implementations
      rest.ts             REST API endpoints + static file serving
      ws.ts               WebSocket state streaming (DB polling)
    ui/
      index.html          Dashboard SPA
      styles.css          Light/dark theme (MD3 design tokens)
      app.js              Client-side vanilla JS (WebSocket, tabs, rendering)
  tests/
    registry.test.ts      Server CRUD, search, tool management
    proxy.test.ts         MCP proxy lifecycle
    marketplace.test.ts   Marketplace API client
    mcp-handlers.test.ts  MCP tool handler dispatch
    rest.test.ts          REST endpoint tests
  scripts/
    copy-ui.js            Post-build: copies UI files to dist/
    setup.js              Auto-configures Claude Code MCP settings
```

## Code Style

- **TypeScript** with strict mode, ES modules
- **No `any`** — ESLint rule enforced
- **No inline comments** — use file-level section headers only (`// === Section ===` or `// --- Section ---`)
- **Naming**: `camelCase` for functions/variables, `PascalCase` for types/classes, `UPPER_SNAKE` for constants
- **Async**: use `async`/`await` over raw promises
- **No frameworks** — no React, Vue, Express. Pure Node.js + TypeScript
- **Dependency injection** — services receive `Db` and `EventBus` via `context.ts`, no global state
- **ESLint + Prettier** enforced via lint-staged (husky pre-commit)

## Testing

```bash
npm test                          # Run all tests
npm run test:watch                # Watch mode
npm run test:coverage             # Coverage report (v8 provider)
npm run lint                      # ESLint
npm run typecheck                 # Type-check (tsc --noEmit)
npm run check                     # Full pipeline: typecheck + lint + format + test
```

Tests use **vitest** with in-memory SQLite databases. Each test gets a fresh context.

### What to Test

- Domain: server registration/search, proxy lifecycle, marketplace client, installer detection
- Transport: MCP tool dispatch, REST endpoints, WebSocket state
- Integration: install-from-registry flow, activate/deactivate lifecycle

## Database Migrations

Schema changes go in `src/storage/database.ts`. Follow this pattern:

1. Add a new `migrateVN()` block inside `applySchema()`
2. Increment `SCHEMA_VERSION`
3. Migrations **must be idempotent** — use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` with existence checks
4. All tables use foreign keys with `ON DELETE CASCADE`

Current schema version: **V3**

### Tables

- `servers` -- registered MCP servers (name, command, args, env, tags, source, transport, health_status, error_count, last_health_check, latest_version)
- `server_tools` -- tools discovered from active servers (FK to servers)
- `server_secrets` -- per-server secrets for env var injection on activation (FK to servers, unique on server_id+key)
- `server_metrics` -- per-tool call counts, error counts, and latency (FK to servers, unique on server_id+tool_name)
- `servers_fts` -- FTS5 virtual table for full-text search (synced via triggers)

## Pull Requests

1. Fork the repository
2. Create a feature branch from `main`
3. Ensure all checks pass: `npm run check`
4. Write or update tests for your changes
5. Keep commits focused — one logical change per commit

### PR checklist

- [ ] `npm run check` passes (typecheck + lint + format + test)
- [ ] New features have tests
- [ ] No `any` types introduced
- [ ] No inline comments (use section headers)

## Commit Messages

Format: `v1.0.x: short description`

Every commit must bump the patch version minimum. No Co-Authored-By or AI branding.

## License

MIT
