// =============================================================================
// agent-discover — Minimal HTTP helpers (JSON responses, JSON bodies, static
// files, a :param router). node:http only.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { RegistryError, ValidationError } from '../types.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

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

/** Serve a file from `baseDir`; refuses traversal and symlinks escaping it. */
export async function serveStatic(
  res: ServerResponse,
  baseDir: string,
  pathname: string,
): Promise<void> {
  const root = resolve(baseDir);
  try {
    const target = await realpath(join(root, decodeURIComponent(pathname)));
    if (!target.startsWith(root + sep)) throw new Error('outside root');
    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch {
    json(res, { error: 'Not found' }, 404);
  }
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
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        try {
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
