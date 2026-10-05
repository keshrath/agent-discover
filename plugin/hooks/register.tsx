// Native Claude Code UI for agent-discover: a /discover panel, a status line entry,
// toasts and an attention band. Actions go through our own MCP server ($.mcp.call:
// the same tools and consent gates the model uses); the daemon's REST API covers
// what has no tool (pending requests, re-index) and is the fallback for status.
import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { AgentDiscoverSearch, AgentDiscoverServer, AgentDiscoverSnapshot } from '../types';
import { Band, Panel, needsAttention, type Handlers } from './view';

/** The server's name as /mcp lists a plugin-provided server. */
const SERVER = 'plugin:agent-discover:agent-discover';
const PANE = 'agent-discover';
const TICK_MS = 5_000;
const IDLE_TICKS = 6; // 30 s between polls while no panel is open

const snapshot = atom({ plugin: 'agent-discover', key: 'snapshot' } as const, null);
const found = atom({ plugin: 'agent-discover', key: 'search' } as const, null);
const busy = atom({ plugin: 'agent-discover', key: 'busy' } as const, null);
const notice = atom({ plugin: 'agent-discover', key: 'notice' } as const, null);
const dismissed = atom({ plugin: 'agent-discover', key: 'dismissed' } as const, null);

// Tool results and REST bodies are daemon JSON; read defensively, never trusted for shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** A meta tool's result. Claude Code hands a hook the structured result as one JSON text block. */
async function tool(
  $: EngineInterface,
  name: string,
  args: Record<string, unknown>,
): Promise<Json> {
  const r = await $.mcp.call(SERVER, name, args);
  const first = r.content[0];
  const text = (first?.type === 'text' && first.text) || `${name} returned no text`;
  try {
    return (r.structuredContent ?? JSON.parse(text)) as Json;
  } catch {
    throw new Error(text); // a plain error message, not a structured result
  }
}

const origin = async ($: EngineInterface) =>
  `http://127.0.0.1:${(await $.env.get('AGENT_DISCOVER_PORT')) ?? '3424'}`;

/** State-changing /api calls carry the daemon's per-launch token (GET /api/token, no Origin). */
async function api($: EngineInterface, path: string, method = 'GET'): Promise<Json> {
  const base = await origin($);
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    const t = await $.http.fetch(`${base}/api/token`);
    if (!t.ok) throw new Error(`GET /api/token: ${t.status}`);
    headers['X-Agent-Discover-Token'] = String((JSON.parse(t.text) as Json).token);
  }
  const res = await $.http.fetch(`${base}${path}`, { method, headers });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
  return JSON.parse(res.text) as Json;
}

const view = (s: Json): AgentDiscoverServer => ({
  name: String(s.name),
  description: String(s.description ?? ''),
  enabled: Boolean(s.enabled),
  quarantined: Boolean(s.quarantined),
  tool_count: Number(s.tool_count ?? 0),
  health_status: String(s.health_status ?? 'unknown'),
});

async function poll($: EngineInterface): Promise<AgentDiscoverSnapshot> {
  const dash = await origin($);
  let status: Json;
  try {
    status = await tool($, 'server_status', {});
  } catch {
    try {
      status = await api($, '/api/status');
    } catch {
      return { isUp: false, dashboard: dash, servers: [], pending: 0, attention: [] };
    }
  }
  const servers = ((status.servers ?? []) as Json[]).map(view);
  const pending = await api($, '/api/elicitations').then(
    (r) => (r.entries as unknown[]).length,
    () => 0,
  );

  return {
    isUp: true,
    dashboard: dash,
    servers,
    pending,
    attention: servers.filter(needsAttention).map((s) => s.name),
  };
}

const summary = (s: AgentDiscoverSnapshot) =>
  `MCP ${s.servers.filter((x) => x.enabled).length}/${s.servers.length}${s.attention.length ? ` !${s.attention.length}` : ''}`;

const signature = (s: AgentDiscoverSnapshot) => `${s.attention.join(',')}|${s.pending}`;

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
  }

  return next;
}

