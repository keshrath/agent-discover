// =============================================================================
// agent-discover — Request guard (every HTTP request and WebSocket upgrade)
//
//   - Host must exactly equal one of the loopback names with the daemon's
//     port (localhost:P, 127.0.0.1:P, [::1]:P), plus the bound host when the
//     operator binds elsewhere. Defeats DNS rebinding.
//   - Origin, when present, must parse to http(s) with a loopback hostname
//     (`new URL().hostname`, so localhost.evil.com fails), or be exactly
//     `file://` (agent-desk's Electron renderer). `null` is rejected.
//   - Requests with a body on POST/PUT/PATCH/DELETE must be application/json,
//     so CORS-safelisted form posts never reach a handler.
//   - Allowed cross-origin callers get their Origin reflected; never `*`.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'node:http';

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const LOOPBACK_SET: ReadonlySet<string> = new Set(LOOPBACK);
const ELECTRON_FILE_ORIGIN = 'file://';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface RequestGuard {
  checkHost(host: string | undefined): boolean;
  checkOrigin(origin: string | undefined): boolean;
  /** Apply the policy; true when the request was answered (rejected / preflight). */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
}

function reject(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify({ error }));
}

export function createRequestGuard(port: number, bindHost = '127.0.0.1'): RequestGuard {
  const names = new Set(LOOPBACK);
  if (!['0.0.0.0', '::', '[::]'].includes(bindHost)) {
    names.add(bindHost.includes(':') && !bindHost.startsWith('[') ? `[${bindHost}]` : bindHost);
  }
  const hosts = new Set([...names].map((h) => `${h.toLowerCase()}:${port}`));

  const checkHost = (host: string | undefined) => !!host && hosts.has(host.toLowerCase());

  function checkOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    if (origin === ELECTRON_FILE_ORIGIN) return true;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.origin !== origin.toLowerCase()) return false; // no paths, credentials, trailing junk
    return LOOPBACK_SET.has(url.hostname);
  }

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    if (!checkHost(req.headers.host)) {
      reject(res, 403, 'Forbidden host');
      return true;
    }
    const origin = req.headers.origin;
    if (!checkOrigin(origin)) {
      reject(res, 403, 'Forbidden origin');
      return true;
    }
    if (origin !== undefined) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Discover-Token',
      });
      res.end();
      return true;
    }
    const length = req.headers['content-length'];
    const hasBody =
      (length !== undefined && length !== '0') || req.headers['transfer-encoding'] !== undefined;
    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (MUTATING.has(req.method ?? '') && hasBody && type !== 'application/json') {
      reject(res, 415, 'Content-Type must be application/json');
      return true;
    }
    return false;
  }

  return { checkHost, checkOrigin, handle };
}
