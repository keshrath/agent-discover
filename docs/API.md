# API Reference (2.0)

One daemon (`agent-discover daemon`, default `127.0.0.1:3424`) serves:

| Path             | What                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------- |
| `/mcp`           | MCP Streamable HTTP — 2026-07-28 (stateless) and 2025-06-18 / 2025-11-25 (sessionful) |
| `/api/*`         | REST for the dashboard and local tooling                                              |
| `/ws`            | Dashboard live updates                                                                |
| `/`, `/tester/*` | Dashboard static files                                                                |

The default bin (`agent-discover`) is a stdio shim: it starts the daemon if needed and relays stdio ⇄ `/mcp`. Hosts that speak HTTP can use `{ "type": "http", "url": "http://127.0.0.1:3424/mcp" }` directly.

## Security

Every request and WebSocket upgrade passes the request guard:

- `Host` must be exactly `localhost:<port>`, `127.0.0.1:<port>` or `[::1]:<port>` (plus `AGENT_DISCOVER_HOST:<port>` if set).
- `Origin`, when present, must be `http(s)://` with a loopback hostname, or exactly `file://` (agent-desk). `null` and look-alikes (`localhost.evil.com`) get 403. `/mcp` additionally runs the SDK's `localhostHostValidation` / `localhostOriginValidation`.
- POST/PUT/PATCH/DELETE with a body must be `application/json` (415 otherwise).
- CORS: allowed origins are reflected; never `*`.

## Environment

| Variable                                   | Default                       | Meaning                                                                                 |
| ------------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------- |
| `AGENT_DISCOVER_PORT`                      | `3424`                        | Daemon port                                                                             |
| `AGENT_DISCOVER_HOST`                      | `127.0.0.1`                   | Listen address                                                                          |
| `AGENT_DISCOVER_DB`                        | `~/.claude/agent-discover.db` | SQLite path (1.x location, migrated in place)                                           |
| `AGENT_DISCOVER_MODE`                      | `native`                      | `native`: enabled servers' tools listed as `<server>__<tool>`; `proxy`: meta tools only |
| `AGENT_DISCOVER_IDLE_MS`                   | `1800000`                     | Daemon exits after this long with no open MCP streams and no WS clients (`0` = never)   |
| `AGENT_DISCOVER_CONN_IDLE_MS`              | `600000`                      | Idle upstream connections are closed                                                    |
| `AGENT_DISCOVER_ALLOW_UNCONFIRMED_INSTALL` | unset                         | `1` lets `install_server` run without an elicitation prompt (operator opt-in)           |
| `AGENT_DISCOVER_SETUP_FILE`                | unset                         | Declarative server list synced at daemon start                                          |
| `AGENT_DISCOVER_EMBEDDING_PROVIDER`        | `none`                        | `openai` / `local` adds semantic ranking                                                |

## MCP

`tools/list` is sorted by name. Server `instructions` explain the flow. Prompts: `discover(task)`, `install(server)`, `status`.

