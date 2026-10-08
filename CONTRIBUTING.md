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
npm run e2e:claude       # the /discover pane in the real Claude Code CLI, with screenshots
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
plugin/          Claude Code plugin (shim .mcp.json, skills, the mod: /discover pane, status, band, context)
bench/           retrieval/ (offline ranker bench) and the agent-loop bench
tests/           vitest suites, fixtures (fake upstream, mock OAuth server, registry), widget harness
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

### The pane in the real Claude Code CLI

`npm run e2e:claude` (`tests/e2e-claude/`, gated by `AGENT_DISCOVER_E2E_CLAUDE=1`) builds, then drives `claude` in a pseudo-terminal (node-pty, rendered by @xterm/headless) and asserts on the screen text of every view: the servers list, a server's detail (health on open, usage, tools and a schema, config keys), a secret typed into the masked field (never drawn), a remote server with a static header (no sign-in), the quarantine diff and Approve, Browse search to install plan to install with a masked requirement, Logs, Audit, the tab hotkeys and where the focus ring lands, every view docked as a sidebar (fullscreen layout, `CLAUDE_CODE_NO_FLICKER=1`), the daemon-down state, and the list, detail and Browse at 80 and 160 columns. It needs a logged-in `claude` on PATH; slash commands make no model calls, so a run costs no tokens and takes about three minutes.

For visual work, drive one session by hand and look at each step: `npx tsx tests/e2e-claude/drive.ts [cols] [rows]` (`FULLSCREEN=1` for the sidebar) starts a scratch world and serves `curl -s localhost:47321 -d '{"op":"shot","label":"x"}'` (ops: `discover`, `key`, `type`, `press`, `focus`, `wait`, `screen`, `shot`, `sync`, `quit`). `sync` copies `plugin/hooks` and `plugin/types` into the session's plugin and runs `/reload-plugins`; shots land in `~/.claude/tmp/pane-shots/drive-<label>.png`. Keys sent while the pane does not hold the keyboard go to the prompt and start a model turn.

`npx tsx tests/e2e-claude/tutorial.ts` records the tutorial: a scripted fullscreen session with captions, filmed to `~/.claude/tmp/tutorial/discover-tutorial.webm` (Playwright records a replay, no ffmpeg) with one still per step; `--render` films the last recording again. `docs/TUTORIAL.md` uses those stills (`docs/images/tutorial/`); re-record and copy them when the pane changes.

Isolation: a scratch daemon (`node dist/index.js daemon`) on a free port with its own `AGENT_DISCOVER_DATA_DIR`, file secrets and a fake MCP Registry; it is seeded through REST and `/mcp` (an enabled stdio fixture with calls, a disabled one, one quarantined by tool drift, a remote one with a static `Authorization` header that uses the daemon's own `/mcp` as upstream). Claude Code runs with `--plugin-dir` on a scratch copy of `plugin/` whose `.mcp.json` runs this checkout's `dist/index.js` with the scratch env, `--setting-sources project,local` (the user settings file, and with it the installed plugin, its hooks and `env`, stay out; login still works) and `--strict-mcp-config` (the user's own MCP servers stay out). The workspace is a fixed temp folder so the folder-trust answer is remembered. The daemon on 3424 and the real data dir are never touched. Browse also queries npm and PyPI live, so it needs the network; the assertions only look at the fake registry's entries.

Each view is captured to `~/.claude/tmp/pane-shots/<view>.png` (`AGENT_DISCOVER_E2E_SHOTS` overrides): the xterm buffer serialized with @xterm/addon-serialize and drawn by xterm.js in Playwright's Chromium. Look at them after a change to the pane.

## Database migrations

Schema changes go in `src/storage/database.ts`:

1. Append a new entry with the next version to `migrations` (the current version is **11**).
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
