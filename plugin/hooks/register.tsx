// agent-discover inside Claude Code: the /discover pane (servers, server detail, browse
// and install, logs, audit, upstream questions), a status line entry, toasts, an
// attention band and one context block telling the model what is enabled. Everything
// goes through the daemon's REST API; mutations carry its per-launch token. Secret
// values typed into the pane are sent and never kept in state.
import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type {
  AgentDiscoverAudit,
  AgentDiscoverBrowse,
  AgentDiscoverConfigKey,
  AgentDiscoverDetail,
  AgentDiscoverElicitation,
  AgentDiscoverField,
  AgentDiscoverPlan,
  AgentDiscoverServer,
  AgentDiscoverSnapshot,
  AgentDiscoverTab,
} from '../types';
import { AUDIT_PAGE, Band, Pane, maskId, needsAttention, sortServers, type Actions } from './view';

const PANE = 'agent-discover';
const TICK_MS = 5_000;
const IDLE_TICKS = 6; // 30 s between polls while the pane is closed
const VIEW_TICKS = 2; // the open view's data every 10 s
const LOG_LIMIT = 30;
const SCHEMA_MAX = 9_000;
const PANE_ROWS = 40; // inline height wanted: detail views run long

const snapshot = atom({ plugin: 'agent-discover', key: 'snapshot' } as const, null);
const route = atom({ plugin: 'agent-discover', key: 'route' } as const, {
  tab: 'servers',
  server: null,
});
const detail = atom({ plugin: 'agent-discover', key: 'detail' } as const, null);
const tool = atom({ plugin: 'agent-discover', key: 'tool' } as const, null);
const confirm = atom({ plugin: 'agent-discover', key: 'confirm' } as const, null);
const browse = atom({ plugin: 'agent-discover', key: 'browse' } as const, null);
const plan = atom({ plugin: 'agent-discover', key: 'plan' } as const, null);
const logs = atom({ plugin: 'agent-discover', key: 'logs' } as const, null);
const audit = atom({ plugin: 'agent-discover', key: 'audit' } as const, null);
const busy = atom({ plugin: 'agent-discover', key: 'busy' } as const, null);
const notice = atom({ plugin: 'agent-discover', key: 'notice' } as const, null);
const dismissed = atom({ plugin: 'agent-discover', key: 'dismissed' } as const, null);
const masked = atom({ plugin: 'agent-discover', key: 'masked' } as const, {});
const editing = atom({ plugin: 'agent-discover', key: 'editing' } as const, null);
const paneOpen = atom({ plugin: 'agent-discover', key: 'paneOpen' } as const, false);

// REST bodies are daemon JSON; read defensively, never trusted for shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const keys = (v: unknown): string[] =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];

const origin = async ($: EngineInterface) =>
  `http://127.0.0.1:${(await $.env.get('AGENT_DISCOVER_PORT')) ?? '3424'}`;

