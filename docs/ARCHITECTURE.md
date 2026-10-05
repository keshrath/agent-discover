# Architecture

## Overview

agent-discover is one local daemon that lets any MCP host find, install, enable and disable MCP servers while a session is running, and that guards what it installs. Hosts connect to it as a single MCP server; the daemon owns the real connections to every upstream server.

## Process model

```
 Host A (stdio) --> shim --\
 Host B (stdio) --> shim ---+--> /mcp  --+
 Host C (http)  -----------/             |
 Browser / plugin ----> /, /api, /ws ----+--> daemon (127.0.0.1:3424)
                                              |  AppContext (one per daemon)
                                              +--> upstream MCP servers (stdio / SSE / streamable HTTP)
```

- **Daemon** (`src/daemon.ts`, `agent-discover daemon`): one `node:http` server on `127.0.0.1:${AGENT_DISCOVER_PORT:-3424}` serving the dashboard (static files), REST `/api/*`, the WebSocket `/ws`, the OAuth callback and MCP Streamable HTTP at `/mcp`. It builds the context after `listen`, so the guard and the OAuth redirect URI use the bound port. It exits after `AGENT_DISCOVER_IDLE_MS` (default 30 min) with no open HTTP exchanges and no WebSocket clients.
- **Shim** (`src/shim.ts`, the default bin): for stdio-only hosts. It probes `GET /api/health`; if the daemon is absent it takes a lockfile in the temp directory, spawns a detached `agent-discover daemon` (log in the temp directory) and waits up to 20 s for readiness, then relays JSON-RPC messages between stdin/stdout and `/mcp`. If the daemon goes away later (idle exit, crash) the next message re-ensures it and, for a 2025 session, replays the cached `initialize` handshake.
- **Hosts with Streamable HTTP** may skip the shim and use `http://127.0.0.1:3424/mcp`, provided something started the daemon.
- **Single source of truth.** Because every host and the dashboard talk to the same process, connection state, enablement and the tool index have one owner.

### `/mcp`: two protocol eras on one URL (`src/mcp/http.ts`)

- **2026-07-28 (stateless):** `createMcpHandler` builds a fresh server per request. `list_changed` reaches clients through their `subscriptions/listen` streams. Multi-round-trip requests (`input_required`) carry HMAC-sealed `requestState` bound to the server and tool.
- **2025-06-18 / 2025-11-25 (sessionful):** a `NodeStreamableHTTPServerTransport` per client, so these clients keep the standalone GET stream (list_changed) and server-to-client elicitation through the SDK's legacy shim. A session with no open response that stays idle longer than `AGENT_DISCOVER_SESSION_IDLE_MS` is closed; the client gets a 404 and re-initializes.

### Request guard (`src/transport/guard.ts`, `token.ts`)

Every request and WebSocket upgrade passes an exact `Host` / `Origin` allowlist (loopback only), JSON-only bodies, no wildcard CORS. Mutating `/api/*` calls additionally need the per-launch `X-Agent-Discover-Token`. `/mcp` also runs the SDK's `localhostHostValidation` / `localhostOriginValidation`. See [SECURITY.md](SECURITY.md).

## Layers

```
+------------------------------------------------------------------+
| Transport:  mcp/ (server, tools, prompts, http)                  |
|             transport/ (rest, ws, http helpers, guard, token)    |
+------------------------------------------------------------------+
| Domain:     ServerLifecycle  <-- single authority                |
|             ServerStore, ToolIndex + Ranker, UpstreamPool        |
|             RegistryMirror, MarketplaceClient, install-plan,     |
|             provenance, OAuthManager, SecretsService, Metrics,   |
|             Log, Presets, trust/ (TrustService)                  |
+------------------------------------------------------------------+
| Storage:    SQLite (better-sqlite3, WAL), version-ordered        |
|             migrations; secret values in keychain / encrypted    |
|             file                                                 |
+------------------------------------------------------------------+
```

`src/context.ts` is the DI root. `createContext()` builds every service and returns one `AppContext`; every transport shares it. No global state.

### Domain services

