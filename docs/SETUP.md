# Setup Guide

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

### Quick setup (Claude Code)

After building, run the setup script to auto-configure Claude Code:

```bash
node scripts/setup.js
```

This will:

- Build the project if `dist/` is missing
- Register the MCP server in `~/.claude.json`
- Add the `mcp__agent-discover__*` permission to `~/.claude/settings.json`

Restart Claude Code after running setup.

## MCP Client Configuration

### Claude Code

The setup script handles this automatically. Manual configuration:

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

### Cursor

Add to your Cursor MCP settings (Settings > MCP Servers):

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

agent-discover communicates via JSON-RPC over stdin/stdout. Configure your MCP client to run:

```
node /path/to/agent-discover/dist/index.js
```

The server supports MCP protocol version `2024-11-05` with the `tools.listChanged` capability.

## Environment Variables

| Variable              | Default                       | Description                   |
| --------------------- | ----------------------------- | ----------------------------- |
| `AGENT_DISCOVER_PORT` | `3424`                        | Dashboard HTTP/WebSocket port |
| `AGENT_DISCOVER_DB`   | `~/.claude/agent-discover.db` | SQLite database path          |

## Running the Dashboard

The dashboard auto-starts when the MCP server is first initialized by a client. If another instance is already serving the dashboard port, the new instance skips starting the dashboard (leader election).

To run the dashboard standalone:

```bash
node dist/server.js
# or with custom port/db:
node dist/server.js --port 3425 --db /tmp/discover.db
```

Dashboard URL: `http://localhost:3424`

## Troubleshooting

### "Dashboard port 3424 in use"

Another instance of agent-discover is already serving the dashboard. This is normal when multiple MCP clients connect — only one instance serves the dashboard, the others operate in stdio-only mode. They all share the same SQLite database.

### MCP server not appearing in Claude Code

1. Verify `~/.claude.json` contains the `agent-discover` entry
2. Check the path to `dist/index.js` is correct and the file exists
3. Restart Claude Code completely (not just reload)
4. Check Claude Code logs for MCP connection errors

### Tools not proxying after activation

1. Verify the activated server's command is correct: `registry` with `action: "list"` shows the command/args
2. Check that the child process can start: run the command manually in a terminal
3. The activation timeout is 30 seconds — slow-starting servers may time out
4. Tool call timeout is 60 seconds

### Database errors

The SQLite database is stored at `~/.claude/agent-discover.db` by default. To reset:

```bash
rm ~/.claude/agent-discover.db
# Restart the MCP server — schema is re-created automatically
```

### Permission denied errors in Claude Code

Add the tool permission pattern to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__agent-discover__*"]
  }
}
```
