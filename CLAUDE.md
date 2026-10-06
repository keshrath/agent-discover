# agent-discover

One local daemon that discovers, installs (with consent and provenance) and enables or disables MCP servers at runtime, for any MCP host. Version 3.x.

## Architecture

Layered, explicit dependency injection (no global state). `src/context.ts` is the DI root and builds one `AppContext` that every transport shares.

```
src/
  index.ts      CLI entry: `agent-discover` = stdio shim, `agent-discover daemon` = the daemon
  daemon.ts     the single process: node:http on 127.0.0.1:3424 (REST for the pane, /mcp), idle exit
  shim.ts       stdio <-> /mcp bridge; ensures the daemon (health probe, lockfile + log in the data dir, detached spawn)
  config.ts     env var config (port, mode, idle, caps, registry URL, ...)
  context.ts    DI root
  lib.ts        programmatic API (createContext, ...)
  mcp/          server.ts (MCP server, native tools, resources, upstream relay), tools.ts (8 meta tools),
                prompts.ts, http.ts (Streamable HTTP endpoint, 2026 + 2025 legs)
  domain/       servers (ServerStore), lifecycle (ServerLifecycle), pool (upstream connections),
                tool-index + tool-doc + tool-hash + ranker (search), install-plan + provenance +
                marketplace + registry (RegistryMirror), oauth, secrets, setup, metrics, log, sampling,
                trust/ (pins, hygiene, secret-store, audit, telemetry)
  embeddings/   none | local (opt-in) | openai
  transport/    rest.ts, http.ts (JSON, router), guard.ts (Host/Origin/Content-Type), token.ts
  storage/      database.ts (better-sqlite3, WAL, version-ordered migrations)
  widgets/      MCP Apps widget (ui://agent-discover/app.html), built to dist/widgets/app.html
plugin/         Claude Code plugin (.mcp.json shim, skills, SessionStart hook, statusline script,
                hooks/register.tsx + view.tsx = the /discover pane, status entry, toasts, attention band)
bench/          retrieval/ (offline ranker bench, CI-gated) and the agent-loop bench
```

- **No frameworks.** No React, Vue, Express. Node.js + TypeScript on the MCP SDK v2 packages (`@modelcontextprotocol/server|client|node|core`).
- **`ServerLifecycle` is the single authority** for install -> index -> enable/disable -> uninstall. MCP tools, REST routes (the pane) and the setup file are thin adapters over it. Indexing is independent of enablement; disabling never clears the index.
- **Server states:** installed, indexed, enabled, connected (lazy, pooled), quarantined.
- **Modes:** `AGENT_DISCOVER_MODE=native` (default) lists enabled servers' tools as `<server>__<tool>` with `list_changed`; `proxy` lists only the meta tools and calls go through `call_tool`.
- **No agent-common dependency.** The request guard and REST token live in `src/transport/`.
- `src/index.ts` and the tool/REST contracts are what hosts see; keep `src/` host-agnostic. Claude-specific glue belongs in `plugin/`.
- Upstream `CallToolResult` objects are passed through verbatim.

## Trust layer (src/domain/trust/)

Tool pinning with quarantine and re-approval (`pins.ts`), description hygiene (`hygiene.ts`), secrets in the OS keychain or an encrypted file (`secret-store.ts`), append-only audit log (`audit.ts`), opt-in OpenTelemetry (`telemetry.ts`). `TrustService` (`trust/index.ts`) implements the `TrustHooks` that `ServerLifecycle` calls. Model: `docs/SECURITY.md`.

## UI surfaces

There is no web dashboard (removed in 3.0, with the WebSocket and agent-desk support). Three surfaces:

- **Claude Code pane** (`plugin/hooks/register.tsx` + `view.tsx`, Claude Code 2.1.289+ function hooks): `/discover` opens it; tabs Servers (detail per server: quarantine diff + Approve, actions, health checked on open, usage, OAuth sign-in only once a server asked for it, tools + schemas, config keys with their value source and a masked secrets editor), Browse (search, install plan, POST /api/install), Logs, Audit; pending upstream questions on top. REST only, mutations with `X-Agent-Discover-Token` (`GET /api/token`, no Origin). View state in `$.state` (contract `plugin/types/index.d.ts`); typed secret values never enter state (masked fields draw bullets; `masked` holds lengths only). Opened as a plain sidebar (no `closeOnEscape`), and `/discover` reports `isPlaced: false` with the reason. Every function that takes `$` must be a top-level declaration (`claude plugin validate` enforces it). Tests: `plugin/tests/*.test.ts` under `claude plugin test plugin`; the real CLI: `npm run e2e:claude` (`tests/e2e-claude/`, node-pty + xterm, scratch daemon and plugin copy, screenshots in `~/.claude/tmp/pane-shots/`, see CONTRIBUTING.md). Type-check with a tsconfig outside the folder (never `tsc -p plugin`, it emits .js into plugin/).
- **MCP Apps widget** (`src/widgets/`): Claude Desktop, claude.ai, VS Code.
- **Markdown text** of every meta tool result (`src/widgets/text.ts`) for every other host (OpenCode, Cursor, Codex). Fallbacks that need a person point at `/discover` or `AGENT_DISCOVER_ALLOW_UNCONFIRMED_INSTALL=1`, never at a URL.