- **`ServerLifecycle`** (`domain/lifecycle.ts`): the single authority for install -> index -> enable / disable -> uninstall, plus `update`, `reindex`, `approve`, `setSecret`, `callTool`, `health` and `status`. MCP tools, REST routes, the setup file and the dashboard are thin adapters over it. It emits change events that become `notifications/tools/list_changed` and WebSocket `state` pushes. `TrustHooks` (`beforeInstall`, `afterIndex`, `aroundCall`, `approve`, `inspect`, `record`) are implemented by `TrustService`.
- **`ServerStore`** (`domain/servers.ts`): server rows, and one `toConfig` for connecting.
- **`UpstreamPool`** (`domain/pool.ts`): one SDK client per upstream server, opened lazily and shared by every caller (MCP, REST, tester).
  - Connects with automatic protocol-era negotiation. The verdict is cached on the server row (a legacy verdict is dated and reused for up to 7 days) so servers launched through `npx` are not spawned twice; stdio servers are probed in place.
  - Drops a connection when its transport closes and reconnects on the next use with exponential backoff (max 60 s); closes connections idle longer than `AGENT_DISCOVER_CONN_IDLE_MS`.
  - Timeouts: connect 30 s, tool call 120 s, health 5 s. Health is a real `ping` (2025) or `server/discover` (2026).
  - Forwards `tools/call` results verbatim, relays upstream `input_required` rounds, and routes 2025 `elicitation/create` pushes to the calling client when it is the only such call in flight, otherwise to the dashboard queue (`/api/elicitations`, 2-minute expiry).
  - OAuth 2.1 for remote servers without their own `Authorization` header (see `OAuthManager`); a 401 becomes an `AuthRequiredError` carrying the sign-in URL.
  - Advertises `roots` (`AGENT_DISCOVER_ROOTS`) and `elicitation` to upstream servers, plus a sampling handler when `AGENT_DISCOVER_OPENAI_API_KEY` or `OPENAI_API_KEY` is set. Transient servers (15-minute TTL, dashboard tester only) are never exposed to hosts.
- **`ToolIndex` and `HybridRanker`** (`domain/tool-index.ts`, `ranker.ts`, `tool-doc.ts`, `tool-hash.ts`): persisted index of every installed server's tools, enabled or not. See Search below.
- **`RegistryMirror`** (`domain/registry.ts`): a local copy of the latest version of every entry in the official MCP Registry (v0.1 API) in `registry_servers` with FTS. The first sync pages through `/v0.1/servers?version=latest`; later syncs ask for `updated_since`, which also returns deleted entries. Deleted entries stay in the table, hidden from search, so an installed server whose entry was taken down shows `registry_status: "deleted"`. The daemon syncs in the background on start and on search when the mirror is older than one hour. Exact pinned versions are fetched live.
- **`MarketplaceClient`** (`domain/marketplace.ts`): search = the registry mirror first (offline FTS), then npm (`registry.npmjs.org/-/v1/search`, two queries so untagged packages like `@playwright/mcp` surface) and PyPI (a curated list of well-known Python MCP servers resolved through the per-project JSON API, plus a best-effort HTML search scrape). Every result is normalized to a `server.json`. `resolve` and `plan` are exact-name only.
- **Install plan and provenance** (`domain/install-plan.ts`, `provenance.ts`): turn a `server.json` (`packages[]`, `remotes[]`) into an `InstallPlan`: the exact command or endpoint, the pinned version, env and header requirements, `warnings`, a `blocked` reason, and provenance checks (`registry_namespace`, `npm_mcp_name`, `pypi_mcp_name`, `oci_label`, each `pass` / `fail` / `skipped` / `error`). Both the MCP consent prompt and `GET /api/install/plan` render it.
- **`OAuthManager`** (`domain/oauth.ts`): the SDK's OAuth client provider persisted through server secrets (`oauth:*` keys), dynamic client registration by default or an operator-hosted Client ID Metadata Document, RFC 9207 `iss` check, single-use `state` with a 10-minute TTL, loopback redirect to `/oauth/callback`. agent-discover never opens the authorization URL.
- **`SecretsService`** (`domain/secrets.ts`) over a backend from `trust/secret-store.ts`: OS keychain (`@napi-rs/keyring`), else an AES-256-GCM file next to the database, else memory for `:memory:` databases. SQLite stores key names and the backend only.
- **`TrustService`** (`domain/trust/`): pins, hygiene, audit, telemetry. See [SECURITY.md](SECURITY.md).
- **`MetricsService`**, **`LogService`** (in-memory ring buffer of 500 calls, retention `AGENT_DISCOVER_LOG_RETENTION_DAYS`, default 30), **`PresetsService`** (tester presets) and setup-file sync (`domain/setup.ts`).

### MCP surface (`src/mcp/`)

