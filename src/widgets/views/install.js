// install_server result: outcome plus the install plan (exact command or endpoint,
// env/header keys without values, provenance badges). Consent itself is the host's
// elicitation prompt; when the host cannot show one (consent_required) the plan is
// shown with where the user can install it instead.
import { h } from '../lib/dom.js';
import { action } from '../lib/bridge.js';
import { badge, plural, provenanceBadges } from '../lib/ui.js';

const quote = (a) => (/[\s"'`$]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a);

export function renderInstall(sc, ctx) {
  const plan = sc.plan;
  switch (sc.status) {
    case 'installed':
      return h(
        'div',
        null,
        h(
          'div',
          { class: ['alert', sc.index_error ? 'warning' : 'success'] },
          h(
            'div',
            null,
            `${sc.name} installed · ${plural(sc.tool_count, 'tool')} indexed${sc.enabled ? ' and exposed' : ''}.`,
          ),
          sc.index_error ? h('div', { class: 'small mono' }, sc.index_error) : null,
          sc.enabled
            ? null
            : h(
                'div',
                { class: 'row gap' },
                action('Enable now', () => ctx.call('enable_server', { name: sc.name }), {
                  kind: 'primary',
                  done: 'Enabled ✓',
                }),
              ),
        ),
        plan ? h('details', null, h('summary', null, 'What was installed'), planCard(plan)) : null,
      );
    case 'already_installed':
      return h(
        'div',
        { class: 'alert info' },
        `${sc.name} is already installed (${plural(sc.tool_count, 'tool')}, ${sc.enabled ? 'enabled' : 'not enabled'}).`,
      );
    case 'declined':
      return h(
        'div',
        { class: 'alert neutral' },
        `Install of ${sc.name} declined. Nothing was installed.`,
      );
    default:
      return h(
        'section',
        { class: 'consent' },
        h(
          'header',
          { class: 'row between' },
          h(
            'div',
            null,
            h('div', { class: 'title' }, `Install ${sc.name}?`),
            h('div', { class: 'muted' }, 'This host cannot show the confirmation prompt.'),
          ),
          h('span', { class: 'lock', title: 'Nothing runs until you approve' }, 'Not installed'),
        ),
        plan ? planCard(plan) : null,
        h(
          'div',
          { class: 'muted small' },
          `Install it in Claude Code with /discover ${plan?.package ?? sc.name}, or have an operator set AGENT_DISCOVER_ALLOW_UNCONFIRMED_INSTALL=1.`,
        ),
      );
  }
}

/** The plan as shown before consent. Field-tolerant: absent parts are skipped. */
export function planCard(p) {
  return h(
    'div',
    { class: 'plan' },
    h('div', { class: 'badges' }, provenanceBadges(p.provenance)),
    p.command ? commandBlock(p.command, p.args ?? []) : null,
    p.url
      ? h(
          'div',
          null,
          h('div', { class: 'label' }, `Connects to (${p.transport})`),
          h('pre', { class: 'code cmd' }, p.url),
        )
      : null,
    keys('Environment variables', p.env_keys),
    keys('Headers', p.header_keys),
  );
}

function keys(label, list) {
  if (!list?.length) return null;
  return h(
    'div',
    null,
    h('div', { class: 'label' }, label),
    h(
      'div',
      { class: 'badges' },
      list.map((k) => badge(k, 'warning', 'value is never shown')),
    ),
  );
}

function commandBlock(command, args) {
  // One token per span so whitespace/quotes inside args stay visible and unambiguous.
  return h(
    'div',
    null,
    h('div', { class: 'label' }, 'Runs on this machine'),
    h(
      'pre',
      { class: 'code cmd' },
      h('span', { class: 'tok cmd-name' }, quote(command)),
      args.map((a) => [' ', h('span', { class: 'tok', title: JSON.stringify(a) }, quote(a))]),
    ),
  );
}
