# Setup Guide

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Client Setup](#client-setup)
- [Claude Code plugin](#claude-code-plugin)
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

agent-discover runs as one local daemon (dashboard, REST and `/mcp` on `127.0.0.1:3424`). The stdio shim that clients spawn starts it on demand; no system service is required.

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

agent-discover is one daemon (`127.0.0.1:3424`: dashboard, REST, `/mcp`) that every client shares. A client connects in one of two ways:

| Entry                                     | When to use it                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **stdio shim** `npx -y agent-discover@^2` | Default. Works in every client. The shim starts the daemon on demand (and again after an idle exit or reboot) and relays JSON-RPC to `/mcp`.                                   |
| **http** `http://127.0.0.1:3424/mcp`      | Clients with Streamable HTTP support when the daemon already runs as a service (see [Running as Standalone Server](#running-as-standalone-server)). Nothing starts it for you. |

Pick one entry per client. Configuring both duplicates every tool.

### Claude Code

Install the plugin. It bundles the stdio shim, four skills, a session hook and a native UI (panel, status line, toasts):

```bash
claude plugin marketplace add keshrath/agent-discover
claude plugin install agent-discover@agent-discover
```

Remove any hand-written `agent-discover` entry from `~/.claude.json` and any old `session-start.js` hook from `~/.claude/settings.json` first; otherwise tools appear twice. See [Claude Code plugin](#claude-code-plugin) below for what it adds.

Without the plugin, register the shim yourself:

```bash
claude mcp add agent-discover -- npx -y agent-discover@^2
```

Or, against a running daemon:

```bash
claude mcp add --transport http agent-discover http://127.0.0.1:3424/mcp
```

### Cursor

`~/.cursor/mcp.json` (or the project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "agent-discover": { "command": "npx", "args": ["-y", "agent-discover@^2"] }
  }
}
```

For a running daemon use `{ "url": "http://127.0.0.1:3424/mcp" }` instead. Cursor shows the results as markdown; consent prompts appear as elicitation dialogs when the build supports them, otherwise `install_server` returns the plan and a `consentToken` for a second call after you agree in chat.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.agent-discover]
command = "npx"
args = ["-y", "agent-discover@^2"]
```

Or, against a running daemon: `url = "http://127.0.0.1:3424/mcp"` in place of `command`/`args`.

### VS Code

`.vscode/mcp.json` (workspace) or the user-level `mcp.json`:

```json
{
  "servers": {
    "agent-discover": { "type": "http", "url": "http://127.0.0.1:3424/mcp" }
  }
}
```

The http form needs the daemon running. For on-demand start use the shim: `{ "type": "stdio", "command": "npx", "args": ["-y", "agent-discover@^2"] }`. VS Code renders the MCP Apps widget (search results, consent card, tool tester) inline.

### Claude Desktop

`claude_desktop_config.json` (Settings, Developer, Edit Config; on Windows `%APPDATA%\Claude\`). Claude Desktop only launches stdio servers, so use the shim:

```json
{
  "mcpServers": {
    "agent-discover": { "command": "npx", "args": ["-y", "agent-discover@^2"] }
  }
}
```

Restart the app. Tool results render as the MCP Apps widget.

### Windsurf, OpenCode, other stdio clients

Same `mcpServers` block as Cursor (Windsurf: `~/.codeium/windsurf/mcp_config.json`). Any client that can spawn a command works with `npx -y agent-discover@^2`; any client with Streamable HTTP can point at `http://127.0.0.1:3424/mcp`. Both protocol eras (2025-11 sessions and 2026-07 stateless requests) are served on the same endpoint.

### REST API

The REST API runs on the dashboard port and is usable without any MCP client:

```bash
curl http://127.0.0.1:3424/api/health
curl http://127.0.0.1:3424/api/status
curl 'http://127.0.0.1:3424/api/browse?query=filesystem'
```

See [API.md](./API.md) for the full reference.

---

## Claude Code plugin

The plugin lives in `plugin/` and is what `claude plugin install` fetches. It has four parts.

**Native UI (function hooks, Claude Code 2.1.289+).** `hooks/register.tsx` draws inside the terminal, the desktop Code tab and VS Code:

- `/discover [what you need]` opens the agent-discover panel: enabled, available and quarantined servers with health and tool counts; Enable, Disable and Re-index buttons; a search box for tools and registry servers with Enable and Install buttons; a link to the dashboard. Installs still go through `install_server`, so the consent step stays the gate. With text, the command also prints the search hits as its output (this is what a headless `claude -p "/discover postgres"` shows).
- A status line entry `MCP 2/6 !1` (enabled/installed, `!n` servers needing a look).
- A toast when a server becomes quarantined or unhealthy.
- A band above the prompt, shown only while something needs you (quarantined or unhealthy servers, upstream requests waiting in the dashboard), with Open panel and Dismiss.

The module talks to the plugin's own MCP server (`$.mcp.call`) and to the daemon's REST API. It polls every 5 seconds while the panel is open and every 30 seconds otherwise. Set `AGENT_DISCOVER_PORT` in the environment if the daemon is not on 3424.

**Skills** (`/agent-discover:find|install|dashboard`). `find` is model-invocable: it runs `search_tools`, enables a hit or installs a server before the model tells you something is impossible.

**SessionStart hook.** Adds one line of context (what is enabled, to call `search_tools` first) and, on hosts without the native UI, a notice when servers need attention. It also copies `statusline.mjs` to `${CLAUDE_PLUGIN_DATA}`.

**Status line script for older Claude Code.** Builds before function hooks cannot add a status line entry from a plugin. Compose the script into your own status line command:

```bash
node ~/.claude/plugins/data/agent-discover-agent-discover/statusline.mjs   # --plain drops ANSI/OSC 8
```

It prints nothing when the daemon is down. Do not use it together with the native entry; the duplicate shows twice.

**Desktop preview.** In the Claude desktop app, `.claude/launch.json` can list the dashboard so it appears in the preview dropdown (plugins cannot declare preview servers):

```json
{
  "version": "0.0.1",
  "configurations": [{ "name": "agent-discover", "url": "http://127.0.0.1:3424" }]
}
```

---

## Running as Standalone Server

The daemon is the single long-running process. The stdio shim starts it on demand; run it yourself (cron, systemd, login item) when you want http clients or a dashboard that outlives your editor:

```bash
# Default 127.0.0.1:3424, DB at ~/.claude/agent-discover.db
agent-discover daemon          # or: node dist/index.js daemon

# Custom port / DB via env vars
AGENT_DISCOVER_PORT=4000 AGENT_DISCOVER_DB=/var/lib/agent-discover.db agent-discover daemon
```

The daemon exits after `AGENT_DISCOVER_IDLE_MS` (default 30 minutes) with no MCP streams or dashboard clients. Set it very high for a service. Shims and http clients find a running daemon by port.

### systemd unit example

```ini
[Unit]
Description=agent-discover daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/agent-discover/dist/index.js daemon
Restart=on-failure
User=agent-discover
Environment=AGENT_DISCOVER_DB=/var/lib/agent-discover.db AGENT_DISCOVER_IDLE_MS=2147483647

[Install]
WantedBy=multi-user.target
```

---

## Configuration Options

### Environment variables

#### Core

| Variable              | Default                       | Description                                                  |
| --------------------- | ----------------------------- | ------------------------------------------------------------ |
| `AGENT_DISCOVER_PORT` | `3424`                        | Dashboard HTTP/WebSocket port                                |
| `AGENT_DISCOVER_HOST` | `127.0.0.1`                   | Dashboard bind address (`0.0.0.0` exposes it to the network) |
| `AGENT_DISCOVER_DB`   | `~/.claude/agent-discover.db` | SQLite database path                                         |
| `AGENT_DISCOVER_LOG`  | `info`                        | Log level (`error`, `warn`, `info`, `debug`)                 |

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

----------- | --------------------- | -------------- |
| `--port N` | `AGENT_DISCOVER_PORT` | Dashboard port |
| `--db PATH` | `AGENT_DISCOVER_DB` | SQLite DB path |

`dist/index.js` (MCP stdio server) accepts no CLI flags — it is always invoked by the MCP client.

---

## Troubleshooting

### Dashboard not loading

- Confirm `http://localhost:3424` (or your custom port) responds: `curl http://localhost:3424/api/health`
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
