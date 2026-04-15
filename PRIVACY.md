# Privacy Policy — agent-discover

**Last updated:** 2026-04-15

## What data this plugin accesses

- **Local filesystem only.** Maintains a local SQLite registry at `~/.claude/agent-discover.db` (configurable via `AGENT_DISCOVER_DB`) listing MCP servers you add, their tool metadata, per-server secrets, health-probe results, metrics, and a rolling call log.
- **Runs child processes.** When you activate an MCP server through agent-discover, it spawns that server as a child process via stdio and proxies tool calls to it. The proxy records call latency, success/failure, and a log entry per call. All records stay on your machine.
- **No telemetry.** The plugin does not collect or transmit usage data.

## Third-party data flow (on your action)

- **Marketplace browse.** When you browse or search the marketplace, the plugin queries the official MCP Registry API to fetch the server catalog. Query terms you type are sent to that API.
- **Child MCP servers.** When you activate a third-party MCP server through agent-discover, that server receives the tool arguments you send it — governed by its own terms, not this plugin's.

## Secrets handling

- Per-server secrets are stored locally in the SQLite DB. On listing, values are masked by default.
- On server activation, secrets are merged into the child process environment. They are not logged, not sent to any external service by this plugin, and not included in metrics or call logs.

## Data retention

- Server registry: persists until you uninstall a server.
- Call logs: in-memory ring buffer (default 500 entries) with optional disk retention (configurable via `AGENT_DISCOVER_LOG_RETENTION_DAYS`). Clear any time via the dashboard.
- Metrics: persisted in SQLite, wiped on uninstall of the associated server.

## Contact

Issues and security reports: <https://github.com/keshrath/agent-discover/issues>