/** One /api call. State-changing ones carry the daemon's per-launch token (GET /api/token). */
async function api(
  $: EngineInterface,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<Json> {
  const base = await origin($);
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    const t = await $.http.fetch(`${base}/api/token`);
    if (!t.ok) throw new Error(`GET /api/token: ${t.status}`);
    headers['X-Agent-Discover-Token'] = String((JSON.parse(t.text) as Json).token);
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await $.http.fetch(`${base}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data: Json = {};
  try {
    data = JSON.parse(res.text) as Json;
  } catch {
    /* not JSON: the status says enough */
  }
  if (!res.ok) throw new Error(text(data.error) ?? `${method} ${path}: ${res.status}`);

  return data;
}

const at = (id: number, sub = '') => `/api/servers/${id}${sub}`;

function fields(schema: Json): AgentDiscoverField[] {
  const required = new Set(list(schema.required).map(String));
  return Object.entries((schema.properties ?? {}) as Record<string, Json>).map(([name, p]) => ({
    name,
    title: String(p.title ?? name),
    type: ['number', 'integer', 'boolean'].includes(p.type) ? p.type : 'string',
    options: p.type === 'boolean' ? ['true', 'false'] : list(p.enum).map(String),
    required: required.has(name),
  }));
}

async function poll($: EngineInterface): Promise<AgentDiscoverSnapshot> {
  const base = await origin($);
  try {
    const [status, rows, pending] = await Promise.all([
      api($, '/api/status'),
      api($, '/api/servers'),
      api($, '/api/elicitations').catch((): Json => ({ entries: [] })),
    ]);
    const byName = new Map(list(rows).map((r) => [String(r.name), r]));
    const servers = list(status.servers).map((s): AgentDiscoverServer => {
      const row = byName.get(String(s.name)) ?? {};
      return {
        id: Number(row.id ?? 0),
        name: String(s.name),
        description: String(s.description ?? ''),
        transport: String(s.transport ?? ''),
        enabled: Boolean(s.enabled),
        quarantined: Boolean(s.quarantined),
        tool_count: Number(s.tool_count ?? 0),
        health_status: String(s.health_status ?? 'unknown'),
        error_count: Number(s.error_count ?? 0),
        registry_status: text(s.registry_status),
        registry_name: text(row.registry_name),
        package_name: text(row.package_name),
      };
    });
    const elicitations = list(pending.entries).map(
      (q): AgentDiscoverElicitation => ({
        id: String(q.id),
        server: String(q.serverName ?? ''),
        message: String(q.message ?? ''),
        fields: fields((q.requestedSchema ?? {}) as Json),
      }),
    );

    return {
      isUp: true,
      origin: base,
      servers,
      elicitations,
      attention: servers.filter(needsAttention).map((s) => s.name),
    };
  } catch {
    return { isUp: false, origin: base, servers: [], elicitations: [], attention: [] };
  }
}

const summary = (s: AgentDiscoverSnapshot) =>
  `MCP ${s.servers.filter((x) => x.enabled).length}/${s.servers.length}${s.attention.length ? ` · ${s.attention.length} to review` : ''}`;

/** The context block the model starts with: what is enabled and to search before giving up. */
function contextText(s: AgentDiscoverSnapshot) {
  const on = s.servers.filter((x) => x.enabled).map((x) => x.name);
  const shown = on.slice(0, 8).join(', ') + (on.length > 8 ? `, +${on.length - 8}` : '');
  return (
    `${on.length} of ${s.servers.length} installed MCP servers are enabled${on.length ? ` (${shown})` : ''}. ` +
    'When a task needs a capability you do not have, call search_tools (or search_servers for uninstalled ones) before saying it is unavailable.'
  );
}

const signature = (s: AgentDiscoverSnapshot) =>
  `${s.attention.join(',')}|${s.elicitations.map((q) => q.id).join(',')}`;

async function refresh($: EngineInterface) {
  const next = await poll($);
  const prev = await read($, snapshot);
  await update($, snapshot, () => next);
  $.ui.status(next.isUp ? summary(next) : undefined);
  if (prev?.isUp) {
    for (const name of next.attention.filter((n) => !prev.attention.includes(n))) {
      const quarantined = next.servers.find((s) => s.name === name)?.quarantined;
      $.ui.toast(
        `agent-discover: ${name} ${quarantined ? 'quarantined, review before use' : 'is unhealthy'}`,
      );
    }
    const asked = next.elicitations.filter((q) => !prev.elicitations.some((p) => p.id === q.id));
    for (const q of asked) $.ui.toast(`agent-discover: ${q.server} asks a question (/discover)`);
  }

  return next;
}

async function serverId($: EngineInterface, name: string): Promise<number> {
  const found = (await read($, snapshot))?.servers.find((s) => s.name === name);
  if (!found) throw new Error(`${name} is not installed`);

  return found.id;
}

function describeChange(c: Json): string {
  const parts: string[] = [];
  if (c.description) parts.push('description');
  const s = c.input_schema as Json | undefined;
  if (s) {
    for (const [label, names] of [
      ['+', s.added],
      ['-', s.removed],
      ['~', s.changed],
    ] as const) {
      for (const n of list(names)) parts.push(`${label}${String(n)}`);
    }
  }
  if (c.annotations) parts.push('annotations');

  return parts.join(' ') || 'definition';
}

/** Env vars and headers with where their value comes from; OAuth state is not a config key. */
function configKeys(row: Json, secrets: Json[]): AgentDiscoverConfigKey[] {
  const stored = new Map(
    secrets
      .map((s) => String(s.key))
      .filter((k) => !k.startsWith('oauth:'))
      .map((k) => [k.toLowerCase(), k]),
  );
  const missing = new Set(list(row.missing_secrets).map(String));
  const declared = [
    ...keys(row.env).map((key) => ({ key, kind: 'env' as const })),
    ...keys(row.headers).map((key) => ({ key, kind: 'header' as const })),
  ];
  const out: AgentDiscoverConfigKey[] = declared.map(({ key, kind }) => ({
    key,
    kind,
    source: stored.delete(key.toLowerCase()) ? 'secret' : missing.has(key) ? 'missing' : 'value',
  }));
  for (const key of stored.values()) out.push({ key, kind: 'secret', source: 'secret' });

  return out;
}

async function loadDetail($: EngineInterface, name: string) {
  const id = await serverId($, name);
  const [row, secrets, trust, metrics] = await Promise.all([
    api($, at(id)),
    api($, at(id, '/secrets')),
    api($, at(id, '/trust')),
    api($, at(id, '/metrics')),
  ]);
  const isRemote = row.transport !== 'stdio' && Boolean(row.url);
  const auth = isRemote ? await api($, at(id, '/auth')).catch(() => null) : null;
  // `unknown` means no sign-in was ever asked for (a static header, or no auth at all).
  const signIn = auth && auth.status !== 'unknown' ? auth : null;
  const prev = await read($, detail);
  const drift = trust.drift as Json | undefined;
  const next: AgentDiscoverDetail = {
    id,
    name,
    description: String(row.description ?? ''),
    transport: String(row.transport ?? ''),
    command: text(row.command),
    args: list(row.args).map(String),
    url: text(row.url),
    tags: list(row.tags).map(String),
    source: String(row.source ?? ''),
    registry_name: text(row.registry_name),
    registry_status:
      (await read($, snapshot))?.servers.find((s) => s.name === name)?.registry_status ?? null,
    package_name: text(row.package_name),
    package_version: text(row.package_version),
    enabled: Boolean(row.enabled),
    quarantined: Boolean(row.quarantined),
    connected: Boolean(row.connected),
    health_status: String(row.health_status ?? 'unknown'),
    last_health_check: text(row.last_health_check),
    error_count: Number(row.error_count ?? 0),
    config: configKeys(row, list(secrets)),
    tools: list(row.tools).map((t) => ({
      name: String(t.name),
      description: String(t.description ?? '').slice(0, 300),
    })),
    metrics: list(metrics).map((m) => ({
      tool: String(m.tool_name),
      calls: Number(m.call_count ?? 0),
      errors: Number(m.error_count ?? 0),
      avg_ms: Number(m.avg_latency_ms ?? 0),
    })),
    drift: drift
      ? {
          changed: list(drift.changed).map((c) => ({
            tool: String(c.tool),
            what: describeChange(c),
            description: c.description
              ? { before: String(c.description.before), after: String(c.description.after) }
              : null,
          })),
          added: list(drift.added).map(String),
          removed: list(drift.removed).map(String),
        }
      : null,
    hashes: list(trust.hashes).map(String),
    auth: signIn
      ? {
          status: String(signIn.status),
          // Shown as a link for the person to open; never opened by the plugin.
          authorize_url: /^https?:\/\//i.test(String(signIn.authorize_url ?? ''))
            ? String(signIn.authorize_url)
            : null,
        }
      : null,
    health: prev?.name === name ? prev.health : null,
  };
  await update($, detail, () => next);
}

async function loadLogs($: EngineInterface) {
  const r = await api($, `/api/logs?limit=${LOG_LIMIT}`);
  await update($, logs, () => ({
    total: Number(r.total ?? 0),
    entries: list(r.entries).map((e) => ({
      id: Number(e.id),
      time: String(e.timestamp ?? ''),
      server: String(e.server ?? ''),
      tool: String(e.tool ?? ''),
      ms: Number(e.latency_ms ?? 0),
      error: e.success
        ? null
        : String(e.response ?? '')
            .replace(/\s+/g, ' ')
            .slice(0, 200),
    })),
  }));
}

async function checkHealth($: EngineInterface, name: string) {
  const r = await api($, at(await serverId($, name), '/health'), 'POST');
  const health = {
    status: String(r.status),
    latency_ms: Number(r.latency_ms ?? 0),
    error: text(r.error),
  };
  await update($, detail, (d) => (d && d.name === name ? { ...d, health } : d));

  return health;
}

type AuditQuery = Pick<AgentDiscoverAudit, 'server' | 'action' | 'cursors' | 'before'>;
const firstAudit: AuditQuery = { server: '', action: '', cursors: [], before: null };

async function loadAudit($: EngineInterface, q: AuditQuery) {
  const params = new URLSearchParams({ limit: String(AUDIT_PAGE) });
  if (q.before !== null) params.set('before', String(q.before));
  if (q.server) params.set('server', q.server);
  if (q.action) params.set('action', q.action);
  const r = await api($, `/api/audit?${params}`);
  await update($, audit, () => ({
    server: q.server,
    action: q.action,
    cursors: q.cursors,
    before: q.before,
    total: Number(r.total ?? 0),
    entries: list(r.entries).map((e) => ({
      id: Number(e.id),
      ts: String(e.ts ?? ''),
      action: String(e.action ?? ''),
      server: text(e.server),
      tool: text(e.tool),
      isError: e.is_error === true,
      ms: typeof e.duration_ms === 'number' ? e.duration_ms : null,
    })),
  }));
}

/** Reloads what the open view shows. */
async function loadView($: EngineInterface) {
  const r = await read($, route);
  if (r.tab === 'servers' && r.server) await loadDetail($, r.server);
  if (r.tab === 'logs') await loadLogs($);
  if (r.tab === 'audit') await loadAudit($, (await read($, audit)) ?? firstAudit);
}

async function find($: EngineInterface, query: string): Promise<AgentDiscoverBrowse> {
  const snap = await read($, snapshot);
  const installed = new Set(
    snap?.servers.flatMap((s) => [s.name, s.registry_name, s.package_name]).filter(Boolean),
  );
  const market = await api($, `/api/browse?query=${encodeURIComponent(query)}&limit=15`).catch(
    (err: Error): Json => ({ error: err.message }),
  );
  const errors = [text(market.error), ...Object.values(market.errors ?? {}).map(text)].filter(
    (e): e is string => e !== null,
  );
  const result: AgentDiscoverBrowse = {
    query,
    results: list(market.servers).map((m) => ({
      source: String(m.source ?? 'registry'),
      name: String(m.name),
      description: String(m.description ?? '').slice(0, 300),
      version: String(m.version ?? ''),
      status: String(m.status ?? 'active'),
      isInstalled: installed.has(String(m.name)),
    })),
    error: errors.length ? errors.join('; ') : null,
  };
  await update($, browse, () => result);

  return result;
}

/** Values typed for the install plan's requirements: sent with the install, never drawn. */
const planValues = new Map<string, string>();
/** Answers typed for upstream questions, by question id: sent on Accept, never drawn. */
const answers = new Map<string, Record<string, string>>();
/** What was typed into each masked field, by field id; the field draws only its length. */
const typed = new Map<string, string>();

/**
 * A masked field draws its value as bullets, so the text it reports is those bullets with
 * the person's edit applied: the kept bullets stand for the kept characters, the rest is new.
 */
async function typeMasked($: EngineInterface, id: string, shown: string) {
  const prev = typed.get(id) ?? '';
  let kept = 0;
  while (kept < shown.length && kept < prev.length && shown[kept] === '•') kept += 1;
  const next = prev.slice(0, kept) + shown.slice(kept).replace(/•/g, '');
  typed.set(id, next);
  await update($, masked, (m) => ({ ...m, [id]: next.length }));
}

/** Takes a masked field's value out (it is sent once, then forgotten). */
async function takeMasked($: EngineInterface, id: string): Promise<string> {
  const value = typed.get(id) ?? '';
  typed.delete(id);
  await update($, masked, (m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id)));

  return value;
}

async function forgetTyped($: EngineInterface) {
  typed.clear();
  await update($, masked, () => ({}));
  await update($, editing, () => null);
}

async function fillPlan($: EngineInterface, key: string, value: string) {
  if (value) planValues.set(key, value);
  else planValues.delete(key);
  await update($, plan, (p) => p && { ...p, filled: [...planValues.keys()] });
}

async function act($: EngineInterface, label: string, fn: () => Promise<string>) {
  await update($, busy, () => label);
  await update($, notice, () => null);
  try {
    const outcome = await fn();
    await update($, notice, () => (outcome ? `✓ ${outcome}` : null));
  } catch (err) {
    await update(
      $,
      notice,
      () => `✗ ${label} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await update($, busy, () => null);
  await refresh($);
  await loadView($).catch(() => {});
}

/** Where the focus ring lands after a move: the control the person most likely wants next. */
async function landing($: EngineInterface, from: string | null): Promise<string | null> {
  const r = await read($, route);
  if (r.tab === 'servers' && r.server) {
    const d = await read($, detail);
    return d?.quarantined ? 'approve' : 'toggle';
  }
  if (r.tab === 'servers') {
    const first = sortServers((await read($, snapshot))?.servers ?? [])[0];
    const to = from ?? first?.name;
    return to ? `open:${to}` : 'empty-browse';
  }
  if (r.tab === 'browse') {
    const p = await read($, plan);
    if (!p) {
      // A field takes the digits: results already shown keep the tab keys working.
      const hit = (await read($, browse))?.results.find((x) => !x.isInstalled);
      return hit ? `plan:${hit.source}:${hit.name}` : 'search';
    }
    const todo = p.requirements.find((q) => !q.present && !p.filled.includes(q.key));
    return todo ? `reqset:${todo.key}` : p.blocked ? 'plan-cancel' : 'install-enable';
  }
  // Never the audit's Select: holding the ring drops its list open and it takes the digits.
  return r.tab === 'logs' ? 'logs-reload' : 'audit-reload';
}

/** Moves the ring when the pane holds the keys; otherwise the engine refuses and nothing moves. */
async function land($: EngineInterface, from: string | null = null) {
  const key = await landing($, from);
  if (key) await $.ui.focus({ requestId: PANE, key }).catch(() => undefined);
}

async function go($: EngineInterface, tab: AgentDiscoverTab, server: string | null = null) {
  const from = (await read($, route)).server;
  await update($, route, () => ({ tab, server }));
  await update($, confirm, () => null);
  if (server !== (await read($, detail))?.name) await update($, tool, () => null);
  await update($, notice, () => null);
  await forgetTyped($);
  await loadView($).catch(async (err: Error) => update($, notice, () => `✗ ${err.message}`));
  void land($, from);
  // An enabled server is connected anyway: check it so the detail opens with a real answer.
  const d = server ? await read($, detail) : null;
  if (d?.name === server && d.enabled && !d.quarantined && !d.health)
    await checkHealth($, d.name).catch(() => {});
}

/** A plain sidebar, not a dialog: Escape returns the keys and leaves it open. */
async function openPane($: EngineInterface) {
  const opened = await $.ui.open({
    id: PANE,
    title: 'agent-discover',
    focus: true,
    rows: PANE_ROWS,
  });
  await update($, paneOpen, () => opened.isPlaced);

  return opened;
}

function actions($: EngineInterface): Actions {
  const run = (label: string, fn: () => Promise<string>) => void act($, label, fn);
  const call = async (name: string, sub: string, method = 'POST', body?: unknown) =>
    api($, at(await serverId($, name), sub), method, body);
  const saveSecret = (name: string, key: string, value: string) =>
    run(`save secret ${key}`, async () => {
      await call(name, `/secrets/${encodeURIComponent(key)}`, 'PUT', { value });
      return `secret ${key} of ${name} saved`;
    });

  return {
    refresh: () => run('refresh', async () => ''),
    go: (tab) => void go($, tab),
    open: (name) => void go($, 'servers', name),
    enable: (name) =>
      run(`enable ${name}`, async () => {
        const r = await call(name, '/enable');
        return `enabled ${name} (${r.tool_count ?? 0} tools)`;
      }),
    disable: (name) =>
      run(`disable ${name}`, async () => {
        await call(name, '/disable');
        return `disabled ${name}`;
      }),
    reindex: (name) =>
      run(`re-index ${name}`, async () => {
        const r = await call(name, '/index');
        return `re-indexed ${name}: +${r.added?.length ?? 0} ~${r.changed?.length ?? 0} -${r.removed?.length ?? 0}`;
      }),
    health: (name) =>
      run(`health check ${name}`, async () => {
        const health = await checkHealth($, name);
        return `${name}: ${health.status} in ${health.latency_ms} ms`;
      }),
    resetErrors: (name) =>
      run(`reset errors ${name}`, async () => {
        await call(name, '/reset-errors');
        return `error count of ${name} reset`;
      }),
    approve: (name) =>
      run(`approve ${name}`, async () => {
        const d = await read($, detail);
        if (d?.name !== name) throw new Error('review the changes first');
        await call(name, '/approve', 'POST', { hashes: d.hashes });
        return `approved ${name}: quarantine lifted`;
      }),
    keepDisabled: (name) =>
      run(`keep ${name} disabled`, async () => {
        await call(name, '/disable');
        return `${name} stays disabled and quarantined`;
      }),
    signIn: (name) =>
      run(`sign in ${name}`, async () => {
        const r = await call(name, '/auth');
        if (r.status === 'authorized') return `${name}: signed in`;
        return `${name}: open the sign-in page below, then Refresh`;
      }),
    askUninstall: (name) => void update($, confirm, () => `uninstall:${name}`),
    cancel: () => void update($, confirm, () => null),
    uninstall: (name) =>
      run(`uninstall ${name}`, async () => {
        await call(name, '', 'DELETE');
        await update($, confirm, () => null);
        await update($, route, () => ({ tab: 'servers' as const, server: null }));
        await update($, detail, () => null);
        return `uninstalled ${name}`;
      }),
    mask: (id, shown) => void typeMasked($, id, shown),
    setSecret: (name, key) =>
      void (async () => {
        const value = await takeMasked($, maskId(`secret:${name}`, key));
        if (!value) return;
        await update($, editing, () => null);
        saveSecret(name, key, value);
      })(),
    editSecret: (key) => void update($, editing, () => key),
    addSecret: (key) => {
      const k = key.trim();
      if (k) void update($, editing, () => k);
    },
    deleteSecret: (name, key) =>
      run(`delete secret ${key}`, async () => {
        await call(name, `/secrets/${encodeURIComponent(key)}`, 'DELETE');
        return `secret ${key} of ${name} deleted`;
      }),
    toggleTool: (name, toolName) =>
      void (async () => {
        const open = await read($, tool);
        if (open?.server === name && open.tool === toolName) {
          await update($, tool, () => null);
          return;
        }
        const row = await api($, at(await serverId($, name)));
        const def = list(row.tools).find((t) => t.name === toolName);
        const schema = JSON.stringify(def?.input_schema ?? {}, null, 2);
        await update($, tool, () => ({
          server: name,
          tool: toolName,
          schema: schema.length > SCHEMA_MAX ? `${schema.slice(0, SCHEMA_MAX)}\n…` : schema,
        }));
      })().catch((err: Error) => update($, notice, () => err.message)),
    search: (query) => {
      if (!query.trim()) return;
      run(`search "${query}"`, async () => {
        await update($, plan, () => null);
        await find($, query.trim());
        void land($);
        return ''; // the results say how many
      });
    },
    syncRegistry: () =>
      run('sync the registry mirror', async () => {
        const r = await api($, '/api/registry/sync', 'POST');
        return `registry mirror: ${r.mode} sync, ${r.fetched} entries`;
      }),
    showPlan: (entry) =>
      run(`plan ${entry.name}`, async () => {
        planValues.clear();
        const params = new URLSearchParams({ source: entry.source, name: entry.name });
        if (entry.version) params.set('version', entry.version);
        const p = await api($, `/api/install/plan?${params}`);
        const prov = (p.provenance ?? {}) as Json;
        const next: AgentDiscoverPlan = {
          source: entry.source,
          name: entry.name,
          version: entry.version || null,
          server: String(p.server),
          transport: String(p.transport ?? ''),
          command: text(p.command),
          args: list(p.args).map(String),
          url: text(p.url),
          pinned: Boolean(prov.pinned),
          publisher: text(prov.registry?.publisher),
          registry_status: text(prov.registry?.status),
          repository: text(prov.repository),
          checks: list(prov.checks).map((c) => ({
            id: String(c.id),
            status: String(c.status),
            detail: String(c.detail ?? ''),
          })),
          warnings: list(p.warnings).map(String),
          blocked: text(p.blocked),
          requirements: list(p.requirements).map((q) => ({
            key: String(q.key),
            kind: String(q.kind),
            required: Boolean(q.required),
            secret: Boolean(q.secret),
            present: Boolean(q.present),
          })),
          filled: [],
        };
        await update($, plan, () => next);
        return '';
      }),
    fill: (key, value) => void fillPlan($, key, value).then(() => land($)),
    fillSecret: (key) =>
      void (async () => {
        await fillPlan($, key, await takeMasked($, maskId('plan', key)));
        await land($);
      })(),
    cancelPlan: () => {
      planValues.clear();
      void forgetTyped($);
      void update($, plan, () => null);
    },
    install: (enable) =>
      run('install', async () => {
        const p = await read($, plan);
        if (!p) throw new Error('no plan to install');
        const r = await api($, '/api/install', 'POST', {
          source: p.source,
          name: p.name,
          ...(p.version ? { version: p.version } : {}),
          enable,
          secrets: Object.fromEntries(planValues),
        });
        planValues.clear();
        await update($, plan, () => null);
        await refresh($); // the detail looks the new server up in the snapshot
        await go($, 'servers', String(r.name));
        const indexed = r.index_error ? `, indexing failed: ${r.index_error}` : '';
        return `installed ${r.name} (${r.tool_count ?? 0} tools${enable ? ', enabled' : ''})${indexed}`;
      }),
    reloadLogs: () => run('reload logs', async () => ''),
    reloadAudit: () => run('reload audit', async () => ''),
    filterAudit: (field, value) =>
      run('filter audit', async () => {
        const prev = (await read($, audit)) ?? firstAudit;
        await loadAudit($, { ...prev, [field]: value, cursors: [], before: null });
        return '';
      }),
    olderAudit: () =>
      run('older entries', async () => {
        const prev = await read($, audit);
        const last = prev?.entries.at(-1);
        if (prev && last)
          await loadAudit($, {
            ...prev,
            cursors: [...prev.cursors, prev.before ?? 0],
            before: last.id,
          });
        return '';
      }),
    newerAudit: () =>
      run('newer entries', async () => {
        const prev = await read($, audit);
        if (prev?.cursors.length) {
          const before = prev.cursors.at(-1) ?? 0;
          await loadAudit($, {
            ...prev,
            cursors: prev.cursors.slice(0, -1),
            before: before === 0 ? null : before,
          });
        }
        return '';
      }),
    answer: (id, field, value) => answers.set(id, { ...answers.get(id), [field]: value }),
    respond: (id, action) =>
      run(`${action} question`, async () => {
        const q = (await read($, snapshot))?.elicitations.find((x) => x.id === id);
        const typed = answers.get(id) ?? {};
        const content = Object.fromEntries(
          (q?.fields ?? [])
            .filter((f) => typed[f.name] !== undefined)
            .map((f) => [
              f.name,
              f.type === 'boolean'
                ? typed[f.name] === 'true'
                : f.type === 'string'
                  ? typed[f.name]
                  : Number(typed[f.name]),
            ]),
        );
        await api($, `/api/elicitations/${encodeURIComponent(id)}/respond`, 'POST', {
          action,
          ...(action === 'accept' ? { content } : {}),
        });
        answers.delete(id);
        return `answered ${q?.server ?? 'the server'}: ${action}`;
      }),
    openFromBand: () =>
      void (async () => {
        await openPane($);
        await go($, 'servers', (await read($, snapshot))?.attention[0] ?? null);
      })(),
    dismiss: async () => {
      const snap = await read($, snapshot);
      if (snap) await update($, dismissed, () => signature(snap));
    },
  };
}

export const register: Register = (on) => {
  let isPolling = false;
  let ticks = 0;
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'discover',
      description: 'Manage MCP servers: installed servers, browse and install, logs, audit',
      argumentHint: '[search the registry for]',
    });
    void refresh($);
    $.clock.every(TICK_MS, async () => {
      ticks += 1;
      const isOpen = (await $.ui.panes()).some((p) => p.id === PANE && p.isPlaced);
      if ((await read($, paneOpen)) !== isOpen) await update($, paneOpen, () => isOpen);
      if (isPolling || !(isOpen || ticks % IDLE_TICKS === 0)) return;
      isPolling = true;
      try {
        await refresh($);
        if (isOpen && ticks % VIEW_TICKS === 0) await loadView($).catch(() => {});
      } finally {
        isPolling = false;
      }
    });

    return next(e);
  });

  on('command.run', { command: 'discover' }, async ($, e) => {
    const opened = await openPane($);
    const snap = await refresh($);
    const lines = [snap.isUp ? summary(snap) : `daemon not reachable at ${snap.origin}`];
    if (!opened.isPlaced) lines.push(`pane not shown: ${opened.reason}`);
    const query = e.args.trim();
    if (snap.isUp && query) {
      await update($, plan, () => null);
      await update($, route, () => ({ tab: 'browse' as const, server: null }));
      const r = await find($, query);
      lines.push(
        `${r.results.length} ${r.results.length === 1 ? 'result' : 'results'} for "${query}" in the pane`,
      );
      if (r.error) lines.push(`search error: ${r.error}`);
    } else if (snap.isUp) await go($, 'servers');

    return { text: lines.join('\n') };
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e);
    const snap = await read($, snapshot);
    if (!snap) return <el.Text dimColor>Loading...</el.Text>;

    return (
      <Pane
        el={el}
        snap={snap}
        route={await read($, route)}
        detail={await read($, detail)}
        tool={await read($, tool)}
        confirm={await read($, confirm)}
        browse={await read($, browse)}
        plan={await read($, plan)}
        logs={await read($, logs)}
        audit={await read($, audit)}
        busy={await read($, busy)}
        notice={await read($, notice)}
        isFocused={e.props.isFocused}
        columns={e.props.bodyColumns}
        masked={await read($, masked)}
        editing={await read($, editing)}
        on={actions($)}
      />
    );
  });

  on('prompt.context', async ($, e, next) => {
    const r = await next(e);
    const snap = (await read($, snapshot)) ?? (await refresh($));
    if (!snap.isUp) return r;

    return { ...r, blocks: [...r.blocks, { name: 'agent-discover', text: contextText(snap) }] };
  });

  // The pane shows the same and more: the band is for when it is closed.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot);
    if (
      e.props.hasSurvey ||
      (await read($, paneOpen)) ||
      !snap?.isUp ||
      (snap.attention.length === 0 && snap.elicitations.length === 0) ||
      (await read($, dismissed)) === signature(snap)
    ) {
      return next(e);
    }

    return <Band el={$.ui.resolve(e)} snap={snap} on={actions($)} />;
  });
};
