# Dashboard

The agent-discover dashboard is a single-page web application served at `http://localhost:3424`.

## Overview

The dashboard provides a visual interface for managing MCP servers. It connects to the backend via WebSocket for real-time updates -- when servers are installed, activated, or deactivated, the UI updates automatically without manual refresh.

## Tabs

### Servers

The default view. Shows all MCP servers registered in the local database as cards. This is a merged view -- both installed and active servers appear together with their current status.

Each server card displays:

- **Server name** with an **approval badge** (`experimental`, `approved`, or `production`). Clicking the badge opens a dropdown to change the approval status.
- **Health dot** indicating the server's health status (green for healthy, red for unhealthy, gray for unknown).
- **Error count** (if greater than 0), shown as a badge.
- **Active/Inactive status indicator** (green/gray dot with label).
- **Description** and **tags** as small badges.
- **Source** (local, registry, smithery, manual) and **transport** (stdio, sse, streamable-http).
- **Tools list** with name and description (if the server has been activated at least once).
- **Action buttons**: Activate/Deactivate, Check Health, Delete.
- **Expandable sections**:
  - **Secrets**: Lists stored secrets with masked values. Provides a form to add new secrets (key + value). Each secret has a delete button.
  - **Metrics**: Shows a table of per-tool call counts, error counts, and average latency. Data is loaded on expand.
  - **Config**: Editable fields for description, command, args (comma-separated), and env vars (KEY=VALUE per line). Save button persists changes via `PUT /api/servers/:id`.

When no servers are registered, a placeholder message is shown with a hint to use `registry_install` or browse the marketplace.

The badge in the sidebar navigation shows the total count of servers.

### Browse

Search and browse the official MCP registry marketplace. Enter a search term to find MCP servers available for installation. Results appear after a 400ms debounce delay.

Results show:

- Server name, description, and version
- Available packages (npm, Python, Docker)
- Repository link (clickable, opens in new tab)
- **Install button**: Registers the server in the local database. Shows a checkmark if already installed. Shows a spinner during install and an error indicator on failure.

Installing a server from Browse adds it to the Servers tab.

## Sidebar

The sidebar contains:

- **Header**: Widgets icon (Material Symbols `widgets`) and "agent-discover" title with version number.
- **Navigation**: Two tab buttons -- Servers (with count badge) and Browse.
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

## Standalone Mode

The dashboard can be run independently of any MCP client:

```bash
node dist/server.js
# or with custom options:
node dist/server.js --port 3425 --db /path/to/discover.db
```
