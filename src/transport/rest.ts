// =============================================================================
// agent-discover — REST transport
//
// Thin adapter over the domain services for the Claude Code pane (and any
// local tooling). Every server state change goes through ServerLifecycle, so REST
// and MCP behave identically. Host/Origin/Content-Type are enforced by the
// daemon's request guard before routing; state-changing /api requests also
// need the per-launch token (transport/token.ts).
//
// Endpoints are documented in docs/API.md.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'http';
import { createRouter, json, readJson } from './http.js';
import type { AppContext } from '../context.js';
import type { ServerEntry, ServerInput, ServerTransport, ServerUpdate } from '../types.js';
import {
  ConflictError,
  NotFoundError,
  RegistryError,
  UpstreamError,
  ValidationError,
} from '../types.js';
import type { ElicitationContent } from '../domain/pool.js';
import { maskEnv, restoreMaskedEnv } from '../domain/secrets.js';
import type { PlanRequest } from '../domain/marketplace.js';
import { version } from '../version.js';
import { TOKEN_HEADER, type RestToken } from './token.js';

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
  onShutdown: () => void,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const router = createRouter();
  const startTime = Date.now();
  const { lifecycle, servers, index } = ctx;
  const pool = lifecycle.pool;

  // Env and header values are masked on the way out; a masked value sent back unchanged keeps the original.
  // `missing_secrets`: declared env vars and headers left empty with no secret to fill them
  // (toConfig drops those; header names match secrets case-insensitively, env names exactly).
  const view = (s: ServerEntry) => {
    const stored = ctx.secrets.list(s).map((x) => x.key);
    const lower = new Set(stored.map((k) => k.toLowerCase()));
    return {
      ...s,
      env: maskEnv(s.env),
      headers: maskEnv(s.headers),
      connected: pool.isConnected(s.name),
      tool_count: index.count(s.id),
      missing_secrets: [
        ...Object.keys(s.env).filter((k) => s.env[k] === '' && !stored.includes(k)),
        ...Object.keys(s.headers).filter((h) => s.headers[h] === '' && !lower.has(h.toLowerCase())),
      ],
    };
  };
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

  route('GET', '/api/token', (_req, res) => {
    json(res, { token: token.value, header: TOKEN_HEADER });
  });

  // Lets a newer shim replace this daemon on upgrade (shim.ts); exits like an idle exit.
  route('POST', '/api/shutdown', (_req, res) => {
    ctx.trust.record({ action: 'shutdown', detail: { pid: process.pid, version } });
    res.once('finish', onShutdown);
    json(res, { status: 'shutting-down' }, 202);
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
    if (fields.headers) fields.headers = restoreMaskedEnv(fields.headers, server.headers);
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

  // -- marketplace ------------------------------------------------------------

  route('GET', '/api/browse', async (req, res) => {
    const q = query(req);
    const limit = Math.max(1, Math.min(parseInt(q.get('limit') ?? '20', 10) || 20, 100));
    json(res, await upstream(() => ctx.marketplace.search(q.get('query') ?? '', limit)));
  });

  // Exact-name install from search results: the plan is what the pane shows for consent.
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
    if (servers.get(plan.server)) {
      throw new ConflictError(
        `Server "${plan.server}" already exists; pass local_name to install ${str(b.name)} under another name`,
      );
    }
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

  // -- logs ------------------------------------------------------------------

  route('GET', '/api/logs', (req, res) => {
    const q = query(req);
    const limit = Math.min(parseInt(q.get('limit') ?? '100', 10) || 100, 500);
    const offset = Math.max(parseInt(q.get('offset') ?? '0', 10) || 0, 0);
    json(res, { entries: ctx.logs.list(limit, offset), total: ctx.logs.count() });
  });
  // -- elicitation (upstream servers asking the person, answered in the pane) --

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
    if (!(await router.handle(req, res))) json(res, { error: 'Not found' }, 404);
  };
}
