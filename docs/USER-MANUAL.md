# agent-discover User Manual

## Table of Contents

1. [Overview](#1-overview)
2. [Installation](#2-installation)
3. [Configuration](#3-configuration)
4. [Dashboard Guide](#4-dashboard-guide)
5. [MCP Tools Reference](#5-mcp-tools-reference)
6. [REST API Reference](#6-rest-api-reference)
7. [Server Management](#7-server-management)
8. [Marketplace](#8-marketplace)
9. [Enterprise Features](#9-enterprise-features)
10. [Troubleshooting](#10-troubleshooting)
11. [FAQ](#11-faq)

---

## 1. Overview

### What agent-discover Does

agent-discover is an MCP (Model Context Protocol) server that functions as a dynamic registry and marketplace for other MCP servers. Instead of hardcoding every MCP server in your agent's configuration and restarting each time you add or remove one, agent-discover lets you:

- **Register** MCP servers in a local SQLite database.
- **Browse** the official MCP registry at `registry.modelcontextprotocol.io` and install servers with a single tool call.
- **Activate and deactivate** servers on demand -- their tools appear and disappear from the agent's tool list without any restart.
- **Proxy** tool calls transparently -- activated server tools are namespaced as `serverName__toolName` and routed through agent-discover to the child server process.
- **Manage secrets** -- store API keys and tokens per server, automatically injected into the environment on activation.
- **Monitor health** -- run health checks on servers, track health status and error counts.
- **Track metrics** -- per-tool call counts, error counts, and latency recorded automatically.
- **Control approval status** -- tag servers as experimental, approved, or production.
- **Monitor** everything via a real-time web dashboard.

### Architecture

agent-discover has two entry points:

| Entry Point      | File             | Purpose                                                                                   |
| ---------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| MCP stdio server | `dist/index.js`  | Communicates with the AI agent via JSON-RPC over stdin/stdout. Auto-starts the dashboard. |
| HTTP server      | `dist/server.js` | Standalone dashboard + REST API. Useful for running the UI independently.                 |

Internally, the project uses a layered architecture:

```
domain/      Registry CRUD, MCP proxy, marketplace client, installer, secrets, health, metrics, event bus
storage/     SQLite via better-sqlite3 (WAL mode, schema V2)
transport/   REST (node:http), WebSocket (ws), MCP (stdio JSON-RPC)
ui/          Vanilla JS dashboard (no build step for the UI itself)
```

There are no framework dependencies -- no Express, no React. Everything is built on Node.js standard library plus a few focused packages (better-sqlite3, ws, @modelcontextprotocol/sdk).

---

## 2. Installation

### Prerequisites

- **Node.js 20.11.0 or later** (required by the `engines` field in package.json)
- **npm** (comes with Node.js)
- **Git** (to clone the repository)

### From Source

```bash
git clone https://github.com/keshrath/agent-discover.git
cd agent-discover
npm install
npm run build
```

The build step compiles TypeScript to `dist/` and copies the UI files (`index.html`, `app.js`, `styles.css`, `morphdom.min.js`) into `dist/ui/`.

### From npm (When Published)

```bash
npm install -g agent-discover
```

Once installed globally, the `agent-discover` command becomes available. It runs the MCP stdio server.

### Setup Script

The included setup script automates Claude Code configuration:

```bash
node scripts/setup.js
```

What it does:

1. Builds the project if `dist/` is missing.
2. Adds agent-discover to `~/.claude.json` under `mcpServers`.
3. Adds the `mcp__agent-discover__*` permission to `~/.claude/settings.json`.

For non-Claude agents, pass `--agent generic` to get manual configuration instructions:

```bash
node scripts/setup.js --agent generic
```

---

## 3. Configuration

### Environment Variables

| Variable              | Default                       | Description                 |
| --------------------- | ----------------------------- | --------------------------- |
| `AGENT_DISCOVER_PORT` | `3424`                        | HTTP port for the dashboard |
| `AGENT_DISCOVER_DB`   | `~/.claude/agent-discover.db` | Path to the SQLite database |

Set these before starting agent-discover. For example:

```bash
AGENT_DISCOVER_PORT=4000 node dist/index.js
```

### Claude Code Setup

Add agent-discover to your Claude Code MCP configuration in `~/.claude.json`:

```json
{
  "mcpServers": {
    "agent-discover": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/agent-discover/dist/index.js"],
      "env": {}
    }
  }
}
```

Replace `/absolute/path/to/agent-discover` with the actual path where you cloned the repository.

### Permissions (settings.json)

To allow Claude Code to call agent-discover tools and any proxied tools without prompting, add a wildcard permission to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__agent-discover__*"]
  }
}
```

This covers both the 2 built-in registry tools (`registry` and `registry_server`) and all dynamically proxied tools from activated servers (since proxied tools are also exposed through agent-discover).

### Other MCP Clients

#### OpenCode

Add to your OpenCode MCP configuration:

```json
{
  "mcpServers": {
    "agent-discover": {
      "command": "node",
      "args": ["/path/to/agent-discover/dist/index.js"]
    }
  }
}
```

#### Cursor

In Cursor's MCP settings, add a new server entry with:

- **Command**: `node`
- **Arguments**: `/path/to/agent-discover/dist/index.js`
- **Transport**: stdio

#### Generic MCP Client

Any MCP client that supports the stdio transport can connect to agent-discover. The server communicates via JSON-RPC 2.0 over stdin/stdout. Configure the client to spawn `node /path/to/dist/index.js` as the server process.

---

## 4. Dashboard Guide

### Accessing the Dashboard

The dashboard is available at **http://localhost:3424** (or the port configured via `AGENT_DISCOVER_PORT`).

When agent-discover runs as an MCP stdio server (the normal mode), it automatically attempts to start the dashboard on first `initialize` handshake. If the port is already in use (another instance is serving), it silently skips dashboard startup.

To run the dashboard standalone:

```bash
node dist/server.js
node dist/server.js --port 4000
node dist/server.js --db /path/to/custom.db
```

### Servers Tab

The default view. Shows all servers registered in the local database as cards. This is a merged view -- both installed and active servers appear in a single list.

Each card displays:

- **Server name** with a clickable **approval badge** (`experimental`, `approved`, or `production`). Clicking the badge opens a dropdown to change the status.
- **Health dot** next to the status indicator -- green (healthy), red (unhealthy), or gray (unknown).
- **Error count** badge (visible only when errors > 0).
- **Active/Inactive status** indicator (green dot = active, gray dot = inactive).
- **Description** text.
- **Tags** as small badges.
- **Source** (local, registry, smithery, manual) and **transport** (stdio, sse, streamable-http).
- **Tools list** with name and description (if the server has been activated at least once), displayed in a grid.
- **Action buttons**: Activate or Deactivate, Check Health, Delete.
- **Expandable sections** (click to toggle):
  - **Secrets**: Shows stored secrets with masked values. Add new secrets via key/value form. Delete individual secrets.
  - **Metrics**: Table showing per-tool call count, error count, and average latency. Loaded on expand.
  - **Config**: Edit server description, command, args, and env vars. Save button persists changes via `PUT /api/servers/:id`.

When no servers are registered, a placeholder message is shown with a hint to use `registry` with `action: "install"` or browse the marketplace.

### Browse Tab

Search the official MCP registry. Type a query in the search bar and results appear after a 400ms debounce delay. Each result card shows:

- **Server name** and **version**
- **Description**
- **Available packages** with their runtime (node, python, etc.)
- **Repository link** (clickable, opens in new tab)
- **Install button**: Registers the server in the local database. Shows a checkmark and "Installed" label if already present. Shows a spinner during installation and an error indicator on failure.

The search calls `GET /api/browse?query=...&limit=20` which proxies to the official MCP registry API.

### Theme Toggle

Click the moon/sun icon in the bottom-left corner of the sidebar to switch between dark and light themes. The preference is saved in `localStorage` and persists across sessions.

### Real-Time Updates

The dashboard connects to agent-discover via WebSocket. On connect, it receives the full state (all servers, active status, tools). After that, the server polls the database every 2 seconds for changes and pushes updates to all connected clients when the data fingerprint changes. This means any action taken via MCP tools (activating, deactivating, installing) is reflected in the dashboard within about 2 seconds.

The WebSocket auto-reconnects after a 2-second delay if the connection drops. A ping/pong heartbeat runs every 30 seconds to detect stale connections. The server limits to 50 concurrent WebSocket connections.

---

## 5. MCP Tools Reference

agent-discover exposes 2 action-based MCP tools, plus any number of proxied tools from activated servers. The `registry` tool handles actions: `list`, `install`, `uninstall`, `browse`, `status`. The `registry_server` tool handles actions: `activate`, `deactivate`.

> **Note:** The examples below use the shorthand `registry_list`, `registry_install`, etc. for readability. In practice, these are called as the `registry` tool with `action: "list"`, `action: "install"`, etc. Similarly, `registry_activate` and `registry_deactivate` are called as the `registry_server` tool with `action: "activate"` or `action: "deactivate"`.

### registry_list

List or search the local MCP server registry.

**Parameters:**

| Name             | Type    | Required | Description                                                      |
| ---------------- | ------- | -------- | ---------------------------------------------------------------- |
| `query`          | string  | No       | Full-text search query (uses FTS5, prefix matching)              |
| `source`         | string  | No       | Filter by source: `local`, `registry`, `smithery`, `manual`      |
| `installed_only` | boolean | No       | Only show servers that are installed (have a command configured) |

**Example usage in Claude Code:**

```
Use registry_list to show all registered servers.
Use registry_list with query "git" to find Git-related servers.
Use registry_list with source "registry" to show servers installed from the marketplace.
```

**Example response:**

```json
[
  {
    "id": 1,
    "name": "filesystem",
    "description": "MCP server for filesystem operations",
    "source": "registry",
    "tags": ["files", "io"],
    "installed": true,
    "active": false,
    "transport": "stdio",
    "approval_status": "experimental",
    "health_status": "unknown",
    "last_health_check": null,
    "error_count": 0,
    "tool_count": 5
  }
]
```

**Error cases:**

- FTS query syntax errors fall back to LIKE-based search automatically.

---

### registry_install

Install (register) an MCP server in the local database. Can auto-fetch metadata and install configuration from the official MCP registry, or accept manual configuration.

**Parameters:**

| Name              | Type     | Required | Description                                                                                    |
| ----------------- | -------- | -------- | ---------------------------------------------------------------------------------------------- |
| `name`            | string   | Yes      | Server name or npm package name                                                                |
| `source`          | string   | No       | `"registry"` to auto-fetch from the official MCP registry, `"manual"` for manual registration  |
| `command`         | string   | No       | Command to start the server (required for manual install)                                      |
| `args`            | string[] | No       | Command-line arguments                                                                         |
| `env`             | object   | No       | Environment variables for the server process                                                   |
| `approval_status` | string   | No       | Initial approval status: `experimental`, `approved`, or `production` (default: `experimental`) |
| `tags`            | string[] | No       | Tags for search and filtering                                                                  |
| `description`     | string   | No       | Server description                                                                             |

**Example usage in Claude Code:**

```
Install from registry:
  registry_install with name "filesystem" and source "registry"

Manual registration:
  registry_install with name "my-server", command "node", args ["/path/to/server.js"]

With environment variables:
  registry_install with name "db-server", command "node", args ["server.js"], env {"DB_URL": "postgres://..."}

With approval status:
  registry_install with name "prod-server", source "registry", approval_status "production"
```

**Example response (registry install):**

```json
{
  "status": "installed",
  "server": "filesystem",
  "source": "registry",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem"]
}
```

**Example response (manual install):**

```json
{
  "status": "installed",
  "server": "my-server",
  "command": "node",
  "args": ["/path/to/server.js"]
}
```

**Error cases:**

- `name` is required -- returns a validation error if missing.
- If the server already exists, returns `{ "status": "already_registered", "server": "name" }`.
- For manual install, `command` is required -- returns an error if missing.
- Names must match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` and cannot contain `__` (reserved as the namespace separator).

---

### registry_uninstall

Remove an MCP server from the registry. If the server is currently active, it is deactivated first.

**Parameters:**

| Name   | Type   | Required | Description                  |
| ------ | ------ | -------- | ---------------------------- |
| `name` | string | Yes      | Name of the server to remove |

**Example usage in Claude Code:**

```
registry_uninstall with name "filesystem"
```

**Example response:**

```json
{
  "status": "uninstalled",
  "name": "filesystem"
}
```

**Error cases:**

- Server not found returns a 404 error.

---

### registry_activate

Start a registered MCP server and expose its tools through agent-discover. The server is launched as a child process via stdio transport. Its tools are discovered automatically and merged into agent-discover's tool list with the namespace prefix `serverName__`.

Secrets stored for this server are automatically merged into the process environment, overriding any matching env vars from the server's config.

After successful activation, agent-discover sends a `notifications/tools/list_changed` notification to the MCP client, telling it to re-fetch the tool list.

**Parameters:**

| Name   | Type   | Required | Description                               |
| ------ | ------ | -------- | ----------------------------------------- |
| `name` | string | Yes      | Name of the registered server to activate |

**Example usage in Claude Code:**

```
registry_activate with name "filesystem"
```

**Example response:**

```json
{
  "status": "activated",
  "name": "filesystem",
  "tools": [
    { "name": "filesystem__read_file", "description": "Read file contents" },
    { "name": "filesystem__write_file", "description": "Write to a file" },
    { "name": "filesystem__list_directory", "description": "List directory contents" }
  ]
}
```

**Error cases:**

- Server not found: `Server "name" not found in registry`.
- No command configured: `Server "name" has no command configured`.
- Already active: returns `{ "status": "already_active", "name": "..." }`.
- Activation timeout: The server must connect and respond to `listTools` within 30 seconds, otherwise activation fails.

---

### registry_deactivate

Stop a running MCP server and remove its proxied tools from agent-discover's tool list. The server process is terminated and its tools disappear.

After deactivation, a `notifications/tools/list_changed` notification is sent.

**Parameters:**

| Name   | Type   | Required | Description                             |
| ------ | ------ | -------- | --------------------------------------- |
| `name` | string | Yes      | Name of the active server to deactivate |

**Example usage in Claude Code:**

```
registry_deactivate with name "filesystem"
```

**Example response:**

```json
{
  "status": "deactivated",
  "name": "filesystem"
}
```

**Error cases:**

- If the server is not currently active, returns `{ "status": "not_active", "name": "..." }`.

---

### registry_browse

Search the official MCP registry at `registry.modelcontextprotocol.io`. Returns matching servers with their metadata and available packages.

**Parameters:**

| Name     | Type   | Required | Description                                |
| -------- | ------ | -------- | ------------------------------------------ |
| `query`  | string | No       | Search term                                |
| `limit`  | number | No       | Maximum results (default: 20, max: 100)    |
| `cursor` | string | No       | Pagination cursor from a previous response |

**Example usage in Claude Code:**

```
registry_browse with query "filesystem"
registry_browse with query "database" and limit 5
registry_browse with cursor "eyJhZnRlciI6..." to get the next page
```

**Example response:**

```json
{
  "servers": [
    {
      "name": "filesystem",
      "description": "MCP server providing filesystem operations",
      "version": "1.2.0",
      "repository": "https://github.com/modelcontextprotocol/servers",
      "packages": [
        {
          "name": "filesystem",
          "runtime": "node",
          "version": "1.2.0"
        }
      ]
    }
  ],
  "next_cursor": "eyJhZnRlciI6..."
}
```

**Error cases:**

- Registry API timeout (15 seconds): `Registry API request timed out`.
- Registry API HTTP error: `Registry API error: 500 Internal Server Error`.

---

### registry_status

Show all currently active (running) MCP servers and the tools they expose.

**Parameters:**

None.

**Example usage in Claude Code:**

```
registry_status
```

**Example response:**

```json
{
  "active_count": 2,
  "servers": [
    {
      "name": "filesystem",
      "description": "Filesystem operations",
      "tool_count": 5,
      "tools": ["read_file", "write_file", "list_directory", "create_directory", "delete_file"]
    },
    {
      "name": "github",
      "description": "GitHub API",
      "tool_count": 3,
      "tools": ["list_repos", "create_issue", "search_code"]
    }
  ]
}
```

**Error cases:**

None -- returns an empty list if no servers are active.

---

## 6. REST API Reference

The REST API is served by the dashboard HTTP server. All API responses include `Access-Control-Allow-Origin: *` for CORS support. CORS preflight (`OPTIONS`) is handled for all routes.

### GET /health

Health check endpoint.

**Response:**

```json
{
  "status": "ok",
  "version": "1.1.0",
  "uptime": 3600
}
```

**Example:**

```bash
curl http://localhost:3424/health
```

---

### GET /api/servers

List all registered servers. Supports filtering.

**Query Parameters:**

| Name        | Type   | Description                                    |
| ----------- | ------ | ---------------------------------------------- |
| `query`     | string | Full-text search query                         |
| `source`    | string | Filter by source                               |
| `installed` | string | Set to `"true"` to show only installed servers |

**Response:** Array of server objects, each with an `active` boolean indicating current runtime status. Each server also includes `approval_status`, `health_status`, `last_health_check`, and `error_count`.

**Examples:**

```bash
# List all servers
curl http://localhost:3424/api/servers

# Search for "git"
curl "http://localhost:3424/api/servers?query=git"

# Filter by source
curl "http://localhost:3424/api/servers?source=registry"

# Only installed
curl "http://localhost:3424/api/servers?installed=true"
```

---

### GET /api/servers/:id

Get a single server by its numeric ID, including its tools.

**Response:**

```json
{
  "id": 1,
  "name": "filesystem",
  "description": "...",
  "source": "registry",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem"],
  "env": {},
  "tags": [],
  "transport": "stdio",
  "installed": true,
  "active": true,
  "approval_status": "approved",
  "health_status": "healthy",
  "error_count": 0,
  "tools": [
    {
      "id": 1,
      "server_id": 1,
      "name": "read_file",
      "description": "Read file contents",
      "input_schema": { "type": "object", "properties": { "path": { "type": "string" } } }
    }
  ]
}
```

**Example:**

```bash
curl http://localhost:3424/api/servers/1
```

**Errors:** Returns `404` if the server ID does not exist.

---

### POST /api/servers

Register a new server.

**Request Body (JSON):**

```json
{
  "name": "my-server",
  "description": "My custom MCP server",
  "command": "node",
  "args": ["/path/to/server.js"],
  "env": { "API_KEY": "..." },
  "tags": ["custom"]
}
```

**Response:** The created server object with HTTP status `201`.

**Example:**

```bash
curl -X POST http://localhost:3424/api/servers \
  -H "Content-Type: application/json" \
  -d '{"name":"my-server","command":"node","args":["/path/to/server.js"]}'
```

**Errors:**

- `409` if a server with the same name already exists.
- `422` for invalid names or missing required fields.

---

### PUT /api/servers/:id

Update an existing server's configuration.

**Request Body (JSON, all fields optional):**

```json
{
  "description": "Updated description",
  "command": "node",
  "args": ["server.js", "--verbose"],
  "env": { "API_KEY": "new-key" },
  "tags": ["updated"],
  "approval_status": "approved"
}
```

**Accepted fields:** `description`, `command`, `args`, `env`, `tags`, `approval_status`.

**Response:** The updated server object.

**Example:**

```bash
curl -X PUT http://localhost:3424/api/servers/1 \
  -H "Content-Type: application/json" \
  -d '{"approval_status":"production"}'
```

**Errors:**

- `404` if the server ID does not exist.
- `422` if `approval_status` is not one of `experimental`, `approved`, `production`.

---

### DELETE /api/servers/:id

Remove a server from the registry. Deactivates it first if active.

**Response:**

```json
{ "status": "deleted" }
```

**Example:**

```bash
curl -X DELETE http://localhost:3424/api/servers/1
```

**Errors:** Returns `404` if the server ID does not exist.

---

### POST /api/servers/:id/activate

Activate a registered server. Starts the server process, discovers its tools, and begins proxying. Secrets are merged into the process environment.

**Response:**

```json
{ "status": "activated", "tool_count": 5 }
```

**Example:**

```bash
curl -X POST http://localhost:3424/api/servers/1/activate
```

**Errors:**

- `404` if the server ID does not exist.
- `400` if the server has no command configured.
- Returns `{ "status": "already_active" }` if already running.

---

### POST /api/servers/:id/deactivate

Deactivate a running server. Stops the process and removes its tools.

**Response:**

```json
{ "status": "deactivated" }
```

**Example:**

```bash
curl -X POST http://localhost:3424/api/servers/1/deactivate
```

**Errors:**

- `404` if the server ID does not exist.
- Returns `{ "status": "not_active" }` if the server is not currently running.

---

### GET /api/servers/:id/secrets

List all secrets for a server. Values are masked (first 4 characters visible, rest replaced with `****`). Values of 4 characters or fewer are shown as `****`.

**Response:**

```json
[
  {
    "key": "API_KEY",
    "masked_value": "sk-t****",
    "updated_at": "2025-01-15T10:30:00"
  }
]
```

**Example:**

```bash
curl http://localhost:3424/api/servers/1/secrets
```

**Errors:** Returns `404` if the server ID does not exist.

---

### PUT /api/servers/:id/secrets/:key

Set (create or update) a secret for a server. Uses upsert -- if the key already exists, the value is updated. Secrets are injected as environment variables when the server is activated.

**Request Body:**

```json
{
  "value": "sk-test-1234567890"
}
```

**Response:**

```json
{ "status": "set", "key": "API_KEY" }
```

**Example:**

```bash
curl -X PUT http://localhost:3424/api/servers/1/secrets/API_KEY \
  -H "Content-Type: application/json" \
  -d '{"value":"sk-test-1234567890"}'
```

**Errors:**

- `404` if the server ID does not exist.
- `422` if `value` is missing or empty.

---

### DELETE /api/servers/:id/secrets/:key

Delete a secret for a server.

**Response:**

```json
{ "status": "deleted", "key": "API_KEY" }
```

**Example:**

```bash
curl -X DELETE http://localhost:3424/api/servers/1/secrets/API_KEY
```

**Errors:** Returns `404` if the server ID does not exist.

---

### POST /api/servers/:id/health

Run a health check on a server.

For active servers, the check verifies the server is responsive by calling `getServerTools()` via the proxy.

For inactive servers with a command configured, the check performs a quick activate/deactivate cycle with a 5-second timeout.

The check updates `health_status`, `last_health_check`, and (on failure) increments `error_count` in the database.

**Response (healthy):**

```json
{
  "status": "healthy",
  "latency_ms": 42
}
```

**Response (unhealthy):**

```json
{
  "status": "unhealthy",
  "latency_ms": 5001,
  "error": "Health check timed out"
}
```

**Example:**

```bash
curl -X POST http://localhost:3424/api/servers/1/health
```

**Errors:** Returns `404` if the server ID does not exist.

---

### GET /api/servers/:id/metrics

Get per-tool metrics for a specific server.

**Response:**

```json
[
  {
    "tool_name": "read_file",
    "call_count": 42,
    "error_count": 1,
    "avg_latency_ms": 150,
    "last_called_at": "2025-01-15T12:00:00"
  }
]
```

**Example:**

```bash
curl http://localhost:3424/api/servers/1/metrics
```

**Errors:** Returns `404` if the server ID does not exist.

---

### GET /api/metrics

Global metrics overview across all servers that have recorded activity.

**Response:**

```json
[
  {
    "server_name": "filesystem",
    "total_calls": 100,
    "total_errors": 2,
    "avg_latency_ms": 120
  }
]
```

**Example:**

```bash
curl http://localhost:3424/api/metrics
```

---

### GET /api/browse

Search the official MCP registry. Proxies the request to `registry.modelcontextprotocol.io`.

**Query Parameters:**

| Name     | Type   | Description                                |
| -------- | ------ | ------------------------------------------ |
| `query`  | string | Search term                                |
| `limit`  | number | Max results, 1-100 (default: 20)           |
| `cursor` | string | Pagination cursor from a previous response |

**Response:**

```json
{
  "servers": [
    {
      "name": "...",
      "description": "...",
      "version": "...",
      "repository": "...",
      "packages": [{ "name": "...", "runtime": "node", "version": "..." }]
    }
  ],
  "next_cursor": "..."
}
```

**Example:**

```bash
curl "http://localhost:3424/api/browse?query=filesystem&limit=5"
```

---

### GET /api/status

Summary of all currently active servers.

**Response:**

```json
{
  "active_count": 1,
  "servers": [
    {
      "name": "filesystem",
      "tool_count": 5,
      "tools": ["read_file", "write_file", "list_directory", "create_directory", "delete_file"]
    }
  ]
}
```

**Example:**

```bash
curl http://localhost:3424/api/status
```

---

## 7. Server Management

### Registering a Local Server Manually

To register a server that you have installed locally (not from the MCP registry), use `registry_install` with explicit command and arguments:

```
registry_install with name "my-custom-server", command "node", args ["/home/user/servers/my-server/index.js"], description "My custom MCP server", tags ["custom", "internal"]
```

Names must follow these rules:

- Start with an alphanumeric character.
- Contain only alphanumeric characters, dashes, underscores, and dots.
- Must not contain `__` (double underscore), which is reserved as the tool namespace separator.

### Installing from the MCP Registry

Use `registry_install` with `source: "registry"` to automatically look up the server in the official MCP registry:

```
registry_install with name "filesystem" and source "registry"
```

agent-discover will:

1. Search the registry for the server name.
2. Find a matching package (preferring Node.js packages).
3. Detect the correct install command (`npx -y <package>` for Node, `uvx <package>` for Python, `docker run -i --rm <image>` for Docker).
4. Register the server with the detected command and metadata.

### Configuring Environment Variables and Args

Environment variables and arguments are specified at install time:

```
registry_install with name "database-server", command "node", args ["server.js", "--port", "5432"], env {"DB_HOST": "localhost", "DB_PASSWORD": "secret"}
```

When a server is activated, its environment variables are merged with the current process environment. Additionally, any secrets stored for the server (see [Secrets Management](#secrets-management)) are layered on top, overriding both process env and config env vars.

### Activating and Deactivating

**Activate** a server to start it and expose its tools:

```
registry_activate with name "filesystem"
```

This:

1. Resolves secrets for the server and merges them into the environment.
2. Spawns the server as a child process using `StdioClientTransport`.
3. Connects via MCP protocol and calls `listTools` to discover available tools.
4. Namespaces each tool as `serverName__toolName`.
5. Merges the namespaced tools into agent-discover's own tool list.
6. Sends a `notifications/tools/list_changed` notification so the agent re-fetches tools.
7. Saves the discovered tools to the database for display in the dashboard.

**Deactivate** to stop and remove tools:

```
registry_deactivate with name "filesystem"
```

This closes the MCP client connection (which terminates the child process), removes the tools from the proxied list, and notifies the agent.

### Proxy Pattern: How Namespaced Tools Work

When a server named `filesystem` is activated and exposes tools `read_file`, `write_file`, and `list_directory`, they appear in agent-discover's tool list as:

- `filesystem__read_file`
- `filesystem__write_file`
- `filesystem__list_directory`

The double-underscore `__` is the namespace separator. When the agent calls `filesystem__read_file`, agent-discover:

1. Parses the tool name to extract `serverName = "filesystem"` and `toolName = "read_file"`.
2. Looks up the active server by name.
3. Forwards the tool call to the child server process via the MCP client.
4. Records metrics (latency, success/failure) for the call.
5. Returns the result to the agent.

Each proxied tool's description is prefixed with `[serverName]` for clarity.

Tool calls have a 60-second timeout. If a call exceeds this, a timeout error is returned.

### Tool List Change Notifications

agent-discover declares the `tools.listChanged` capability. After any of these operations, it sends a `notifications/tools/list_changed` notification:

- `registry_activate` (new tools added)
- `registry_deactivate` (tools removed)
- `registry_uninstall` (tools removed if server was active)

This tells MCP clients like Claude Code to call `tools/list` again to get the updated tool list.

---

## 8. Marketplace

### How the Official MCP Registry Works

The official MCP registry at `https://registry.modelcontextprotocol.io` is a public index of MCP servers. agent-discover queries its API at `/v0/servers` to search for and retrieve server metadata.

The registry returns server entries that include:

- **name**: The server's identifier.
- **description**: What the server does.
- **version**: Current version.
- **repository**: Source code URL.
- **remotes/packages**: Available installation methods with their runtimes (node, python, docker).

### Searching for Servers

Use `registry_browse` to search:

```
registry_browse with query "github"
```

Or via the dashboard's Browse tab -- type in the search bar and results appear after a short delay.

### Understanding Transport Types

MCP servers can use different transport mechanisms:

| Transport         | Description                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `stdio`           | Communication over stdin/stdout. The default and most common for local servers. agent-discover launches these as child processes. |
| `sse`             | Server-Sent Events over HTTP. For remote/hosted servers.                                                                          |
| `streamable-http` | HTTP-based bidirectional streaming. For remote servers.                                                                           |

Currently, agent-discover's proxy only supports `stdio` transport -- it spawns child processes and communicates via stdin/stdout. Servers with `sse` or `streamable-http` transport are shown in search results but cannot be activated through the proxy.

### Installing from Marketplace Results

After browsing, install a server from the registry:

```
registry_browse with query "filesystem"
# Find the server you want, then:
registry_install with name "filesystem" and source "registry"
```

agent-discover will match the name against registry results, detect the appropriate package manager, and configure the server automatically.

The auto-detection logic:

| Runtime  | Command Generated            |
| -------- | ---------------------------- |
| `node`   | `npx -y <package-name>`      |
| `python` | `uvx <package-name>`         |
| `docker` | `docker run -i --rm <image>` |

### Pagination with Cursors

The MCP registry API uses cursor-based pagination. When there are more results than the limit, the response includes a `next_cursor` value:

```json
{
  "servers": [...],
  "next_cursor": "eyJhZnRlciI6MTB9"
}
```

To get the next page, pass this cursor in the next call:

```
registry_browse with query "database" and cursor "eyJhZnRlciI6MTB9"
```

When there are no more results, `next_cursor` is `null`.

---

## 9. Enterprise Features

### Secrets Management

Secrets allow you to store API keys, tokens, and other sensitive values per server. When a server is activated, its secrets are automatically injected into the process environment as environment variables.

**Storing secrets via REST API:**

```bash
# Set a secret
curl -X PUT http://localhost:3424/api/servers/1/secrets/OPENAI_API_KEY \
  -H "Content-Type: application/json" \
  -d '{"value":"sk-..."}'

# List secrets (values are masked)
curl http://localhost:3424/api/servers/1/secrets

# Delete a secret
curl -X DELETE http://localhost:3424/api/servers/1/secrets/OPENAI_API_KEY
```

**Via the dashboard:** Open the Secrets section on a server card. Use the key/value form to add secrets and the delete button to remove them.

**How secrets are applied:** When `registry_activate` is called, the proxy:

1. Loads the current process environment.
2. Applies the server's configured `env` vars (from registration).
3. Overlays secrets from the `server_secrets` table (secrets take precedence).
4. Passes the merged environment to the child process.

This means you can store sensitive values as secrets rather than in the server's `env` config, keeping them separate and masked in API responses.

### Health Monitoring

Health checks verify that a server can start and respond. Two modes:

- **Active server check**: Calls `getServerTools()` via the proxy to verify the server is responsive.
- **Inactive server check**: Performs a quick activate/deactivate cycle with a 5-second timeout.

**Running a health check:**

```bash
curl -X POST http://localhost:3424/api/servers/1/health
```

Or click the "Check Health" button on a server card in the dashboard.

**Health status values:**

| Status      | Meaning                                          |
| ----------- | ------------------------------------------------ |
| `healthy`   | Server responded successfully                    |
| `unhealthy` | Server failed to respond or returned an error    |
| `unknown`   | No health check has been run yet (default state) |

Health status is displayed as a colored dot on server cards: green (healthy), red (unhealthy), gray (unknown).

When a health check fails, the `error_count` on the server is incremented. Error counts are visible on server cards when greater than zero.

### Metrics

Metrics are recorded automatically by the proxy layer on every tool call. No configuration needed.

**What is tracked per tool:**

- `call_count`: Total number of calls.
- `error_count`: Number of failed calls (timeouts, errors, `isError` responses).
- `avg_latency_ms`: Average call duration in milliseconds.
- `last_called_at`: Timestamp of the most recent call.

**Viewing metrics:**

```bash
# Per-server metrics (by tool)
curl http://localhost:3424/api/servers/1/metrics

# Global overview (by server)
curl http://localhost:3424/api/metrics
```

Or expand the Metrics section on a server card in the dashboard.

### Approval Workflow

Servers have an `approval_status` field that tracks their readiness level:

| Status         | Meaning                                            |
| -------------- | -------------------------------------------------- |
| `experimental` | Default status for new servers. Not yet validated. |
| `approved`     | Reviewed and approved for general use.             |
| `production`   | Validated for production workloads.                |

**Setting approval status:**

- Via MCP: Use `registry_install` with `approval_status` parameter.
- Via REST: `PUT /api/servers/:id` with `{ "approval_status": "approved" }`.
- Via dashboard: Click the approval badge on a server card and select the desired status from the dropdown.

### Config Editing

Server configuration can be updated after registration via the `PUT /api/servers/:id` endpoint or the Config section in the dashboard.

**Editable fields:**

- `description`: Server description text.
- `command`: Executable command.
- `args`: Command-line arguments (array of strings).
- `env`: Environment variables (key-value object).
- `tags`: Tags for search and filtering (array of strings).
- `approval_status`: Approval level.

**Via the dashboard:** Expand the Config section on a server card. Edit the fields and click "Save Config". Args are entered as comma-separated values. Env vars are entered as `KEY=VALUE` per line.

---

## 10. Troubleshooting

### Dashboard Won't Start

**Symptom:** Message in stderr: `Dashboard port 3424 in use -- another instance is serving.`

**Cause:** Another process (possibly another agent-discover instance or another application) is using port 3424.

**Solutions:**

1. Use a different port: set `AGENT_DISCOVER_PORT=3425` in the MCP server config env.
2. Find and stop the process using port 3424.
3. This is often harmless -- if another agent-discover MCP instance is already serving the dashboard, the second instance simply skips dashboard startup. Both instances share the same SQLite database.

### Server Activation Fails

**Symptom:** `Failed to activate "server-name": connect timed out after 30000ms`

**Causes and solutions:**

- **Command not found**: Verify the server's command is installed and on the PATH. For npx-based servers, ensure Node.js and npm are installed. For uvx-based servers, ensure uv is installed.
- **Server crashes on startup**: Run the command manually to see the error output: `npx -y <package-name>`. Check that any required environment variables are set.
- **Slow startup**: The activation timeout is 30 seconds. If the server takes longer to start (e.g., needs to download packages), try running the command once manually first so packages are cached.
- **Missing secrets**: If the server requires API keys, store them as secrets before activating.

**Symptom:** `Server "name" has no command configured`

**Cause:** The server was registered without a command. This can happen if the registry install could not detect a suitable package.

**Solution:** Update the server with a command via `PUT /api/servers/:id` or via the Config section in the dashboard. Or uninstall and re-register manually with the correct command.

### Marketplace Search Returns Empty

**Symptom:** `registry_browse` returns no results.

**Causes:**

- The search term may not match any servers in the registry. Try broader terms.
- Network connectivity issues -- the machine needs internet access to reach `registry.modelcontextprotocol.io`.
- Registry API timeout (15-second limit). Check your network connection.

### WebSocket Disconnections

**Symptom:** Dashboard shows stale data or reconnects frequently.

**Causes and solutions:**

- The WebSocket auto-reconnects after 2 seconds. Brief disconnections are normal if the server restarts.
- If behind a reverse proxy, ensure WebSocket upgrade is configured.
- The server sends ping frames every 30 seconds. Clients that do not respond with pong within the next interval are terminated.
- Maximum 50 concurrent WebSocket connections are allowed. Excess connections are rejected with code 1013.

### Database Issues

**Symptom:** Errors related to SQLite or database access.

**Solutions:**

- Check that the database directory exists and is writable. The default location is `~/.claude/`.
- If the database is corrupted, delete `~/.claude/agent-discover.db` (and any associated WAL files) and restart. All server registrations and secrets will be lost but can be re-created.
- The database uses WAL (Write-Ahead Logging) mode and a 5-second busy timeout for concurrent access.

**Symptom:** Active servers show as inactive after restart.

**This is expected behavior.** On startup, agent-discover resets all servers to `active = 0` in the database because the child processes from the previous session are no longer running. You need to re-activate servers after each restart.

---

## 11. FAQ

### Can I use this with Cursor/OpenCode?

Yes. agent-discover is a standard MCP server that communicates over stdio. Any MCP-compatible client can use it. See the [Configuration](#3-configuration) section for setup instructions for different clients. The dashboard works regardless of which client is connected.

### How many servers can I activate at once?

There is no hard-coded limit. Each activated server runs as a separate child process, so the practical limit depends on your system's available memory and CPU. Each child process consumes resources comparable to running the server standalone.

### What happens when Claude Code restarts?

When agent-discover starts (or restarts), it:

1. Resets all `active` flags in the database to `false` -- previous child processes are gone.
2. Attempts to start the dashboard on the configured port.

You need to re-activate any servers you want to use. The server registrations (name, command, args, env), secrets, and metrics persist in the SQLite database across restarts.

### How to migrate from mcp-discovery?

agent-discover is a replacement for mcp-discovery. To migrate:

1. Install and configure agent-discover as described in the [Installation](#2-installation) section.
2. Re-register your servers using `registry_install`. If they were manual registrations, provide the same command/args. If they came from a registry, use `source: "registry"`.
3. Remove mcp-discovery from your MCP client configuration.
4. The two systems use different databases, so there is no automatic migration.

### Can I run the dashboard without the MCP server?

Yes. Use the standalone server entry point:

```bash
node dist/server.js --port 3424
```

This starts only the HTTP + WebSocket server for the dashboard and REST API. It creates its own database connection and does not require an MCP client to be connected.

### How does the leader election work for the dashboard?

When agent-discover runs as an MCP stdio server, it tries to bind the dashboard to the configured port on the first `initialize` handshake. If the port is already in use (error code `EADDRINUSE`), it assumes another instance is already serving the dashboard and does not try again. Both instances share the same SQLite database, so they see the same data.

### What is the request body size limit for the REST API?

The maximum request body size is 128 KB (131,072 bytes). Requests exceeding this limit are rejected with a validation error.

### Where are the server tools stored?

Tool metadata (name, description, input schema) is stored in the `server_tools` SQLite table, linked to the server by `server_id`. Tools are saved when a server is activated (discovered from the child process) and cleared when the server is deactivated or uninstalled. This allows the dashboard to show tool information even when looking at inactive servers that were previously activated.

### How do secrets work with activation?

Secrets stored via `PUT /api/servers/:id/secrets/:key` are saved in the `server_secrets` table. When a server is activated, the proxy calls `SecretsService.getEnvForServer()` which returns all secrets as a key-value map. These are merged into the process environment after the server's configured `env` vars, so secrets take precedence. Secrets are never included in the server's `env` field -- they are separate and masked in API responses.

### Are metrics retained across restarts?

Yes. Metrics are stored in the `server_metrics` SQLite table and persist across restarts. They accumulate over time. There is no automatic cleanup or rotation -- metrics grow as servers are used.

### How do I reset a server's health status?

Health status is updated by running a health check via `POST /api/servers/:id/health` or the "Check Health" button in the dashboard. There is no separate reset -- a successful check sets the status to `healthy`. The `error_count` is cumulative and does not reset automatically.
