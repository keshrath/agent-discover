# API Reference (3.0)

One daemon (`agent-discover daemon`, default `127.0.0.1:3424`) serves:

| Path              | What                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------- |
| `/mcp`            | MCP Streamable HTTP — 2026-07-28 (stateless) and 2025-06-18 / 2025-11-25 (sessionful) |
| `/api/*`          | REST for the Claude Code `/discover` pane and local tooling                           |
| `/oauth/callback` | OAuth loopback redirect for remote upstreams                                          |

There is no web UI: the UI surfaces are the Claude Code pane (plugin), the MCP Apps widget and the markdown text of every tool result.

The default bin (`agent-discover`) is a stdio shim: it starts the daemon if needed and relays stdio ⇄ `/mcp`. Hosts that speak HTTP can use `{ "type": "http", "url": "http://127.0.0.1:3424/mcp" }` directly.

## Security

Every request passes the request guard:

- `Host` must be exactly `localhost:<port>`, `127.0.0.1:<port>` or `[::1]:<port>` (plus `AGENT_DISCOVER_HOST:<port>` if set).
- Any request with an `Origin` header gets 403, loopback origins included: only browsers send one, and no web page is a caller (the pane and the shim are non-browser clients; the OAuth callback is a top-level navigation without one). No CORS headers are sent. `/mcp` additionally runs the SDK's `localhostHostValidation`.
- POST/PUT/PATCH/DELETE with a body must be `application/json` (415 otherwise).
- CORS: allowed origins are reflected; never `*`.
- **Shutdown.** `POST /api/shutdown` (token required) answers 202 and exits like an idle exit; a newer shim uses it to replace an older daemon on upgrade.
- **REST token.** Every POST/PUT/PATCH/DELETE on `/api/*` must send `X-Agent-Discover-Token` (random per daemon launch); otherwise 403 `TOKEN_REQUIRED`. `GET /api/token` → `{token, header}` for local non-browser clients (the Claude Code pane); the guard refuses any Origin, so a web page never learns it. `/mcp` is unaffected.

See [SECURITY.md](SECURITY.md) for the whole trust model.

## Environment

