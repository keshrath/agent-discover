# Dashboard

The agent-discover dashboard is a single-page web application served at `http://localhost:3424`.

## Overview

The dashboard is served by the agent-discover daemon (`agent-discover daemon`) and manages the same servers the MCP tools do. It connects over WebSocket for real-time updates: when a server is installed, enabled or disabled from any host, the UI updates without a refresh. Every state-changing request carries the per-launch `X-Agent-Discover-Token`, fetched from `GET /api/token`.

## Tabs

### Servers

The default view. Shows all installed MCP servers as cards with their current state (enabled or disabled, health).

An **Add Server** button in the panel header opens a collapsible form for manual server registration. The form adapts to the selected transport:

- **Local (stdio)**: Name, Command, Args (comma-separated), Description, Env vars, Tags.
- **Remote URL**: Name, URL, Description, Env vars, Tags.

Each server card displays:

- **Server name**.
- **Health dot** indicating the server's health status (green for healthy, red for unhealthy, gray for unknown).
- **Error count** (if greater than 0), shown as a badge with a clear button (x) to reset via `POST /api/servers/:id/reset-errors`. Error count also auto-resets on a successful health probe.
- **Enabled/Disabled status indicator** (green/gray dot with label).
- **Description** and **tags** as small badges.
- **Source** (local, registry, manual, setup-file) and **transport** (stdio, sse, streamable-http).
- **Tools list** with name and description, from the index (a server is indexed when it is installed, whether or not it is enabled).
- **Action buttons**: Enable/Disable, Check Health, Delete.
- **Test drawer**: seven subtabs — **Tools**, **Info**, **Resources**, **Prompts**, **Events**, **Export**, **Diagnostics** — plus a pop-out button that re-parents the drawer into a floating panel for side-by-side debugging. See [Test Panel](#test-panel) below for full detail.
- **Expandable sections**:
  - **Secrets**: Lists stored secrets with masked values. Provides a form to add new secrets (key + value). Each secret has a delete button.
  - **Metrics**: Shows a table of per-tool call counts, error counts, and average latency. Data is loaded on expand.
  - **Config**: Editable fields for description, command, args (comma-separated), and env vars (KEY=VALUE per line). Save button persists changes via `PUT /api/servers/:id`.

When no servers are installed, a placeholder message is shown with a hint to use the Browse tab.

The badge in the sidebar navigation shows the total count of servers.

### Browse

Federated search across the **official MCP registry**, **npm**, and **PyPI**. Enter a search term to find MCP servers available for installation. Results appear after a 400ms debounce delay.

Each card shows:

- Server name, description, and version
- Runtime tag (`node`, `python`, `streamable-http`, `sse`, `docker`)
- Repository link (clickable, opens in new tab)
- **Install button**: calls `POST /api/install`. The daemon resolves the exact entry, pins the version and builds the install plan (command or endpoint, requirements, provenance checks); a plan that is `blocked` is refused. The server is indexed right after install. Shows a checkmark if already installed, a spinner during install and an error indicator on failure.

A **prereqs banner** is rendered above the result list when a package manager that the host needs (`npx`, `uvx`, `docker`) is missing — fed by `GET /api/prereqs` which probes each tool with `<tool> --version`. The banner explains which tool is missing and how to install it.

Installing a server from Browse adds it to the Servers tab. The search runs against the local registry mirror, npm and PyPI (`GET /api/browse`).

Clicking **Install** opens the **install consent modal**. It loads `GET /api/install/plan` (source, name, optional `local_name` and `transport`) and shows what installing will do: the exact command to run on your machine or the endpoint to connect to, warnings, the pinned version or image digest, the registry entry and verified publisher, and each provenance check with its pass/fail result. Required environment variables and headers are entered here (secret ones as password fields) and stored as server secrets. You can change the local name and, for entries with both packages and remotes, the transport; the plan reloads on each change. There is also an "enable after install" choice. **Install** stays disabled while the plan is `blocked` or a required value is missing, and `POST /api/install` runs only after you confirm. On success the dashboard jumps to the new server.

Entries the registry has marked `deleted` get a red border in the results.

### Logs

Real-time call log of all proxied MCP tool calls. Each row shows timestamp, server name, tool name, success/fail badge, and latency.

- **Click any row** to expand full-width Args and Response panels below it (stacked vertically).
- **Filter bar**: dropdown to filter by server, dropdown for success/fail status.
- **Clear All** button removes all log entries (calls `DELETE /api/logs`).
- **Real-time**: new entries stream in via WebSocket (`log_entry` messages) without page refresh.
- **Badge**: sidebar navigation shows the current log entry count.
- **Retention**: entries older than 30 days are auto-pruned (configurable via `AGENT_DISCOVER_LOG_RETENTION_DAYS` env var). In-memory ring buffer capped at 500 entries.

### Audit

Read-only view of the append-only audit log (`GET /api/audit`, newest first). Filter by server, action and tool; **Load more** pages backwards with `before=<last id>`. Installs, approvals, quarantines, secret changes and tool calls are recorded here. See [API.md](API.md) for the entry shape.

### Trust, registry and sign-in banners

Server cards on the Servers tab show banners when something needs attention:

- **Quarantined**: the server's tools changed since you approved them and agents cannot use it. The banner shows the drift diff (from `GET /api/servers/:id/trust`) with **Approve changes** (`POST /api/servers/:id/approve`, bound to the tool hashes you reviewed; a 409 means the tools changed again and the new diff is shown) or **Keep disabled**. Enable is disabled until the quarantine is reviewed.
- **Flagged tools**: tools whose descriptions look suspicious (hidden characters, instruction override, hidden tags, possible exfiltration, secret access, concealing actions from the user) are listed in a banner and tagged `flagged` in the tools list.
- **Removed from / Deprecated in the MCP Registry**: shown from the server's `registry_status`. A deleted entry is a registry takedown (used for malware and spam); consider uninstalling.
- **Sign in**: a remote server that needs OAuth gets a **Sign in** button (`POST /api/servers/:id/auth` returns the authorization URL, the dashboard polls `GET /api/servers/:id/auth` until the callback finishes).

## Routes

The URL hash is a deep link and follows browser back/forward: `#/servers`, `#/servers/<name>` (a server's card), `#/browse?q=<query>`, `#/logs`, `#/audit`. Unknown hashes open Servers.

## Sidebar

The sidebar contains:

- **Header**: Widgets icon (Material Symbols `widgets`) and "agent-discover" title with version number.
- **Navigation**: Four tab buttons -- Servers (with count badge), Browse, Logs (with count badge) and Audit.
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

1. A full `state` snapshot on connect.
2. A new snapshot, debounced to 100 ms, after every lifecycle event (install, enable, disable, index, connection change). The daemon is the only writer, so there is no database polling.
3. `log_entry`, `notification`, `progress` and `elicitation_request` messages as they happen.
4. Manual refresh via the `{ "type": "refresh" }` WebSocket message.

The dashboard uses [morphdom](https://github.com/patrick-steele-idem/morphdom) for efficient DOM diffing when applying state updates.

## Test Panel

Each server card exposes a **Test** expandable section that provides MCP-Inspector-grade debugging inside the dashboard itself — no second process, no second port. All network calls hit the daemon's own HTTP port (`AGENT_DISCOVER_PORT`, default `3424`), which only accepts loopback `Host` and `Origin` headers.

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
- **Export** — one-click copy of the server's config in two formats:
  - `mcp.json` — the generic MCP client shape (Claude Desktop, Claude Code, Cursor, Windsurf).
  - `agent-discover` — the declarative setup-file format used by `AGENT_DISCOVER_SETUP_FILE`.
- **Diagnostics** — `ping` round-trip (RTT in ms) and `logging/setLevel` selector.

### Pop-out to floating panel

Every Test drawer has a pop-out button (top-right of the tab bar). Pop-out reparents the tester into a floating panel anchored to the top-right of the viewport. Multiple floating panels can coexist, so you can test two servers side-by-side.

### Presets

Below the tool form, the drawer offers a **Save as preset** button and a preset dropdown. Presets are scoped by `(serverName, toolName, presetName)` and stored by the daemon (`GET|POST /api/presets`, `DELETE /api/presets/:id`), so they survive a refresh and are shared by every browser that opens the dashboard. Presets saved in `localStorage` by older versions are migrated once.

### Ad-hoc (transient) servers

The **Test ad-hoc** button in the Servers tab header opens a floating panel backed by a _transient_ MCP server — one that's connected just for this test session and never written to the registry. Transient servers get a 15-minute TTL, disconnect on release or tab close, and their tools are never exposed to hosts. Ideal for paste-and-test flows during local MCP server development without polluting the registry.

### Client capabilities advertised

agent-discover advertises the following client capabilities to the upstream servers it connects to:

- `roots.listChanged` — the list of roots is configurable via the `AGENT_DISCOVER_ROOTS` env var (comma-separated URIs) and exposed at `GET /api/roots`.
- `elicitation` — an upstream 2025 server's `elicitation/create` request is forwarded to the calling MCP client when possible, otherwise shown as a modal in the dashboard with a schema-driven form (Accept / Decline / Cancel, 2-minute expiry). Pending requests are listed at `GET /api/elicitations`.
- `sampling` — only when `AGENT_DISCOVER_OPENAI_API_KEY` (or `OPENAI_API_KEY`) is set; requests are answered by an OpenAI-compatible endpoint.

### Security posture

The Test panel can execute arbitrary tool calls and dump server capabilities, so the trust boundary is the request guard: an exact loopback `Host` and `Origin` allowlist (DNS-rebinding protection) plus the per-launch REST token on every mutating call. See [SECURITY.md](SECURITY.md).

## Running the dashboard

The dashboard is part of the daemon. Start it directly with:

```bash
agent-discover daemon                                   # or: node dist/index.js daemon
AGENT_DISCOVER_PORT=3425 AGENT_DISCOVER_DB=/path/to/discover.db agent-discover daemon
```

It also starts on demand when any host connects through the stdio shim, and exits after `AGENT_DISCOVER_IDLE_MS` (default 30 minutes) with no MCP streams and no dashboard clients.
