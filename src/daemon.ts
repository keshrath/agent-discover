// =============================================================================
// agent-discover — Daemon
//
// The single long-running process (SPEC §1): one node:http server on
// 127.0.0.1:<port> serving the dashboard, REST /api/*, WebSocket and MCP
// Streamable HTTP at /mcp. Every host connects here (directly over HTTP or
// through the stdio shim), so proxy/connection state has one owner.
//
// Exits after `idleMs` with no open HTTP exchanges (MCP streams, SSE) and no
// WebSocket clients.
// =============================================================================

import { createServer, type Server } from 'node:http';
import { localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { createContext, type AppContext, type ContextOptions } from './context.js';
import { createMcpFactory } from './mcp/server.js';
import { createMcpEndpoint, type McpEndpoint } from './mcp/http.js';
import { createRestHandler } from './transport/rest.js';
import { createRequestGuard } from './transport/guard.js';
import { setupWebSocket } from './transport/ws.js';
import { createRestToken } from './transport/token.js';
import { loadTelemetry } from './domain/trust/telemetry.js';
import { version } from './version.js';

export interface Daemon {
  readonly ctx: AppContext;
  readonly httpServer: Server;
  readonly mcp: McpEndpoint;
  readonly port: number;
  /** Per-launch token required on state-changing /api requests. */
  readonly restToken: string;
  close(): Promise<void>;
}

export interface DaemonOptions extends ContextOptions {
  /** Skip setup-file sync and background indexing (tests). */
  skipStartupTasks?: boolean;
  /** Called when the idle timer fires (default: close + process.exit(0)). */
  onIdle?: (daemon: Daemon) => void;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const ctx = createContext({
    ...options,
    telemetry: options.telemetry ?? (await loadTelemetry(version)),
  });
  const { port, host, idleMs } = ctx.config;
  const mcpHost = localhostHostValidation();
  const mcpOrigin = localhostOriginValidation();
  const token = createRestToken();
  const rest = createRestHandler(ctx, token);

  let open = 0;
  let lastActivity = Date.now();
  const httpServer = createServer();
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  // The guard pins Host to the bound port, so requests are accepted only after listen.
  const boundPort = (httpServer.address() as { port: number }).port;
  const guard = createRequestGuard(boundPort, host);
  const mcp = createMcpEndpoint(createMcpFactory(ctx, `http://${host}:${boundPort}`));
  httpServer.on('request', (req, res) => {
    lastActivity = Date.now();
    open++;
    res.on('close', () => {
      open--;
      lastActivity = Date.now();
    });
    if (guard.handle(req, res)) return;
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/mcp' && (!mcpHost(req, res) || !mcpOrigin(req, res))) return;
    const handler = pathname === '/mcp' ? mcp.handle(req, res) : rest(req, res);
    handler.catch((err: unknown) => {
      process.stderr.write(`[agent-discover] request failed: ${String(err)}\n`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    });
  });
  const ws = setupWebSocket(httpServer, ctx, guard);
  const unsubscribe = ctx.lifecycle.onChange((e) => {
    if (e.type === 'tools') mcp.notifyToolsChanged();
  });

  let closing: Promise<void> | null = null;
  const daemon: Daemon = {
    ctx,
    httpServer,
    mcp,
    port: boundPort,
    restToken: token.value,
    close() {
      closing ??= (async () => {
        clearInterval(idleTimer);
        unsubscribe();
        ws.close();
        await mcp.close().catch(() => {});
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        await ctx.close();
      })();
      return closing;
    },
  };

  const idleTimer = setInterval(
    () => {
      if (!idleMs || open > 0 || ws.clientCount() > 0) return;
      if (Date.now() - lastActivity < idleMs) return;
      if (options.onIdle) options.onIdle(daemon);
      else void daemon.close().then(() => process.exit(0));
    },
    Math.max(1_000, Math.min(60_000, Math.floor(idleMs / 4) || 60_000)),
  );
  idleTimer.unref();

  if (!options.skipStartupTasks) {
    void ctx
      .syncSetup()
      .then(() => ctx.lifecycle.indexPending())
      .catch((err) =>
        process.stderr.write(`[agent-discover] startup tasks failed: ${String(err)}\n`),
      );
  }
  return daemon;
}
