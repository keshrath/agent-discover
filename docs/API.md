# API Reference

## MCP Tools

agent-discover exposes 2 action-based MCP tools plus dynamically proxied tools from active servers.

### registry

Registry management tool with multiple actions: `list`, `install`, `uninstall`, `browse`, `status`.

**Parameters:**

| Name             | Type     | Required | Description                                                                            |
| ---------------- | -------- | -------- | -------------------------------------------------------------------------------------- |
| `action`         | string   | **yes**  | Action: `list`, `install`, `uninstall`, `browse`, `status`                             |
| `query`          | string   | no       | [list/browse] FTS search query                                                         |
| `source`         | string   | no       | [list/install] Filter by or specify source (`local`, `registry`, `smithery`, `manual`) |
| `installed_only` | boolean  | no       | [list] Only show installed servers                                                     |
| `name`           | string   | no       | [install/uninstall] Server name                                                        |
| `command`        | string   | no       | [install] Command to start server (required for manual install)                        |
| `args`           | string[] | no       | [install] Command arguments                                                            |
| `env`            | object   | no       | [install] Environment variables                                                        |
| `description`    | string   | no       | [install] Server description                                                           |
| `tags`           | string[] | no       | [install] Tags for search/filtering                                                    |
| `limit`          | number   | no       | [browse] Max results (default: 20, max: 100)                                           |
| `cursor`         | string   | no       | [browse] Pagination cursor from previous response                                      |

**Example (list):**

```json
{
  "name": "registry",
  "arguments": { "action": "list", "query": "filesystem", "installed_only": true }
}
```

**Example (install from registry):**

```json
{
  "name": "registry",
  "arguments": { "action": "install", "name": "filesystem", "source": "registry" }
}
```

**Example (install manually):**

```json
{
  "name": "registry",
  "arguments": {
    "action": "install",
    "name": "my-server",
    "command": "node",
    "args": ["/path/to/server.js"],
    "description": "My custom MCP server"
  }
}
```

**Example (uninstall):**

```json
{
  "name": "registry",
  "arguments": { "action": "uninstall", "name": "filesystem" }
}
```

**Example (browse):**

```json
{
  "name": "registry",
  "arguments": { "action": "browse", "query": "database", "limit": 5 }
}
```

**Example (status):**

```json
{
  "name": "registry",
  "arguments": { "action": "status" }
}
```

---

### registry_server

Server lifecycle tool. Actions: `activate`, `deactivate`.

Activation starts the server as a child process and exposes its tools through agent-discover. Proxied tools appear as `serverName__toolName`. Secrets stored for this server are automatically merged into the process environment.

Deactivation stops the server and removes its proxied tools.

**Parameters:**

| Name     | Type   | Required | Description                        |
| -------- | ------ | -------- | ---------------------------------- |
| `action` | string | **yes**  | Action: `activate` or `deactivate` |
| `name`   | string | **yes**  | Server name                        |

**Example (activate):**

```json
{
  "name": "registry_server",
  "arguments": { "action": "activate", "name": "filesystem" }
}
```

**Example (deactivate):**

```json
{
  "name": "registry_server",
  "arguments": { "action": "deactivate", "name": "filesystem" }
}
```

---

### Proxied Tools

When a server is activated, its tools are exposed with a namespaced name: `serverName__toolName`. These tools accept the same parameters as the original server defines and proxy calls through to the child process.

Example: If `filesystem` is active and provides `read_file`, you can call the tool `filesystem__read_file` with the original tool's parameters.

Each proxied tool call is automatically metered -- latency, success/failure, and call count are recorded in the metrics table.

---

## REST API

The dashboard server exposes a REST API for programmatic access. All responses include `Access-Control-Allow-Origin: *` for CORS. CORS preflight (`OPTIONS`) is handled for all routes.

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

---

### GET /api/servers

List registered servers. Supports query parameters for filtering.

**Query parameters:**

| Name        | Description                        |
| ----------- | ---------------------------------- |
| `query`     | FTS search query                   |
| `source`    | Filter by source type              |
| `installed` | Set to `"true"` for installed only |

**Response:** Array of server objects with `active` status merged from proxy. Each server includes `health_status`, `last_health_check`, and `error_count` fields.

---

### GET /api/servers/:id

Get a single server by ID, including its discovered tools.

**Response:**

```json
{
  "id": 1,
  "name": "filesystem",
  "description": "...",
  "active": true,
  "health_status": "healthy",
  "error_count": 0,
  "tools": [
    { "id": 1, "server_id": 1, "name": "read_file", "description": "...", "input_schema": {} }
  ]
}
```

