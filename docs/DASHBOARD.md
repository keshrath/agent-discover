# Dashboard

The agent-discover dashboard is a single-page web application served at `http://localhost:3424`.

## Overview

The dashboard provides a visual interface for managing MCP servers. It connects to the backend via WebSocket for real-time updates -- when servers are installed, activated, or deactivated, the UI updates automatically without manual refresh.

## Tabs

### Servers

The default view. Shows all MCP servers registered in the local database as cards. This is a merged view -- both installed and active servers appear together with their current status.

An **Add Server** button in the panel header opens a collapsible form for manual server registration. The form adapts to the selected transport:

- **Local (stdio)**: Name, Command, Args (comma-separated), Description, Env vars, Tags.
- **Remote URL**: Name, URL, Description, Env vars, Tags.

Each server card displays:

- **Server name**.
- **Health dot** indicating the server's health status (green for healthy, red for unhealthy, gray for unknown).
- **Error count** (if greater than 0), shown as a badge with a clear button (x) to reset via `POST /api/servers/:id/reset-errors`. Error count also auto-resets on a successful health probe.
- **Active/Inactive status indicator** (green/gray dot with label).
- **Description** and **tags** as small badges.
- **Source** (local, registry, smithery, manual) and **transport** (stdio, sse, streamable-http).
- **Tools list** with name and description (if the server has been activated at least once).
- **Action buttons**: Activate/Deactivate, Check Health, Delete.
- **Test drawer** (active servers only): seven subtabs — **Tools**, **Info**, **Resources**, **Prompts**, **Events**, **Export**, **Diagnostics** — plus a pop-out button that re-parents the drawer into a floating panel for side-by-side debugging. See [Test Panel](#test-panel) below for full detail.
- **Expandable sections**:
  - **Secrets**: Lists stored secrets with masked values. Provides a form to add new secrets (key + value). Each secret has a delete button.
  - **Metrics**: Shows a table of per-tool call counts, error counts, and average latency. Data is loaded on expand.
  - **Config**: Editable fields for description, command, args (comma-separated), and env vars (KEY=VALUE per line). Save button persists changes via `PUT /api/servers/:id`.

When no servers are registered, a placeholder message is shown with a hint to use `registry_install` or browse the marketplace.

The badge in the sidebar navigation shows the total count of servers.

### Browse

Federated search across the **official MCP registry**, **npm**, and **PyPI**. Enter a search term to find MCP servers available for installation. Results appear after a 400ms debounce delay.

Each card shows:

- Server name, description, and version
- Runtime tag (`node`, `python`, `streamable-http`, `sse`, `docker`)
- Repository link (clickable, opens in new tab)
- **Install button**: Registers the server in the local database with the right command for its runtime — `npx -y <pkg>` for node, `uvx <pkg>` for python, the remote URL for sse/streamable-http. Shows a checkmark if already installed. Shows a spinner during install and an error indicator on failure.

A **prereqs banner** is rendered above the result list when a package manager that the host needs (`npx`, `uvx`, `docker`) is missing — fed by `GET /api/prereqs` which probes each tool with `<tool> --version`. The banner explains which tool is missing and how to install it.

Installing a server from Browse adds it to the Servers tab.

### Logs

Real-time call log of all proxied MCP tool calls. Each row shows timestamp, server name, tool name, success/fail badge, and latency.

- **Click any row** to expand full-width Args and Response panels below it (stacked vertically).
- **Filter bar**: dropdown to filter by server, dropdown for success/fail status.
- **Clear All** button removes all log entries (calls `DELETE /api/logs`).
- **Real-time**: new entries stream in via WebSocket (`log_entry` messages) without page refresh.
- **Badge**: sidebar navigation shows the current log entry count.
- **Retention**: entries older than 30 days are auto-pruned (configurable via `AGENT_DISCOVER_LOG_RETENTION_DAYS` env var). In-memory ring buffer capped at 500 entries.

## Sidebar

The sidebar contains:

- **Header**: Widgets icon (Material Symbols `widgets`) and "agent-discover" title with version number.
- **Navigation**: Three tab buttons -- Servers (with count badge), Browse, and Logs (with count badge).
- **Footer**: Theme toggle button (moon/sun icon).

## Favicon

The page uses an inline SVG favicon -- four rounded rectangles in the accent color (`#5d8da8`) at varying opacities.

## Theme

The dashboard supports light and dark themes, toggled via the theme button in the sidebar footer.

- **Dark theme** (default): Dark backgrounds with light text
- **Light theme**: Light backgrounds with dark text

Both themes use the same accent color (`#5d8da8`) and Material Design 3 design tokens.

### Design System

- **Icons**: Material Symbols Outlined (Google Fonts)
- **Body font**: Inter (400, 500, 600, 700 weights)
- **Monospace font**: JetBrains Mono (400, 500 weights)
- **Border radius**: 12px for cards, 16px for panels, 8px for small elements
- **Section headers**: Uppercase, 13px, weight 600, 0.5px letter-spacing

### Theme Sync with agent-desk

The dashboard supports bidirectional theme sync with the agent-desk shell:

- **Inbound**: Listens for `postMessage` events with `type: "theme-sync"` and applies custom CSS variables (colors, shadows) from the parent frame. Also watches for external body class mutations via `MutationObserver`.
- **Outbound**: Emits theme changes via `console.log('__agent_desk_theme__:dark')` for reverse sync.
- When theme sync is active from a parent, the local theme toggle button is hidden.

## Toast Notifications

Actions like saving config, setting secrets, and running health checks show brief toast notifications at the bottom of the screen. Toasts auto-dismiss after 3 seconds.

## Real-Time Updates

The dashboard maintains a persistent WebSocket connection. State is synchronized via:

1. Full state snapshot on initial connection
2. DB fingerprint polling every 2 seconds
3. Automatic re-sync when the fingerprint changes
4. Manual refresh available via the `{ "type": "refresh" }` WebSocket message

The dashboard uses [morphdom](https://github.com/patrick-steele-idem/morphdom) for efficient DOM diffing when applying state updates.

## Test Panel

Each active server card exposes a **Test** expandable section that provides MCP-Inspector-grade debugging inside the dashboard itself — no second process, no second port. All network calls hit agent-discover's existing dashboard HTTP port (`AGENT_DISCOVER_PORT`, default `3424`) and are restricted to loopback origins unless `AGENT_DISCOVER_ALLOW_REMOTE_TEST=1` is set.

### Subtabs

- **Tools** — list of `tools/list` entries. Selecting one renders a schema-driven form from the tool's `inputSchema` (supports `string`, `number`, `integer`, `boolean`, `enum` → `<select>`, `array` with add/remove rows, nested `object`, format-aware inputs for `date-time` / `date` / `email` / `uri`, and a raw JSON textarea fallback for `oneOf` / `anyOf` / `patternProperties`). Submit calls the tool via `POST /api/servers/:id/call`. The result pane has three view modes:
  - **Pretty** — walks the MCP content array: `text` as markdown, `image`/`audio` as embedded media (base64 data URL), `resource` / `resource_link` as tagged blocks.
  - **Raw** — JSON-highlighted payload.
  - **cURL** — copy-pasteable `curl` command that reproduces the call outside the UI.
  - Latency pill (ms) and a success/fail badge sit above the body.
- **Info** — `getServerInfo()` — server name, version, instructions (rendered as markdown), and a readable capabilities dump.
- **Resources** — `resources/list` paginated via `nextCursor` (`Load more` button). Selecting a resource exposes **Read**, **Subscribe**, and **Unsubscribe** actions. Subscribed resources' `resources/updated` notifications flow through the WebSocket `notification` stream and appear in the **Events** subtab.
- **Prompts** — `prompts/list` paginated. Selecting a prompt renders its declared arguments as a mini form. **Get prompt** calls `prompts/get` and renders the resulting message chain inline (roles + markdown bodies).
- **Events** — live feed of every server-sent notification and progress update since the drawer opened, scoped to the currently selected server.
- **Export** — one-click copy of the server's config in four formats:
  - `mcp.json` — standard MCP client shape (Claude Desktop, Cursor, Windsurf).
  - `claude-code` — same `{ mcpServers: { ... } }` shape scoped to Claude Code.
  - `cursor` — Cursor `.cursor/mcp.json` shape.
  - `agent-discover` — the declarative setup-file format used by `AGENT_DISCOVER_SETUP_FILE`.
- **Diagnostics** — `ping` round-trip (RTT in ms) and `logging/setLevel` selector.

### Pop-out to floating panel

Every Test drawer has a pop-out button (top-right of the tab bar). Pop-out reparents the tester into a floating panel anchored to the top-right of the viewport. Multiple floating panels can coexist, so you can test two servers side-by-side.

### Presets

Below the tool form, the drawer offers a **Save as preset** button and a preset dropdown. Presets are scoped by `(serverName, toolName, presetName)` and persisted to `localStorage` — they survive page refresh but are not synced across browsers or machines.

### Ad-hoc (transient) servers

The **Test ad-hoc** button in the Servers tab header opens a floating panel backed by a _transient_ MCP server — one that's activated just for this test session and never written to the registry. Transient servers get a 15-minute TTL, auto-disconnect on release or tab close, and their tools are **not** exposed to the host MCP catalog (`getAllProxiedTools` skips them). Ideal for paste-and-test flows during local MCP server development without polluting the registry.

### Client capabilities advertised

agent-discover advertises the following client capabilities to every child server it activates:

- `roots.listChanged` — the list of roots is configurable via the `AGENT_DISCOVER_ROOTS` env var (comma-separated URIs) and exposed at `GET /api/roots`.
- `elicitation` — servers that request user confirmation via `elicitation/create` are not blocked at the protocol level; interactive UI support lands in v1.5.

### Security posture

The Test panel can execute arbitrary tool calls and dump server capabilities — the trust boundary is "localhost only". The REST endpoints powering it refuse requests with non-loopback `remoteAddress` or suspicious `Origin` headers (DNS-rebinding protection). The `AGENT_DISCOVER_ALLOW_REMOTE_TEST=1` escape hatch exists for controlled reverse-proxy deployments but prints a warning at startup.

## Standalone Mode

The dashboard can be run independently of any MCP client:

```bash
node dist/server.js
# or with custom options:
node dist/server.js --port 3425 --db /path/to/discover.db
```
