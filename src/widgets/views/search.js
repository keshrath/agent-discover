// search_servers / search_tools results.
import { h } from '../lib/dom.js';
import { action } from '../lib/bridge.js';
import { badge, dashLink, header, plural, serverRoute, dashUrl, stateChip } from '../lib/ui.js';
import { renderTester } from './tester.js';
import { renderInstall } from './install.js';

export function renderSearchServers(sc, ctx) {
  const total = sc.installed.length + sc.marketplace.length;
  const route = `/browse?q=${encodeURIComponent(sc.query)}`;
  return [
    header(
      ctx,
      total ? plural(total, 'server') : 'No servers found',
      `for “${sc.query}” · ${sc.installed.length} installed · ${sc.marketplace.length} in registries`,
      route,
    ),
    total
      ? h(
          'ul',
          { class: 'list' },
          sc.installed.map((s) => installedRow(s, ctx)),
          sc.marketplace.map((s) => marketRow(s, ctx)),
        )
      : h('div', { class: 'empty' }, 'Try broader terms.'),
    sc.marketplace_error
      ? h(
          'div',
          { class: 'alert warning small' },
          `Registry search failed: ${sc.marketplace_error}`,
        )
      : null,
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
    [
      h('span', { class: 'name mono' }, s.name),
      stateChip(s.enabled ? 'enabled' : 'installed'),
      dashLink(ctx, '↗', dashUrl(ctx, serverRoute(s.name))),
    ],
    s.description,
    [badge(plural(s.tool_count, 'tool'))],
    toggle(),
  );
}

/** install_server arguments for a registry entry: remote endpoint or package (npm pinned). */
export function installArgs(s) {
  const p = s.packages[0];
  const name = (s.name.split('/').pop() ?? s.name).replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!p) return { name, description: s.description };
  if (p.url)
    return {
      name,
      url: p.url,
      transport: p.runtime === 'sse' ? 'sse' : 'streamable-http',
      description: s.description,
    };
  const exact = p.runtime === 'node' && /^\d+\.\d+\.\d+/.test(p.version);
  return {
    name,
    package: exact ? `${p.name}@${p.version}` : p.name,
    ...(['node', 'python', 'docker'].includes(p.runtime) ? { runtime: p.runtime } : {}),
    description: s.description,
  };
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
      p ? badge(`${p.registry} ${p.name}`, 'neutral', p.url ?? undefined) : null,
      s.repository ? dashLink(ctx, 'source ↗', s.repository) : null,
    ],
    p
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
      ctx,
      total ? plural(total, 'tool') : 'No tools found',
      `for ${sc.results.map((r) => `“${r.query}”`).join(', ')}`,
      '/servers',
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