## Code Style

- ESLint + Prettier enforced via lint-staged (husky pre-commit). TypeScript strict, no `any`.
- No inline comments beyond file-level headers and the occasional why-comment.

## Versioning

- Version lives in `package.json` and is read at runtime (`/api/health`, MCP `initialize`). Never hardcode version strings.
- `package.json`, `server.json` (top-level and package entry) and `plugin/.claude-plugin/plugin.json` must stay on the same version (`tests/manifest.test.ts`); `plugin/.mcp.json` pins the major (`agent-discover@^3`).
- Commit message format: `vX.Y.Z: short description`. Patch bumps get no CHANGELOG entry; feature releases do.

## Build & Test

```
npm run build              # tsc + build the widget
npm test                   # vitest (24 files, 192 tests; +9 e2e skipped unless AGENT_DISCOVER_E2E=1, +14 unless AGENT_DISCOVER_E2E_CLAUDE=1)
npm run check              # typecheck + lint + format + test
npm run bench:retrieval    # offline ranker bench; CI runs it with --check
npm run plugin:check       # claude plugin validate + test (needs the claude CLI; 9 pane tests)
npm run e2e:claude         # the pane in the real Claude Code CLI (14 tests, ~2 min, screenshots)
npm run widgets:shots      # widget screenshots against real tool results
```

## Key APIs

Full reference: `docs/API.md`.

- **MCP** (`/mcp`): `search_servers`, `install_server`, `enable_server`, `disable_server`, `server_status`, `search_tools`, `get_tool`, `call_tool`; prompts `discover`, `install`, `status`; resource `ui://agent-discover/app.html`; in native mode also `<server>__<tool>` for every enabled server.
- **REST** (what the pane uses): `GET /api/health`, `GET /api/token`, `GET /api/status`; servers `GET|POST /api/servers`, `GET|PUT|DELETE /api/servers/:id`, `POST .../enable|disable|index|health|reset-errors|approve`, `GET .../trust|metrics|auth`, `POST .../auth`, `GET|PUT|DELETE .../secrets[/:key]`; `GET /api/metrics`; `GET /api/audit`; `GET /api/browse`, `GET /api/install/plan`, `POST /api/install`; `GET /api/registry`, `POST /api/registry/sync`; `GET /api/logs`; `GET /api/elicitations`, `POST /api/elicitations/:id/respond`; `GET /oauth/callback`.

## DB

- SQLite `agent-discover.db` in the data dir: `AGENT_DISCOVER_DATA_DIR`, else `%LOCALAPPDATA%\agent-discover` (Windows), `~/Library/Application Support/agent-discover` (macOS), `$XDG_DATA_HOME/agent-discover` or `~/.local/share/agent-discover` (Linux). `AGENT_DISCOVER_DB` overrides the file. A 1.x `~/.claude/agent-discover.db` (+ `-wal`/`-shm`, `agent-discover-secrets.json`/`.key`) is moved there once on first start (default dir only); startup fails while another process holds the old DB open.
- Schema version: **11** (migrations in `src/storage/database.ts`, applied in version order; add a new one, never edit an old one).
- Tables: `servers`, `server_tools` (+ `server_tools_fts`), `servers_fts`, `server_secrets` (key names and backend only), `server_metrics`, `server_pins`, `audit_log`, `registry_servers` (+ `registry_servers_fts`), `_meta`.

## Search

`ToolIndex.save` is the only writer of `server_tools` and its FTS table, keyed by `tool_hash`. `HybridRanker` (`ranker.ts`) does FTS5 BM25 with field weights, typo repair, optional dense fusion and server routing. Every constant was tuned on the dev split of `bench/retrieval`; report the test split. Change a ranker on purpose by committing new `bench/retrieval/_results` with it.