| Tool             | Annotations             | Purpose                                                                                                                                             |
| ---------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_servers` | read-only, open-world   | `{query, limit?, marketplace?}` → installed matches + public registry / npm / PyPI matches                                                          |
| `install_server` | idempotent, open-world  | `{name, package?+runtime? \| command+args? \| url+transport?, env?, headers?, enable?}` → installs and indexes                                      |
| `enable_server`  | idempotent              | `{name}` → exposes the server's tools (indexes first if needed)                                                                                     |
| `disable_server` | idempotent              | `{name}` → hides them; index and searchability stay                                                                                                 |
| `server_status`  | read-only               | `{name?, check_health?}` → installed/indexed/enabled/connected/tool_count/health                                                                    |
| `search_tools`   | read-only               | `{queries: string[1..10], limit?}` → per query, matches across **all installed** servers with `score` (0..1), `enabled`, `exposed`, `required_args` |
| `get_tool`       | read-only               | `{server, tool}` → full definition (input/output schema, annotations, `tool_hash`) by direct lookup                                                 |
| `call_tool`      | destructive, open-world | `{server, tool, arguments?}` → the upstream `CallToolResult`, unchanged                                                                             |

All tools except `call_tool` declare an `outputSchema` and return `structuredContent`.

**Native tools** (`AGENT_DISCOVER_MODE=native`): each enabled server's indexed tools are listed as `<server>__<tool>` with the upstream schema, output schema and annotations verbatim. Every enable / disable / uninstall / re-index of an enabled server emits `notifications/tools/list_changed` (on 2026 `subscriptions/listen` streams and on every 2025 session).

**Install consent.** `install_server` asks the user through elicitation (2026: `input_required` round; 2025: `elicitation/create` via the SDK legacy shim), showing the exact command line or URL, env var names, header names and source. The consent is bound to a hash of the proposed config. Clients that cannot elicit get an `isError` result telling the user to install from the dashboard — unless the operator set `AGENT_DISCOVER_ALLOW_UNCONFIRMED_INSTALL=1`. There is deliberately no agent-supplied `confirm` argument.

**Upstream input requests.** An upstream 2026 server's `input_required` result is relayed to the client (its `requestState` wrapped in an HMAC-sealed state bound to that server and tool). An upstream 2025 server's `elicitation/create` push goes to the dashboard queue (`/api/elicitations`).

## REST

Errors are `{ error, code? }` with 400 (validation), 404, 409, 413, 415, 502 (upstream failure) or 500.

### Health and status

- `GET /api/health` → `{status:"ok", version, pid, mode, uptime}` (the shim's readiness probe)
- `GET /api/status` → `{mode, servers: ServerStatus[]}`

### Servers

Server objects carry the stored row (`name, description, source, transport, command, args, env, url, headers, tags, package_name, package_version, repository, homepage, enabled, quarantined, indexed_at, health_status, last_health_check, error_count`) plus live `connected` and `tool_count`.

- `GET /api/servers?query=&source=`
- `GET /api/servers/:id` → server + `tools` (indexed definitions)
- `POST /api/servers` `{name, transport?, command?, args?, env?, url?, headers?, ..., enabled?}` → 201 server (+ `index_error` when the probe failed; the server stays installed)
- `PUT /api/servers/:id` → update (drops the live connection)
- `DELETE /api/servers/:id`
- `POST /api/servers/:id/enable` · `POST /api/servers/:id/disable`
- `POST /api/servers/:id/index` → re-index; returns `{added, changed, removed, unchanged, embedded}`
- `POST /api/servers/:id/health` → `{status, latency_ms, error?}` (real ping / `server/discover`)
- `POST /api/servers/:id/reset-errors`
- `POST /api/servers/:id/call` `{tool, args}` → upstream `CallToolResult`
- `GET|PUT|DELETE /api/servers/:id/secrets[/:key]` (PUT body `{value}`; changes drop the live connection)
- `GET /api/servers/:id/metrics` · `GET /api/metrics`

Removed in 2.0: `/health` (use `/api/health`), `/activate`, `/deactivate` (use `/enable`, `/disable`), `/preinstall`.

### Tester (connects lazily; same routes under `/api/transient/:handle`)

`GET /info`, `GET /tools`, `GET /resources`, `GET /resource-templates`, `POST /resource/read|subscribe|unsubscribe`, `GET /prompts`, `POST /prompt/get`, `POST /ping`, `POST /logging-level`, `GET /export?format=mcp-json|agent-discover`, `POST /call`.
`POST /api/transient` `{transport, command|url, args?, env?, headers?, ttl_ms?}` → 201 handle · `DELETE /api/transient/:handle`.

### Other

`GET /api/browse?query=&limit=&cursor=` · `GET /api/prereqs` · `GET /api/npm-check?package=` · `POST /api/sync` · `GET|DELETE /api/logs` · `GET /api/logs/notifications` · `GET /api/logs/progress` · `GET|POST /api/presets`, `DELETE /api/presets/:id` · `GET /api/elicitations`, `POST /api/elicitations/:id/respond` · `GET /api/roots`.

## WebSocket (`/ws`)

Server → client: `{type:"state", version, mode, servers}` on connect and after every lifecycle change (debounced), `log_entry`, `notification`, `progress`, `elicitation_request`. Client → server: `{type:"refresh"}`. Max 50 clients, 4 KiB messages.

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

`auto_activate` was renamed to `enabled`; a file still using it fails sync with a clear error. A sibling `*.local.json` is merged.
