# Privacy Policy — agent-discover

**Last updated:** 2026-10-05 (agent-discover 2.0)

## What data this plugin accesses

- **Local filesystem only.** Maintains a local SQLite database `agent-discover.db` in your per-user data directory (`AGENT_DISCOVER_DATA_DIR`, else `%LOCALAPPDATA%\agent-discover` on Windows, `~/Library/Application Support/agent-discover` on macOS, `$XDG_DATA_HOME/agent-discover` or `~/.local/share/agent-discover` on Linux; `AGENT_DISCOVER_DB` overrides the file). It holds the MCP servers you install, their tool metadata and pins, a mirror of the MCP Registry, key names of per-server secrets, health-probe results, metrics, a rolling call log and the audit log.
- **Local daemon.** One daemon serves the dashboard, REST, WebSocket and MCP endpoint. It listens on `127.0.0.1` by default (`AGENT_DISCOVER_HOST`).
- **Runs child processes.** When you enable a local MCP server through agent-discover, it spawns that server as a child process and relays tool calls to it. Remote servers are reached over HTTP. Call latency, success/failure and a log entry per call stay on your machine.
- **Audit log.** Installs, approvals, quarantines, secret changes and tool calls are recorded locally in an append-only audit log. Tool-call arguments are recorded only if you set `AGENT_DISCOVER_AUDIT_ARGS=1`, with secret-looking values masked.
- **No telemetry by default.** The plugin does not collect or transmit usage data. OpenTelemetry export is off unless you set `OTEL_EXPORTER_OTLP_ENDPOINT` or `AGENT_DISCOVER_OTEL=1`; it then goes to the endpoint you configured.

## Third-party data flow (on your action)

- **Registry mirror.** The daemon syncs the server catalog from the official MCP Registry (`registry.modelcontextprotocol.io`, configurable with `AGENT_DISCOVER_REGISTRY_URL`) into the local database.
- **Browse and install.** Searching can also query npm and PyPI, and installing checks provenance against those registries. Query terms and package names you use are sent to them.
- **Child MCP servers.** When you enable a third-party MCP server through agent-discover, that server receives the tool arguments you send it, governed by its own terms, not this plugin's.
- **OAuth.** For remote servers that require sign-in, agent-discover talks to that server's authorization server on your action.

## Secrets handling

- Per-server secrets are stored in the OS keychain, or, without a usable keychain, in an AES-256-GCM encrypted file in the data directory. The SQLite database keeps only key names and the backend.
- Secret values are never returned by REST, WebSocket or MCP output; listings show key names only.
- OAuth tokens and client credentials are stored the same way, as server secrets.
- When you enable a server, secrets are merged into the child process environment or the declared request headers. They are not logged, not sent to any service by this plugin, and not included in metrics, call logs or audit entries.

## Data retention

- Server registry: persists until you uninstall a server.
- Call logs: in-memory ring buffer (default 500 entries) with optional disk retention (configurable via `AGENT_DISCOVER_LOG_RETENTION_DAYS`). Clear any time via the dashboard.
- Metrics: persisted in SQLite, wiped on uninstall of the associated server.
- Audit log: persisted in SQLite, trimmed to `AGENT_DISCOVER_AUDIT_MAX_ROWS`.

## Contact

Issues and security reports: <https://github.com/keshrath/agent-discover/issues>
