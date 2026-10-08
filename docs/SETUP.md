# Setup Guide

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Client Setup](#client-setup)
- [Claude Code plugin](#claude-code-plugin)
- [Running as Standalone Server](#running-as-standalone-server)
- [Configuration Options](#configuration-options)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js**: v22 or later
- **npm**: bundled with Node
- An MCP-compatible AI client (Claude Code, Cursor, OpenCode, Windsurf, Aider, Continue, etc.) — or a plain REST consumer
- (Source builds only) git

agent-discover runs as one local daemon (REST and `/mcp` on `127.0.0.1:3424`). The stdio shim that clients spawn starts it on demand; no system service is required.

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
node dist/index.js daemon   # starts the daemon (REST + /mcp on http://127.0.0.1:3424)
```

From an npm install use `agent-discover daemon` instead.

The first run creates the SQLite DB `agent-discover.db` in the per-user data directory: `%LOCALAPPDATA%\agent-discover` (Windows), `~/Library/Application Support/agent-discover` (macOS), `$XDG_DATA_HOME/agent-discover` or `~/.local/share/agent-discover` (Linux). Override the directory with `AGENT_DISCOVER_DATA_DIR`, the DB file with `AGENT_DISCOVER_DB`. A 1.x `~/.claude/agent-discover.db` (with its `-wal`/`-shm` files and `agent-discover-secrets.json`/`.key`) is moved there once on first start. The daemon refuses to start while another process, such as a still-running 1.x, holds that old DB open; stop it and start again.

---

## Client Setup

agent-discover is one daemon (`127.0.0.1:3424`: REST, `/mcp`) that every client shares. A client connects in one of two ways:

| Entry                                     | When to use it                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **stdio shim** `npx -y agent-discover@^3` | Default. Works in every client. The shim starts the daemon on demand (and again after an idle exit or reboot) and relays JSON-RPC to `/mcp`.                                   |
| **http** `http://127.0.0.1:3424/mcp`      | Clients with Streamable HTTP support when the daemon already runs as a service (see [Running as Standalone Server](#running-as-standalone-server)). Nothing starts it for you. |

Pick one entry per client. Configuring both duplicates every tool.

### Claude Code

Install the plugin. It bundles the stdio shim, two skills and a Claude Code mod (pane, status line entry, toasts, attention band, context block):

```bash
claude plugin marketplace add keshrath/agent-discover
claude plugin install agent-discover@agent-discover
```

Remove any hand-written `agent-discover` entry from `~/.claude.json` and any old `session-start.js` hook from `~/.claude/settings.json` first; otherwise tools appear twice. See [Claude Code plugin](#claude-code-plugin) below for what it adds.

Without the plugin, register the shim yourself:

```bash
claude mcp add agent-discover -- npx -y agent-discover@^3
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
    "agent-discover": { "command": "npx", "args": ["-y", "agent-discover@^3"] }
  }
}
```

For a running daemon use `{ "url": "http://127.0.0.1:3424/mcp" }` instead. Cursor shows the results as markdown. Consent prompts appear as elicitation dialogs when the build supports them; otherwise `install_server` returns `consent_required` with the plan; install it from Claude Code's `/discover` pane or set `AGENT_DISCOVER_ALLOW_UNCONFIRMED_INSTALL=1`.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.agent-discover]
command = "npx"
args = ["-y", "agent-discover@^3"]
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

The http form needs the daemon running. For on-demand start use the shim: `{ "type": "stdio", "command": "npx", "args": ["-y", "agent-discover@^3"] }`. VS Code renders the MCP Apps widget (search results, consent card, tool tester) inline.

### Claude Desktop

`claude_desktop_config.json` (Settings, Developer, Edit Config; on Windows `%APPDATA%\Claude\`). Claude Desktop only launches stdio servers, so use the shim:

```json
{
  "mcpServers": {
    "agent-discover": { "command": "npx", "args": ["-y", "agent-discover@^3"] }
  }
}
```

Restart the app. Tool results render as the MCP Apps widget.

### Windsurf, OpenCode, other stdio clients

Same `mcpServers` block as Cursor (Windsurf: `~/.codeium/windsurf/mcp_config.json`). Any client that can spawn a command works with `npx -y agent-discover@^3`; any client with Streamable HTTP can point at `http://127.0.0.1:3424/mcp`. Both protocol eras (2025-11 sessions and 2026-07 stateless requests) are served on the same endpoint.

### REST API

The REST API runs on the daemon port and is usable without any MCP client:

```bash
curl http://127.0.0.1:3424/api/health
curl http://127.0.0.1:3424/api/status
curl 'http://127.0.0.1:3424/api/browse?query=filesystem'
```

See [API.md](./API.md) for the full reference.

---

## Claude Code plugin

The plugin lives in `plugin/` and is what `claude plugin install` fetches. It has these parts.

**The management UI (function hooks, Claude Code 2.1.289+).** `hooks/register.tsx` and `hooks/view.tsx` draw inside the terminal, the desktop Code tab and VS Code. This is agent-discover's only full UI; there is no web dashboard since 3.0.

- `/discover` opens the agent-discover pane, docked beside the transcript in the fullscreen layout and above the prompt otherwise (also the desktop Code tab and VS Code). Tabs:
  - **Servers**: every installed server on two lines (name and state, then tool count and description), what needs a look first. Open one for its detail: transport and the exact command or URL, tags, source and MCP Registry name and status, package and version, env and header key names (values are never shown); a secrets editor (set a missing key, add `KEY=value`, delete; typed values are sent and never kept or drawn); its tools, each expandable to its input schema, with per-tool calls, errors and latency; health check, last error and error count with Reset errors; for a quarantined server the drift (changed, added, removed tools) with Approve and Keep disabled; for a remote server the OAuth state with Sign in, showing the authorization URL as a link (agent-discover never opens it); Enable or Disable, Re-index and Uninstall (asks once more).
  - **Browse**: search the registry mirror, npm and PyPI, sync the mirror; open a result for its install plan: the exact command or URL, pinned version, publisher and provenance checks, warnings or the reason it is blocked, and its env and header requirements with an input for each missing one. Install or Install and enable sends `POST /api/install`; you pressing it is the consent.
  - **Logs**: the recent proxied calls with latency and errors. **Audit**: the audit log, filtered by server and action, paged.
  - Questions upstream servers ask (elicitation) that no client could answer show on top, with a field per requested value and Accept, Decline, Cancel.
- `/discover <what you need>` opens Browse with the results for that query.
- Keys: 1-4 switch tabs and r refreshes while the pane holds the keyboard (a text field takes them while it has the focus); Tab moves, Enter presses, Esc hands the keys back, ctrl+x tab takes them again. After each move the focus lands on the next step.
- A status line entry `MCP 2/6 · 1 to review` (enabled of installed, and how many servers need a look).
- A toast when a server becomes quarantined or unhealthy, or an upstream server asks a question.
- A band above the prompt, shown only while something needs you and the pane is closed, with Review (opens the server in the pane) and Dismiss.
- A context block (`# agent-discover`) in each conversation's first message: which servers are enabled, and to call `search_tools` (or `search_servers`) before saying a capability is unavailable. Nothing is added while the daemon is down.

The module talks to the daemon's REST API only (state-changing calls with the per-launch token). It refreshes the status every 30 seconds, every 5 seconds while the pane is open, and after every action. If the engine does not place the pane (a terminal too narrow for an unasked pane, a surface that places none), `/discover` prints why. Set `AGENT_DISCOVER_PORT` in the environment if the daemon is not on 3424.

**Skills** (`/agent-discover:find|install`). `find` is model-invocable: it runs `search_tools`, enables a hit or installs a server before the model tells you something is impossible.

---

## Running as Standalone Server

The daemon is the single long-running process. The stdio shim starts it on demand; run it yourself (cron, systemd, login item) when you want http clients or a daemon that outlives your editor:

```bash
# Default 127.0.0.1:3424, DB in the data directory
agent-discover daemon          # or: node dist/index.js daemon

# Custom port / DB via env vars
AGENT_DISCOVER_PORT=4000 AGENT_DISCOVER_DB=/var/lib/agent-discover.db agent-discover daemon
```

The daemon exits after `AGENT_DISCOVER_IDLE_MS` (default 30 minutes) with no open HTTP exchanges. Set it very high for a service. Shims and http clients find a running daemon by port.

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

The complete list with defaults is in [API.md](./API.md#environment). The ones most setups touch:

| Variable                            | Default                   | Description                                                             |
| ----------------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `AGENT_DISCOVER_PORT`               | `3424`                    | Daemon port (REST, `/mcp`)                                              |
| `AGENT_DISCOVER_HOST`               | `127.0.0.1`               | Listen address. Anything but loopback exposes the daemon to the network |
| `AGENT_DISCOVER_DATA_DIR`           | platform data dir         | Data directory (DB, file secret store)                                  |
| `AGENT_DISCOVER_DB`                 | `agent-discover.db` in it | SQLite database path                                                    |
| `AGENT_DISCOVER_MODE`               | `native`                  | `native` or `proxy`, see below                                          |
| `AGENT_DISCOVER_IDLE_MS`            | `1800000`                 | Daemon idle exit (`0` = never)                                          |
| `AGENT_DISCOVER_SETUP_FILE`         | unset                     | Declarative server list synced at daemon start                          |
| `AGENT_DISCOVER_SECRETS`            | auto                      | `keyring` or `file` forces the secret backend                           |
| `AGENT_DISCOVER_EMBEDDING_PROVIDER` | `none`                    | `local` or `openai` enables semantic ranking                            |

Environment variables must reach the **daemon**. A shim spawns the daemon with its own environment, so set them in the host's MCP server entry (`env`) or in the shell that starts `agent-discover daemon`. A daemon that is already running keeps the environment it started with.

### Native or proxy mode

`AGENT_DISCOVER_MODE=native` (default) lists every enabled server's tools as `<server>__<tool>` next to the eight meta tools and sends `notifications/tools/list_changed` when that set changes. Use it with hosts that have their own tool search or handle large tool lists, so their permission prompts and deferred loading apply to those tools.

`AGENT_DISCOVER_MODE=proxy` lists only the meta tools. Tools are reached with `search_tools` then `call_tool`. Use it for hosts that load every tool schema up front, or that ignore `list_changed`.

### Semantic search (optional)

Search works without embeddings (lexical ranking). A provider adds dense scores; on the retrieval bench the local model raised R@10 from .661 to .722 (see [bench/retrieval/README.md](../bench/retrieval/README.md)).

**Local** (no network after the first download, no API key):

```bash
npm install @huggingface/transformers       # optional dependency, not installed by default
export AGENT_DISCOVER_EMBEDDING_PROVIDER=local
```

The default model is `Xenova/multilingual-e5-small` (384 dims, q8, about 130 MB, multilingual). The first use downloads it. Indexing a large catalog is slow on one thread (1674 tools took about 3 minutes in the bench); `AGENT_DISCOVER_EMBEDDING_THREADS` raises it. The model is unloaded after `AGENT_DISCOVER_EMBEDDING_IDLE_TIMEOUT` idle seconds (default 60).

**OpenAI**:

```bash
export AGENT_DISCOVER_EMBEDDING_PROVIDER=openai
export AGENT_DISCOVER_OPENAI_API_KEY=sk-...    # or OPENAI_API_KEY
```

The default model is `text-embedding-3-small`. Tool text is sent to OpenAI when indexing.

If a provider is requested but unavailable (no key, package not installed, model fails to load) the daemon logs a note to stderr and falls back to lexical search.

### Declarative setup file

`AGENT_DISCOVER_SETUP_FILE` points at a JSON file listing servers to ensure installed at daemon start (idempotent). A sibling `*.local.json` is merged. Entries are operator-authored, so they install without the interactive consent step. Format and the 2.0 `auto_activate` to `enabled` rename: [API.md](./API.md#setup-file).

---

## Troubleshooting

### Daemon not answering

- Check the daemon: `curl http://127.0.0.1:3424/api/health` should return `{"status":"ok",...}`.
- The shim starts the daemon on the first MCP message. If it did not start, run `agent-discover daemon` in a terminal and read its output. The daemon a shim starts logs to `daemon-<port>.log` in the data directory (beside the database).
- `port 3424 already in use` means another process holds the port. Another agent-discover daemon is fine (shims reuse it); anything else needs `AGENT_DISCOVER_PORT`.

### MCP server not appearing in the host

1. Confirm exactly one entry (plugin or hand-written, not both) and that the host was restarted after adding it.
2. Run the entry's command by hand (`npx -y agent-discover@^3`); it should wait on stdin without errors.
3. Check the host's MCP logs for the shim's stderr.

### A server's tools do not show up after enabling

1. `server_status` (or the `/discover` pane) shows whether it is indexed, connected and quarantined. A quarantined server's tools are hidden until you approve the change.
2. Try `POST /api/servers/:id/health` or Check health in the server's detail in `/discover`. Install and enable report a probe failure as `index_error` instead of failing the install.
3. Run the server's command by hand to see why it cannot start. Connecting times out after 30 s; slow `npx` downloads may need a retry.
4. In `proxy` mode tools are never listed; call them through `call_tool`.
5. If the host does not refresh its tool list after `list_changed`, start a new turn or reconnect the server; use proxy mode with such hosts.

### Install returns `consent_required`

The host cannot show an elicitation prompt. Install from Browse in Claude Code's `/discover` pane, or have the operator set `AGENT_DISCOVER_ALLOW_UNCONFIRMED_INSTALL=1` if skipping the prompt is acceptable.

### Database errors

The database lives in the data directory (`%LOCALAPPDATA%\agent-discover`, `~/Library/Application Support/agent-discover` or `~/.local/share/agent-discover`) by default and migrates itself on start. To reset, stop the daemon and delete the file. Installed servers, metrics, pins and the audit log are lost. Secret values live in the OS keychain (service `agent-discover`) or in `agent-discover-secrets.json` next to the database, and are not removed with it.

### Permission prompts in Claude Code

To pre-approve the meta tools add the pattern to `~/.claude/settings.json`. The plugin's MCP server is named `plugin:agent-discover:agent-discover`, so its tools are `mcp__plugin_agent-discover_agent-discover__*`; a hand-registered server is `mcp__agent-discover__*`:

```json
{
  "permissions": {
    "allow": ["mcp__plugin_agent-discover_agent-discover__*"]
  }
}
```

`install_server` asks for approval on every call regardless (it declares `anthropic/requiresUserInteraction`), and the consent prompt is separate.
