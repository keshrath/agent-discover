# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-04-12

### Added

- **Log search** — text input in the Logs tab filter bar. Searches across server name, tool name, args JSON, and response text (case-insensitive substring match).
- **Log time range filter** — "From" and "To" datetime-local pickers to narrow logs to a specific window.

### Changed

- **Log timestamps now include date** — format changed from `HH:MM:SS` to `YYYY-MM-DD HH:MM:SS` so entries from different days are distinguishable.

## [1.3.0] - 2026-04-12

### Added

- **Add Server form** in the Servers tab. Collapsible panel with Name, Transport (Local stdio / Remote URL), Command+Args or URL fields, Description, Env vars, and Tags. Submits via `POST /api/servers`.
- **Logs tab** — third dashboard tab showing a real-time call log of all proxied MCP tool calls. Click any row to expand full-width Args and Response panels below. Filter by server or success/fail status. "Clear All" button to wipe the log. Badge in sidebar shows entry count.
- **`LogService`** (`src/domain/log.ts`) — in-memory ring buffer (500 entries, configurable via `AGENT_DISCOVER_LOG_RETENTION_DAYS`, default 30 days auto-prune). New log entries are broadcast to all connected WS clients as `log_entry` messages for real-time streaming.
- **`POST /api/servers/:id/call`** — REST proxy endpoint to call a tool on an active server without going through MCP stdio. Used by the dashboard for testing and generates log entries.
- **`POST /api/servers/:id/reset-errors`** — resets a server's error count to 0.
- **`GET /api/logs`** — returns log entries with pagination (`limit`, `offset`).
- **`DELETE /api/logs`** — clears all log entries.
- **Clear errors button** on server cards when error count > 0.
- **Error count auto-reset** on successful health probe — `HealthService.checkServer()` now sets `error_count = 0` in the healthy branch.

### Changed

- **Logs expand layout** — Args and Response render as stacked full-width panels below the clicked row instead of inline `<details>` elements in table cells.
- **Styled scrollbars** throughout the Logs tab (thin, themed via `--scrollbar-thumb` CSS variable).

## [1.2.5] - 2026-04-12

### Fixed

- **Multi-process hydrate no longer corrupts `servers.active`.** The per-process `McpProxy.activeServers` map used to be rebuilt on every context creation, so every fresh stdio child (one per connected MCP client) raced to spawn a duplicate child for the same server, and whichever lost the race flipped `active = 0` via `setActive(name, false)` in the `catch` branch of the hydrate IIFE. Real symptom: a server that `registry.activate` had just successfully activated would appear as "Inactive" in the dashboard seconds later, even though the stdio child that ran the activate still had a live bridge. Fix: extracted the hydrate logic into an exported `hydrateActiveServers(ctx)` function, removed the auto-invocation from `createContext`, and only call it from `src/index.ts` after `startDashboard` binds successfully — so only the primary process (the one that owns port 3424) rebuilds the map. Secondary stdio children leave the DB flag alone. Hydrate failures in the primary process are now informational log lines only — they never flip `active = 0`, because a failed hydrate is often a transient spawn race and we should not punish the DB state that the REST + WS dashboard depends on.
- **`HEALTH_CHECK_TIMEOUT_MS` raised from 5 s to 60 s** (`src/domain/health.ts`). When a health probe arrives for a server that is not currently in the local process's proxy map, the health service runs a full activate / deactivate cycle — which for an `npx -y mcp-remote …` wrapper involves npm cold-start, package download, HTTP handshake with the remote, and `tools/list`. 5 s was never enough; every cold probe returned `{status:"unhealthy", latency_ms:5141, error:"Health check timed out"}` and the dashboard surfaced the server as Unhealthy even when a plain `proxy_call` round-tripped fine. 60 s matches `ACTIVATE_TIMEOUT_MS` in `src/domain/proxy.ts`.
- **Hydrate is idempotent.** The new `hydrateActiveServers` skips any server where `proxy.isActive(name)` is already true, so calling it twice in the same process (e.g. future use of `hydrateActiveServers` as an imperative refresh) never throws `"Server already active"`.

### Added

