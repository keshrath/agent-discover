# Contributing to agent-discover

## Getting Started

```bash
git clone https://github.com/keshrath/agent-discover.git
cd agent-discover
npm install
npm run build
```

Prerequisites: Node.js >= 20.11, npm, Git. `npm install` also builds `better-sqlite3`, which needs a working native toolchain or a prebuilt binary for your platform.

## Development

```bash
npm run build            # tsc + build the MCP Apps widget
node dist/index.js daemon    # run the daemon (REST + /mcp on http://127.0.0.1:3424)
npm test                 # vitest
npm run test:watch
npm run check            # typecheck + lint + format check + test
npm run bench:retrieval  # offline ranker bench (see bench/retrieval/README.md)
npm run plugin:check     # claude plugin validate + test (needs the claude CLI)
npm run widgets:shots    # screenshots of the widget against real tool results
```

`AGENT_DISCOVER_PORT` and `AGENT_DISCOVER_DB` point a dev daemon at a scratch port and database. Never develop against a database a real session is using: migrations only move forward.

## Project structure

```
src/
  index.ts       CLI entry: stdio shim (default) or `daemon`
  daemon.ts      the single process: HTTP server for REST and /mcp; idle exit
  shim.ts        stdio <-> /mcp bridge that ensures the daemon
  config.ts      environment configuration
  context.ts     DI root: builds every service into one AppContext (no global state)
  lib.ts         programmatic API
  types.ts       shared types and errors
  mcp/           server.ts, tools.ts (8 meta tools), prompts.ts, http.ts (2026 + 2025 legs)
  domain/        lifecycle, servers, pool, tool-index, ranker, tool-doc, tool-hash,
                 install-plan, provenance, marketplace, registry, oauth, secrets, setup,
                 metrics, log, sampling, trust/
  embeddings/    none, local, openai providers
  transport/     rest.ts, http.ts, guard.ts, token.ts
  storage/       database.ts (SQLite, migrations)
  widgets/       MCP Apps widget sources and build
plugin/          Claude Code plugin (skills, hooks, the /discover pane, status line script)
bench/           retrieval/ (offline ranker bench) and the agent-loop bench
tests/           vitest suites, fixtures (fake upstream, mock OAuth server, registry), widget harness
scripts/         setup.js
docs/            ARCHITECTURE, API, SECURITY, SETUP, USER-MANUAL
```

Architecture in depth: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Code style

- TypeScript strict, ES modules, no `any`.
- No frameworks (no React, Vue, Express). Node.js and TypeScript on the MCP SDK v2 packages.
- Services receive their dependencies explicitly via `context.ts`.
- `ServerLifecycle` is the single authority for install, index, enable, disable and uninstall. MCP tools, REST routes and the setup file are adapters; do not duplicate lifecycle logic in a transport.
- `src/` stays host-agnostic. Claude-specific code belongs in `plugin/`.
- ESLint and Prettier run in the husky pre-commit hook through lint-staged.

## Testing

Tests use vitest with in-memory SQLite and a fake upstream MCP server (`tests/fixtures/upstream.mjs`); there is also a mock OAuth authorization server and a fake registry. Add or update tests with every behavior change. The `/discover` pane has its own suite under `plugin/tests/`: `npm run plugin:check` (`claude plugin validate` + `claude plugin test`).

## Database migrations

Schema changes go in `src/storage/database.ts`:

1. Append a new entry with the next version to `migrations` (the current version is **10**).
2. Never edit an existing migration. Migrations are applied only above the stored version, so changing an old one does nothing for existing databases.
3. Keep them idempotent (`CREATE ... IF NOT EXISTS`, guarded `ALTER TABLE ADD COLUMN`) and SQL-only. A data move that needs a service belongs in that service's constructor.
4. Cascade deletes from `servers` via foreign keys.

Tables: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#database-schema-version-10).

## Search changes

Ranker constants were tuned on the dev split of `bench/retrieval` only. Tune on `--split=dev`, report `--split=test`, and commit the new `bench/retrieval/_results` with the change. CI runs `npm run bench:retrieval -- --check` and fails when dev or test R@10 or MRR drops below the committed results.

## Pull requests

1. Branch from `main`.
2. `npm run check` passes, and `npm run bench:retrieval -- --check` if search changed.
3. Tests for new behavior; one logical change per commit.
4. Update the docs that describe what you changed (API.md for tools and routes, SECURITY.md for trust changes). A feature release also gets a CHANGELOG entry; a patch release does not.

## Versioning and commits

- Commit message: `vX.Y.Z: short description`, a single line. No co-author or tool-attribution trailers.
- `package.json`, `server.json` and `plugin/.claude-plugin/plugin.json` carry the same version. The version is read at runtime from `package.json`; never hardcode it.
- A tag `vX.Y.Z` triggers the GitHub Actions publish to npm and the MCP Registry.

## License

MIT
