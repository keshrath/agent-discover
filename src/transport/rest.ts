// =============================================================================
// agent-discover — REST transport
//
// Lightweight HTTP API using only node:http. No framework dependencies.
// Serves both the JSON API and the static web UI.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile, spawn } from 'child_process';
import {
  json,
  readBody as kitReadBody,
  serveStatic,
  KitError,
  ValidationError as KitValidationError,
} from 'agent-common';
import type { AppContext } from '../context.js';
import { RegistryError, ValidationError } from '../types.js';
import { version } from '../version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    try {
      return await kitReadBody(req, 131_072);
    } catch (err) {
      if (err instanceof KitValidationError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }
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

    // Async pre-download
    if (server.command === 'npx' && server.args && server.args.length > 0) {
      const pkgName = server.args.find((a: string) => a !== '-y') ?? server.args[0];
      if (pkgName) {
        execFile('npm', ['cache', 'add', pkgName], { timeout: 120_000 }, () => {
          /* fire and forget */
        });
      }
    } else if (server.command === 'uvx' && server.args && server.args.length > 0) {
      const pkgName = server.args[0];
      if (pkgName) {
        // `uv tool install` warms uv's tool cache without running the package
        execFile('uv', ['tool', 'install', pkgName], { timeout: 180_000 }, () => {
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
    if (!server.args || server.args.length === 0) {
      json(res, { status: 'skipped', reason: 'no package name' });
      return;
    }

    let cmd: string;
    let cmdArgs: string[];
    let pkgName: string;
    if (server.command === 'npx') {
      pkgName = server.args.find((a) => a !== '-y') ?? server.args[0];
      cmd = 'npm';
      cmdArgs = ['cache', 'add', pkgName];
    } else if (server.command === 'uvx') {
      pkgName = server.args[0];
      cmd = 'uv';
      cmdArgs = ['tool', 'install', pkgName];
    } else {
      json(res, { status: 'skipped', reason: 'not an npx/uvx server' });
      return;
    }

    if (!pkgName) {
      json(res, { status: 'skipped', reason: 'no package name found' });
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(cmd, cmdArgs, { timeout: 180_000 }, (err) => {
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

  // Phase 3: prereqs probe — UI uses this to warn when npx/uvx/docker is
  // missing on the host before the user attempts an install. Uses `spawn`
  // with `shell: true` (instead of execFile) so Windows .cmd/.bat shims
  // (npx.cmd, uvx.cmd) are resolved without execFile's strict path lookup.
  route('GET', '/api/prereqs', async (_req, res) => {
    const probe = (cmd: string): Promise<boolean> =>
      new Promise((resolve) => {
        let done = false;
        const finish = (ok: boolean) => {
          if (done) return;
          done = true;
          resolve(ok);
        };
        try {
          const child = spawn(`${cmd} --version`, { shell: true, stdio: 'ignore' });
          const t = setTimeout(() => {
            try {
              child.kill();
            } catch {
              /* ignore */
            }
            finish(false);
          }, 5_000);
          child.on('exit', (code) => {
            clearTimeout(t);
            finish(code === 0);
          });
          child.on('error', () => {
            clearTimeout(t);
            finish(false);
          });
        } catch {
          finish(false);
        }
      });
    const [npx, uvx, docker, uv] = await Promise.all([
      probe('npx'),
      probe('uvx'),
      probe('docker'),
      probe('uv'),
    ]);
    json(res, { npx, uvx, docker, uv });
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

  route('POST', '/api/servers/:id/reset-errors', (_req, res, params) => {
    const id = parseInt(params.id, 10);
    const server = ctx.registry.getById(id);
    if (!server) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    ctx.registry.resetErrorCount(id);
    json(res, { status: 'reset' });
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

  route('GET', '/api/logs', (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 500);
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
    json(res, { entries: ctx.logs.list(limit, offset), total: ctx.logs.count() });
  });

  route('DELETE', '/api/logs', (_req, res) => {
    ctx.logs.clear();
    json(res, { status: 'cleared' });
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

  route('POST', '/api/servers/:id/call', async (req, res, params) => {
    const id = parseInt(params.id, 10);
    const server = ctx.registry.getById(id);
    if (!server) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    if (!ctx.proxy.isActive(server.name)) {
      json(res, { error: 'Server not active' }, 400);
      return;
    }
    const body = await readBody(req);
    const tool = String(body.tool ?? '');
    const args = typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {};
    if (!tool) {
      json(res, { error: 'tool is required' }, 400);
      return;
    }
    try {
      const result = await ctx.proxy.callTool(server.name, tool, args);
      json(res, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, { error: message }, 500);
    }
  });

  route('POST', '/api/sync', async (_req, res) => {
    const result = await ctx.syncSetup();
    json(res, result);
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
  // Tester surface (MCP Inspector parity)
  // -----------------------------------------------------------------------

  function resolveServerName(params: Record<string, string>): string | null {
    if (params.id) {
      const server = ctx.registry.getById(parseInt(params.id, 10));
      return server ? server.name : null;
    }
    if (params.handle) {
      return ctx.proxy.resolveTransient(params.handle);
    }
    return null;
  }

  function isLoopback(req: IncomingMessage): boolean {
    const addr = req.socket?.remoteAddress ?? '';
    if (!addr) return true;
    return (
      addr === '127.0.0.1' ||
      addr === '::1' ||
      addr === '::ffff:127.0.0.1' ||
      addr.startsWith('127.')
    );
  }

  function validateOrigin(req: IncomingMessage, res: ServerResponse): boolean {
    if (process.env.AGENT_DISCOVER_ALLOW_REMOTE_TEST === '1') return true;
    if (!isLoopback(req)) {
      json(
        res,
        {
          error:
            'Tester API is localhost-only. Set AGENT_DISCOVER_ALLOW_REMOTE_TEST=1 to override.',
        },
        403,
      );
      return false;
    }
    const origin = req.headers.origin;
    if (origin) {
      const ok =
        origin.startsWith('http://localhost') ||
        origin.startsWith('http://127.0.0.1') ||
        origin.startsWith('http://[::1]') ||
        origin === 'null';
      if (!ok) {
        json(res, { error: 'Origin rejected (DNS rebinding protection)' }, 403);
        return false;
      }
    }
    return true;
  }

  const testerGet = (
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse, serverName: string) => Promise<void>,
  ): void => {
    route('GET', path, async (req, res, params) => {
      if (!validateOrigin(req, res)) return;
      const name = resolveServerName(params);
      if (!name) {
        json(res, { error: 'Server not found' }, 404);
        return;
      }
      if (!ctx.proxy.isActive(name)) {
        json(res, { error: 'Server not active' }, 400);
        return;
      }
      await handler(req, res, name);
    });
  };

  const testerPost = (
    path: string,
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
      serverName: string,
      body: Record<string, unknown>,
    ) => Promise<void>,
  ): void => {
    route('POST', path, async (req, res, params) => {
      if (!validateOrigin(req, res)) return;
      const name = resolveServerName(params);
      if (!name) {
        json(res, { error: 'Server not found' }, 404);
        return;
      }
      if (!ctx.proxy.isActive(name)) {
        json(res, { error: 'Server not active' }, 400);
        return;
      }
      const body = await readBody(req);
      await handler(req, res, name, body);
    });
  };

  for (const prefix of ['/api/servers/:id', '/api/transient/:handle'] as const) {
    testerGet(`${prefix}/info`, async (_req, res, name) => {
      const info = ctx.proxy.getServerInfo(name);
      json(res, info ?? { error: 'Server has no info' });
    });

    testerGet(`${prefix}/tools`, async (_req, res, name) => {
      const tools = await ctx.proxy.listToolsLive(name);
      json(res, { tools });
    });

    testerGet(`${prefix}/resources`, async (req, res, name) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const result = await ctx.proxy.listResources(name, cursor);
      json(res, result);
    });

    testerGet(`${prefix}/resource-templates`, async (req, res, name) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const result = await ctx.proxy.listResourceTemplates(name, cursor);
      json(res, result);
    });

    testerPost(`${prefix}/resource/read`, async (_req, res, name, body) => {
      const uri = String(body.uri ?? '');
      if (!uri) {
        json(res, { error: 'uri is required' }, 400);
        return;
      }
      const result = await ctx.proxy.readResource(name, uri);
      json(res, result);
    });

    testerPost(`${prefix}/resource/subscribe`, async (_req, res, name, body) => {
      const uri = String(body.uri ?? '');
      if (!uri) {
        json(res, { error: 'uri is required' }, 400);
        return;
      }
      await ctx.proxy.subscribeResource(name, uri);
      json(res, { ok: true });
    });

    testerPost(`${prefix}/resource/unsubscribe`, async (_req, res, name, body) => {
      const uri = String(body.uri ?? '');
      if (!uri) {
        json(res, { error: 'uri is required' }, 400);
        return;
      }
      await ctx.proxy.unsubscribeResource(name, uri);
      json(res, { ok: true });
    });

    testerGet(`${prefix}/prompts`, async (req, res, name) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const result = await ctx.proxy.listPrompts(name, cursor);
      json(res, result);
    });

    testerPost(`${prefix}/prompt/get`, async (_req, res, name, body) => {
      const promptName = String(body.name ?? '');
      if (!promptName) {
        json(res, { error: 'name is required' }, 400);
        return;
      }
      const args =
        typeof body.arguments === 'object' && body.arguments !== null
          ? (body.arguments as Record<string, string>)
          : {};
      const result = await ctx.proxy.getPrompt(name, promptName, args);
      json(res, result);
    });

    testerPost(`${prefix}/ping`, async (_req, res, name) => {
      const result = await ctx.proxy.ping(name);
      json(res, result);
    });

    testerPost(`${prefix}/logging-level`, async (_req, res, name, body) => {
      const level = String(body.level ?? '');
      const valid = [
        'debug',
        'info',
        'notice',
        'warning',
        'error',
        'critical',
        'alert',
        'emergency',
      ];
      if (!valid.includes(level)) {
        json(res, { error: `level must be one of: ${valid.join(', ')}` }, 400);
        return;
      }
      await ctx.proxy.setLoggingLevel(
        name,
        level as Parameters<typeof ctx.proxy.setLoggingLevel>[1],
      );
      json(res, { ok: true, level });
    });

    testerGet(`${prefix}/export`, async (req, res, name) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const format = (url.searchParams.get('format') ?? 'mcp-json') as
        | 'mcp-json'
        | 'agent-discover';
      const valid = ['mcp-json', 'agent-discover'];
      if (!valid.includes(format)) {
        json(res, { error: `format must be one of: ${valid.join(', ')}` }, 400);
        return;
      }
      const config = ctx.proxy.exportConfig(name, format);
      json(res, { format, config });
    });
  }

  // Transient server lifecycle
  route('POST', '/api/transient', async (req, res) => {
    if (!validateOrigin(req, res)) return;
    const body = await readBody(req);
    const command = typeof body.command === 'string' ? body.command : undefined;
    const url = typeof body.url === 'string' ? body.url : undefined;
    const transport = typeof body.transport === 'string' ? body.transport : 'stdio';
    if (transport === 'stdio') {
      if (!command) {
        json(res, { error: 'command is required for stdio transport' }, 400);
        return;
      }
      if (!/^[@a-zA-Z0-9._/\\:-]+$/.test(command)) {
        json(res, { error: 'command contains unsafe characters' }, 400);
        return;
      }
    } else if (!url) {
      json(res, { error: 'url is required for remote transports' }, 400);
      return;
    }
    const args = Array.isArray(body.args) ? (body.args as string[]) : [];
    const envCandidate = typeof body.env === 'object' ? (body.env as Record<string, string>) : {};
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(envCandidate)) {
      if (typeof v !== 'string') continue;
      if (/[\r\n]/.test(v)) continue;
      env[k] = v;
    }
    const headers =
      typeof body.headers === 'object' && body.headers !== null
        ? (body.headers as Record<string, string>)
        : undefined;
    const ttlMs = typeof body.ttl_ms === 'number' && body.ttl_ms > 0 ? body.ttl_ms : undefined;
    try {
      const handle = await ctx.proxy.activateTransient(
        {
          name: 'transient',
          command,
          args,
          env,
          transport: transport as 'stdio' | 'sse' | 'streamable-http',
          url,
          headers,
        },
        ttlMs,
      );
      json(res, handle, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, { error: message }, 500);
    }
  });

  route('DELETE', '/api/transient/:handle', async (req, res, params) => {
    if (!validateOrigin(req, res)) return;
    await ctx.proxy.releaseTransient(params.handle);
    json(res, { ok: true });
  });

  testerPost('/api/transient/:handle/call', async (_req, res, name, body) => {
    const tool = String(body.tool ?? '');
    const args = typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {};
    if (!tool) {
      json(res, { error: 'tool is required' }, 400);
      return;
    }
    const result = await ctx.proxy.callTool(name, tool, args);
    json(res, result);
  });

  // Logs filtered by kind
  route('GET', '/api/logs/notifications', (_req, res) => {
    const entries = ctx.logs.list(200, 0, 'notification');
    json(res, { entries });
  });

  route('GET', '/api/logs/progress', (_req, res) => {
    const entries = ctx.logs.list(200, 0, 'progress');
    json(res, { entries });
  });

  // -----------------------------------------------------------------------
  // Test-panel presets (SQLite-backed)
  // -----------------------------------------------------------------------

  route('GET', '/api/presets', (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const server = url.searchParams.get('server') ?? undefined;
    const kindRaw = url.searchParams.get('kind') ?? undefined;
    const target = url.searchParams.get('target') ?? undefined;
    const kind = kindRaw === 'tool' || kindRaw === 'prompt' ? kindRaw : undefined;
    const entries = ctx.presets.list({ server, kind, target });
    json(res, { entries });
  });

  route('POST', '/api/presets', async (req, res) => {
    const body = await readBody(req);
    const server = String(body.server ?? '');
    const kind = String(body.kind ?? '');
    const target = String(body.target ?? '');
    const preset = String(body.preset ?? '');
    const payload = body.payload ?? {};
    if (kind !== 'tool' && kind !== 'prompt') {
      json(res, { error: 'kind must be "tool" or "prompt"' }, 400);
      return;
    }
    try {
      const entry = ctx.presets.upsert({
        server,
        kind: kind as 'tool' | 'prompt',
        target,
        preset,
        payload,
      });
      json(res, entry, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, { error: message }, 400);
    }
  });

  route('DELETE', '/api/presets/:id', (_req, res, params) => {
    const id = parseInt(params.id, 10);
    if (!Number.isFinite(id)) {
      json(res, { error: 'invalid id' }, 400);
      return;
    }
    const removed = ctx.presets.delete(id);
    json(res, { ok: removed });
  });

  // -----------------------------------------------------------------------
  // Elicitation — server → human round-trip
  // -----------------------------------------------------------------------

  route('GET', '/api/elicitations', (_req, res) => {
    const entries = ctx.proxy.listPendingElicitations();
    json(res, { entries });
  });

  route('POST', '/api/elicitations/:id/respond', async (req, res, params) => {
    if (!validateOrigin(req, res)) return;
    const body = await readBody(req);
    const action = String(body.action ?? '');
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
      json(res, { error: 'action must be accept / decline / cancel' }, 400);
      return;
    }
    const content =
      typeof body.content === 'object' && body.content !== null
        ? (body.content as Record<string, unknown>)
        : undefined;
    const ok = ctx.proxy.respondElicitation(params.id, {
      action: action as 'accept' | 'decline' | 'cancel',
      content,
    });
    if (!ok) {
      json(res, { error: 'Unknown elicitation id or already resolved' }, 404);
      return;
    }
    json(res, { ok: true });
  });

  // Roots config (client-advertised capability)
  route('GET', '/api/roots', (_req, res) => {
    const raw = process.env.AGENT_DISCOVER_ROOTS ?? '';
    const roots = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((uri) => ({ uri, name: uri }));
    json(res, { roots });
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
          let status = 500;
          if (err instanceof RegistryError) status = err.statusCode;
          else if (err instanceof KitError) status = err.statusCode;
          const message = err instanceof Error ? err.message : String(err);
          json(res, { error: message }, status);
        });
      return;
    }

    if (req.method === 'GET') {
      // Tester pop-out windows live at /tester/:id and /tester/transient/:handle.
      // Both paths serve the same minimal HTML shell which reads its context
      // from window.location.pathname.
      if (/^\/tester(\/|$)/.test(pathname)) {
        serveStatic(res, uiDir, '/tester-window.html', { spaFallback: false });
        return;
      }
      serveStatic(res, uiDir, pathname === '/' ? '/index.html' : pathname, {
        spaFallback: false,
      });
      return;
    }

    json(res, { error: 'Not found' }, 404);
  };
}
