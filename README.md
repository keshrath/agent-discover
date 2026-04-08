# agent-discover

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-151%20passing-brightgreen)]()
[![MCP Tools](https://img.shields.io/badge/MCP%20tools-1-purple)]()
[![REST Endpoints](https://img.shields.io/badge/REST-19%20endpoints-orange)]()

**MCP server registry and marketplace.** Discover, install, activate, and manage MCP tools on demand. Acts as a dynamic proxy -- activated servers have their tools merged into the registry's own tool list, so agents can use them without restarting.

Search spans the **official MCP registry**, **npm**, and **PyPI** in one query, so popular servers that aren't in the official index (Microsoft `@playwright/mcp`, `@modelcontextprotocol/server-*`, `mcp-server-fetch`, `mcp-server-git`, …) all show up.

Built for AI coding agents (Claude Code, Codex CLI, Gemini CLI, Aider) but works equally well with any MCP client, REST consumer, or WebSocket listener.

---

| Light Theme                                | Dark Theme                               |
| ------------------------------------------ | ---------------------------------------- |
| ![Light Theme](docs/screenshots/light.png) | ![Dark Theme](docs/screenshots/dark.png) |

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
| **Management**   | Manual config edits               | Dashboard + REST API for config, tags                      |

---

## Features

- **Local registry** -- register MCP servers in a SQLite database with name, command, args, env, tags
- **Federated marketplace search** -- a single query hits the official MCP registry, npm, and PyPI in parallel, dedupes by `<source>:<name>`, and collapses version duplicates
- **PyPI integration** -- curated list of well-known Python MCP servers (`mcp-server-fetch`, `mcp-server-git`, `mcp-server-time`, `mcp-server-postgres`, `mcp-server-sqlite`, `mcp-proxy`, …) plus live metadata via the PyPI JSON API; Python entries install via `uvx`
- **npm fallback** -- two parallel npm searches (`keywords:mcp` and `<query> mcp`) catch packages that didn't tag themselves (e.g. Microsoft `@playwright/mcp`)
- **Prereqs probe** -- `GET /api/prereqs` reports which package managers (`npx`, `uvx`, `docker`, `uv`) are available on the host; the dashboard surfaces a banner when something needed for an install is missing
- **Cross-process activation** -- the `active` flag is the source of truth in SQLite; every fresh agent-discover process hydrates its in-memory proxy from the DB on startup, so tools activated in one process show up in others
- **On-demand activation** -- activate/deactivate servers at runtime; their tools appear and disappear dynamically with `tools/list_changed` notifications
- **Tool proxying** -- activated server tools are namespaced as `serverName__toolName` and merged into the tool list
- **Multi-transport** -- stdio, SSE, and streamable-http transports for connecting to child servers
- **Secret management** -- store API keys and tokens per server, automatically injected as env vars (stdio) or HTTP headers (SSE/streamable-http) on activation; CRLF-validated to prevent header injection
- **Health checks** -- connect/disconnect probes for inactive servers, tool-list checks for active ones, with error count tracking
- **Per-tool metrics** -- call counts, error counts, and average latency recorded automatically on every proxied tool call
- **Full-text search** -- FTS5 search across server names, descriptions, and tags
- **Pre-download** -- fire-and-forget `npm cache add` (npx servers) or `uv tool install` (uvx servers) on registration, plus a dedicated `/preinstall` endpoint
- **Real-time dashboard** -- web UI at http://localhost:3424 with Servers and Browse tabs, dark/light theme, WebSocket updates
- **3 transport layers** -- MCP (stdio), REST API (HTTP), WebSocket (real-time events)

---

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

Add to your MCP client config (Claude Code, Cline, Cursor, Windsurf, etc.):

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

## MCP Tools (1)

A single action-based tool handles every operation via the `action` parameter — this keeps the prompt-overhead cost minimal.

| Tool       | Actions                                                                      | Description                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `registry` | `list`, `install`, `uninstall`, `activate`, `deactivate`, `browse`, `status` | Registry + server lifecycle — search local servers, install from marketplace or manual config, activate/deactivate, browse, show status |

Activated servers expose their tools through agent-discover, namespaced as `serverName__toolName`. For example, activating a server named `filesystem` that exposes `read_file` makes it available as `filesystem__read_file`.

---

## REST API (19 endpoints)

All endpoints return JSON. CORS enabled.

```
GET    /health                            Version, uptime
GET    /api/prereqs                       Probe host for npx/uvx/docker/uv availability
GET    /api/servers                       List servers (?query=, ?source=, ?installed=)
GET    /api/servers/:id                   Server details + tools
POST   /api/servers                       Register new server
PUT    /api/servers/:id                   Update server config (description, command, args, env, tags)
DELETE /api/servers/:id                   Unregister (deactivates first if active)
POST   /api/servers/:id/activate          Activate -- start server, discover tools, begin proxying
POST   /api/servers/:id/deactivate        Deactivate -- stop server, remove tools
POST   /api/servers/:id/preinstall        Pre-download package (npm cache add for npx, uv tool install for uvx)
GET    /api/servers/:id/secrets           List secrets (masked values)
PUT    /api/servers/:id/secrets/:key      Set a secret (upsert)
DELETE /api/servers/:id/secrets/:key      Delete a secret
POST   /api/servers/:id/health            Run health check (connect/disconnect probe)
GET    /api/servers/:id/metrics           Per-tool metrics for a server (call count, errors, latency)
GET    /api/metrics                       Metrics overview across all servers
GET    /api/browse                        Federated search: official registry + npm + PyPI (?query=, ?limit=, ?cursor=)
GET    /api/npm-check                     Check if an npm package exists (?package=)
GET    /api/status                        Active servers summary (names, tool counts, tool lists)
```

---

## Dashboard

The web dashboard auto-starts at **http://localhost:3424** and provides two views:

**Servers tab** -- all registered servers as cards showing health dots, error counts, active/inactive status, description, tags, tools list, and expandable Secrets/Metrics/Config sections. Action buttons for activate, deactivate, health check, and delete.

**Browse tab** -- federated search across the official MCP registry, npm, and PyPI. Each card shows the runtime tag (`node`, `python`, `streamable-http`, …), version, description, and an install button that picks the right command (`npx`, `uvx`, or remote URL) automatically. A prereq banner at the top of the tab warns when a required package manager (`npx`, `uvx`, `docker`) is missing on the host.

Real-time updates via WebSocket with 2-second database polling. Dark and light themes with persistent preference.

---

## Testing

```bash
npm test              # 177 tests across 12 files
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
npm run check         # Full CI: typecheck + lint + format + test
npm run test:e2e:ui   # Playwright dashboard smoke tests
```

---

## Environment Variables

| Variable              | Default                       | Description          |
| --------------------- | ----------------------------- | -------------------- |
| `AGENT_DISCOVER_PORT` | `3424`                        | Dashboard HTTP port  |
| `AGENT_DISCOVER_DB`   | `~/.claude/agent-discover.db` | SQLite database path |

### Host package manager prerequisites

agent-discover spawns child MCP servers via the host's installed package managers. Install whatever you intend to use; missing tools are reported by `GET /api/prereqs` and surfaced as a banner in the Browse tab.

| Tool     | Used for                        | Install hint                                          |
| -------- | ------------------------------- | ----------------------------------------------------- |
| `npx`    | npm-published MCP servers       | ships with [Node.js](https://nodejs.org/)             |
| `uvx`    | PyPI-published MCP servers      | install [uv](https://docs.astral.sh/uv/)              |
| `docker` | Docker-image MCP servers (rare) | install [Docker](https://docs.docker.com/get-docker/) |

---

## Documentation

- [User Manual](docs/USER-MANUAL.md) -- comprehensive guide covering all tools, REST API, dashboard, and troubleshooting
- [API Reference](docs/API.md) -- all MCP tools and REST endpoints
- [Architecture](docs/ARCHITECTURE.md) -- source structure, design principles, database schema
- [Dashboard](docs/DASHBOARD.md) -- web UI views and features
- [Setup Guide](docs/SETUP.md) -- installation, client setup (Claude Code, Cursor, Windsurf)
- [Changelog](CHANGELOG.md)

---

## License

MIT -- see [LICENSE](LICENSE)
