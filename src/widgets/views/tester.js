/* global performance */
// Tool tester: schema-driven form + verbatim CallToolResult viewer.
// Used by the tester widget and inline ("Try") in search results.
import { h } from '../lib/dom.js';
import { action } from '../lib/bridge.js';
import { annotationBadges, badge, dashLink } from '../lib/ui.js';
import { buildForm } from '../lib/schema-form.js';

/** renderTester(get_tool structuredContent, ctx) -> Node */
export function renderTester(gt, ctx) {
  const { tool, server } = gt;
  if (!gt.found)
    return h('div', { class: 'alert warning' }, `No indexed tool ${server} / ${tool}.`);
  const form = buildForm(gt.input_schema);
  const out = h('div', { class: 'result', 'aria-live': 'polite' });
  const error = h('div', { class: 'inline-error', role: 'alert' });

  const run = action(
    'Run',
    async () => {
      error.textContent = '';
      let args;
      try {
        args = form.read();
      } catch (e) {
        error.textContent = e.message;
        return;
      }
      const started = performance.now();
      const res = await ctx.callRaw('call_tool', { server, tool, arguments: args });
      out.replaceChildren(renderResult(res, Math.round(performance.now() - started), ctx));
    },
    { kind: 'primary', busy: 'Running…' },
  );

  return h(
    'section',
    { class: 'tester' },
    h(
      'header',
      { class: 'row between' },
      h(
        'div',
        null,
        h('div', { class: 'title mono' }, `${server} / ${tool}`),
        gt.title ? h('div', { class: 'muted' }, gt.title) : null,
      ),
      h('div', { class: 'badges' }, annotationBadges(gt.annotations)),
    ),
    gt.description ? h('p', { class: 'desc' }, gt.description) : null,
    gt.enabled
      ? null
      : h(
          'div',
          { class: 'alert warning' },
          `${server} is not enabled — running connects it for this call only.`,
        ),
    h(
      'form',
      {
        class: 'sf-form',
        on: {
          submit: (e) => {
            e.preventDefault();
            run.click();
          },
        },
      },
      form.el,
      h('div', { class: 'row gap' }, run, error),
    ),
    out,
  );
}

export function renderResult(res, ms, ctx) {
  const blocks = (res.content ?? []).map((c) => block(c, ctx));
  const raw = h('pre', { class: 'code' }, JSON.stringify(res, null, 2));
  const details = h('details', { class: 'raw' }, h('summary', null, 'Raw result'), raw);
  return h(
    'div',
    { class: ['result-card', res.isError ? 'is-error' : null] },
    h(
      'div',
      { class: 'row gap' },
      res.isError ? badge('isError', 'danger') : badge('ok', 'success'),
      ms === undefined ? null : h('span', { class: 'muted' }, `${ms} ms`),
      h('span', { class: 'muted' }, `${(res.content ?? []).length} block(s)`),
    ),
    blocks,
    res.structuredContent === undefined
      ? null
      : h(
          'div',
          null,
          h('div', { class: 'label' }, 'structuredContent'),
          h('pre', { class: 'code' }, JSON.stringify(res.structuredContent, null, 2)),
        ),
    details,
  );
}

function block(c, ctx) {
  switch (c.type) {
    case 'text':
      return h('pre', { class: 'code text' }, c.text);
    case 'image':
      return h('img', {
        class: 'shot',
        alt: 'tool image',
        src: `data:${c.mimeType};base64,${c.data}`,
      });
    case 'resource_link':
      return h(
        'div',
        { class: 'row gap' },
        badge('link', 'info'),
        /^https?:/i.test(c.uri)
          ? dashLink(ctx, c.name ?? c.uri, c.uri)
          : h('span', { class: 'mono' }, c.name ?? c.uri),
        h('span', { class: 'muted' }, c.uri),
      );
    case 'resource':
      return h(
        'pre',
        { class: 'code' },
        c.resource?.text ??
          `[${c.resource?.mimeType ?? 'binary'} resource ${c.resource?.uri ?? ''}]`,
      );
    default:
      return h('pre', { class: 'code' }, JSON.stringify(c, null, 2));
  }
}
