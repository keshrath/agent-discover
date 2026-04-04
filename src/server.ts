#!/usr/bin/env node

// =============================================================================
// agent-discover — HTTP + WebSocket server entry point
//
// Standalone web server for the dashboard UI and REST API.
// Can be started manually: node dist/server.js [--port 3424]
// Or auto-started from the MCP server via leader election.
// =============================================================================

import { createServer, type Server } from 'http';
import { createContext, type AppContext } from './context.js';
import { createRouter } from './transport/rest.js';
import { setupWebSocket, type WebSocketHandle } from './transport/ws.js';
import type { DbOptions } from './storage/database.js';

export interface DashboardServer {
  httpServer: Server;
  port: number;
  close(): void;
}

/** Returns the argv element immediately after `flag`, or `undefined` if missing. */
function getCliArgAfterFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

export function startDashboard(ctx: AppContext, port = 3424): Promise<DashboardServer> {
  return new Promise((resolve, reject) => {
    const router = createRouter(ctx);
    const httpServer = createServer(router);

    let wsHandle: WebSocketHandle | null = null;

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} in use`));
      } else {
        reject(err);
      }
    });

    httpServer.listen(port, () => {
      wsHandle = setupWebSocket(httpServer, ctx);
      process.stderr.write(`agent-discover dashboard: http://localhost:${port}\n`);
      resolve({
        httpServer,
        port,
        close() {
          if (wsHandle) wsHandle.close();
          httpServer.close();
        },
      });
    });
  });
}

if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  const port = parseInt(
    getCliArgAfterFlag(process.argv, '--port') ?? process.env.AGENT_DISCOVER_PORT ?? '3424',
    10,
  );
  const dbPath = getCliArgAfterFlag(process.argv, '--db');
  const dbOptions: DbOptions = dbPath ? { path: dbPath } : {};

  const ctx = createContext(dbOptions);
  startDashboard(ctx, port)
    .then((dashboardServer) => {
      process.on('SIGINT', () => {
        dashboardServer.close();
        ctx.close();
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        dashboardServer.close();
        ctx.close();
        process.exit(0);
      });
    })
    .catch((err) => {
      process.stderr.write(`Failed to start dashboard: ${err.message}\n`);
      process.exit(1);
    });
}
