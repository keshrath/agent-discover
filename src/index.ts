#!/usr/bin/env node

// =============================================================================
// agent-discover — MCP server entry point (stdio transport)
//
// Communicates via JSON-RPC over stdin/stdout via agent-common's startMcpServer.
// Dynamic tool list (regenerated per request so proxied child-server tools
// stay current), auto-starts dashboard on initialize, and emits
// `notifications/tools/list_changed` after tool calls that alter active
// servers (activate/deactivate/uninstall).
// =============================================================================

import { startMcpServer } from 'agent-common';
import { createContext } from './context.js';
import { readPackageMeta } from './package-meta.js';
import { createToolHandler, getToolList } from './transport/mcp.js';
import { startDashboard, type DashboardServer } from './server.js';

const SERVER_INFO = readPackageMeta();
const DASHBOARD_PORT = parseInt(process.env.AGENT_DISCOVER_PORT ?? '3424', 10);

const appContext = createContext();
const handleTool = createToolHandler(appContext);

let dashboard: DashboardServer | null = null;
let dashboardAttempted = false;

function tryStartDashboard(): void {
  if (dashboard || dashboardAttempted) return;
  dashboardAttempted = true;
  startDashboard(appContext, DASHBOARD_PORT)
    .then((dashboardServer) => {
      dashboard = dashboardServer;
    })
    .catch(() => {
      process.stderr.write(
        `[agent-discover] Dashboard port ${DASHBOARD_PORT} in use — another instance is serving.\n`,
      );
    });
}

startMcpServer({
  serverInfo: SERVER_INFO,
  tools: () => getToolList(appContext),
  handleTool,
  onInitialize: tryStartDashboard,
  capabilities: { tools: { listChanged: true } },
  onToolCalled: (name, args, notify) => {
    if (
      name === 'registry' &&
      (args.action === 'activate' || args.action === 'deactivate' || args.action === 'uninstall')
    ) {
      notify('notifications/tools/list_changed');
    }
  },
  logLabel: 'agent-discover',
});

function cleanup(): void {
  if (dashboard) {
    dashboard.close();
    dashboard = null;
  }
  appContext.close();
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
process.on('exit', cleanup);
