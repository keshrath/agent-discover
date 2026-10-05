// Shared presentational pieces (chips, badges, links). Pure DOM via h().
import { h } from './dom.js';

const TONE = {
  QUARANTINED: 'danger',
  connected: 'success',
  enabled: 'success',
  installed: 'info',
  available: 'neutral',
};

/** One word for an installed server's state, most significant first (mirrors text.ts). */
export function serverState(s) {
  return s.quarantined
    ? 'QUARANTINED'
    : s.connected
      ? 'connected'
      : s.enabled
        ? 'enabled'
        : 'installed';
}

export function stateChip(state) {
  return h('span', { class: ['chip', TONE[state] ?? 'neutral'] }, state.toLowerCase());
}

const HEALTH = { healthy: 'ok', unhealthy: 'down', unknown: 'unknown' };

export function healthDot(status = 'unknown') {
  return h('span', {
    class: ['dot', `h-${HEALTH[status] ?? 'unknown'}`],
    title: `Health: ${status}`,
    'aria-label': `health ${status}`,
  });
}

export function badge(text, tone = 'neutral', title) {
  return h('span', { class: ['badge', tone], title }, text);
}

const FACT_TONE = { ok: 'success', warn: 'warning', info: 'neutral' };

/** Provenance facts → trust badges. No facts is itself shown as a warning. */
export function provenanceBadges(facts) {
  if (!facts?.length) return [badge('Unverified source', 'warning')];
  return facts.map((f) => badge(f.label, FACT_TONE[f.level] ?? 'neutral', f.detail));
}

export function annotationBadges(a = {}) {
  const out = [];
  if (a.readOnlyHint) out.push(badge('read-only', 'success'));
  if (a.destructiveHint) out.push(badge('destructive', 'danger'));
  if (a.openWorldHint) out.push(badge('open-world', 'info'));
  return out;
}

/** Dashboard deep link (routes in docs/API.md); undefined when the origin is unknown. */
export function dashUrl(ctx, route = '/servers') {
  return ctx.dashboard ? `${ctx.dashboard}/#${route}` : undefined;
}

export function serverRoute(name) {
  return `/servers/${encodeURIComponent(name)}`;
}

export function dashLink(ctx, label, url) {
  if (!url) return null;
  return h(
    'a',
    {
      class: 'link',
      href: url,
      on: {
        click: (e) => {
          e.preventDefault();
          ctx.openLink(url);
        },
      },
    },
    label,
  );
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function header(ctx, title, subtitle, route) {
  return h(
    'header',
    { class: 'row between head' },
    h(
      'div',
      null,
      h('div', { class: 'title' }, title),
      subtitle ? h('div', { class: 'muted' }, subtitle) : null,
    ),
    dashLink(ctx, 'Dashboard ↗', dashUrl(ctx, route)),
  );
}
