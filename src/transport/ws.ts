// =============================================================================
// agent-discover — WebSocket transport
//
// Thin wrapper around agent-common's setupWebSocket. Streams full state with
// a single fingerprint (servers+active count). Both categories return the
// full payload so any DB change refreshes all connected clients.
// =============================================================================

import { setupWebSocket as setupKitWebSocket, type WsHandle } from 'agent-common';
import type { Server } from 'http';
import type { AppContext } from '../context.js';
import { version } from '../version.js';

export type WebSocketHandle = WsHandle;

export function setupWebSocket(httpServer: Server, ctx: AppContext): WebSocketHandle {
  return setupKitWebSocket({
    httpServer,
    getFingerprints: () => {
      const row = ctx.db.queryOne<{ fp: string }>(
        `SELECT
           COALESCE((SELECT COUNT(*) FROM servers), 0)
           || ':' || COALESCE((SELECT MAX(id) FROM servers), 0)
           || ':' || COALESCE((SELECT MAX(updated_at) FROM servers), '')
           || ':' || COALESCE((SELECT COUNT(*) FROM server_tools), 0)
         AS fp`,
      );
      const active = ctx.proxy.getActiveServerNames().length;
      return { registry: (row?.fp ?? '') + ':' + active };
    },
    getCategoryData: () => buildStatePayload(ctx),
    getFullState: () => ({ version, ...buildStatePayload(ctx) }),
    logError: (err) =>
      process.stderr.write(
        '[agent-discover] WS error: ' + (err instanceof Error ? err.message : String(err)) + '\n',
      ),
  });
}

function buildStatePayload(ctx: AppContext): Record<string, unknown> {
  const servers = ctx.registry.list();
  const serversWithStatus = servers.map((s) => ({
    ...s,
    active: ctx.proxy.isActive(s.name),
    tools: ctx.registry.getTools(s.id),
  }));

  const activeNames = ctx.proxy.getActiveServerNames();
  const active = activeNames.map((name) => ({
    name,
    tools: ctx.proxy.getServerTools(name),
  }));

  return { servers: serversWithStatus, active };
}
