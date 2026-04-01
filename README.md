# agent-discover

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)](https://nodejs.org/)
[![MCP Tools](https://img.shields.io/badge/MCP%20tools-2-purple)]()
[![REST Endpoints](https://img.shields.io/badge/REST-16%20endpoints-orange)]()

**MCP server registry and marketplace.** Discover, install, activate, and manage MCP tools on demand. Acts as a dynamic proxy -- activated servers have their tools merged into the registry's own tool list, so agents can use them without restarting.

## Why

Static MCP configs mean every server is always running, even when unused. Adding a new server requires editing config files and restarting. There's no way to browse what's available or install new tools at runtime.

**agent-discover** solves this:

- **Register** MCP servers in a local SQLite database
- **Browse** the official MCP registry (registry.modelcontextprotocol.io) and install with one tool call
- **Activate/deactivate** servers on demand -- their tools appear and disappear dynamically
- **Proxy** tool calls transparently -- activated server tools are namespaced as `serverName__toolName`
- **Secrets management** -- store API keys and tokens per server, automatically injected as env vars on activation
- **Health monitoring** -- check server health via connect/disconnect probes, track health status and error counts
- **Metrics** -- per-tool call counts, error counts, and average latency, recorded automatically by the proxy
- **Approval workflow** -- tag servers as `experimental`, `approved`, or `production`
- **Config editing** -- update server description, command, args, env, and approval status via REST API or dashboard
- **Dashboard** shows everything in real time at http://localhost:3424

## Quick Start

### Install from npm

```bash
npm install -g agent-discover
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

## MCP Tools

| Tool              | Actions                                            | Description                                                   |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| `registry`        | `list`, `install`, `uninstall`, `browse`, `status` | Registry management — search, install, remove, browse, status |
| `registry_server` | `activate`, `deactivate`                           | Server lifecycle — start/stop MCP servers on demand           |

## REST API

| Method | Path                            | Description                                                                   |
| ------ | ------------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/health`                       | Version, uptime                                                               |
| GET    | `/api/servers`                  | List servers (`?query=`, `?source=`, `?installed=`)                           |
| GET    | `/api/servers/:id`              | Server details + tools                                                        |
| POST   | `/api/servers`                  | Register new server                                                           |
| PUT    | `/api/servers/:id`              | Update server config (description, command, args, env, tags, approval_status) |
| DELETE | `/api/servers/:id`              | Unregister                                                                    |
| POST   | `/api/servers/:id/activate`     | Activate                                                                      |
| POST   | `/api/servers/:id/deactivate`   | Deactivate                                                                    |
| GET    | `/api/servers/:id/secrets`      | List secrets (masked values)                                                  |
| PUT    | `/api/servers/:id/secrets/:key` | Set a secret                                                                  |
| DELETE | `/api/servers/:id/secrets/:key` | Delete a secret                                                               |
| POST   | `/api/servers/:id/health`       | Run health check                                                              |
| GET    | `/api/servers/:id/metrics`      | Per-tool metrics for a server                                                 |
| GET    | `/api/metrics`                  | Metrics overview across all servers                                           |
| GET    | `/api/browse`                   | Proxy to official MCP registry                                                |
| GET    | `/api/status`                   | Active servers summary                                                        |

## Configuration

| Env Variable          | Default                       | Description          |
| --------------------- | ----------------------------- | -------------------- |
| `AGENT_DISCOVER_PORT` | `3424`                        | Dashboard HTTP port  |
| `AGENT_DISCOVER_DB`   | `~/.claude/agent-discover.db` | SQLite database path |

## Development

```bash
npm run build          # Compile TypeScript + copy UI
npm test               # Run tests
npm run check          # Full check (typecheck + lint + format + test)
```

## License

MIT
