# Setup Guide

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Client Setup](#client-setup)
- [Hooks](#hooks)
- [Running as Standalone Server](#running-as-standalone-server)
- [Configuration Options](#configuration-options)
- [Troubleshooting](#troubleshooting)
- [Client Comparison](#client-comparison)

---

## Prerequisites

- **Node.js**: v20.11 or later
- **npm**: bundled with Node
- An MCP-compatible AI client (Claude Code, Cursor, OpenCode, Windsurf, Aider, Continue, etc.) — or a plain REST/WebSocket consumer
- (Source builds only) git

agent-discover does **not** require any system services or background daemons. The MCP stdio server, the REST API, and the dashboard all run in a single Node process that the MCP client spawns on demand.

---

## Installation

### From npm

```bash
npm install -g agent-discover
```

### From source

```bash
git clone https://github.com/keshrath/agent-discover.git
cd agent-discover
npm install
npm run build
```

### Verify

```bash
node dist/index.js --version    # prints the version
node dist/server.js --port 3424 # starts the dashboard standalone — visit http://localhost:3424
```

The first run creates the SQLite DB at `~/.claude/agent-discover.db` (override with `AGENT_DISCOVER_DB`).

---

## Client Setup

### Claude Code

#### Automated setup

After building, run:

```bash
node scripts/setup.js
```

This will:

- Build the project if `dist/` is missing
- Register the MCP server in `~/.claude.json`
- Add the `mcp__agent-discover__*` permission to `~/.claude/settings.json`

Restart Claude Code afterwards.

#### Manual setup

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "agent-discover": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/agent-discover/dist/index.js"]
    }
  }
}
```

Add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__agent-discover__*"]
  }
}
```

Or, if you installed globally via npm and have `agent-discover` on your PATH:

```json
{
  "mcpServers": {
    "agent-discover": {
      "command": "npx",
      "args": ["-y", "agent-discover"]
    }
  }
}
```

### Cursor

In **Settings → MCP Servers**, add:

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

### Windsurf

Add the same `mcpServers` block to `~/.codeium/windsurf/mcp_config.json`.

### OpenCode

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

### Generic MCP Client

agent-discover communicates via JSON-RPC 2.0 over stdin/stdout. Spawn it as:

```
node /path/to/agent-discover/dist/index.js
```

The server implements MCP protocol version `2024-11-05` and advertises the `tools` capability with `listChanged: true` (so clients refresh their tool list automatically when servers are activated/deactivated).

### REST API

The dashboard's REST API runs on the same port as the dashboard itself (default `3424`). It is fully usable without any MCP client. Examples:

```bash
# Health check
curl http://localhost:3424/health

# List servers
curl http://localhost:3424/api/servers

# Browse the official MCP marketplace
curl 'http://localhost:3424/api/browse?query=filesystem'
```

See [API.md](./API.md) for the full reference.

---

## Hooks

### Claude Code Hooks

`scripts/hooks/session-start.js` is shipped with the repo as an **optional adapter** for Claude Code users. It announces the dashboard URL on session start so agents know where to look.

To wire it up, add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$HOME/.claude/mcp-servers/agent-discover/scripts/hooks/session-start.js\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The hook respects `AGENT_DISCOVER_PORT` if set in the environment.

### Other hosts

There is no host-specific scaffolding for Cursor, Codex, Aider, etc. — those clients don't have a Claude-Code-style hook system. Use the dashboard URL directly or rely on the MCP `initialize` handshake to learn the port.

---

## Running as Standalone Server

When the dashboard is needed without an MCP client (e.g. cron, systemd, or a remote machine), run:

```bash
# Default port 3424, default DB at ~/.claude/agent-discover.db
node dist/server.js

# Custom port
node dist/server.js --port 4000

# Custom DB
node dist/server.js --db /var/lib/agent-discover.db

# Or via env vars
AGENT_DISCOVER_PORT=4000 AGENT_DISCOVER_DB=/tmp/d.db node dist/server.js
```

Multiple processes can share the same SQLite DB safely (WAL mode); only one of them will bind the dashboard port — the others operate in stdio-only mode (leader election by port-bind race).

### systemd unit example

```ini
[Unit]
Description=agent-discover dashboard
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/agent-discover/dist/server.js --port 3424
Restart=on-failure
User=agent-discover
Environment=AGENT_DISCOVER_DB=/var/lib/agent-discover.db

[Install]
WantedBy=multi-user.target
```

---

## Configuration Options

### Environment variables

#### Core

| Variable               | Default                       | Description                                                                                |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| `AGENT_DISCOVER_PORT`  | `3424`                        | Dashboard HTTP/WebSocket port                                                              |
| `AGENT_DISCOVER_DB`    | `~/.claude/agent-discover.db` | SQLite database path                                                                       |
| `AGENT_DISCOVER_NO_UI` | unset                         | If set to `1`, the stdio MCP server skips starting the dashboard (useful in headless mode) |
| `AGENT_DISCOVER_LOG`   | `info`                        | Log level (`error`, `warn`, `info`, `debug`)                                               |

#### Embeddings (semantic search for `find_tool` / `find_tools`)

Embeddings are **opt-in**. The default is `none` — `find_tool` ranks with BM25 + verb synonyms only, which is fine for keyword-rich queries. Setting a provider enables hybrid BM25 + cosine retrieval, which closes the natural-language gap (e.g. "billing arrangement" → "subscription") that BM25 alone misses.

| Variable                                | Default | Description                                                                   |
| --------------------------------------- | ------- | ----------------------------------------------------------------------------- |
| `AGENT_DISCOVER_EMBEDDING_PROVIDER`     | `none`  | `none` \| `local` \| `openai`                                                 |
| `AGENT_DISCOVER_EMBEDDING_MODEL`        | —       | Override the default model id for the chosen provider                         |
| `AGENT_DISCOVER_EMBEDDING_THREADS`      | `1`     | Local provider only — onnx runtime thread count                               |
| `AGENT_DISCOVER_EMBEDDING_IDLE_TIMEOUT` | `60`    | Local provider only — seconds before unloading the model from RAM             |
| `AGENT_DISCOVER_OPENAI_API_KEY`         | —       | OpenAI API key for embeddings (falls back to plain `OPENAI_API_KEY` if unset) |

**To use the local provider** (no network, no API key):

```bash
npm install @huggingface/transformers       # optional peer dep
export AGENT_DISCOVER_EMBEDDING_PROVIDER=local
```

The default model is `Xenova/all-MiniLM-L6-v2` (384 dims, q8 quantized). The first call downloads and caches the model — subsequent calls reuse it. Idle for `AGENT_DISCOVER_EMBEDDING_IDLE_TIMEOUT` seconds and the model is unloaded from RAM until needed again.

**To use the OpenAI provider**:

```bash
export AGENT_DISCOVER_EMBEDDING_PROVIDER=openai
export OPENAI_API_KEY=sk-...                # or AGENT_DISCOVER_OPENAI_API_KEY
```

Default model is `text-embedding-3-small` (1536 dims). One-time cost to embed your registered tools at registration; queries do brute-force cosine over the local store with no further API calls.

**To explicitly disable** (this is the default, but you can set it explicitly to override an inherited env):

```bash
export AGENT_DISCOVER_EMBEDDING_PROVIDER=none
```

If a provider is requested but unavailable (missing API key, transformers not installed, model fails to load), the registry logs a warning to stderr and falls back to BM25-only ranking — it never crashes.

### CLI flags

`dist/server.js` (standalone dashboard) accepts:

| Flag        | Equivalent env var    | Description    |
| ----------- | --------------------- | -------------- |
| `--port N`  | `AGENT_DISCOVER_PORT` | Dashboard port |
| `--db PATH` | `AGENT_DISCOVER_DB`   | SQLite DB path |

`dist/index.js` (MCP stdio server) accepts no CLI flags — it is always invoked by the MCP client.

---

## Troubleshooting

### Dashboard not loading

- Confirm `http://localhost:3424` (or your custom port) responds: `curl http://localhost:3424/health`
- The dashboard auto-starts on first MCP `initialize` handshake. If your MCP client never calls `initialize`, run the standalone server instead.
- Check whether another process is already bound to the port. Multiple agent-discover instances share the DB but only one binds the port.

### MCP server not appearing in Claude Code

1. Verify `~/.claude.json` contains the `agent-discover` entry under `mcpServers`.
2. Check the path to `dist/index.js` is absolute and the file exists.
3. Restart Claude Code completely (not just reload).
4. Inspect Claude Code's MCP connection logs for stderr output from the server process.

### Tools not proxying after activation

1. Verify the activated server's command is correct: call `registry` with `action: "list"` to see the stored command/args.
2. Confirm the child process can start independently: run the command manually in a terminal.
3. The activation timeout is 30 seconds — slow-starting servers may time out. Increase by editing `proxy.ts` or pre-warming the package.
4. Per-tool call timeout is 60 seconds.

### Database errors

The SQLite database lives at `~/.claude/agent-discover.db` by default. To reset:

```bash
rm ~/.claude/agent-discover.db
```

The schema is re-created on the next start. You will lose any manually-installed servers, secrets, and metrics history.

### Permission denied errors in Claude Code

Add the tool permission pattern to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__agent-discover__*"]
  }
}
```

Or use a wider pattern (`mcp__*`) if you trust all MCP servers in your config.

### "tools/list_changed" not refreshing in client

agent-discover sends a `tools/list_changed` notification on `activate`, `deactivate`, and `uninstall`. If your client doesn't refresh:

- Confirm the client supports the `2024-11-05` MCP capability `tools.listChanged`.
- Some clients only refresh on a fresh `tools/list` call — check the client's MCP support matrix.

---

## Client Comparison

| Client        | MCP stdio | tools/list_changed | Permission gating        | Setup difficulty |
| ------------- | --------- | ------------------ | ------------------------ | ---------------- |
| Claude Code   | ✓         | ✓                  | `permissions.allow` glob | Easy (auto)      |
| Cursor        | ✓         | partial            | none                     | Easy             |
| Windsurf      | ✓         | partial            | none                     | Easy             |
| OpenCode      | ✓         | ✓                  | none                     | Easy             |
| Aider         | ✓         | n/a                | none                     | Medium           |
| Continue      | ✓         | partial            | none                     | Medium           |
| Plain REST/WS | n/a       | n/a                | none (bind to localhost) | Trivial          |

"partial" tools/list_changed means the client picks up new tools on the next prompt rather than immediately. For agent-discover this is fine — proxied tools become available within one round-trip.