- **`tests/domain/hydrate.test.ts`** — unit coverage for `hydrateActiveServers`: empty-DB no-op, does not flip `active = 0` when `proxy.activate` throws, skips already-active servers, and happy-path restores an entry into the in-memory proxy map.

## [1.2.4] - 2026-04-11

### Fixed

- **`src/ui/app.js`** `initTheme()`: added a null-guard before attaching the click handler on `#theme-toggle`. The element is absent when agent-discover's UI is mounted as an embedded plugin inside agent-desk's shadow DOM (the host drives theming), and the unguarded `toggle.addEventListener` was throwing `TypeError: Cannot read properties of null` during plugin init. That crash cascaded into (a) the Discover view rendering completely blank in agent-desk, and (b) every view switch firing a renderer pageerror. The sibling `updateThemeIcon` helper already had the guard; `initTheme` just forgot. One-line fix: `if (!toggle) return;` before the listener wiring.

## [1.2.3] - 2026-04-09

### Documentation

- **README.md**: bumped test count to 179, added the new badge for 11 registry actions, rewrote the "MCP Tools" section to document `find_tool` / `find_tools` / `get_schema` / `proxy_call` with the auto_activate guidance, expanded the Features list to lead with single-call discovery + pluggable embeddings + indirect invocation, added the embeddings env-var section, linked the bench README headline result.
- **CHANGELOG.md**: backfilled v1.1.3 / v1.1.4 / v1.2.0 / v1.2.1 / v1.2.2 entries.
- **docs/API.md**: documented all 4 new registry actions with parameters and example payloads + responses, added the no-match threshold semantics for `find_tool`.
- **docs/ARCHITECTURE.md**: added the embeddings provider layer to the layered diagram, documented the `src/embeddings/` subsystem (none/local/openai), the hybrid retrieval pipeline, the `0.25` no-match threshold, the migration to schema V5, and the new `embedding` / `embedding_model` columns on `server_tools`.
- **docs/USER-MANUAL.md**: new sections for `registry_find_tool` / `registry_find_tools` / `registry_get_schema` / `registry_proxy_call` with usage examples, added the embeddings env-var table to the configuration section.
- **docs/SETUP.md**: added the embeddings env-var table with full enable/disable walkthrough for both local and openai providers.

## [1.2.2] - 2026-04-09

### Fixed

- **`find_tool` / `find_tools` no-match detection.** Hybrid retrieval (introduced in 1.2.0) returned at least one match for every query because cosine similarity is non-zero for every embedded tool, so the existing `matches.length === 0` guard never fired and a query like `"totally nonexistent xyzzy"` would surface a low-confidence garbage tool. Both actions now apply a `MIN_SCORE_THRESHOLD = 0.25` to the top result and return `{ found: false, top_score, hint }` when nothing crosses it. Real queries (typical scores > 0.4) are unaffected; garbage matches (~0.1) are now correctly rejected. Caught by the v1.2.x E2E test pass.

## [1.2.1] - 2026-04-09

### Added

