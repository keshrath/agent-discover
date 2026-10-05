/* global document, window, URLSearchParams */
// Standalone MCP Apps host for the widget, built on the official ext-apps AppBridge.
// Each scenario mounts the real widget HTML in a sandboxed iframe, sends a mock
// tool result and answers the widget's tools/call requests from fixtures.
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

// Real tool results (window.__fx, from tests/widgets/capture.ts) and a real daemon behind
// window.__callTool (both installed by shoot.ts) drive every scenario.
const fx = window.__fx;
const SCENARIOS = [
  ['search_servers', 'search_servers', { query: 'fixture' }, 'search_servers'],
  ['search_tools', 'search_tools', { queries: ['echo text', 'weather data'] }, 'search_tools'],
  ['server_status', 'server_status', {}, 'server_status'],
  ['install_plan', 'install_server', { name: 'weather' }, 'install_server_consent'],
  ['get_tool', 'get_tool', { server: 'fixture', tool: 'structured' }, 'get_tool'],
];

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const only = params.get('only');
document.documentElement.dataset.theme = theme;
window.__calls = [];
window.__links = [];
window.__context = [];

async function mount(id, tool, args, key) {
  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.id = `p-${id}`;
  const h = document.createElement('h2');
  h.textContent = tool;
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
  bridge.oncalltool = ({ name, arguments: a = {} }) => {
    window.__calls.push({ name, arguments: a });
    return window.__callTool(name, a);
  };
  bridge.onopenlink = async ({ url }) => (window.__links.push(url), {});
  bridge.onupdatemodelcontext = async (p) => (window.__context.push(p), {});
  bridge.onsizechange = ({ height }) => {
    if (height) frame.style.height = `${Math.ceil(height)}px`;
  };
  bridge.oninitialized = async () => {
    await bridge.sendToolInput({ arguments: args });
    await bridge.sendToolResult(fx[key]);
    panel.dataset.ready = '1';
  };
  // The iframe's WindowProxy survives navigation, so listen before the widget boots.
  await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
  frame.srcdoc = window.WIDGET_HTML;
}

for (const [id, tool, args, key] of SCENARIOS)
  if (!only || only === id) await mount(id, tool, args, key);