| Variable                                              | Default                                    | Meaning                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_DISCOVER_PORT`                                 | `3424`                                     | Daemon port                                                                                                                                                         |
| `AGENT_DISCOVER_HOST`                                 | `127.0.0.1`                                | Listen address                                                                                                                                                      |
| `AGENT_DISCOVER_DATA_DIR`                             | platform data dir                          | Data directory: `%LOCALAPPDATA%\agent-discover`, `~/Library/Application Support/agent-discover`, `$XDG_DATA_HOME/agent-discover` or `~/.local/share/agent-discover` |
| `AGENT_DISCOVER_DB`                                   | `agent-discover.db` in the data dir        | SQLite file path (a 1.x `~/.claude/agent-discover.db` is moved into the data dir once on first start)                                                               |
| `AGENT_DISCOVER_MODE`                                 | `native`                                   | `native`: enabled servers' tools listed as `<server>__<tool>`; `proxy`: meta tools only                                                                             |
| `AGENT_DISCOVER_IDLE_MS`                              | `1800000`                                  | Daemon exits after this long with no open HTTP exchanges (`0` = never)                                                                                              |
| `AGENT_DISCOVER_CONN_IDLE_MS`                         | `600000`                                   | Idle upstream connections are closed                                                                                                                                |
| `AGENT_DISCOVER_SESSION_IDLE_MS`                      | `1800000`                                  | 2025 HTTP sessions with no open stream are closed after this long (`0` = never)                                                                                     |
| `AGENT_DISCOVER_REGISTRY_URL`                         | `https://registry.modelcontextprotocol.io` | Official MCP Registry (or a compatible sub-registry) mirrored locally                                                                                               |
| `AGENT_DISCOVER_OAUTH_CLIENT_METADATA_URL`            | unset                                      | HTTPS URL of an operator-hosted OAuth Client ID Metadata Document; unset = dynamic client registration                                                              |
| `AGENT_DISCOVER_ALLOW_UNCONFIRMED_INSTALL`            | unset                                      | `1` lets `install_server` run without an elicitation prompt (operator opt-in)                                                                                       |
| `AGENT_DISCOVER_SETUP_FILE`                           | unset                                      | Declarative server list synced at daemon start                                                                                                                      |
| `AGENT_DISCOVER_ROOTS`                                | unset                                      | Comma-separated root URIs advertised to upstream servers                                                                                                            |
| `AGENT_DISCOVER_LOG_RETENTION_DAYS`                   | `30`                                       | Call-log retention (the in-memory buffer also caps at 500 entries)                                                                                                  |
| `AGENT_DISCOVER_EMBEDDING_PROVIDER`                   | `none`                                     | `local` or `openai` adds semantic ranking                                                                                                                           |
| `AGENT_DISCOVER_EMBEDDING_MODEL`                      | see below                                  | Model id override for the chosen provider                                                                                                                           |
| `AGENT_DISCOVER_EMBEDDING_THREADS`                    | `1`                                        | `local` only: ONNX thread count                                                                                                                                     |
| `AGENT_DISCOVER_EMBEDDING_IDLE_TIMEOUT`               | `60`                                       | `local` only: seconds before the model is unloaded from RAM                                                                                                         |
| `AGENT_DISCOVER_OPENAI_API_KEY`                       | unset                                      | OpenAI key for embeddings (`OPENAI_API_KEY` is the fallback); only this variable enables sampling for upstream servers (each request is audited)                    |
| `AGENT_DISCOVER_OPENAI_BASE_URL`                      | `https://api.openai.com/v1`                | Base URL of the OpenAI-compatible sampling endpoint                                                                                                                 |
| `AGENT_DISCOVER_SAMPLING_MODEL`                       | `gpt-5-mini`                               | Model used to answer upstream `sampling/createMessage` requests                                                                                                     |
| `AGENT_DISCOVER_SECRETS`                              | auto                                       | `keyring` / `file` forces the secret backend (default: OS keychain, else encrypted file)                                                                            |
| `AGENT_DISCOVER_MAX_TOOL_DESCRIPTION`                 | `1024`                                     | Cap (chars) on tool descriptions shown to models (`0` = none)                                                                                                       |
| `AGENT_DISCOVER_MAX_SERVER_DESCRIPTION`               | `512`                                      | Same for server descriptions                                                                                                                                        |
| `AGENT_DISCOVER_AUDIT_ARGS`                           | unset                                      | `1` also records (masked) tool-call arguments in the audit log                                                                                                      |
| `AGENT_DISCOVER_AUDIT_MAX_ROWS`                       | `50000`                                    | Audit retention (oldest rows pruned, `0` = unlimited)                                                                                                               |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `AGENT_DISCOVER_OTEL` | unset                                      | Either one (or `AGENT_DISCOVER_OTEL=1`) turns OpenTelemetry on                                                                                                      |

Default embedding models: `Xenova/multilingual-e5-small` for `local` (optional dependency `@huggingface/transformers`, installed by hand), `text-embedding-3-small` for `openai`.

## MCP

`tools/list` is sorted by name. Server `instructions` explain the flow. Prompts: `discover(task)`, `install(server)`, `status`.

