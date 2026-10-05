// server_status cards, and the enable_server / disable_server confirmation.
import { h } from '../lib/dom.js';
import { action } from '../lib/bridge.js';
import { header, healthDot, plural, serverState, stateChip } from '../lib/ui.js';

const TOOL_PREVIEW = 12;

export function renderStatus(sc, ctx) {
  const s = sc.servers;
  const n = (f) => s.filter(f).length;
  const quarantined = n((x) => x.quarantined);
  return [
    header(
      `${n((x) => x.enabled)} of ${plural(s.length, 'server')} enabled`,
      [
        `${n((x) => x.connected)} connected`,
        quarantined ? `${quarantined} quarantined` : null,
        `${sc.mode} mode`,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
    s.length
      ? s.map((x) => card(x, sc, ctx))
      : h('div', { class: 'empty' }, 'No servers installed yet. Ask to search for one.'),
  ];
}

function card(s, sc, ctx) {
  return h(
    'section',
    { class: 'card' },
    h(
      'header',
      { class: 'row between' },
      h(
        'div',
        { class: 'grow' },
        h(
          'div',
          { class: 'row gap' },
          healthDot(s.health?.status ?? s.health_status),
          h('span', { class: 'title mono' }, s.name),
          stateChip(serverState(s)),
        ),
        s.description ? h('div', { class: 'desc' }, s.description) : null,
      ),
      h(
        'div',
        { class: 'actions' },
        // enable_server on a quarantined server asks the user to review and approve the change.
        action(
          s.quarantined ? 'Review changes' : s.enabled ? 'Disable' : 'Enable',
          async () => {
            const r = await ctx.call(
              s.enabled && !s.quarantined ? 'disable_server' : 'enable_server',
              { name: s.name },
            );
            ctx.say(`User ${r.enabled ? 'enabled' : 'disabled'} ${s.name}.`);
            const next = await ctx.call('server_status', {});
            ctx.rerender({ ...sc, servers: next.servers });
          },
          { kind: s.enabled && !s.quarantined ? 'ghost' : 'primary' },
        ),
      ),
    ),
    stats(s),
    s.health?.error ? h('div', { class: 'alert danger small mono' }, s.health.error) : null,
  );
}

function stats(s) {
  const items = [
    ['Transport', s.transport],
    ['Source', s.source],
    ['Tools', s.indexed ? String(s.tool_count) : 'not indexed'],
    s.health ? ['Latency', `${s.health.latency_ms} ms`] : null,
    s.error_count ? ['Errors', String(s.error_count)] : null,
    s.last_health_check ? ['Checked', ago(s.last_health_check)] : null,
  ].filter(Boolean);
  return h(
    'dl',
    { class: 'stats' },
    items.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v))),
  );
}

/** enable_server / disable_server result, with the reverse action. */
export function renderToggle(sc, ctx) {
  const tools = sc.tools ?? [];
  const rows = tools.map((t) => h('li', { class: 'tool' }, h('span', { class: 'mono name' }, t)));
  return h(
    'section',
    { class: ['card', 'flash'] },
    h(
      'header',
      { class: 'row between' },
      h(
        'div',
        { class: 'row gap' },
        h('span', { class: 'title mono' }, sc.name),
        stateChip(sc.enabled ? 'enabled' : 'installed'),
        sc.enabled
          ? h('span', { class: 'muted' }, `${plural(sc.tool_count, 'tool')} exposed`)
          : null,
      ),
      h(
        'div',
        { class: 'actions' },
        action(
          sc.enabled ? 'Disable' : 'Enable',
          async () => {
            const r = await ctx.call(sc.enabled ? 'disable_server' : 'enable_server', {
              name: sc.name,
            });
            ctx.say(`User ${r.enabled ? 'enabled' : 'disabled'} ${sc.name}.`);
            ctx.rerender(r);
          },
          { kind: sc.enabled ? 'ghost' : 'primary' },
        ),
      ),
    ),
    sc.enabled
      ? null
      : h('div', { class: 'muted small' }, 'Still installed; its tools stay searchable.'),
    rows.length <= TOOL_PREVIEW
      ? h('ul', { class: 'tools' }, rows)
      : h(
          'div',
          null,
          h('ul', { class: 'tools' }, rows.slice(0, TOOL_PREVIEW)),
          h(
            'details',
            null,
            h('summary', null, `Show ${rows.length - TOOL_PREVIEW} more`),
            h('ul', { class: 'tools' }, rows.slice(TOOL_PREVIEW)),
          ),
        ),
  );
}

function ago(sqlTime) {
  // SQLite datetime('now') is UTC without a zone marker.
  const t = Date.parse(/[zZ+]/.test(sqlTime) ? sqlTime : `${sqlTime.replace(' ', 'T')}Z`);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (!Number.isFinite(s)) return sqlTime;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
