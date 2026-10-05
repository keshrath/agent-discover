// ui://agent-discover/app.html: one widget for every agent-discover tool result.
import { h } from './lib/dom.js';
import { startWidget } from './lib/bridge.js';
import { viewOf } from './lib/view.js';
import { renderSearchServers, renderSearchTools } from './views/search.js';
import { renderStatus, renderToggle } from './views/server.js';
import { renderInstall } from './views/install.js';
import { renderTester } from './views/tester.js';

const VIEWS = {
  search_servers: renderSearchServers,
  search_tools: renderSearchTools,
  server_status: renderStatus,
  enable_server: renderToggle,
  disable_server: renderToggle,
  install_server: renderInstall,
  get_tool: renderTester,
};

startWidget({
  name: 'app',
  render(sc, ctx) {
    const view = VIEWS[viewOf(sc)];
    return view ? view(sc, ctx) : h('div', { class: 'alert warning' }, 'Nothing to show.');
  },
});