- **Meta tools** (`tools.ts`): `search_servers`, `install_server`, `enable_server`, `disable_server`, `server_status`, `search_tools`, `get_tool`, `call_tool`. Schemas are zod; each carries annotations, a title and (except `call_tool`) an `outputSchema` with `structuredContent`. The output contracts live in `widgets/types.ts` and the markdown renderings in `widgets/text.ts`. `tools/list` is deterministic and sorted by name.
- **Native mode** (default, `AGENT_DISCOVER_MODE=native`): `tools/list` also contains `<server>__<tool>` for every tool of every enabled, non-quarantined server, with the upstream schema, output schema and annotations verbatim and the description prefixed with `[server]` (cleaned and capped). The host's own tool search, permission prompts and `alwaysLoad` therefore apply to them. **Proxy mode** lists only the meta tools; tools are called with `call_tool`.
- **Consent** uses elicitation (2026 `input_required` round; 2025 `elicitation/create` through the legacy shim), bound to a hash of the exact proposed config. A client that cannot elicit gets an `isError` result with status `consent_required` and the plan; the user installs from the dashboard (or the operator sets `AGENT_DISCOVER_ALLOW_UNCONFIRMED_INSTALL=1`). `install_server` is flagged `anthropic/requiresUserInteraction`.
- **Prompts** (`prompts.ts`): `discover`, `install`, `status`.
- **MCP Apps widget** (`widgets/`): `resources/read` serves `ui://agent-discover/app.html` (`text/html;profile=mcp-app`), one self-contained page built to `dist/widgets/app.html` that picks its view (search, server card, install consent, tester) from the shape of `structuredContent`. Tools with a view carry `_meta.ui.resourceUri`. Claude Desktop, claude.ai and VS Code render it; Claude Code does not render MCP Apps yet, so it shows the markdown text.

### Claude Code plugin (`plugin/`)

`.mcp.json` runs the stdio shim (`npx -y agent-discover@^2`). Skills `find`, `install` and `dashboard`; a SessionStart hook (`scripts/session-start.mjs`) that adds one line of context; `scripts/statusline.mjs` for older builds. `hooks/register.tsx` is a function-hooks mod (Claude Code 2.1.289+): the `/discover` panel, the `MCP n/m` status entry, toasts and the attention band. It calls the plugin's own MCP server through `$.mcp.call` and the daemon's REST API, polling every 5 s while the panel is open and every 30 s otherwise. Plugin-specific code stays in `plugin/`; `src/` is host-agnostic.

### Search (tool retrieval)

`search_tools` / `get_tool` read the persisted tool index (`ToolIndex`, `src/domain/tool-index.ts`), which covers every installed server whether it is enabled or not. Measured on the retrieval bench (`bench/retrieval/`, 50 real servers / 1674 tools / 468 labelled queries); every constant was tuned on its dev split only and is reported on the held-out test split.

**Index (write path).** `ToolIndex.save(serverId, tools)` is the only writer. It diffs by `tool_hash`, builds each tool's search document (`src/domain/tool-doc.ts`) and writes `server_tools` + `server_tools_fts` in one transaction, then bumps `_meta.tool_index_generation` so rankers drop their caches. The document is a function of the tool definition alone, so `tool_hash` is the cache key for both the FTS row and the stored vector: identical tools on two servers embed once.

- Fields: `name` (tool name + title), `description`, `args` (argument names + descriptions, one level deep).
- Words: lower-case, split at non-alphanumerics; a mixed-case word is indexed whole and split (`GitLab` → `gitlab git lab`, `createTask` → `createtask create task`). FTS5 tokenizer `porter unicode61 remove_diacritics 2`.

**Ranker (read path).** `HybridRanker` (`src/domain/ranker.ts`, options `DEFAULT_HYBRID`) behind the `Ranker` interface (`rank(query, limit)` → ids + scores in 0..1):

1. Query terms: diacritic folding, EN + DE stopwords (a query of only stopwords keeps them), typo repair of terms missing from the index vocabulary (Damerau-Levenshtein 1-2, same first letter, most frequent candidate).
2. Lexical: FTS5 `bm25()` with field weights name 6 / description 1.5 / args 0.5, saturated `raw / (raw + 6)`.
3. Dense (opt-in): cosine over stored tool vectors, min-max rescaled per query, fused `0.5 × lexical + 0.5 × dense`. Weighted fusion beat RRF on dev. Query vectors are cached (LRU, 256).
4. Server routing: tools of servers the query does not name (distinctive server-name terms, e.g. "github") are damped by 0.3; tools of servers other than the best-scoring one by up to 0.3 × their gap to it.
5. Usage prior: `+min(0.05, 0.01 × ln(1 + calls))` from `server_metrics`.

There is no score floor. On the bench, no signal (IDF-weighted query coverage, BM25, raw or rescaled cosine) separates the 20 unanswerable queries from answerable ones; any floor that rejected one would also drop correct answers. The ranker returns nothing only when no query term matches.

