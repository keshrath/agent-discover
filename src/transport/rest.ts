// =============================================================================
// agent-discover — REST transport
//
// Lightweight HTTP API using only node:http. No framework dependencies.
// Serves both the JSON API and the static web UI.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { join, extname, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import type { AppContext } from '../context.js';
import { RegistryError, ValidationError } from '../types.js';
import { version } from '../version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export function createRouter(ctx: AppContext): (req: IncomingMessage, res: ServerResponse) => void {
  const routes: Route[] = [];
  const uiDir = join(__dirname, '..', 'ui');

  function route(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const pattern = path.replace(/:(\w+)/g, (_match, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    routes.push({
      method,
      pattern: new RegExp(`^${pattern}$`),
      paramNames,
      handler,
    });
  }

  function json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(data));
  }

  const MAX_BODY_SIZE = 131_072; // 128KB

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      req.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
          req.destroy();
          reject(new ValidationError('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString();
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new ValidationError('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  const startTime = Date.now();

  // -----------------------------------------------------------------------
  // API routes
  // -----------------------------------------------------------------------

  route('GET', '/health', (_req, res) => {
    json(res, {
      status: 'ok',
      version,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  route('GET', '/api/servers', (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const query = url.searchParams.get('query') ?? undefined;
    const source = url.searchParams.get('source') ?? undefined;
    const installed = url.searchParams.get('installed');

    const servers = ctx.registry.list({
      query,
      source,
      installedOnly: installed === 'true',
    });

    const result = servers.map((s) => ({
      ...s,
      active: ctx.proxy.isActive(s.name),
    }));

    json(res, result);
  });

  route('GET', '/api/servers/:id', (_req, res, params) => {
    const id = parseInt(params.id, 10);
    const server = ctx.registry.getById(id);
    if (!server) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    const tools = ctx.registry.getTools(server.id);
    json(res, {
      ...server,
      active: ctx.proxy.isActive(server.name),
      tools,
    });
  });

  route('POST', '/api/servers', async (req, res) => {
    const body = await readBody(req);
    const transport = typeof body.transport === 'string' ? body.transport : undefined;
    const homepage = typeof body.homepage === 'string' ? body.homepage : undefined;
    const server = ctx.registry.register({
      name: String(body.name ?? ''),
      description: body.description ? String(body.description) : undefined,
      command: body.command ? String(body.command) : undefined,
      args: Array.isArray(body.args) ? (body.args as string[]) : undefined,
      env: typeof body.env === 'object' ? (body.env as Record<string, string>) : undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
      source:
        typeof body.source === 'string'
          ? (body.source as 'local' | 'registry' | 'smithery' | 'manual')
          : undefined,
      transport: transport as 'stdio' | 'sse' | 'streamable-http' | undefined,
      homepage,
    });

    // Async pre-download for npx-based servers
    if (server.command === 'npx' && server.args && server.args.length > 0) {
      const pkgName = server.args.find((a: string) => a !== '-y') ?? server.args[0];
      if (pkgName) {
        execFile('npm', ['cache', 'add', pkgName], { timeout: 120_000 }, () => {
          /* fire and forget */
        });
      }
    }

    json(res, server, 201);
  });

  route('POST', '/api/servers/:id/preinstall', async (_req, res, params) => {
    const id = parseInt(params.id, 10);
    const server = ctx.registry.getById(id);
    if (!server) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    if (server.command !== 'npx' || !server.args || server.args.length === 0) {
      json(res, { status: 'skipped', reason: 'not an npx server' });
      return;
    }
    const pkgName = server.args.find((a) => a !== '-y') ?? server.args[0];
    if (!pkgName) {
      json(res, { status: 'skipped', reason: 'no package name found' });
      return;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('npm', ['cache', 'add', pkgName], { timeout: 120_000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      json(res, { status: 'downloaded', package: pkgName });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, { status: 'failed', error: message }, 500);
    }
  });

  route('DELETE', '/api/servers/:id', async (_req, res, params) => {
    const id = parseInt(params.id, 10);
    const server = ctx.registry.getById(id);
    if (!server) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    if (ctx.proxy.isActive(server.name)) {
      await ctx.proxy.deactivate(server.name);
      ctx.registry.setActive(server.name, false);
    }
    ctx.registry.unregister(server.name);
    json(res, { status: 'deleted' });
  });

  route('POST', '/api/servers/:id/activate', async (_req, res, params) => {
    const id = parseInt(params.id, 10);
    const server = ctx.registry.getById(id);
    if (!server) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    const isRemote = server.transport === 'sse' || server.transport === 'streamable-http';
    if (!isRemote && !server.command) {
      json(res, { error: 'No command configured' }, 400);
      return;
    }
    if (ctx.proxy.isActive(server.name)) {
      json(res, { status: 'already_active' });
      return;
    }

    let tools;
    try {
      tools = await ctx.proxy.activate({
        name: server.name,
        command: server.command ?? undefined,
        args: server.args,
        env: server.env,
        transport: server.transport,
        url: server.homepage ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.registry.incrementErrorCount(server.id);
      json(res, { error: message }, 500);
      return;
    }

    ctx.registry.setActive(server.name, true);
    ctx.registry.saveTools(
      server.id,
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      })),
    );

    ctx.events.emit('server:activated', {
      name: server.name,
      tool_count: tools.length,
    });
    json(res, { status: 'activated', tool_count: tools.length });
  });

  route('POST', '/api/servers/:id/deactivate', async (_req, res, params) => {
    const id = parseInt(params.id, 10);
    const server = ctx.registry.getById(id);
    if (!server) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    if (!ctx.proxy.isActive(server.name)) {
      json(res, { status: 'not_active' });
      return;
    }

    await ctx.proxy.deactivate(server.name);
    ctx.registry.setActive(server.name, false);
    ctx.registry.clearTools(server.id);
    ctx.events.emit('server:deactivated', { name: server.name });
    json(res, { status: 'deactivated' });
  });

  route('GET', '/api/browse', async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const query = url.searchParams.get('query') ?? undefined;
    const limit = Math.max(
      1,
      Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 100),
    );
    const cursor = url.searchParams.get('cursor') ?? undefined;

    const result = await ctx.marketplace.browse(query, limit, cursor);
    json(res, result);
  });

  route('PUT', '/api/servers/:id', async (req, res, params) => {
    const id = parseInt(params.id, 10);
    const server = ctx.registry.getById(id);
    if (!server) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    const body = await readBody(req);
    const updated = ctx.registry.updateById(id, {
      description: typeof body.description === 'string' ? body.description : undefined,
      command: typeof body.command === 'string' ? body.command : undefined,
      args: Array.isArray(body.args) ? (body.args as string[]) : undefined,
      env: typeof body.env === 'object' ? (body.env as Record<string, string>) : undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
    });
    json(res, updated);
  });

  route('GET', '/api/servers/:id/secrets', (_req, res, params) => {
    const id = parseInt(params.id, 10);
    const server = ctx.registry.getById(id);
    if (!server) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    const secrets = ctx.secrets.list(id);
    json(res, secrets);
  });

  route('PUT', '/api/servers/:id/secrets/:key', async (req, res, params) => {
    const id = parseInt(params.id, 10);
    const server = ctx.registry.getById(id);
    if (!server) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    const body = await readBody(req);
    const value = typeof body.value === 'string' ? body.value : '';
    if (!value) {
      json(res, { error: 'value is required' }, 422);
      return;
    }
    ctx.secrets.set(id, params.key, value);
    json(res, { status: 'set', key: params.key });
  });

  route('DELETE', '/api/servers/:id/secrets/:key', (_req, res, params) => {
    const id = parseInt(params.id, 10);
    const server = ctx.registry.getById(id);
    if (!server) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    ctx.secrets.delete(id, params.key);
    json(res, { status: 'deleted', key: params.key });
  });

  route('POST', '/api/servers/:id/health', async (_req, res, params) => {
    const id = parseInt(params.id, 10);
    const server = ctx.registry.getById(id);
    if (!server) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    const result = await ctx.health.checkServer(id);
    json(res, result);
  });

  route('GET', '/api/servers/:id/metrics', (_req, res, params) => {
    const id = parseInt(params.id, 10);
    const server = ctx.registry.getById(id);
    if (!server) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    const metrics = ctx.metrics.getServerMetrics(id);
    json(res, metrics);
  });

  route('GET', '/api/metrics', (_req, res) => {
    const overview = ctx.metrics.getOverview();
    json(res, overview);
  });

  route('GET', '/api/npm-check', async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pkg = url.searchParams.get('package') ?? '';
    if (!pkg) {
      json(res, { error: 'package query parameter is required' }, 400);
      return;
    }
    try {
      const npmUrl = pkg.startsWith('@')
        ? `https://registry.npmjs.org/${pkg.replace('/', '%2F')}`
        : `https://registry.npmjs.org/${encodeURIComponent(pkg)}`;
      const response = await fetch(npmUrl);
      json(res, { exists: response.ok });
    } catch {
      json(res, { exists: false });
    }
  });

  route('GET', '/api/status', (_req, res) => {
    const activeNames = ctx.proxy.getActiveServerNames();
    const servers = activeNames.map((name) => {
      const tools = ctx.proxy.getServerTools(name);
      return {
        name,
        tool_count: tools.length,
        tools: tools.map((t) => t.name),
      };
    });
    json(res, { active_count: servers.length, servers });
  });

  // -----------------------------------------------------------------------
  // Router dispatch
  // -----------------------------------------------------------------------

  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = pathname.match(r.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });

      Promise.resolve()
        .then(() => r.handler(req, res, params))
        .catch((err) => {
          const status = err instanceof RegistryError ? err.statusCode : 500;
          const message = err instanceof Error ? err.message : String(err);
          json(res, { error: message }, status);
        });
      return;
    }

    if (req.method === 'GET') {
      const filePath = pathname === '/' ? '/index.html' : pathname;
      const ext = extname(filePath);
      const mime = MIME_TYPES[ext];

      if (mime) {
        try {
          const resolved = resolve(join(uiDir, filePath));
          if (!resolved.startsWith(resolve(uiDir))) {
            json(res, { error: 'Forbidden' }, 403);
            return;
          }
          const content = readFileSync(resolved);
          res.writeHead(200, { 'Content-Type': mime });
          res.end(content);
          return;
        } catch {
          // Fall through to 404
        }
      }
    }

    json(res, { error: 'Not found' }, 404);
  };
}
