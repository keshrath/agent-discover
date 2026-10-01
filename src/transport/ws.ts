// =============================================================================
// agent-discover — WebSocket transport (/ws, dashboard live updates)
//
// The daemon is the only writer, so state is pushed on lifecycle events
// (debounced) instead of polling the DB. Messages:
//   server → client: {type:'state', version, servers, mode}, log_entry,
//                    notification, progress, elicitation_request
//   client → server: {type:'refresh'}
// Upgrades are admitted only when the request guard accepts Host + Origin.
// =============================================================================

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { AppContext } from '../context.js';
import type { RequestGuard } from './guard.js';
import { version } from '../version.js';

const MAX_CLIENTS = 50;
const PING_MS = 30_000;
const DEBOUNCE_MS = 100;

export interface WebSocketHandle {
  clientCount(): number;
  close(): void;
}

function statePayload(ctx: AppContext): string {
  const pool = ctx.lifecycle.pool;
  const servers = ctx.servers.list().map((s) => ({
    ...s,
    connected: pool.isConnected(s.name),
    tools: ctx.index.list(s.id),
  }));
  return JSON.stringify({ type: 'state', version, mode: ctx.config.mode, servers });
}

export function setupWebSocket(
  httpServer: Server,
  ctx: AppContext,
  guard: RequestGuard,
): WebSocketHandle {
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: 4096,
    verifyClient: ({ req }: { req: { headers: Record<string, string | string[] | undefined> } }) =>
      guard.checkHost(req.headers.host as string | undefined) &&
      guard.checkOrigin(req.headers.origin as string | undefined),
  });
  const alive = new WeakMap<WebSocket, boolean>();

  const broadcast = (message: string) => {
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(message);
  };

  wss.on('connection', (ws) => {
    if (wss.clients.size > MAX_CLIENTS) return ws.close(1013, 'Too many connections');
    alive.set(ws, true);
    ws.send(statePayload(ctx));
    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (raw) => {
      let msg: { type?: unknown } | null = null;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        /* reported below */
      }
      if (msg?.type === 'refresh') ws.send(statePayload(ctx));
      else ws.send(JSON.stringify({ type: 'error', message: 'Unknown message' }));
    });
  });
  wss.on('error', (err) => process.stderr.write(`[agent-discover] WS error: ${err.message}\n`));

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, PING_MS);
  ping.unref();

  let pending: NodeJS.Timeout | null = null;
  const unsubscribe = ctx.lifecycle.onChange(() => {
    if (pending || wss.clients.size === 0) return;
    pending = setTimeout(() => {
      pending = null;
      broadcast(statePayload(ctx));
    }, DEBOUNCE_MS);
  });

  ctx.lifecycle.pool.elicitationListener = (p) =>
    broadcast(
      JSON.stringify({
        type: 'elicitation_request',
        id: p.id,
        serverName: p.serverName,
        message: p.message,
        requestedSchema: p.requestedSchema,
        ts: new Date(p.createdAt).toISOString(),
      }),
    );

  ctx.logs.onEntry = (entry) => {
    broadcast(JSON.stringify({ type: 'log_entry', entry }));
    if (entry.kind === 'notification') {
      broadcast(
        JSON.stringify({
          type: 'notification',
          serverName: entry.server,
          method: entry.tool,
          params: entry.args,
          ts: entry.timestamp,
        }),
      );
    } else if (entry.kind === 'progress') {
      broadcast(
        JSON.stringify({
          type: 'progress',
          serverName: entry.server,
          payload: entry.args,
          ts: entry.timestamp,
        }),
      );
    }
  };

  return {
    clientCount: () => wss.clients.size,
    close() {
      clearInterval(ping);
      if (pending) clearTimeout(pending);
      unsubscribe();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