async function find($: EngineInterface, query: string) {
  const [tools, servers] = await Promise.all([
    tool($, 'search_tools', { queries: [query], limit: 6 }),
    tool($, 'search_servers', { query, limit: 5 }),
  ]);
  const installed = new Set(((servers.installed ?? []) as Json[]).map((s) => s.name));
  const result: AgentDiscoverSearch = {
    query,
    tools: ((tools.results?.[0]?.matches ?? []) as Json[]).map((m) => ({
      server: m.server,
      tool: m.tool,
      description: String(m.description ?? ''),
      isEnabled: Boolean(m.enabled),
    })),
    market: ((servers.marketplace ?? []) as Json[])
      .filter((m) => !installed.has(m.name))
      .map((m) => ({
        name: m.name,
        source: String(m.source ?? 'registry'),
        description: String(m.description ?? ''),
        version: String(m.version ?? ''),
      })),
    ...(servers.marketplace_errors
      ? { error: Object.values(servers.marketplace_errors as Record<string, string>).join('; ') }
      : {}),
  };
  await update($, found, () => result);

  return result;
}

const act = async ($: EngineInterface, label: string, fn: () => Promise<string>) => {
  await update($, busy, () => label);
  await update($, notice, () => null);
  try {
    const outcome = await fn();
    await update($, notice, () => outcome);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    await update($, notice, () => `${label} failed: ${why}`);
  }
  await update($, busy, () => null);
  await refresh($);
};

const handlers = ($: EngineInterface): Handlers => ({
  refresh: () => void refresh($),
  run: (label, fn) => void act($, label, fn),
  enable: async (name) =>
    `enabled ${name} (${(await tool($, 'enable_server', { name })).tool_count ?? 0} tools)`,
  disable: async (name) => {
    await tool($, 'disable_server', { name });

    return `disabled ${name}`;
  },
  reindex: async (name) => {
    const list = (await api(
      $,
      `/api/servers?query=${encodeURIComponent(name)}`,
    )) as unknown as Json[];
    const r = await api($, `/api/servers/${list.find((s) => s.name === name)?.id}/index`, 'POST');

    return `re-indexed ${name}: +${r.added} ~${r.changed} -${r.removed}`;
  },
  install: async (name, source) => {
    const r = await tool($, 'install_server', { server: name, source });
    if (r.status === 'installed') return `installed ${name} (${r.tool_count} tools)`;
    if (r.status === 'consent_required') return `${name}: consent needed, ask Claude to install it`;

    return `${name}: ${r.status}`;
  },
  find: (query) =>
    void act($, `search "${query}"`, async () => {
      const r = await find($, query);

      return `${r.tools.length} tool(s), ${r.market.length} registry server(s) for "${query}"`;
    }),
  open: () =>
    void $.ui.open({ id: PANE, title: 'agent-discover', focus: true, closeOnEscape: true }),
  dismiss: async () => {
    const snap = await read($, snapshot);
    if (snap) await update($, dismissed, () => signature(snap));
  },
});

export const register: Register = (on) => {
  let isPolling = false;
  let ticks = 0;

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'discover',
      description: 'Open the agent-discover panel; with text, search tools and servers for it',
      argumentHint: '[what you need]',
    });
    void refresh($);
    $.clock.every(TICK_MS, async () => {
      ticks += 1;
      const isOpen = (await $.ui.panes()).some((p) => p.id === PANE);
      if (isPolling || !(isOpen || ticks % IDLE_TICKS === 0)) return;
      isPolling = true;
      await refresh($).finally(() => (isPolling = false));
    });

    return next(e);
  });

  on('command.run', { command: 'discover' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'agent-discover', focus: true, closeOnEscape: true });
    const snap = await refresh($);
    const query = e.args.trim();
    const lines = [snap.isUp ? summary(snap) : 'agent-discover: daemon not reachable'];
    if (query) {
      const r = await find($, query).catch((err) => String(err));
      if (typeof r === 'string') lines.push(r);
      else {
        lines.push(...r.tools.map((t) => `${t.isEnabled ? '+' : '-'} ${t.server}__${t.tool}`));
        lines.push(...r.market.map((m) => `  install: ${m.name} ${m.version}`));
      }
    }

    return { text: lines.join('\n') };
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e);
    const snap = await read($, snapshot);
    if (!snap) return <el.Text dimColor>Loading...</el.Text>;

    return (
      <Panel
        el={el}
        snap={snap}
        found={await read($, found)}
        busy={await read($, busy)}
        notice={await read($, notice)}
        on={handlers($)}
      />
    );
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot);
    if (
      e.props.hasSurvey ||
      !snap?.isUp ||
      (snap.attention.length === 0 && snap.pending === 0) ||
      (await read($, dismissed)) === signature(snap)
    ) {
      return next(e);
    }

    return <Band el={$.ui.resolve(e)} snap={snap} on={handlers($)} />;
  });
};