- **Pluggable embedding providers (`src/embeddings/`).** Multi-provider subsystem mirroring agent-knowledge's pattern, with semantic search opt-in via `AGENT_DISCOVER_EMBEDDING_PROVIDER` (default `none` so existing installs without an embedding key keep working with BM25-only ranking). Providers shipped:
  - `none` — `NoopEmbeddingProvider`, returned by default. Reports unavailable so callers transparently fall back to BM25.
  - `openai` — `OpenAIEmbeddingProvider`, `text-embedding-3-small` (1536 dims), native `fetch`, batched 256 inputs per request.
  - `local` — `LocalEmbeddingProvider`, `Xenova/all-MiniLM-L6-v2` (384 dims) via `@huggingface/transformers` (optional peer dep, dynamically imported via indirect string so the package isn't required at compile time). q8 quantized, configurable `AGENT_DISCOVER_EMBEDDING_THREADS` and `AGENT_DISCOVER_EMBEDDING_IDLE_TIMEOUT`.
- **Provider factory** (`src/embeddings/factory.ts`) caches the resolved provider, falls back to `NoopEmbeddingProvider` on any unavailable / API-key-missing / model-load-failure case so the registry never crashes on a misconfiguration.
- **Shared math + encoding helpers** (`cosineSimilarity`, `encodeEmbedding` / `decodeEmbedding`) exported from `src/embeddings/index.ts`.

### Changed

- `RegistryService` constructor no longer eagerly creates the embedding provider — it's lazily resolved via `getEmbeddings()` so the factory's dynamic imports only run when somebody actually saves or searches tools.
- `saveToolsWithEmbeddings()` returns `{ embedded, skipped, provider }` and tolerates per-tool null embeddings cleanly.
- `searchToolsHybrid()` awaits the provider, falls back to plain `searchTools()` when `provider.name === 'none'` or the query embedding fails.

## [1.2.0] - 2026-04-09

### Added

- **`find_tool` registry action — single-call tool discovery.** Hybrid BM25 + semantic ranking returns the top match with a confidence label (`high` / `medium` / `low` derived from the score gap to the runner-up), compact `required_args`, and 4 ranked alternatives in `other_matches`. Auto-activates the owning child server so the agent can call the proxied tool immediately on the next turn. Replaces the old multi-call `search → list → activate` flow that took ~16 round-trips per task in the bench baseline.
- **`find_tools` registry action — batch variant.** Pass `intents: ["intent1", "intent2", …]` to discover N tools in one round-trip for multi-step tasks.
- **`get_schema` registry action.** Returns the full `input_schema` for a tool already discovered via `find_tool`. Use only when the compact `required_args` summary isn't enough (conditional / polymorphic args). Compact-first delivery cuts `find_tool` result tokens 5–10× on heavy registries.
- **`proxy_call` registry action.** Invokes a discovered tool **through** agent-discover without exposing it to the host catalog. Combined with `find_tool({auto_activate: false})`, this keeps the host MCP catalog at exactly 5 agent-discover actions regardless of how many tools the registered child servers actually expose — critical at large catalog sizes where firing `notifications/tools/list_changed` would flood the host with thousands of schemas.
- **`did_you_mean` recovery on tool errors.** When a proxied tool call fails (validation error, missing args, runtime error), the proxy intercepts the response, runs a BM25 search by the failed tool name, and attaches a `did_you_mean` array of similarly-named alternatives. Lets the agent recover from a wrong-tool selection in one extra turn instead of giving up or re-running discovery.
- **FTS5 + BM25 ranking on `server_tools`** (migration v4). Adds a `server_tools_fts` virtual table with name × 4 / description × 1 column weighting, plus a query preprocessor that expands verb synonyms (`fetch → get`, `cancel → delete`, etc.) and singularizes plurals (`subscriptions → subscription`).
- **Embedding columns on `server_tools`** (migration v5). `embedding` (TEXT, base64-encoded float32) and `embedding_model` columns for semantic search. Embeddings are optional; tools without one fall back to BM25 ranking only.
- **Hybrid retrieval (`searchToolsHybrid`).** Brute-force cosine similarity over the entire embedded catalog + BM25 candidate union, scored 70% semantic / 30% lexical. Closes the natural-language gap that pure BM25 misses (e.g. "billing arrangement" → "subscription").
- **Bench harness** under `bench/` comparing eager tool loading vs deferred discovery. Real Claude Code (`bench/drivers/cli.ts`) and OpenCode (`bench/drivers/opencode.ts`) drivers, isolated bench DB, scoring with `success` / `choice_accuracy` / `distractor_call_rate` / `refusal_rate` metrics, and a standalone `bench/rescore.ts` that re-applies the current scoring logic to captured event streams without spending fresh API tokens. Headline result at N=1000 on OpenCode + gpt-5-mini against an adversarial natural-language verb pack: discover 100% / 100% / 0% vs eager 80% / 80% / 20%, with ~27% lower per-turn token cost. Full results in `bench/README.md`.

## [1.1.4] - 2026-04-09

### Added

- Bench iteration adding `find_tools` (plural) and `did_you_mean` recovery — both later carried forward into v1.2.0. See `bench/README.md` for the historical context.

## [1.1.3] - 2026-04-09

### Added

- Bench iteration adding BM25 + confidence labels + compact-first schema delivery — later carried forward into v1.2.0.

## [1.1.2] - 2026-04-08

### Fixed

- **Activation error message rewrite for stdio servers.** When a stdio child process exits before the MCP handshake completes, the SDK reports the opaque `MCP error -32000: Connection closed` — equally true for "command not on PATH" and "child crashed because args were wrong". `McpProxy.activate()` now distinguishes the two by probing the command synchronously with `spawnSync(cmd --version, { shell: true })` and rewrites the failure into either:
  - `command "<cmd>" not found on PATH` — with an install hint pointing at uv / Node / Docker docs when the command is one of those, OR
  - `child process for "<cmd> <args>" exited before the MCP handshake completed — verify the package/args are correct and the server actually starts` — when the command IS on PATH but the package failed to start.

  Both messages preserve the original SDK error in `Original: …` for debugging. Verified end-to-end via Playwright against a real `mcp-server-time` install (uvx-spawned Python child, MCP handshake, two tools discovered) plus negative tests for missing-command and bad-args.

### Tests

- `tests/v110-misc.test.ts`: replaced the two earlier friendly-error tests with sharper ones that lock in the rewrite branching — one asserts `not found on PATH` against an unknown binary, the other asserts `exited before the MCP handshake` against `node /__nope__.js` (proves the on-PATH branch is exercised, not just the unknown-command branch).

## [1.1.1] - 2026-04-08

### Fixed

- **Concurrent `McpProxy.activate()` race.** Two parallel `activate(name)` calls used to both pass the `if (activeServers.has(name))` guard before either awaited `client.connect()`, causing two child processes to spawn for the same logical server. The fix reserves the name in a synchronous `activating` set before any await so the second caller rejects immediately. (`src/domain/proxy.ts`, regression test in `tests/proxy-race.test.ts`)

### Tests

- Quality pass on the v1.1.0 backfill — total suite 151 → 177:
  - `tests/marketplace-extra.test.ts` (11) — `searchNpm` / `searchPypi` augmentation via mocked `fetch`. Failure-mode tests now seed a real registry result and assert it survives intact when npm/pypi blow up, instead of the meaningless `Array.isArray` check. Cross-source dedupe asserts exactly two `mcp-server-sqlite` rows from `npm` + `python`, not `>= 1`.
  - `tests/proxy-headers.test.ts` (4) — locks in CRLF header sanitization on streamable-http and SSE. `readHeaders()` throws if it can't locate the SDK's `requestInit` so an upstream rename fails loudly instead of silently turning the file into a no-op.
  - `tests/proxy-race.test.ts` (2) — regression for the activate-race fix above; mocks the MCP SDK Client to hold `connect()` open across two parallel `activate()` calls.
  - `tests/v110-misc.test.ts` (9) — hydration failure path against a real temp DB, `/api/prereqs` with a positive `npx === true` assertion (proves `probe()` actually exits 0 on success rather than always returning false), `RegistryService.getByName` surfacing `SyntaxError` on malformed `args` and `env` JSON columns, `InstallerService` edge cases (scoped npm names, python/docker routing, unicode + shell metachar rejection, prefix stripping).

## [1.1.0] - 2026-04-08

Federated marketplace release: `/api/browse` now spans the official MCP registry, npm, and PyPI in one query, with cross-process activation, prereqs probing, and a `uvx` install path. Full UI/REST/MCP coverage.

### Added

- **PyPI marketplace integration.** `MarketplaceClient.searchPypi()` resolves a curated list of well-known Python MCP servers (`mcp-server-fetch`, `mcp-server-git`, `mcp-server-time`, `mcp-server-postgres`, `mcp-server-sqlite`, `mcp-proxy`, `mcp-cli`, …) against the stable PyPI JSON API (`/pypi/<name>/json`) for live metadata, plus a best-effort HTML scrape of `pypi.org/search` to surface anything beyond the curated list. PyPI hits are tagged `runtime: python` and merged into `/api/browse` results alongside the official registry and npm.
- **npm search fallback in `/api/browse`.** Two parallel npm queries (`<query> keywords:mcp` and `<query> mcp`) merge + dedupe with the official-registry results. The first variant catches packages that opted into the `keywords:mcp` tag; the second catches packages like Microsoft's `@playwright/mcp` that have no `keywords` field at all. Filtered to entries mentioning `mcp` / `model context protocol` in name/keywords/description.
- **Federated dedupe with cross-source visibility.** Browse results are keyed by `<source>:<name>` (`registry:`, `npm:`, `pypi:`) so packages with colliding names across sources (e.g. `mcp-server-sqlite` exists on both npm and PyPI as different projects) all stay visible, while same-source version duplicates still collapse (highest semver wins).
- **uvx install path in the dashboard.** The Browse-tab Install button now branches on `pkg.runtime === 'python'` (or `registry_name === 'pypi'`) and posts `command: 'uvx'`, `args: ['<pkg>']`, `tags: ['marketplace', 'pypi']`. The async pre-download path (`POST /api/servers`) and the explicit `POST /api/servers/:id/preinstall` endpoint both grew a `uv tool install <pkg>` branch alongside the existing `npm cache add`.
- **Prereqs probe (`GET /api/prereqs`).** Spawns `npx --version`, `uvx --version`, `docker --version`, `uv --version` using `spawn` with `shell: true` so Windows `.cmd` shims resolve. Returns `{ npx, uvx, docker, uv }`. The dashboard fetches it on load and renders an orange banner above the Browse list when something needed for an install is missing, with install hints linking to nodejs.org / docs.astral.sh/uv.
- **README/CHANGELOG/USER-MANUAL/API/ARCHITECTURE/DASHBOARD docs** brought fully up to date for the new federated marketplace, hydration, prereqs, and uvx flow.

### Fixed

- **Cross-process activation hydration.** Removed the `UPDATE servers SET active = 0` startup wipe in `context.ts`. Each fresh agent-discover process now reads `WHERE active = 1 AND installed = 1` and re-activates those servers in its own `McpProxy` on boot, with stale entries (failed activate) cleared back to `active = 0` so we don't retry forever. Activation lives in-memory in `McpProxy.activeServers` but the DB-backed `active` flag is the cross-process source of truth, so a tool activated via the dashboard UI is now visible to a freshly-spawned MCP client process without manual re-activation.
- **Scoped npm names rejected by server-name validation.** The Browse-tab install path sanitised `@scope/pkg` → `@scope-pkg`, leaving the leading `@` which fails the registry's `^[a-zA-Z0-9]…$` regex with HTTP 422. Now strips `@` to match the parallel `__installFromNpm` path. Confirmed via Playwright e2e against `@modelcontextprotocol/server-everything`.
- **Marketplace version-duplicates.** `parseResponse` now collapses one-row-per-version results from the official registry (`playwright-wizard-mcp ×3` → `×1`).

### Security

- **CRLF header injection in proxy secret merge.** When activating an SSE / streamable-http remote server, secrets stored for that server are merged into the outbound HTTP headers (`Authorization`, `API_KEY`, plus pass-through). Values containing `\r` or `\n` are now rejected before insertion to prevent HTTP header injection from a poisoned secret value. (`src/domain/proxy.ts`)

[Note: 1.0.28 – 1.0.31 were intermediate dev tags during this work and have been folded into 1.1.0 for the public release.]

## [1.0.27] - 2026-04-08

### Documentation

- Self-documenting release: documents this version + retroactively records the 1.0.26 release whose payload was the 1.0.17 – 1.0.25 backfill.

## [1.0.25] - 2026-04-08

### Changed

- Tidied `.gitignore` with section headers and added `test-results/` + `playwright-report/`.

## [1.0.24] - 2026-04-08

### Added

- **Playwright E2E dashboard test suite** at `tests/e2e-ui/dashboard.pw.ts`. Boots the standalone HTTP+WS server against a temp SQLite DB on a free port, seeds three mock server entries via the registry, and verifies: page loads with no console/page errors, websocket upgrade, REST `/api/servers` returns the seeded entries, the installed list renders the seeded server cards, the Browse tab switches into view. Runnable via `npm run test:e2e:ui`. Devdep `@playwright/test`. Vitest count unchanged at 151.

## [1.0.23] - 2026-04-08

### Changed

- Dropped the `seedMetaFromUserVersion` shim in favour of `agent-common`'s `adoptUserVersion` + `addColumnIfMissing` helpers.

## [1.0.22] - 2026-04-08

### Changed

- Version bump after a tag collision on the database.ts shim release.

## [1.0.21] - 2026-04-08

### Changed

- `storage/database.ts` delegated to `agent-common`'s `createDb`, with a `user_version` → `_meta` seeding shim for in-place migration of existing DBs.

## [1.0.20] - 2026-04-08

### Changed

- `index.ts` MCP dispatcher delegated to `agent-common`'s `startMcpServer`, with `dynamic tools` + `onToolCalled` notify hooks for the proxy lifecycle.

## [1.0.19] - 2026-04-08

### Changed

- `transport/ws.ts` delegated to `agent-common`'s `setupWebSocket`.

## [1.0.18] - 2026-04-08

### Changed

- `transport/rest.ts` `json` / `readBody` / `serveStatic` helpers delegated to `agent-common`, with strict 404 fallback.

## [1.0.17] - 2026-04-08

### Changed

- Added `agent-common` as a runtime dependency for events, package metadata, and the dashboard server primitives.

## [1.0.16] - 2026-04-07

### Changed

- **MCP tool count: 2 → 1.** Folded the former `registry_server` tool (`activate`/`deactivate`) into the existing `registry` tool. activate/deactivate are server-lifecycle actions, not a separate domain — keeping them in one place reduces prompt overhead. New `registry` action enum: `list, install, uninstall, activate, deactivate, browse, status`.
- `index.ts` `tools/list_changed` notification now fires on `registry { activate | deactivate | uninstall }` (was `registry_server` + `registry uninstall`).
- README, USER-MANUAL, API.md and CLAUDE.md updated to reflect the single-tool surface.
- Added a SessionStart hook script (`scripts/hooks/session-start.js`) so Claude Code agents see the dashboard URL alongside the other agent-\* servers. This is an optional adapter — non–Claude-Code hosts ignore it.

### Fixed

- **Three version files now in sync**: `package.json`, `server.json`, AND `agent-desk-plugin.json`. The latter two had silently lagged behind `package.json` for several releases. Going forward, all three must be bumped together as a release rule.
- Repo-wide prettier sweep fixed pre-existing format drift in `README.md`, `src/index.ts`, `src/server.ts`, `src/package-meta.ts`, `src/transport/ws.ts`, `src/version.ts`, `docs/ARCHITECTURE.md`, and `package.json`.

### Tests

- 151 passing (was 152; 1 invalid-action test for the removed `registry_server` tool dropped).

## [1.0.15] - 2026-04-04

### Changed

- Extracted `package-meta.ts` to load `name` and `version` from `package.json` for the MCP `initialize` handshake and WebSocket payloads. No more hardcoded version strings.
- Renamed several internal variables for clarity in MCP stdio entry, standalone server argv parsing, WebSocket client state, MCP handlers, and channel resolution.

## [1.0.14] - 2026-04-03

### Fixed

- Replaced inline `onclick` handlers in the dashboard with delegated event listeners (Content-Security-Policy compliance for agent-desk plugin embedding).
- Hide the dashboard's theme toggle when running inside agent-desk (the host shell controls theming).

## [1.0.13] - 2026-04-03

### Changed

- Standardized `morph` / `esc` / `escAttr` helpers across the dashboard JS modules.
- Bumped `agent-desk-plugin.json` in lockstep with `package.json`.

## [1.0.12] - 2026-04-03

### Changed

- Standardized the CSS variable contract used by the dashboard so it matches the rest of the agent-\* family.
- Switched the theme selector from a body class to `[data-theme='dark']` on `<html>`.

## [1.0.11] - 2026-04-03

### Fixed

- Container-scoped DOM queries so the dashboard works correctly when mounted into agent-desk's shadow DOM via the plugin system.

## [1.0.10] - 2026-04-02

### Fixed

- Include `agent-desk-plugin.json` in the published npm package (`files` field).

## [1.0.9] - 2026-04-02

### Added

- Plugin `mount` / `unmount` API for agent-desk integration. The dashboard can now be embedded into agent-desk as a first-party plugin.

## [1.0.8] - 2026-04-01

### Changed

- Side-by-side dark/light screenshots in the README, matching the agent-comm format.

## [1.0.7] - 2026-03-31

### Added

- Comprehensive README rewrite with screenshots, feature matrix, and full client setup instructions.

## [1.0.6] - 2026-03-30

### Removed

- `approval_status` column from `servers` (schema V3 migration). The approval workflow was unused.

### Added

- npm package-name validation in `installer.ts`.
- Remote transport support (`sse`, `streamable-http`) in `proxy.ts` for connecting to remote MCP servers.
- Activation error display in the dashboard (badge on the server card when the last activation attempt failed).
- npm `npm cache add` pre-download on registration (fire-and-forget).

## [1.0.5] - 2026-03-30

### Removed

- "Approval" badges from the dashboard (column was about to be dropped).

### Changed

- Browse-tab install form is now collapsible.

### Fixed

- Browse-install path now correctly uses `npx` for npm-runtime servers.

## [1.0.4] - 2026-03-30

### Added

- npm install form in the Browse tab (manual install path alongside the marketplace install).

### Changed

- Single status dot per server (merged "active" and "health" indicators).

## [1.0.3] - 2026-03-30

### Changed

- Merged the health and status dots into a single indicator on each server card.
- "npm install" hint shown on the empty Browse tab.

## [1.0.2] - 2026-03-29

### Added

- User Manual (`docs/USER-MANUAL.md`).

### Changed

- README updated with manual link and a clearer feature list.

## [1.0.1] - 2026-03-29

### Changed

- README updated with the npx-based MCP client config format.

## [1.0.0] - 2026-03-29

Initial release.

- 2 action-based MCP tools: `registry` (`list/install/uninstall/browse/status`) and `registry_server` (`activate/deactivate`)
- MCP server proxy: activate/deactivate child servers, expose their tools via `serverName__toolName` namespacing with `tools/list_changed` notifications
- Official MCP registry marketplace browser (`registry.modelcontextprotocol.io`)
- Auto-detect install method (npx, uvx, docker) with package-name validation
- Per-server secrets management (masked values, env merge on activation)
- Per-tool metrics (call count, error count, average latency)
- Health monitoring (connect/disconnect probes for inactive servers, tool-list checks for active ones)
- REST API (16 endpoints) covering CRUD, secrets, health, metrics, browse
- WebSocket real-time dashboard with 2-second DB-fingerprint polling
- Dashboard UI: Servers tab (health dots, expandable Secrets/Metrics/Config sections) and Browse tab (marketplace search with install button)
- SQLite with WAL mode (schema V2: `servers`, `server_tools`, `server_secrets`, `server_metrics`, `servers_fts`)
- 152 tests (unit + integration + e2e)
- Theme sync for agent-desk integration (postMessage + MutationObserver)

[1.0.16]: https://github.com/keshrath/agent-discover/compare/v1.0.15...v1.0.16
[1.0.15]: https://github.com/keshrath/agent-discover/compare/v1.0.14...v1.0.15
[1.0.14]: https://github.com/keshrath/agent-discover/compare/v1.0.13...v1.0.14
[1.0.13]: https://github.com/keshrath/agent-discover/compare/v1.0.12...v1.0.13
[1.0.12]: https://github.com/keshrath/agent-discover/compare/v1.0.11...v1.0.12
[1.0.11]: https://github.com/keshrath/agent-discover/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/keshrath/agent-discover/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/keshrath/agent-discover/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/keshrath/agent-discover/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/keshrath/agent-discover/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/keshrath/agent-discover/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/keshrath/agent-discover/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/keshrath/agent-discover/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/keshrath/agent-discover/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/keshrath/agent-discover/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/keshrath/agent-discover/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/keshrath/agent-discover/releases/tag/v1.0.0
