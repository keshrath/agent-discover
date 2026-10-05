/* global document, window */
// Host bridge: the official @modelcontextprotocol/ext-apps App client, plus host
// theming and a uniform "render this CallToolResult" loop for every widget.
import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { h, mount } from './dom.js';

/**
 * startWidget({ name, render })
 * render(structuredContent, ctx) -> Node | Node[];
 * ctx = { call, callRaw, openLink, say, rerender }.
 * `call(tool, args)` invokes one of OUR server tools through the host and returns its
 * structuredContent (throws on isError) so actions can re-render in place.
 */
export async function startWidget({ name, render, placeholder }) {
  const root = document.getElementById('root');
  const app = new App(
    { name: `agent-discover-${name}`, version: '2.0.0' },
    {},
    { autoResize: true },
  );
  let last;

  const ctx = {
    async call(tool, args) {
      const res = await ctx.callRaw(tool, args);
      if (res.isError && !res.structuredContent) throw new Error(textOf(res) || `${tool} failed`);
      return res.structuredContent;
    },
    /** Full CallToolResult (call_tool passes upstream results through verbatim). */
    async callRaw(tool, args) {
      return app.callServerTool({ name: tool, arguments: args ?? {} });
    },
    openLink(url) {
      return app.openLink({ url }).catch(() => window.open(url, '_blank', 'noopener'));
    },
    /** Tell the model what the user did in the widget (best effort; host may not support it). */
    say(text) {
      return app.updateModelContext({ content: [{ type: 'text', text }] }).catch(() => undefined);
    },
    current: () => last,
    rerender(sc) {
      last = sc;
      paint();
    },
  };

  const paint = () => {
    try {
      mount(
        root,
        last
          ? render(last, ctx)
          : (placeholder ?? h('div', { class: 'empty' }, 'Waiting for results…')),
      );
    } catch (err) {
      mount(root, h('div', { class: 'alert danger' }, `Render error: ${err.message}`));
    }
  };

  const theme = (hc) => {
    if (!hc) return;
    if (hc.theme) applyDocumentTheme(hc.theme);
    if (hc.styles?.variables) applyHostStyleVariables(hc.styles.variables);
    if (hc.styles?.css?.fonts) applyHostFonts(hc.styles.css.fonts);
  };

  app.addEventListener('hostcontextchanged', theme);
  app.addEventListener('toolinput', (p) => {
    if (!last) mount(root, h('div', { class: 'empty' }, inputHint(p.arguments)));
  });
  app.addEventListener('toolresult', (res) => {
    // install_server's consent_required result is an error that still carries a plan to show.
    if (res.isError && !res.structuredContent) {
      mount(root, h('div', { class: 'alert danger' }, textOf(res) || 'Tool failed'));
      return;
    }
    ctx.rerender(res.structuredContent);
  });
  app.addEventListener('toolcancelled', () =>
    mount(root, h('div', { class: 'empty' }, 'Cancelled.')),
  );

  paint();
  await app.connect(new PostMessageTransport(window.parent, window.parent));
  theme(app.getHostContext());
  return app;
}

function textOf(res) {
  return (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function inputHint(args) {
  if (!args) return 'Working…';
  const q =
    args.query ??
    (Array.isArray(args.queries) ? args.queries.join(', ') : (args.name ?? args.server));
  return q ? `Working on “${q}”…` : 'Working…';
}

/** Run an async action from a button: disables it, shows progress, surfaces errors inline. */
export function action(label, fn, opts = {}) {
  const btn = h('button', { class: ['btn', opts.kind], type: 'button', title: opts.title }, label);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = opts.busy ?? `${label}…`;
    try {
      await fn();
    } catch (err) {
      btn.textContent = prev;
      btn.disabled = false;
      btn.after(h('span', { class: 'inline-error', role: 'alert' }, err.message));
      return;
    }
    if (btn.isConnected) {
      btn.textContent = opts.done ?? prev;
      btn.disabled = Boolean(opts.done);
    }
  });
  return btn;
}
