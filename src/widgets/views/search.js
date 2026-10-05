// search_servers / search_tools results.
import { h } from '../lib/dom.js';
import { action } from '../lib/bridge.js';
import { badge, header, link, plural, stateChip } from '../lib/ui.js';
import { renderTester } from './tester.js';
import { renderInstall } from './install.js';

export function renderSearchServers(sc, ctx) {
  const total = sc.installed.length + sc.marketplace.length;
  return [
    header(
      total ? plural(total, 'server') : 'No servers found',
      `for “${sc.query}” · ${sc.installed.length} installed · ${sc.marketplace.length} in registries`,
    ),
    total
      ? h(
          'ul',
          { class: 'list' },
          sc.installed.map((s) => installedRow(s, ctx)),
          sc.marketplace.map((s) => marketRow(s, ctx)),
        )
      : h('div', { class: 'empty' }, 'Try broader terms.'),
    ...Object.entries(sc.marketplace_errors ?? {}).map(([source, error]) =>
      h('div', { class: 'alert warning small' }, `${source} search failed: ${error}`),
    ),
  ];
}

function installedRow(s, ctx) {
  const toggle = () =>
    action(
      s.enabled ? 'Disable' : 'Enable',
      async () => {
        const r = await ctx.call(s.enabled ? 'disable_server' : 'enable_server', { name: s.name });
        s.enabled = r.enabled;
        if (r.tool_count !== undefined) s.tool_count = r.tool_count;
        ctx.say(`User ${s.enabled ? 'enabled' : 'disabled'} ${s.name}.`);
        ctx.rerender(ctx.current());
      },
      { kind: s.enabled ? 'ghost' : 'primary' },
    );
  return row(
    [h('span', { class: 'name mono' }, s.name), stateChip(s.enabled ? 'enabled' : 'installed')],
    s.description,
    [badge(plural(s.tool_count, 'tool'))],
    toggle(),
  );
}

/** install_server arguments for a search result: its exact name and source; the server plans the rest. */
export function installArgs(s) {
  return { server: s.name, source: s.source };
}

function marketRow(s, ctx) {
  const slot = h('div', { class: 'expand' });
  const p = s.packages[0];
  return row(
    [
      h('span', { class: 'name mono' }, s.name),
      s.version ? h('span', { class: 'muted' }, `v${s.version}`) : null,
      stateChip('available'),
    ],
    s.description,
    [
      p ? badge(`${p.registry_type} ${p.identifier}`, 'neutral') : null,
      s.status !== 'active' ? badge(s.status, 'warning') : null,
      s.repository ? link(ctx, 'source ↗', s.repository) : null,
    ],
    p || s.remotes.length
      ? action(
          'Install',
          async () => {
            // The host shows the consent prompt (elicitation) with the exact command.
            const res = await ctx.call('install_server', installArgs(s));
            slot.replaceChildren(renderInstall(res, ctx));
          },
          { done: 'See below' },
        )
      : null,
    slot,
  );
}

function row(titleParts, description, badges, act, slot) {
  return h(
    'li',
    { class: 'item' },
    h(
      'div',
      { class: 'row between' },
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'row gap' }, titleParts),
        description ? h('div', { class: 'desc clamp' }, description) : null,
        h('div', { class: 'badges' }, badges),
      ),
      h('div', { class: 'actions' }, act),
    ),
    slot,
  );
}

export function renderSearchTools(sc, ctx) {
  const total = sc.results.reduce((n, r) => n + r.matches.length, 0);
  return [
    header(
      total ? plural(total, 'tool') : 'No tools found',
      `for ${sc.results.map((r) => `“${r.query}”`).join(', ')}`,
    ),
    total
      ? sc.results.map((r) =>
          r.matches.length
            ? h(
                'section',
                null,
                sc.results.length > 1 ? h('div', { class: 'label' }, r.query) : null,
                h(
                  'ul',
                  { class: 'list' },
                  r.matches.map((m) => toolRow(m, sc, ctx)),
                ),
              )
            : null,
        )
      : h(
          'div',
          { class: 'empty' },
          'Try search_servers to find a server that provides this capability.',
        ),
  ];
}

function toolRow(m, sc, ctx) {
  const slot = h('div', { class: 'expand' });
  return row(
    [
      h('span', { class: 'name mono' }, m.exposed ? m.name : m.tool),
      h('span', { class: 'muted' }, `on ${m.server}`),
      stateChip(m.enabled ? 'enabled' : 'installed'),
      h('span', { class: 'score', title: 'relevance' }, `${Math.round(m.score * 100)}%`),
    ],
    m.title ? `${m.title}: ${m.description}` : m.description,
    [
      m.required_args.map((a) => badge(a.name, 'info', a.description ?? a.type)),
      m.optional_count ? badge(`+${m.optional_count} optional`) : null,
    ],
    [
      m.enabled
        ? null
        : action(
            'Enable server',
            async () => {
              await ctx.call('enable_server', { name: m.server });
              for (const r of sc.results)
                for (const o of r.matches) if (o.server === m.server) o.enabled = true;
              ctx.say(`User enabled ${m.server}; its tools are now available.`);
              ctx.rerender(sc);
            },
            { kind: 'primary' },
          ),
      action(
        'Try',
        async () => {
          const gt = await ctx.call('get_tool', { server: m.server, tool: m.tool });
          slot.replaceChildren(renderTester(gt, ctx));
        },
        { kind: 'ghost' },
      ),
    ],
    slot,
  );
}
