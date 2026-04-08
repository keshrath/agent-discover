# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
