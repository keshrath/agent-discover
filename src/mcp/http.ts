// =============================================================================
// agent-discover — MCP Streamable HTTP endpoint (/mcp)
//
// Two legs behind one URL:
//   - modern (2026-07-28): `createMcpHandler` with legacy:'reject', a fresh
//     Server per request; list_changed reaches clients through their
//     `subscriptions/listen` streams via `handler.notify.toolsChanged()`.
//   - legacy (2025-06-18 / 2025-11-25): a sessionful
//     NodeStreamableHTTPServerTransport per client, so 2025 clients keep the
//     standalone GET stream (list_changed) and server→client elicitation
//     (the SDK's MRTR legacy shim). A session with no open response (no
//     GET stream, no request in flight) idle longer than `sessionIdleMs` is
//     closed; its client gets 404 and re-initializes.
// Host/Origin/Content-Type are enforced by the daemon's request guard
// before a request reaches this module.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpHandler, isLegacyRequest, type Server } from '@modelcontextprotocol/server';
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from '@modelcontextprotocol/node';
import type { McpFactory } from './server.js';

interface LegacySession {
  transport: NodeStreamableHTTPServerTransport;
  server: Server;
  /** Responses currently open (the GET stream, requests in flight). */
  open: number;
  lastSeen: number;
}

export interface McpEndpoint {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Fan tools/list_changed out to every connected client of both eras. */
  notifyToolsChanged(): void;
  /** Open legacy sessions (for status / idle accounting). */
  sessionCount(): number;
  close(): Promise<void>;
}

function log(err: unknown): void {
  process.stderr.write(
    `[agent-discover] mcp: ${err instanceof Error ? err.message : String(err)}\n`,
  );
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }));
}

export function createMcpEndpoint(factory: McpFactory, sessionIdleMs: number): McpEndpoint {
  const modern = createMcpHandler(() => factory.build(), { legacy: 'reject', onerror: log });
  const modernNode = toNodeHandler(modern, { onerror: log });
  const sessions = new Map<string, LegacySession>();

  async function legacy(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const sid = req.headers['mcp-session-id'];
    let session = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (!session) {
      if (typeof sid === 'string') {
        return jsonRpcError(res, 404, -32001, 'Session not found');
      }
      const server = factory.build();
      const transport: NodeStreamableHTTPServerTransport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void sessions.set(id, session!),
        onsessionclosed: (id) => void sessions.delete(id),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      session = { transport, server, open: 0, lastSeen: Date.now() };
      await server.connect(transport);
    }
    const s = session;
    s.open++;
    res.on('close', () => {
      s.open--;
      s.lastSeen = Date.now();
    });
    await s.transport.handleRequest(req, res, body);
  }

  const sweeper = sessionIdleMs
    ? setInterval(
        () => {
          const cutoff = Date.now() - sessionIdleMs;
          for (const s of sessions.values()) {
            if (s.open === 0 && s.lastSeen < cutoff) void s.transport.close().catch(() => {});
          }
        },
        Math.max(250, Math.min(60_000, Math.floor(sessionIdleMs / 4))),
      )
    : undefined;
  sweeper?.unref();

  return {
    async handle(req, res) {
      const probe = await toWebRequest(req);
      let body: unknown;
      if (req.method === 'POST') {
        const raw = await probe.clone().text();
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          return jsonRpcError(res, 400, -32700, 'Parse error');
        }
      }
      if (await isLegacyRequest(probe, body)) return legacy(req, res, body);
      await modernNode(req, res, body);
    },
    notifyToolsChanged() {
      modern.notify.toolsChanged();
      for (const { server } of sessions.values()) {
        server.sendToolListChanged().catch(() => {});
      }
    },
    sessionCount: () => sessions.size,
    async close() {
      clearInterval(sweeper);
      await Promise.all([...sessions.values()].map((s) => s.transport.close().catch(() => {})));
      sessions.clear();
      await modern.close();
    },
  };
}
