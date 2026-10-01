/* global document, window, URLSearchParams, setTimeout */
// Standalone MCP Apps host for the widget, built on the official ext-apps AppBridge.
// Each scenario mounts the real widget HTML in a sandboxed iframe, sends a mock
// tool result and answers the widget's tools/call requests from fixtures.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import fx from '../fixtures.json';

const SCENARIOS = [
  ['search_servers', 'search_servers', { query: 'postgres database' }],
  ['search_tools', 'search_tools', { queries: ['run sql query', 'list tables'] }],
  ['server_status', 'server_status', {}],
  ['install_plan', 'install_server', { name: 'io.github.neondatabase/mcp-server-neon' }],
  ['get_tool', 'get_tool', { server: 'postgres', tool: 'query' }],
];

const clone = (o) => JSON.parse(JSON.stringify(o));
const ok = (sc) => ({
  content: [{ type: 'text', text: JSON.stringify(sc) }],
  structuredContent: sc,
});

function statusFor(name, state) {
  const base = fx.server_status.servers.find((s) => s.name === name) ?? {
    name,
    source: 'local',
    tools: [],
  };
  return {
    kind: 'server_status',
    totals: fx.server_status.totals,
    servers: [{ ...clone(base), state }],
    changed: { server: name, action: state === 'enabled' ? 'enabled' : 'disabled' },
  };
}

async function onCall({ name, arguments: a = {} }) {
  window.__calls.push({ name, arguments: a });
  await new Promise((r) => setTimeout(r, 250));
  switch (name) {
    case 'enable_server':
      return ok(statusFor(a.name, 'enabled'));
    case 'disable_server':
      return ok(statusFor(a.name, 'installed'));
    case 'install_server':
      return ok(a.consentToken ? fx.install_outcome : fx.install_plan);
    case 'get_tool':
      return ok({
        ...clone(fx.get_tool),
        server: a.server,
        tool: { ...fx.get_tool.tool, name: a.tool },
      });
    case 'call_tool':
      return clone(fx.call_tool);
    case 'server_status':
      return ok(fx.server_status);
    default:
      return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  }
}

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const only = params.get('only');
document.documentElement.dataset.theme = theme;
window.__calls = [];
window.__links = [];
window.__context = [];

async function mount(id, tool, args) {
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.id = `p-${id}`;
  const h = document.createElement('h2');
  h.textContent = `${tool} → ${id}`;
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-forms');
  frame.title = id;
  panel.append(h, frame);
  document.getElementById('grid').append(panel);

  const bridge = new AppBridge(
    null,
    { name: 'w4-harness', version: '0.0.0' },
    { openLinks: {}, serverTools: {}, updateModelContext: { text: {} }, logging: {} },
    {
      hostContext: {
        theme,
        displayMode: 'inline',
        platform: 'web',
        toolInfo: { tool: { name: tool, inputSchema: { type: 'object' } } },
      },
    },
  );
  bridge.oncalltool = (p) => onCall(p);
  bridge.onopenlink = async ({ url }) => (window.__links.push(url), {});
  bridge.onupdatemodelcontext = async (p) => (window.__context.push(p), {});
  bridge.onsizechange = ({ height }) => {
    if (height) frame.style.height = `${Math.ceil(height)}px`;
  };
  bridge.oninitialized = async () => {
    await bridge.sendToolInput({ arguments: args });
    await bridge.sendToolResult(ok(clone(fx[id])));
    panel.dataset.ready = '1';
  };
  // The iframe's WindowProxy survives navigation, so listen before the widget boots.
  await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
  frame.srcdoc = window.WIDGET_HTML;
}

for (const [id, tool, args] of SCENARIOS) if (!only || only === id) await mount(id, tool, args);
