# agent-discover

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)](https://nodejs.org/)
[![MCP Tools](https://img.shields.io/badge/MCP%20tools-2-purple)]()
[![REST Endpoints](https://img.shields.io/badge/REST-16%20endpoints-orange)]()

**MCP server registry and marketplace.** Discover, install, activate, and manage MCP tools on demand. Acts as a dynamic proxy -- activated servers have their tools merged into the registry's own tool list, so agents can use them without restarting.

---

| Light Theme                                    | Dark Theme                                   |
| ---------------------------------------------- | -------------------------------------------- |
| ![Light mode](docs/screenshots/light-mode.png) | ![Dark mode](docs/screenshots/dark-mode.png) |

---

## Why

Static MCP configs mean every server is always running, even when unused. Adding a new server requires editing config files and restarting. There is no way to browse what is available or install new tools at runtime.

|                  | Without agent-discover            | With agent-discover                                        |
| ---------------- | --------------------------------- | ---------------------------------------------------------- |
| **Discovery**    | Must know server names in advance | Browse the official MCP registry, search by keyword        |
| **Installation** | Edit config files, restart agent  | One tool call installs and registers                       |
| **Activation**   | All servers always running        | Activate/deactivate on demand, tools appear/disappear live |
| **Secrets**      | API keys in config files or env   | Per-server secret storage, auto-injected on activation     |
| **Monitoring**   | No visibility into server health  | Health checks, per-tool metrics, error counts              |
| **Management**   | Manual config edits               | Dashboard + REST API for config, approval status, tags     |

**agent-discover** solves this:

- **Register** MCP servers in a local SQLite database
- **Browse** the official MCP registry (`registry.modelcontextprotocol.io`) and install with one tool call
- **Activate/deactivate** servers on demand -- their tools appear and disappear dynamically
- **Proxy** tool calls transparently -- activated server tools are namespaced as `serverName__toolName`
- **Manage secrets** -- store API keys and tokens per server, automatically injected as env vars on activation
- **Monitor health** -- run health checks, track health status and error counts
- **Track metrics** -- per-tool call counts, error counts, and average latency recorded automatically
- **Control approvals** -- tag servers as `experimental`, `approved`, or `production`
- **Edit config** -- update server description, command, args, env, and approval status via REST or dashboard
- A **web dashboard** shows everything in real time at http://localhost:3424

It works with any agent that supports [MCP](https://modelcontextprotocol.io/) (stdio transport) or can make HTTP requests (REST API).

## Quick Start

### Install from npm

```bash
npm install -g agent-discover
```

### Or run directly with npx

```bash
npx agent-discover
```

### Or clone from source

```bash
git clone https://github.com/keshrath/agent-discover.git
cd agent-discover
npm install
npm run build
```

### Option 1: MCP server (for AI agents)

Add to your MCP client config (Claude Code, Cline, etc.):

```json
{
  "mcpServers": {
    "agent-discover": {
      "command": "npx",
      "args": ["agent-discover"]
    }
  }
}
```

The dashboard auto-starts at http://localhost:3424 on the first MCP connection.

### Option 2: Standalone server (for REST/WebSocket clients)

```bash
node dist/server.js --port 3424
```

---

## MCP Tools (2)

Both tools are action-based -- a single tool handles multiple operations via the `action` parameter.

| Tool              | Actions                                            | Description                                                                                                        |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `registry`        | `list`, `install`, `uninstall`, `browse`, `status` | Registry management -- search local servers, install from registry, remove, browse marketplace, show active status |
| `registry_server` | `activate`, `deactivate`                           | Server lifecycle -- start/stop MCP servers on demand, tools appear/disappear dynamically                           |

Activated servers expose their tools through agent-discover, namespaced as `serverName__toolName`. For example, activating a server named `filesystem` that exposes `read_file` makes it available as `filesystem__read_file`.

---

## REST API (16 endpoints)

All endpoints return JSON. CORS enabled.

| Method | Path                            | Description                                                                   |
| ------ | ------------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/health`                       | Version, uptime                                                               |
| GET    | `/api/servers`                  | List servers (`?query=`, `?source=`, `?installed=`)                           |
| GET    | `/api/servers/:id`              | Server details + tools                                                        |
| POST   | `/api/servers`                  | Register new server                                                           |
| PUT    | `/api/servers/:id`              | Update server config (description, command, args, env, tags, approval_status) |
| DELETE | `/api/servers/:id`              | Unregister (deactivates first if active)                                      |
| POST   | `/api/servers/:id/activate`     | Activate -- start server, discover tools, begin proxying                      |
| POST   | `/api/servers/:id/deactivate`   | Deactivate -- stop server, remove tools                                       |
| GET    | `/api/servers/:id/secrets`      | List secrets (masked values)                                                  |
| PUT    | `/api/servers/:id/secrets/:key` | Set a secret (upsert)                                                         |
| DELETE | `/api/servers/:id/secrets/:key` | Delete a secret                                                               |
| POST   | `/api/servers/:id/health`       | Run health check (connect/disconnect probe)                                   |
| GET    | `/api/servers/:id/metrics`      | Per-tool metrics for a server (call count, errors, latency)                   |
| GET    | `/api/metrics`                  | Metrics overview across all servers                                           |
| GET    | `/api/browse`                   | Proxy to official MCP registry (`?query=`, `?limit=`, `?cursor=`)             |
| GET    | `/api/status`                   | Active servers summary (names, tool counts, tool lists)                       |

---

## Dashboard

The web dashboard auto-starts at **http://localhost:3424** and provides two views:

**Servers tab** -- all registered servers as cards showing approval badges, health dots, error counts, active/inactive status, description, tags, tools list, and expandable Secrets/Metrics/Config sections. Action buttons for activate, deactivate, health check, and delete.

**Browse tab** -- search the official MCP registry. Results show server name, version, description, packages, and an install button.

Real-time updates via WebSocket with 2-second database polling. Dark and light themes with persistent preference.

---

## Testing

```bash
npm test              # Run tests
npm run check         # Full check (typecheck + lint + format + test)
```

---

## Environment Variables

| Variable              | Default                       | Description          |
| --------------------- | ----------------------------- | -------------------- |
| `AGENT_DISCOVER_PORT` | `3424`                        | Dashboard HTTP port  |
| `AGENT_DISCOVER_DB`   | `~/.claude/agent-discover.db` | SQLite database path |

---

## Documentation

- [User Manual](docs/USER-MANUAL.md) -- comprehensive guide covering all tools, REST API, dashboard, and troubleshooting
- [Changelog](CHANGELOG.md)

---

## License

MIT -- see [LICENSE](LICENSE)
