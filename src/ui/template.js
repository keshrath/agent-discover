/* eslint-disable */
var AD = (window.AD = window.AD || {});
AD._template = function () {
  return (
    '<div class="layout">' +
    '<aside class="sidebar">' +
    '<div class="sidebar-header">' +
    '<span class="material-symbols-outlined sidebar-icon">widgets</span>' +
    '<div>' +
    '<div class="sidebar-title">agent-discover</div>' +
    '<div class="sidebar-version" id="version">v0.0.0</div>' +
    '</div>' +
    '</div>' +
    '<nav class="sidebar-nav">' +
    '<button class="nav-item active" data-tab="installed">' +
    '<span class="material-symbols-outlined">dns</span>' +
    '<span>Servers</span>' +
    '<span class="badge" id="installed-count">0</span>' +
    '</button>' +
    '<button class="nav-item" data-tab="browse">' +
    '<span class="material-symbols-outlined">explore</span>' +
    '<span>Browse</span>' +
    '</button>' +
    '<button class="nav-item" data-tab="logs">' +
    '<span class="material-symbols-outlined">receipt_long</span>' +
    '<span>Logs</span>' +
    '<span class="badge" id="log-count">0</span>' +
    '</button>' +
    '</nav>' +
    '<div class="sidebar-footer">' +
    '<span class="connection-status" id="conn-status">' +
    '<span class="conn-dot"></span>' +
    'Connecting...' +
    '</span>' +
    '<button class="theme-toggle" id="theme-toggle" title="Toggle theme">' +
    '<span class="material-symbols-outlined">dark_mode</span>' +
    '</button>' +
    '</div>' +
    '</aside>' +
    '<main class="content">' +
    '<section class="tab-panel active" id="tab-installed">' +
    '<div class="panel-header">' +
    '<h2 class="section-title">Servers</h2>' +
    '<button class="btn-add-server" id="add-server-toggle">' +
    '<span class="material-symbols-outlined" style="font-size:16px">add</span>' +
    ' Add Server' +
    '</button>' +
    '</div>' +
    '<div id="add-server-panel" class="add-server-panel" style="display:none">' +
    '<div class="add-server-form">' +
    '<div class="form-row">' +
    '<div class="form-field"><label>Name</label><input type="text" id="add-name" placeholder="my-server" /></div>' +
    '<div class="form-field"><label>Transport</label>' +
    '<select id="add-transport"><option value="stdio">Local (stdio)</option><option value="streamable-http">Remote URL</option></select>' +
    '</div>' +
    '</div>' +
    '<div class="form-row" id="add-stdio-fields">' +
    '<div class="form-field"><label>Command</label><input type="text" id="add-command" placeholder="npx" /></div>' +
    '<div class="form-field" style="flex:2"><label>Args (comma-separated)</label><input type="text" id="add-args" placeholder="-y, @some/package" /></div>' +
    '</div>' +
    '<div class="form-row" id="add-url-fields" style="display:none">' +
    '<div class="form-field" style="flex:2"><label>URL</label><input type="text" id="add-url" placeholder="https://example.com/mcp" /></div>' +
    '</div>' +
    '<div class="form-row">' +
    '<div class="form-field" style="flex:2"><label>Description</label><input type="text" id="add-desc" placeholder="Optional description" /></div>' +
    '</div>' +
    '<div class="form-row">' +
    '<div class="form-field"><label>Env vars (KEY=VALUE per line)</label><textarea id="add-env" rows="2" placeholder="API_KEY=secret"></textarea></div>' +
    '<div class="form-field"><label>Tags (comma-separated)</label><input type="text" id="add-tags" placeholder="odoo, remote" /></div>' +
    '</div>' +
    '<div class="form-row">' +
    '<button class="btn-submit-server" data-action="submit-add-server">' +
    '<span class="material-symbols-outlined" style="font-size:14px">save</span> Register' +
    '</button>' +
    '</div>' +
    '</div>' +
    '</div>' +
    '<div id="installed-list" class="server-grid">' +
    '<div class="empty-state">' +
    '<span class="material-symbols-outlined empty-icon">dns</span>' +
    '<p>No servers registered</p>' +
    '<p class="hint">Use registry_install or browse the marketplace</p>' +
    '</div>' +
    '</div>' +
    '</section>' +
    '<section class="tab-panel" id="tab-browse">' +
    '<div class="panel-header">' +
    '<h2 class="section-title">Browse MCP Registry</h2>' +
    '<div class="search-bar">' +
    '<span class="material-symbols-outlined">search</span>' +
    '<input type="text" id="browse-search" placeholder="Search MCP servers..." autocomplete="off" />' +
    '</div>' +
    '</div>' +
    '<div id="browse-list" class="server-grid">' +
    '<div class="empty-state">' +
    '<span class="material-symbols-outlined empty-icon">explore</span>' +
    '<p>Search the official MCP registry</p>' +
    '<p class="hint">Type a query above to discover servers</p>' +
    '</div>' +
    '</div>' +
    '</section>' +
    '<section class="tab-panel" id="tab-logs">' +
    '<div class="panel-header">' +
    '<h2 class="section-title">Call Logs</h2>' +
    '<div class="log-filters">' +
    '<select id="log-filter-server"><option value="">All servers</option></select>' +
    '<select id="log-filter-status"><option value="">All</option><option value="success">Success</option><option value="fail">Failed</option></select>' +
    '<button class="btn-clear-logs" data-action="clear-logs"><span class="material-symbols-outlined" style="font-size:14px">delete_sweep</span> Clear All</button>' +
    '</div>' +
    '</div>' +
    '<div id="logs-list" class="logs-table-wrap">' +
    '<div class="empty-state">' +
    '<span class="material-symbols-outlined empty-icon">receipt_long</span>' +
    '<p>No tool calls logged yet</p>' +
    '<p class="hint">Logs appear when proxied tools are called</p>' +
    '</div>' +
    '</div>' +
    '</section>' +
    '</main>' +
    '</div>'
  );
};
