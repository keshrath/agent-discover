#!/usr/bin/env node

// =============================================================================
// agent-discover — MCP server entry point (stdio transport)
//
// Communicates via JSON-RPC over stdin/stdout.
// Auto-starts the dashboard HTTP server via leader election.
// =============================================================================

import { createInterface } from 'readline';
import { createContext } from './context.js';
import { readPackageMeta } from './package-meta.js';
import { createToolHandler, getToolList } from './transport/mcp.js';
import { startDashboard, type DashboardServer } from './server.js';
import { RegistryError } from './types.js';
import type { JsonRpcRequest, JsonRpcResponse } from './types.js';

const SERVER_INFO = readPackageMeta();
const CAPABILITIES = { tools: { listChanged: true } };
const DASHBOARD_PORT = parseInt(process.env.AGENT_DISCOVER_PORT ?? '3424', 10);

const appContext = createContext();
const handleTool = createToolHandler(appContext);

let dashboard: DashboardServer | null = null;
let dashboardAttempted = false;
let toolsChanged = false;

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

function writeJsonRpcResponse(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function sendToolsChangedNotification(): void {
  if (toolsChanged) {
    toolsChanged = false;
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed',
      }) + '\n',
    );
  }
}

async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const { method, params, id } = request;

  switch (method) {
    case 'initialize':
      tryStartDashboard();
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: SERVER_INFO,
          capabilities: CAPABILITIES,
        },
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: getToolList(appContext) } };

    case 'tools/call': {
      const toolName = String(params?.name ?? '');
      const rawArgs = params?.arguments;
      const toolArgs: Record<string, unknown> =
        typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};

      try {
        const result = await handleTool(toolName, toolArgs);

        if (toolName === 'registry_server') {
          toolsChanged = true;
        }
        if (toolName === 'registry' && toolArgs.action === 'uninstall') {
          toolsChanged = true;
        }

        const response: JsonRpcResponse = {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        };

        return response;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof RegistryError ? err.code : 'UNKNOWN_ERROR';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error [${code}]: ${message}` }],
            isError: true,
          },
        };
      }
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

const stdioReadline = createInterface({ input: process.stdin, terminal: false });

stdioReadline.on('line', (line: string) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    handleRequest(request)
      .then((response) => {
        if (response) {
          writeJsonRpcResponse(response);
          sendToolsChangedNotification();
        }
      })
      .catch((err) => {
        process.stderr.write(
          '[agent-discover] Handler error: ' +
            (err instanceof Error ? err.message : String(err)) +
            '\n',
        );
      });
  } catch (err) {
    process.stderr.write(
      '[agent-discover] JSON-RPC parse error: ' +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
    writeJsonRpcResponse({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }
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
