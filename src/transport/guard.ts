// =============================================================================
// agent-discover — Request guard
//
// Local copy of agent-common 1.1.2's request guard (same API), used until
// that release is available; then this file is replaced by the import.
//
// Shared Host / Origin / Content-Type policy for every dashboard request and
// WebSocket upgrade:
//   - Host header must name a loopback host (or the explicitly bound host),
//     which defeats DNS rebinding.
//   - Origin, when present, must be loopback http(s), the same host the
//     request was sent to, the Electron renderer origin `file://`, or an
//     explicitly allowed origin. `null` and unparsable origins are rejected.
//   - State-changing requests with a body must be `application/json`, so
//     CORS-safelisted `text/plain` form posts never reach a handler.
//   - Allowed cross-origin callers get their Origin reflected (no wildcard).
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'http';

export const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::', '[::]']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HOST_HEADER_RE = /^[a-z0-9.\-[\]:]+$/i;

export interface RequestGuardOptions {
  /**
   * Address the server listens on (default `127.0.0.1`). A non-loopback
   * address adds itself to the accepted Host names; a wildcard address
   * (`0.0.0.0`, `::`) accepts any Host header.
   */
  bindHost?: string;
  /** Extra exact Origin values to accept (e.g. `https://my-tool.example`). */
  allowedOrigins?: string[];
}

export interface RequestGuard {
  /** True when the Host header names an accepted host. */
  checkHost(host: string | undefined): boolean;
  /** True when the Origin header is absent or accepted for a request sent to `host`. */
  checkOrigin(origin: string | undefined, host: string | undefined): boolean;
  /**
   * Apply the full policy to an HTTP request. Returns true when the request
   * was answered (rejected, or a CORS preflight) and must not reach a handler.
   */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
}

function hostnameOf(host: string | undefined): string | null {
  if (!host || !HOST_HEADER_RE.test(host)) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

function reject(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify({ error }));
}

function hasBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  return (length !== undefined && length !== '0') || req.headers['transfer-encoding'] !== undefined;
}

function isJson(req: IncomingMessage): boolean {
  const type = req.headers['content-type'];
  return typeof type === 'string' && type.split(';')[0].trim().toLowerCase() === 'application/json';
}

export function createRequestGuard(options: RequestGuardOptions = {}): RequestGuard {
  const bindHost = (options.bindHost ?? '127.0.0.1').toLowerCase();
  const anyHost = WILDCARD_BIND_HOSTS.has(bindHost);
  const allowedHosts = new Set(LOOPBACK_HOSTNAMES);
  if (!anyHost) allowedHosts.add(bindHost.includes(':') ? `[${bindHost}]` : bindHost);
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  function checkHost(host: string | undefined): boolean {
    const hostname = hostnameOf(host);
    if (hostname === null) return false;
    return anyHost || allowedHosts.has(hostname);
  }

  function checkOrigin(origin: string | undefined, host: string | undefined): boolean {
    if (origin === undefined) return true;
    if (origin === 'file://' || allowedOrigins.has(origin)) return true;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.origin !== origin.toLowerCase()) return false;
    return LOOPBACK_HOSTNAMES.has(url.hostname) || url.host === host?.toLowerCase();
  }

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (!checkHost(host)) {
      reject(res, 403, 'Forbidden host');
      return true;
    }
    if (!checkOrigin(origin, host)) {
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
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return true;
    }
    if (MUTATING_METHODS.has(req.method ?? '') && hasBody(req) && !isJson(req)) {
      reject(res, 415, 'Content-Type must be application/json');
      return true;
    }
    return false;
  }

  return { checkHost, checkOrigin, handle };
}
