// =============================================================================
// agent-discover — Minimal HTTP helpers (JSON responses, JSON bodies, a
// :param router). node:http only.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'node:http';
import { RegistryError, ValidationError } from '../types.js';

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

/** Read a JSON object body (empty body → {}). */
export async function readJson(
  req: IncomingMessage,
  maxBytes = 131_072,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes)
      throw new RegistryError('Request body too large', 'PAYLOAD_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('Body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

export interface Router {
  route(method: string, path: string, handler: RouteHandler): void;
  /** Dispatch; false when no route matched. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new ValidationError(`Malformed URL escape in "${raw}"`);
  }
}

export function createRouter(): Router {
  const routes: Array<{ method: string; pattern: RegExp; names: string[]; handler: RouteHandler }> =
    [];
  return {
    route(method, path, handler) {
      const names: string[] = [];
      const pattern = new RegExp(
        `^${path.replace(/:(\w+)/g, (_m, n: string) => {
          names.push(n);
          return '([^/]+)';
        })}$`,
      );
      routes.push({ method, pattern, names, handler });
    },
    async handle(req, res) {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(pathname);
        if (!m) continue;
        try {
          const params = Object.fromEntries(r.names.map((n, i) => [n, decodeParam(m[i + 1])]));
          await r.handler(req, res, params);
        } catch (err) {
          if (err instanceof RegistryError) {
            json(res, { error: err.message, code: err.code }, err.statusCode);
          } else {
            process.stderr.write(`[agent-discover] REST handler error: ${String(err)}\n`);
            json(res, { error: 'Internal server error' }, 500);
          }
        }
        return true;
      }
      return false;
    },
  };
}
