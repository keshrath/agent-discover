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
    '</main>' +
    '</div>'
  );
};