**Embeddings** (`src/embeddings/`, `AGENT_DISCOVER_EMBEDDING_PROVIDER`). Providers embed with a side (`embed(texts, 'query' | 'document')`), because retrieval models format queries and documents differently. Any failure falls back to the no-op provider, which means lexical search only.

- `none` (default): no key, no download.
- `local`: `Xenova/multilingual-e5-small` via the optional `@huggingface/transformers` package. It is q8, about 130 MB, downloaded once, and uses the `query:` / `passage:` prefixes. This is the opt-in "best quality" configuration. `AGENT_DISCOVER_EMBEDDING_MODEL` selects another model, which then runs unprefixed.
- `openai`: `text-embedding-3-small` via fetch.

Results (test split, R@10 / MRR):

| configuration   | R@10 | MRR  |
| --------------- | ---- | ---- |
| plain BM25      | .618 | .430 |
| 1.4 ranker      | .642 | .446 |
| 2.0 zero-config | .661 | .474 |
| 2.0 + e5        | .722 | .522 |

The full table is in `bench/retrieval/README.md`.

LLM index-time enrichment is not shipped. The bench measures it offline from a committed cache: R@10 .922. That measurement is what to reconsider when a key is acceptable.

### Storage

`src/storage/database.ts` wraps `better-sqlite3` (WAL, foreign keys, busy timeout). Migrations are version-ordered and applied in one transaction each above the stored version (kept in `_meta`; databases older than that adopt `pragma user_version`). The current schema version is **10**. A 1.x database migrates in place on first start: `active` becomes `enabled`, remote URLs move from `homepage` to `url`, tool hashes are computed, and servers that had persisted tools are marked indexed and pinned.

## Database schema (version 10)

| Table              | Holds                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `servers`          | `name` (unique), `description`, `source` (`local`, `registry`, `manual`, `setup-file`), `transport`, `command`, `args`, `env`, `url`, `headers`, `tags`, `package_name`, `package_version`, `registry_name`, `repository`, `homepage`, `enabled`, `quarantined`, `indexed_at`, `protocol_era`, `discover_result`, `era_checked_at`, `health_status`, `last_health_check`, `error_count`, timestamps |
| `server_tools`     | one row per indexed tool: `server_id`, `name`, `title`, `description`, `input_schema`, `output_schema`, `annotations`, `tool_hash`, optional `embedding` and `embedding_model`. Unique on `(server_id, name)`                                                                                                                                                                                       |
| `server_tools_fts` | FTS5 over `name`, `description`, `args` (`porter unicode61 remove_diacritics 2`), written only by `ToolIndex.save`                                                                                                                                                                                                                                                                                  |
| `servers_fts`      | FTS5 over server `name`, `description`, `tags`, kept in sync by triggers                                                                                                                                                                                                                                                                                                                            |
| `server_secrets`   | key names and `backend` per server. Values are never stored here                                                                                                                                                                                                                                                                                                                                    |
| `server_metrics`   | per-tool call count, error count, total latency, last call                                                                                                                                                                                                                                                                                                                                          |
| `server_pins`      | one JSON row per server: the pinned hash, description, input schema and annotations of every tool                                                                                                                                                                                                                                                                                                   |
| `audit_log`        | append-only (an UPDATE trigger aborts edits); indexed by server and action                                                                                                                                                                                                                                                                                                                          |
| `registry_servers` | the mirrored official MCP Registry entries (`server_json`, `status`, `is_latest`, ...) plus `registry_servers_fts`                                                                                                                                                                                                                                                                                  |
| `test_presets`     | dashboard tester presets                                                                                                                                                                                                                                                                                                                                                                            |
| `_meta`            | key/value: schema version, `tool_index_generation`, registry sync markers                                                                                                                                                                                                                                                                                                                           |

Adding a migration: append an entry with the next version to `migrations` in `database.ts`; never edit an old one. Keep migrations SQL-only. A data move that needs a service (like moving secrets into the keychain) happens in that service's constructor.

## Prereqs probe

`GET /api/prereqs` runs `<tool> --version` for `npx`, `uvx`, `docker` and `uv` and reports which are available. The dashboard shows a banner on the Browse tab when an install needs one that is missing.

## Real-time updates

The daemon is the only writer, so the WebSocket pushes a full `state` message on connect and after every lifecycle event (debounced 100 ms), plus `log_entry`, `notification`, `progress` and `elicitation_request`. There is no database polling.

## Not in 2.0

- Sandboxing upstream stdio servers (Docker, sandbox-runtime). See [SECURITY.md](SECURITY.md#not-yet-covered).
- LLM index-time enrichment of descriptions: measured offline only (see Search).