**Errors:** Returns `404` if the server ID does not exist.

---

### POST /api/servers

Register a new server.

**Request body:**

```json
{
  "name": "my-server",
  "command": "node",
  "args": ["/path/to/server.js"],
  "description": "My server",
  "tags": ["custom"]
}
```

**Response:** `201 Created` with the server object.

---

### PUT /api/servers/:id

Update an existing server's configuration.

**Request body (all fields optional):**

```json
{
  "description": "Updated description",
  "command": "node",
  "args": ["server.js", "--verbose"],
  "env": { "API_KEY": "..." },
  "tags": ["updated"]
}
```

**Accepted fields:** `description`, `command`, `args`, `env`, `tags`.

**Response:** The updated server object.

**Errors:**

- `404` if the server ID does not exist.

---

### DELETE /api/servers/:id

Remove a server. Deactivates it first if active.

**Response:**

```json
{ "status": "deleted" }
```

**Errors:** Returns `404` if the server ID does not exist.

---

### POST /api/servers/:id/activate

Activate a server by ID. Secrets are merged into the server's environment on activation.

**Response:**

```json
{ "status": "activated", "tool_count": 5 }
```

**Errors:**

- `404` if the server ID does not exist.
- `400` if the server has no command configured.
- Returns `{ "status": "already_active" }` if already running.

---

### POST /api/servers/:id/deactivate

Deactivate a running server.

**Response:**

```json
{ "status": "deactivated" }
```

**Errors:**

- `404` if the server ID does not exist.
- Returns `{ "status": "not_active" }` if the server is not currently running.

---

### GET /api/servers/:id/secrets

List all secrets for a server. Values are masked (first 4 characters visible, rest replaced with `****`).

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

**Errors:** Returns `404` if the server ID does not exist.

---

### PUT /api/servers/:id/secrets/:key

Set (create or update) a secret for a server. The secret value is stored and will be injected as an environment variable when the server is activated.

**Request body:**

```json
{
  "value": "sk-test-1234567890"
}
```

**Response:**

```json
{ "status": "set", "key": "API_KEY" }
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

**Errors:** Returns `404` if the server ID does not exist.

---

### POST /api/servers/:id/health

Run a health check on a server. For active servers, checks the tool list via the proxy. For inactive servers with a command, attempts a quick activate/deactivate cycle (5-second timeout). Updates `health_status`, `last_health_check`, and `error_count` in the database.

**Response:**

```json
{
  "status": "healthy",
  "latency_ms": 42
}
```

or on failure:

```json
{
  "status": "unhealthy",
  "latency_ms": 5001,
  "error": "Health check timed out"
}
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

**Errors:** Returns `404` if the server ID does not exist.

---

### GET /api/metrics

Global metrics overview across all servers with recorded activity.

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

---

### GET /api/browse

Browse the MCP registry marketplace.

**Query parameters:**

| Name     | Description              |
| -------- | ------------------------ |
| `query`  | Search term              |
| `limit`  | Max results (default 20) |
| `cursor` | Pagination cursor        |

**Response:** Marketplace result with `servers` array and `next_cursor`.

---

### GET /api/status

Show active server summary.

**Response:**

```json
{
  "active_count": 2,
  "servers": [{ "name": "filesystem", "tool_count": 5, "tools": ["read_file", "..."] }]
}
```

---

## WebSocket Protocol

Connect to `ws://localhost:3424` to receive real-time state updates.

### Connection

On connect, the server sends a full state snapshot:

```json
{
  "type": "state",
  "version": "1.1.0",
  "servers": [
    {
      "id": 1,
      "name": "filesystem",
      "active": true,
      "health_status": "healthy",
      "error_count": 0,
      "tools": [{ "id": 1, "name": "read_file", "description": "..." }]
    }
  ],
  "active": [
    {
      "name": "filesystem",
      "tools": [{ "name": "read_file", "description": "..." }]
    }
  ]
}
```

### Delta Updates

The server polls the database every 2 seconds. When changes are detected (via a fingerprint based on server count, max ID, last update time, and tool count), a full state message is re-sent to all connected clients whose fingerprint is stale.

### Client Messages

| Message                 | Description                 |
| ----------------------- | --------------------------- |
| `{ "type": "refresh" }` | Request a full state resend |

### Server Messages

| Message         | Description                        |
| --------------- | ---------------------------------- |
| `type: "state"` | Full state snapshot                |
| `type: "error"` | Error message (invalid JSON, etc.) |

### Connection Limits

- Max payload size: 4096 bytes
- Max connections: 50
- Ping interval: 30 seconds (clients must respond to pings)
