// =============================================================================
// agent-discover — WebSocket transport
//
// Real-time state streaming to connected dashboard clients.
// Full state on connect, delta updates via DB polling.
// =============================================================================

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { AppContext } from '../context.js';
import { version } from '../version.js';

const MAX_WS_MESSAGE_SIZE = 4096;
const MAX_WS_CONNECTIONS = 50;
const PING_INTERVAL_MS = 30_000;
const DB_POLL_INTERVAL_MS = 2_000;

export interface WebSocketHandle {
  wss: WebSocketServer;
  close(): void;
}

interface ClientState {
  alive: boolean;
  fingerprint: string | null;
}

export function setupWebSocket(httpServer: Server, ctx: AppContext): WebSocketHandle {
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_WS_MESSAGE_SIZE,
  });
  const clients = new Map<WebSocket, ClientState>();

  wss.on('connection', (ws: WebSocket) => {
    if (wss.clients.size > MAX_WS_CONNECTIONS) {
      ws.close(1013, 'Too many connections');
      return;
    }

    clients.set(ws, { alive: true, fingerprint: null });
    sendFullState(ws, ctx, clients);

    ws.on('pong', () => {
      const clientState = clients.get(ws);
      if (clientState) clientState.alive = true;
    });

    ws.on('message', (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Message must be a JSON object',
          }),
        );
        return;
      }

      const msg = parsed as { type: string };

      if (msg.type === 'refresh') {
        const clientState = clients.get(ws);
        if (clientState) clientState.fingerprint = null;
        sendFullState(ws, ctx, clients);
      }
    });

    ws.on('error', () => clients.delete(ws));
    ws.on('close', () => clients.delete(ws));
  });

  const pingInterval = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  pingInterval.unref();

  const dbPollInterval = setInterval(() => {
    if (clients.size === 0) return;
    try {
      const fp = getFingerprint(ctx);
      for (const [ws, clientState] of clients) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (clientState.fingerprint !== fp) {
          sendFullState(ws, ctx, clients);
        }
      }
    } catch (err) {
      process.stderr.write(
        '[agent-discover] WS DB poll error: ' +
          (err instanceof Error ? err.message : String(err)) +
          '\n',
      );
    }
  }, DB_POLL_INTERVAL_MS);
  dbPollInterval.unref();

  return {
    wss,
    close() {
      clearInterval(pingInterval);
      clearInterval(dbPollInterval);
      for (const [ws] of clients) {
        ws.close(1001, 'Server shutting down');
      }
      clients.clear();
      wss.close();
    },
  };
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function getFingerprint(ctx: AppContext): string {
  const row = ctx.db.queryOne<{ fp: string }>(
    `SELECT
       COALESCE((SELECT COUNT(*) FROM servers), 0)
       || ':' || COALESCE((SELECT MAX(id) FROM servers), 0)
       || ':' || COALESCE((SELECT MAX(updated_at) FROM servers), '')
       || ':' || COALESCE((SELECT COUNT(*) FROM server_tools), 0)
     AS fp`,
  );
  const activeCount = ctx.proxy.getActiveServerNames().length;
  return (row?.fp ?? '') + ':' + activeCount;
}

function sendFullState(ws: WebSocket, ctx: AppContext, clients: Map<WebSocket, ClientState>): void {
  try {
    const fp = getFingerprint(ctx);
    const clientState = clients.get(ws);
    if (clientState) clientState.fingerprint = fp;

    const servers = ctx.registry.list();
    const serversWithStatus = servers.map((s) => ({
      ...s,
      active: ctx.proxy.isActive(s.name),
      tools: ctx.registry.getTools(s.id),
    }));

    const activeNames = ctx.proxy.getActiveServerNames();
    const activeServers = activeNames.map((name) => ({
      name,
      tools: ctx.proxy.getServerTools(name),
    }));

    ws.send(
      JSON.stringify({
        type: 'state',
        version,
        servers: serversWithStatus,
        active: activeServers,
      }),
    );
  } catch (err) {
    process.stderr.write(
      '[agent-discover] WS send error: ' +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
  }
}