| Tool             | Annotations             | Purpose                                                                                                                                                      |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search_servers` | read-only, open-world   | `{query, limit?, marketplace?}` → installed matches + public registry / npm / PyPI matches                                                                   |
| `install_server` | idempotent, open-world  | `{server?, source?, version?, name?, transport?, command?, args?, env?, url?, headers?, description?, tags?, enable?}` → installs and indexes, after consent |
| `enable_server`  | idempotent              | `{name}` → exposes the server's tools (indexes first if needed)                                                                                              |
| `disable_server` | idempotent              | `{name}` → hides them; index and searchability stay                                                                                                          |
| `server_status`  | read-only               | `{name?, check_health?}` → installed/indexed/enabled/connected/tool_count/health                                                                             |
| `search_tools`   | read-only               | `{queries: string[1..10], limit?}` → per query, matches across **all installed** servers with `score` (0..1), `enabled`, `exposed`, `required_args`          |
| `get_tool`       | read-only               | `{server, tool}` → full definition (input/output schema, annotations, `tool_hash`) by direct lookup                                                          |
| `call_tool`      | destructive, open-world | `{server, tool, arguments?}` → the upstream `CallToolResult`, unchanged                                                                                      |

All tools except `call_tool` declare an `outputSchema` and return `structuredContent`.

**Native tools** (`AGENT_DISCOVER_MODE=native`): each enabled server's indexed tools are listed as `<server>__<tool>` with the upstream schema, output schema and annotations verbatim. Every enable / disable / uninstall / re-index of an enabled server emits `notifications/tools/list_changed` (on 2026 `subscriptions/listen` streams and on every 2025 session).

**Install consent.** `install_server` asks the user through elicitation (2026: `input_required` round; 2025: `elicitation/create` via the SDK legacy shim), showing the exact command line or URL, env var names (plus the values of vars that change what code runs, such as `NODE_OPTIONS`, `PATH`, `LD_PRELOAD` or `NPM_CONFIG_*`), header names and source; publisher-supplied text is shown with control characters escaped. The consent is bound to a hash of the proposed config. Clients that cannot elicit get an `isError` result with `status: "consent_required"` and the `plan`, so the user can install from the Claude Code `/discover` pane — unless the operator set `AGENT_DISCOVER_ALLOW_UNCONFIRMED_INSTALL=1`. `server` is the exact name from `search_servers` (MCP Registry name, npm package or PyPI project, with `source` defaulting to `registry`); without it, `name` plus `command` or `url` describes a manual install. `env` and `headers` apply to manual installs only (a registry, npm or PyPI server's secrets are set by the user in `/discover`). If the local name is already taken by the same server the result is `already_installed`; by a different one it is an error, and `name` picks another local name. A package version counts as pinned only when exact (full semver for npm, a PEP 440 release for PyPI); an unversioned registry package is pinned to the current release, and when that lookup fails the plan stays unpinned with a warning. There is deliberately no agent-supplied `confirm` argument.

**Upstream input requests.** An upstream 2026 server's `input_required` result is relayed to the client (its `requestState` wrapped in an HMAC-sealed state bound to that server and tool). An upstream 2025 server's `elicitation/create` push is forwarded to the calling client when it is the only such call in flight on that connection (the call is parked and the retry carries the answer); otherwise, or when the client cannot elicit, it goes to the pending queue the `/discover` pane answers (`/api/elicitations`, 2-minute expiry).

## REST

Errors are `{ error, code? }` with 400 (validation), 401 (`AUTH_REQUIRED`: a remote upstream needs OAuth sign-in), 404, 409, 413, 415, 502 (upstream failure) or 500.

### Health and status

- `GET /api/health` → `{status:"ok", version, pid, mode, uptime}` (the shim's readiness probe)
- `GET /api/status` → `{mode, servers: ServerStatus[]}`

### Servers

Server objects carry the stored row (`name, description, source, transport, command, args, env, url, headers, tags, package_name, package_version, repository, homepage, enabled, quarantined, indexed_at, health_status, last_health_check, error_count`) plus live `connected`, `tool_count` and `missing_secrets` (declared env vars and headers with no value and no stored secret; empty placeholders are never passed to the server). Env and header values are masked (first four characters, then `****`); a masked value sent back unchanged in `PUT` keeps the stored one.

- `GET /api/servers?query=&source=`
- `GET /api/servers/:id` → server + `tools` (indexed definitions)
- `POST /api/servers` `{name, transport?, command?, args?, env?, url?, headers?, ..., enabled?}` → 201 server (+ `index_error` when the probe failed; the server stays installed)
- `PUT /api/servers/:id` → update (drops the live connection)
- `DELETE /api/servers/:id`
- `POST /api/servers/:id/enable` · `POST /api/servers/:id/disable`
- `POST /api/servers/:id/index` → re-index; returns `{added, changed, removed, unchanged, embedded}`
- `POST /api/servers/:id/health` → `{status, latency_ms, error?}` (real ping / `server/discover`)
- `POST /api/servers/:id/reset-errors`
- `GET|PUT|DELETE /api/servers/:id/secrets[/:key]` (PUT body `{value}`; changes drop the live connection). Values live in the OS keychain (or an encrypted file), never in SQLite; `GET` always returns `masked_value: "********"`.
- `GET /api/servers/:id/trust` → `{name, quarantined, drift?: {changed: [{tool, description?, input_schema?, annotations?}], added, removed}, flagged_tools: [{tool, flags}], hashes, digest}`
- `POST /api/servers/:id/approve` `{hashes}` → re-pins the current tools and lifts the quarantine. `hashes` must be the `hashes` of the reviewed `trust` report; 409 if the tool set changed since (review again).
- `GET /api/audit?limit=&before=&server=&action=&tool=` → `{entries: [{id, ts, action, server?, tool?, duration_ms?, is_error?, detail?}], total}`, newest first; page backwards with `before=<last id>`. Actions: `install approve deny enable disable uninstall quarantine release flag secret-set secret-delete shutdown call_tool sampling`.
- `GET /api/servers/:id/metrics` · `GET /api/metrics`

Removed in 3.0 with the web dashboard: `/ws`, static files, `POST /api/servers/:id/call` (use the `call_tool` MCP tool), the tester routes (`/api/servers/:id/info|tools|resources|resource-templates|resource/*|prompts|prompt/get|ping|logging-level|export`), `/api/transient*`, `/api/presets*`, `/api/prereqs`, `POST /api/sync`, `DELETE /api/logs`, `/api/logs/notifications|progress`, `/api/roots`. Removed in 2.0: `/health` (use `/api/health`), `/activate`, `/deactivate` (use `/enable`, `/disable`), `/preinstall`, `/api/npm-check` (use `/api/install` with `source: "npm"`).

### Marketplace and install

- `GET /api/browse?query=&limit=` → `{servers: MarketplaceEntry[], registry: "mirror"|"live", errors: {registry?, npm?, pypi?}}`. `MarketplaceEntry = {source: "registry"|"npm"|"pypi", name, title?, description, version, status: "active"|"deprecated"|"deleted", repository, packages: [{registry_type, identifier, version, transport}], remotes: [{type, url}]}`. `name` is the exact name to install.
- `GET /api/install/plan?source=&name=&version=&local_name=&transport=` → `InstallPlan` (the exact command or endpoint, the pinned version, env/header requirements, provenance checks, warnings, and `blocked` when it cannot be installed). `source` defaults to `registry`.
- `POST /api/install` `{source?, name, version?, local_name?, transport?, enable?, secrets?}` → 201 server + `plan` (+ `index_error`). It returns 400 when the plan is blocked and 409 when the local name exists (pass `local_name` to install under another name).
- `GET /api/registry` → `{count, synced_at, syncing, last_error}` (local mirror of the official MCP Registry; the daemon syncs on start and on search when older than 1 h) · `POST /api/registry/sync` → `{mode: "full"|"incremental", fetched, pages, ms}`.
- `ServerStatus.registry_status` (`GET /api/status`, `server_status`) is `deleted` when the entry an installed server came from was taken down.

### OAuth (remote upstreams)

Remote servers without their own `Authorization` header authenticate with OAuth 2.1. The SDK runs discovery (RFC 9728, RFC 8414), PKCE, refresh and the RFC 9207 `iss` check. The client registers dynamically unless `AGENT_DISCOVER_OAUTH_CLIENT_METADATA_URL` names a Client ID Metadata Document. Credentials are stored as server secrets: `oauth:client:<issuer>`, `oauth:tokens:<issuer>`, `oauth:issuer`, `oauth:discovery` and `oauth:verifier`. These keys never go into env or headers. agent-discover never opens the authorization URL itself and only hands out http(s) URLs.

- `GET /api/servers/:id/auth` → `{status: "authorized"|"required"|"unknown", authorize_url?, issuer?}`.
- `POST /api/servers/:id/auth` → runs `auth()` now and returns the same shape. Use it to start sign-in before the first call.
- `GET /oauth/callback?code&state&iss` → the loopback redirect URI `http://127.0.0.1:<port>/oauth/callback`. It checks that `state` is single-use and less than 10 minutes old, then redeems the code, indexes the server if needed and answers with an HTML page.
- Over MCP, a call to a server that needs sign-in returns a URL-mode elicitation (`inputRequests.signin`) when the client declares `elicitation.url`. The retry waits up to 5 minutes for the callback. Without URL-mode support the call returns `isError` with the URL in the text.

### Logs and upstream questions

- `GET /api/logs?limit=&offset=` → `{entries: [{id, timestamp, server, tool, response, latency_ms, success, kind}], total}`, newest first; no call arguments or successful output (`response` is a failed call's error text, an elicitation's message or a notification's payload) (in memory, `AGENT_DISCOVER_LOG_RETENTION_DAYS`, at most 500).
- `GET /api/elicitations` → `{entries: [{id, serverName, message, requestedSchema, createdAt}]}`: upstream questions no client could answer.
- `POST /api/elicitations/:id/respond` `{action: "accept"|"decline"|"cancel", content?}`.

## Setup file

```json
{
  "servers": [
    {
      "name": "x",
      "transport": "streamable-http",
      "url": "https://…/mcp",
      "secrets": { "AUTHORIZATION": "$TOKEN" },
      "enabled": true
    }
  ]
}
```

`auto_activate` was renamed to `enabled`; an entry still using it is reported in the sync result's `errors` and not applied. A sibling `*.local.json` is merged.
