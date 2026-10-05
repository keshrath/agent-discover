// =============================================================================
// MCP Apps wiring. One self-contained widget renders every meta tool result
// (the view is picked from the structuredContent shape, see lib/view.js).
// src/widgets/build.mjs writes it to dist/widgets/app.html.
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const WIDGET_URI = 'ui://agent-discover/app.html';
/** ext-apps RESOURCE_MIME_TYPE (pinned by tests/widgets/contract.test.ts). */
export const WIDGET_MIME = 'text/html;profile=mcp-app';

/** Meta tools whose results the widget renders. */
export const WIDGET_TOOLS: ReadonlySet<string> = new Set([
  'search_servers',
  'search_tools',
  'server_status',
  'enable_server',
  'disable_server',
  'install_server',
  'get_tool',
]);

/** Tool `_meta` that points MCP Apps hosts at the widget (nested form + the legacy flat key). */
export const WIDGET_META = { ui: { resourceUri: WIDGET_URI }, 'ui/resourceUri': WIDGET_URI };

/** Result `_meta` key carrying the dashboard origin for widget links. */
export const DASHBOARD_META_KEY = 'agent-discover/dashboard';

// Same relative path from src/widgets (tests) and dist/widgets (runtime).
const HTML = fileURLToPath(new URL('../../dist/widgets/app.html', import.meta.url));
let cached: string | undefined;

export function widgetHtml(): string {
  cached ??= readFileSync(HTML, 'utf8');
  return cached;
}
