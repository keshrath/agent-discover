// =============================================================================
// agent-discover — REST transport
//
// Thin adapter over the domain services for the dashboard (and any local
// tooling). Every server state change goes through ServerLifecycle, so REST
// and MCP behave identically. Host/Origin/Content-Type are enforced by the
// daemon's request guard before routing; state-changing /api requests also
// need the per-launch token (transport/token.ts).
//
// Endpoints are documented in docs/API.md.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRouter, json, readJson, serveStatic } from './http.js';
import type { Client } from '@modelcontextprotocol/client';
import type { AppContext } from '../context.js';
import { configuredRoots } from '../context.js';
import type { ServerEntry, ServerInput, ServerTransport, ServerUpdate } from '../types.js';
import { NotFoundError, RegistryError, UpstreamError, ValidationError } from '../types.js';
import { isCommandOnPath, type ElicitationContent } from '../domain/pool.js';
import { maskEnv, restoreMaskedEnv } from '../domain/secrets.js';
import type { PlanRequest } from '../domain/marketplace.js';
import { version } from '../version.js';
import { TOKEN_HEADER, mayReadToken, type RestToken } from './token.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 131_072;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}
function strMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );
}

function serverFields(body: Record<string, unknown>): ServerUpdate {
  return {
    description: str(body.description),
    transport: str(body.transport) as ServerTransport | undefined,
    command: str(body.command),
    args: strArray(body.args),
    env: strMap(body.env),
    url: str(body.url),
    headers: strMap(body.headers),
    tags: strArray(body.tags),
    package_name: str(body.package_name),
    package_version: str(body.package_version),
    repository: str(body.repository),
    homepage: str(body.homepage),
  };
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function page(res: ServerResponse, status: number, title: string, text: string): void {
  const esc = (v: string) => v.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><h1>${esc(title)}</h1><p>${esc(text)}</p>`,
  );
}

export function createRestHandler(
  ctx: AppContext,
  token: RestToken,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const router = createRouter();
  const uiDir = join(__dirname, '..', 'ui');
  const startTime = Date.now();
  const { lifecycle, servers, index } = ctx;
  const pool = lifecycle.pool;

  // Env values are masked on the way out; a masked value sent back unchanged keeps the original.
  const view = (s: ServerEntry) => ({
    ...s,
    env: maskEnv(s.env),
    connected: pool.isConnected(s.name),
    tool_count: index.count(s.id),
  });
  const byId = (id: string): ServerEntry => {
    const server = servers.getById(parseInt(id, 10));
    if (!server) throw new NotFoundError('Server', id);
    return server;
  };
  const query = (req: IncomingMessage) => new URL(req.url ?? '/', 'http://localhost').searchParams;
  const body = (req: IncomingMessage) => readJson(req, BODY_LIMIT);
  const route = router.route;

  /** Run an upstream operation, surfacing its message as 502. */
  async function upstream<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RegistryError) throw err;
      throw new UpstreamError(err instanceof Error ? err.message : String(err), { cause: err });
    }
  }

  // -- health / status -------------------------------------------------------

  route('GET', '/api/health', (_req, res) => {
    json(res, {
      status: 'ok',
      version,
      pid: process.pid,
      mode: ctx.config.mode,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    });
  });

  route('GET', '/api/token', (req, res) => {
    if (!mayReadToken(req)) return json(res, { error: 'Forbidden origin', code: 'FORBIDDEN' }, 403);
    json(res, { token: token.value, header: TOKEN_HEADER });
  });

  route('GET', '/api/status', (_req, res) => {
    json(res, { mode: ctx.config.mode, servers: lifecycle.status() });
  });

  // -- servers ---------------------------------------------------------------

  route('GET', '/api/servers', (req, res) => {
    const q = query(req);
    json(
      res,
      servers
        .list({ query: q.get('query') ?? undefined, source: q.get('source') ?? undefined })
        .map(view),
    );
  });

  route('GET', '/api/servers/:id', (_req, res, p) => {
    const server = byId(p.id);
    json(res, { ...view(server), tools: index.list(server.id) });
  });

  route('POST', '/api/servers', async (req, res) => {
    const b = await body(req);
    const input: ServerInput = {
      ...serverFields(b),
      name: str(b.name) ?? '',
      source: (str(b.source) as ServerInput['source']) ?? 'manual',
    };
    const { server, index_error } = await lifecycle.install(input, { enable: b.enabled === true });
    json(res, { ...view(server), ...(index_error ? { index_error } : {}) }, 201);
  });

  route('PUT', '/api/servers/:id', async (req, res, p) => {
    const server = byId(p.id);
    const fields = serverFields(await body(req));
    if (fields.env) fields.env = restoreMaskedEnv(fields.env, server.env);
    json(res, view(await lifecycle.update(server.name, fields)));
  });

  route('DELETE', '/api/servers/:id', async (_req, res, p) => {
    await lifecycle.uninstall(byId(p.id).name);
    json(res, { status: 'deleted' });
  });

  route('POST', '/api/servers/:id/enable', async (_req, res, p) => {
    const server = await upstream(() => lifecycle.enable(byId(p.id).name));
    json(res, view(server));
  });

  route('POST', '/api/servers/:id/disable', async (_req, res, p) => {
    json(res, view(await lifecycle.disable(byId(p.id).name)));
  });

  // -- trust: drift review + re-approval, audit log -------------------------

  route('GET', '/api/servers/:id/trust', (_req, res, p) => {
    const server = byId(p.id);
    json(res, { name: server.name, quarantined: server.quarantined, ...ctx.trust.inspect(server) });
  });

  route('POST', '/api/servers/:id/approve', async (req, res, p) => {
    const hashes = strArray((await body(req)).hashes);
    if (!hashes) throw new ValidationError('hashes (the reviewed tool hash set) is required');
    json(res, view(lifecycle.approve(byId(p.id).name, hashes)));
  });

  route('GET', '/api/audit', (req, res) => {
    const q = query(req);
    const num = (k: string) => {
      const n = parseInt(q.get(k) ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    json(
      res,
      ctx.trust.audit.list({
        limit: num('limit'),
        before: num('before'),
        server: q.get('server') ?? undefined,
        action: q.get('action') ?? undefined,
        tool: q.get('tool') ?? undefined,
      }),
    );
  });

  route('POST', '/api/servers/:id/index', async (_req, res, p) => {
    json(res, await upstream(() => lifecycle.reindex(byId(p.id).name)));
  });

  route('POST', '/api/servers/:id/health', async (_req, res, p) => {
    json(res, await lifecycle.health(byId(p.id).name));
  });

  route('POST', '/api/servers/:id/reset-errors', (_req, res, p) => {
    lifecycle.resetErrors(byId(p.id).name);
    json(res, { status: 'reset' });
  });

  route('POST', '/api/servers/:id/call', async (req, res, p) => {
    const server = byId(p.id);
    const b = await body(req);
    const tool = str(b.tool);
    if (!tool) throw new ValidationError('tool is required');
    const args = (b.args && typeof b.args === 'object' ? b.args : {}) as Record<string, unknown>;
    json(res, await upstream(() => lifecycle.callTool(server.name, tool, args)));
  });

  // -- secrets / metrics -----------------------------------------------------

  route('GET', '/api/servers/:id/secrets', (_req, res, p) => {
    json(res, ctx.secrets.list(byId(p.id)));
  });

  route('PUT', '/api/servers/:id/secrets/:key', async (req, res, p) => {
    const server = byId(p.id);
    const value = str((await body(req)).value);
    if (!value) throw new ValidationError('value is required');
    await lifecycle.setSecret(server.name, p.key, value);
    json(res, { status: 'set', key: p.key });
  });

  route('DELETE', '/api/servers/:id/secrets/:key', async (_req, res, p) => {
    await lifecycle.deleteSecret(byId(p.id).name, p.key);
    json(res, { status: 'deleted', key: p.key });
  });

  // -- OAuth (remote upstreams) ----------------------------------------------

  const remote = (id: string): ServerEntry & { url: string } => {
    const server = byId(id);
    if (server.transport === 'stdio' || !server.url) {
      throw new ValidationError(`"${server.name}" is not a remote server`);
    }
    return server as ServerEntry & { url: string };
  };

  route('GET', '/api/servers/:id/auth', (_req, res, p) => {
    json(res, ctx.oauth.status(remote(p.id).name));
  });

  route('POST', '/api/servers/:id/auth', async (_req, res, p) => {
    const server = remote(p.id);
    json(res, await upstream(() => ctx.oauth.begin(server.name, server.url)));
  });

  // The authorization server redirects the user's browser here (loopback redirect URI).
  route('GET', '/oauth/callback', async (req, res) => {
    let name: string;
    try {
      name = await ctx.oauth.callback(query(req), (n) => servers.require(n).url ?? '');
    } catch (err) {
      return page(res, 400, 'Sign-in failed', err instanceof Error ? err.message : String(err));
    }
    if (!servers.require(name).indexed_at) {
      lifecycle.reindex(name).catch((err) =>
        process.stderr.write(`[agent-discover] indexing "${name}" failed: ${String(err)}
`),
      );
    }
    page(
      res,
      200,
      'Signed in',
      `agent-discover is authorized for "${name}". You can close this tab.`,
    );
  });

  route('GET', '/api/servers/:id/metrics', (_req, res, p) => {
    json(res, ctx.metrics.getServerMetrics(byId(p.id).id));
  });

  route('GET', '/api/metrics', (_req, res) => json(res, ctx.metrics.getOverview()));

  // -- marketplace / prerequisites ------------------------------------------

  route('GET', '/api/browse', async (req, res) => {
    const q = query(req);
    const limit = Math.max(1, Math.min(parseInt(q.get('limit') ?? '20', 10) || 20, 100));
    json(res, await upstream(() => ctx.marketplace.search(q.get('query') ?? '', limit)));
  });

  // Exact-name install from search results: the plan is what the dashboard shows for consent.
  const planRequest = (src: { get(k: string): string | null | undefined }): PlanRequest => {
    const source = src.get('source') ?? 'registry';
    if (source !== 'registry' && source !== 'npm' && source !== 'pypi') {
      throw new ValidationError('source must be registry, npm or pypi');
    }
    const name = src.get('name');
    if (!name) throw new ValidationError('name is required');
    const localName = src.get('local_name') ?? undefined;
    const existing = localName ? servers.get(localName) : null;
    return {
      source,
      name,
      version: src.get('version') ?? undefined,
      local_name: localName,
      transport: (src.get('transport') ?? undefined) as ServerTransport | undefined,
      storedSecrets: existing ? ctx.secrets.list(existing).map((s) => s.key) : [],
    };
  };

  route('GET', '/api/install/plan', async (req, res) => {
    const q = query(req);
    json(res, await upstream(() => ctx.marketplace.plan(planRequest(q))));
  });

  route('POST', '/api/install', async (req, res) => {
    const b = await body(req);
    const plan = await upstream(() => ctx.marketplace.plan(planRequest({ get: (k) => str(b[k]) })));
    if (plan.blocked) throw new ValidationError(`Cannot install: ${plan.blocked}`);
    const { server, index_error } = await lifecycle.install(plan.input, {
      enable: b.enable === true,
      secrets: strMap(b.secrets),
    });
    json(res, { ...view(server), plan, ...(index_error ? { index_error } : {}) }, 201);
  });

  route('GET', '/api/registry', (_req, res) => json(res, ctx.registry.status()));

  route('POST', '/api/registry/sync', async (_req, res) => {
    json(res, await upstream(() => ctx.registry.sync()));
  });

  route('GET', '/api/prereqs', async (_req, res) => {
    const [npx, uvx, docker, uv] = await Promise.all(
      ['npx', 'uvx', 'docker', 'uv'].map((c) => isCommandOnPath(c)),
    );
    json(res, { npx, uvx, docker, uv });
  });

  route('POST', '/api/sync', async (_req, res) => json(res, await ctx.syncSetup()));

  // -- logs ------------------------------------------------------------------

  route('GET', '/api/logs', (req, res) => {
    const q = query(req);
    const limit = Math.min(parseInt(q.get('limit') ?? '100', 10) || 100, 500);
    const offset = Math.max(parseInt(q.get('offset') ?? '0', 10) || 0, 0);
    json(res, { entries: ctx.logs.list(limit, offset), total: ctx.logs.count() });
  });
  route('DELETE', '/api/logs', (_req, res) => {
    ctx.logs.clear();
    json(res, { status: 'cleared' });
  });
  route('GET', '/api/logs/notifications', (_req, res) => {
    json(res, { entries: ctx.logs.list(200, 0, 'notification') });
  });
  route('GET', '/api/logs/progress', (_req, res) => {
    json(res, { entries: ctx.logs.list(200, 0, 'progress') });
  });

  // -- tester (MCP Inspector parity); connects lazily -----------------------

  function testerName(p: Record<string, string>): string {
    if (p.id) return byId(p.id).name;
    const name = pool.resolveTransient(p.handle);
    if (!name) throw new NotFoundError('Transient server', p.handle);
    return name;
  }

  /** Run a client operation for a tester route, logging it like a proxied call. */
  async function logged<T>(
    name: string,
    kind: 'resource-read' | 'prompt-get' | 'ping',
    label: string,
    args: Record<string, unknown>,
    fn: (c: Client) => Promise<T>,
  ): Promise<T> {
    const start = Date.now();
    try {
      const out = await fn(await pool.connect(name));
      ctx.logs.push(name, label, args, JSON.stringify(out), Date.now() - start, true, kind);
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logs.push(name, label, args, msg, Date.now() - start, false, kind);
      throw err;
    }
  }

  for (const prefix of ['/api/servers/:id', '/api/transient/:handle']) {
    const get = (path: string, fn: (name: string, q: URLSearchParams) => Promise<unknown>) =>
      route('GET', prefix + path, async (req, res, p) => {
        const name = testerName(p);
        json(res, await upstream(() => fn(name, query(req))));
      });
    const post = (
      path: string,
      fn: (name: string, b: Record<string, unknown>) => Promise<unknown>,
    ) =>
      route('POST', prefix + path, async (req, res, p) => {
        const name = testerName(p);
        const b = await body(req);
        json(res, await upstream(() => fn(name, b)));
      });
    const cursor = (q: URLSearchParams) => {
      const c = q.get('cursor');
      return c ? { cursor: c } : undefined;
    };
    const uri = (b: Record<string, unknown>) => {
      const u = str(b.uri);
      if (!u) throw new ValidationError('uri is required');
      return u;
    };

    get('/info', async (name) => {
      await pool.connect(name);
      return pool.info(name);
    });
    get('/tools', async (name) => ({ tools: await pool.listTools(name) }));
    get('/resources', async (name, q) => (await pool.connect(name)).listResources(cursor(q)));
    get('/resource-templates', async (name, q) =>
      (await pool.connect(name)).listResourceTemplates(cursor(q)),
    );
    post('/resource/read', async (name, b) => {
      const u = uri(b);
      return logged(name, 'resource-read', u, { uri: u }, (c) => c.readResource({ uri: u }));
    });
    post('/resource/subscribe', async (name, b) => {
      await (await pool.connect(name)).subscribeResource({ uri: uri(b) });
      return { ok: true };
    });
    post('/resource/unsubscribe', async (name, b) => {
      await (await pool.connect(name)).unsubscribeResource({ uri: uri(b) });
      return { ok: true };
    });
    get('/prompts', async (name, q) => (await pool.connect(name)).listPrompts(cursor(q)));
    post('/prompt/get', async (name, b) => {
      const promptName = str(b.name);
      if (!promptName) throw new ValidationError('name is required');
      const args = strMap(b.arguments) ?? {};
      return logged(name, 'prompt-get', promptName, args, (c) =>
        c.getPrompt({ name: promptName, arguments: args }),
      );
    });
    post('/ping', async (name) => {
      const h = await pool.health(name);
      ctx.logs.push(
        name,
        'ping',
        {},
        h.error ?? 'pong',
        h.latency_ms,
        h.status === 'healthy',
        'ping',
      );
      if (h.status !== 'healthy') throw new UpstreamError(h.error ?? 'ping failed');
      return { ok: true, rtt_ms: h.latency_ms };
    });
    post('/logging-level', async (name, b) => {
      const level = str(b.level) ?? '';
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
        throw new ValidationError(`level must be one of: ${valid.join(', ')}`);
      }
      await (await pool.connect(name)).setLoggingLevel(level as 'info');
      return { ok: true, level };
    });
    get('/export', async (name, q) => {
      const format = q.get('format') ?? 'mcp-json';
      if (format !== 'mcp-json' && format !== 'agent-discover') {
        throw new ValidationError('format must be one of: mcp-json, agent-discover');
      }
      // Stored config only — secrets are never exported.
      const row = servers.get(name);
      const cfg = row ? { ...row, url: row.url ?? undefined } : pool.transientConfig(name);
      if (!cfg) throw new NotFoundError('Server', name);
      const entry: Record<string, unknown> =
        cfg.transport === 'stdio'
          ? {
              command: cfg.command,
              ...(cfg.args.length ? { args: cfg.args } : {}),
              ...(Object.keys(cfg.env).length ? { env: cfg.env } : {}),
            }
          : {
              type: cfg.transport === 'sse' ? 'sse' : 'http',
              url: cfg.url,
              ...(Object.keys(cfg.headers).length ? { headers: cfg.headers } : {}),
            };
      const config =
        format === 'agent-discover'
          ? { servers: [{ name, ...entry, enabled: true }] }
          : { mcpServers: { [name]: entry } };
      return { format, config };
    });
    post('/call', async (name, b) => {
      const tool = str(b.tool);
      if (!tool) throw new ValidationError('tool is required');
      const args = (b.args && typeof b.args === 'object' ? b.args : {}) as Record<string, unknown>;
      return testerCall(name, tool, args);
    });
  }

  // Registered servers go through the lifecycle (trust hooks); transient ones are pool-only.
  function testerCall(name: string, tool: string, args: Record<string, unknown>) {
    return servers.get(name)
      ? lifecycle.callTool(name, tool, args)
      : pool.callTool(name, tool, args);
  }

  // -- transient servers -----------------------------------------------------

  route('POST', '/api/transient', async (req, res) => {
    const b = await body(req);
    const transport = (str(b.transport) ?? 'stdio') as ServerTransport;
    const command = str(b.command);
    const url = str(b.url);
    if (transport === 'stdio') {
      if (!command) throw new ValidationError('command is required for stdio transport');
      if (!/^[@a-zA-Z0-9._/\\:-]+$/.test(command)) {
        throw new ValidationError('command contains unsafe characters');
      }
    } else if (!url) {
      throw new ValidationError('url is required for remote transports');
    }
    const env = Object.fromEntries(
      Object.entries(strMap(b.env) ?? {}).filter(([, v]) => !/[\r\n]/.test(v)),
    );
    const ttl = typeof b.ttl_ms === 'number' && b.ttl_ms > 0 ? b.ttl_ms : undefined;
    const handle = await upstream(() =>
      pool.openTransient(
        {
          transport,
          command,
          args: strArray(b.args) ?? [],
          env,
          url,
          headers: strMap(b.headers) ?? {},
        },
        ttl,
      ),
    );
    json(res, handle, 201);
  });

  route('DELETE', '/api/transient/:handle', async (_req, res, p) => {
    await pool.releaseTransient(p.handle);
    json(res, { ok: true });
  });

  // -- presets ---------------------------------------------------------------

  route('GET', '/api/presets', (req, res) => {
    const q = query(req);
    const kind = q.get('kind');
    json(res, {
      entries: ctx.presets.list({
        server: q.get('server') ?? undefined,
        kind: kind === 'tool' || kind === 'prompt' ? kind : undefined,
        target: q.get('target') ?? undefined,
      }),
    });
  });

  route('POST', '/api/presets', async (req, res) => {
    const b = await body(req);
    const kind = str(b.kind);
    if (kind !== 'tool' && kind !== 'prompt') {
      throw new ValidationError('kind must be "tool" or "prompt"');
    }
    try {
      const entry = ctx.presets.upsert({
        server: str(b.server) ?? '',
        kind,
        target: str(b.target) ?? '',
        preset: str(b.preset) ?? '',
        payload: b.payload ?? {},
      });
      json(res, entry, 201);
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : String(err));
    }
  });

  route('DELETE', '/api/presets/:id', (_req, res, p) => {
    const id = parseInt(p.id, 10);
    if (!Number.isFinite(id)) throw new ValidationError('invalid id');
    json(res, { ok: ctx.presets.delete(id) });
  });

  // -- elicitation (upstream 2025 servers → dashboard human) ----------------

  route('GET', '/api/elicitations', (_req, res) => {
    json(res, { entries: pool.listPendingElicitations() });
  });

  route('POST', '/api/elicitations/:id/respond', async (req, res, p) => {
    const b = await body(req);
    const action = str(b.action);
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
      throw new ValidationError('action must be accept / decline / cancel');
    }
    const content =
      b.content && typeof b.content === 'object' ? (b.content as ElicitationContent) : undefined;
    if (!pool.respondElicitation(p.id, { action, content })) {
      throw new NotFoundError('Elicitation', p.id);
    }
    json(res, { ok: true });
  });

  route('GET', '/api/roots', (_req, res) => json(res, { roots: configuredRoots() }));

  return async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (
      MUTATING.has(req.method ?? '') &&
      pathname.startsWith('/api/') &&
      !token.verify(req.headers[TOKEN_HEADER])
    ) {
      return json(
        res,
        {
          error: `Missing or invalid ${TOKEN_HEADER} header (GET /api/token)`,
          code: 'TOKEN_REQUIRED',
        },
        403,
      );
    }
    if (await router.handle(req, res)) return;
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      const file = /^\/tester(\/|$)/.test(pathname)
        ? '/tester-window.html'
        : pathname === '/'
          ? '/index.html'
          : pathname;
      return serveStatic(res, uiDir, file);
    }
    json(res, { error: 'Not found' }, 404);
  };
}
