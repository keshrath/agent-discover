/* eslint-disable */
// =============================================================================
// agent-discover — Dashboard client
// =============================================================================

(function () {
  'use strict';

  var AD = (window.AD = window.AD || {});
  AD._baseUrl = '';
  AD._fetch = function (url, opts) {
    return fetch(AD._baseUrl + url, opts);
  };
  AD._wsUrl = null;
  AD._root = document;

  let state = { servers: [], active: [], version: '0.0.0' };
  let ws = null;
  let browseResults = [];
  let currentTab = 'installed';
  let searchTimeout = null;
  let openSections = {};
  let prereqs = null;
  let logEntries = [];
  let logFilter = { server: '', status: '', search: '', from: '', to: '' };

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + (AD._wsUrl || location.host));

    ws.onopen = function () {
      setConnectionStatus('connected', 'Connected');
    };

    ws.onmessage = function (evt) {
      try {
        var msg = JSON.parse(evt.data);
        if (msg.type === 'state') {
          state = {
            servers: msg.servers || state.servers,
            active: msg.active || state.active,
            version: msg.version || state.version,
          };
          render();
        } else if (msg.type === 'log_entry' && msg.entry) {
          logEntries.unshift(msg.entry);
          if (logEntries.length > 500) logEntries.length = 500;
          updateLogCount();
          if (currentTab === 'logs') renderLogs();
        }
      } catch (e) {
        console.error('WS parse error:', e);
      }
    };

    ws.onclose = function () {
      setConnectionStatus('disconnected', 'Disconnected');
      setTimeout(connect, 2000);
    };

    ws.onerror = function () {
      ws.close();
    };
  }

  function setConnectionStatus(cls, text) {
    var el = AD._root.getElementById('conn-status');
    if (!el) return;
    el.className = 'connection-status ' + cls;
    el.innerHTML = '<span class="conn-dot"></span>' + text;
  }

  // -------------------------------------------------------------------------
  // Tab navigation
  // -------------------------------------------------------------------------

  function switchTab(tab) {
    currentTab = tab;
    var navItems = AD._root.querySelectorAll('.nav-item');
    navItems.forEach(function (n) {
      n.classList.remove('active');
      if (n.dataset.tab === tab) n.classList.add('active');
    });
    AD._root.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.remove('active');
    });
    AD._root.getElementById('tab-' + tab).classList.add('active');
    if (tab === 'logs') renderLogs();
    try {
      history.replaceState(null, '', '#' + tab);
    } catch (e) {
      /* ignore */
    }
  }

  function initTabs() {
    var navItems = AD._root.querySelectorAll('.nav-item');
    navItems.forEach(function (item) {
      item.addEventListener('click', function () {
        switchTab(this.dataset.tab);
      });
    });

    var hash = location.hash.replace('#', '');
    if (hash && AD._root.getElementById('tab-' + hash)) {
      switchTab(hash);
    }
  }

  // -------------------------------------------------------------------------
  // Theme toggle
  // -------------------------------------------------------------------------

  function initTheme() {
    var toggle = AD._root.getElementById('theme-toggle');
    var saved = localStorage.getItem('agent-discover-theme');
    if (saved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else if (saved === 'light') {
      document.documentElement.removeAttribute('data-theme');
    }
    var currentTheme =
      document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    updateThemeIcon(currentTheme);

    // When mounted as an embedded plugin inside agent-desk, the shadow root
    // may not contain a #theme-toggle element (the host drives theming).
    // Bail out gracefully instead of throwing on the click wiring.
    if (!toggle) return;

    toggle.addEventListener('click', function () {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      var next = isDark ? 'light' : 'dark';
      if (next === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
      localStorage.setItem('agent-discover-theme', next);
      updateThemeIcon(next);
      // Reverse sync — notify agent-desk shell
      console.log('__agent_desk_theme__:' + next);
    });
  }

  function updateThemeIcon(theme) {
    var toggle = AD._root.getElementById('theme-toggle');
    if (!toggle) return;
    var icon = toggle.querySelector('.material-symbols-outlined');
    if (icon) icon.textContent = theme === 'dark' ? 'dark_mode' : 'light_mode';
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  function initSearch() {
    var input = AD._root.getElementById('browse-search');
    input.addEventListener('input', function () {
      clearTimeout(searchTimeout);
      var q = this.value.trim();
      if (!q) {
        browseResults = [];
        renderBrowse();
        return;
      }
      searchTimeout = setTimeout(function () {
        fetchBrowse(q);
      }, 400);
    });
  }

  function fetchPrereqs() {
    AD._fetch('/api/prereqs')
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        prereqs = data;
        renderBrowse();
      })
      .catch(function () {
        /* prereqs are advisory only — never block UI */
      });
  }

  function fetchBrowse(query) {
    var el = AD._root.getElementById('browse-list');
    el.innerHTML = '<div class="loading">Searching...</div>';

    AD._fetch('/api/browse?query=' + encodeURIComponent(query) + '&limit=20')
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        browseResults = data.servers || [];
        renderBrowse();
      })
      .catch(function () {
        el.innerHTML =
          '<div class="empty-state"><span class="material-symbols-outlined empty-icon">error</span><p>Failed to fetch from registry</p></div>';
      });
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  function render() {
    AD._root.getElementById('version').textContent = 'v' + state.version;
    AD._root.getElementById('installed-count').textContent = String(state.servers.length);
    updateLogCount();
    updateLogServerFilter();
    renderInstalled();
  }

  function updateLogCount() {
    var el = AD._root.getElementById('log-count');
    if (el) el.textContent = String(logEntries.length);
  }

  function updateLogServerFilter() {
    var sel = AD._root.getElementById('log-filter-server');
    if (!sel) return;
    var servers = {};
    logEntries.forEach(function (e) {
      servers[e.server] = true;
    });
    state.servers.forEach(function (s) {
      servers[s.name] = true;
    });
    var names = Object.keys(servers).sort();
    var current = sel.value;
    var opts =
      '<option value="">All servers</option>' +
      names
        .map(function (n) {
          return (
            '<option value="' +
            escAttr(n) +
            '"' +
            (n === current ? ' selected' : '') +
            '>' +
            esc(n) +
            '</option>'
          );
        })
        .join('');
    sel.innerHTML = opts;
  }

  function renderInstalled() {
    var el = AD._root.getElementById('installed-list');
    if (!state.servers.length) {
      el.innerHTML =
        '<div class="empty-state"><span class="material-symbols-outlined empty-icon">dns</span><p>No servers registered</p><p class="hint">Use registry_install or browse the marketplace</p></div>';
      return;
    }

    var html = state.servers
      .map(function (s) {
        var statusClass = s.active
          ? s.health_status === 'unhealthy'
            ? 'unhealthy'
            : 'active'
          : 'inactive';
        var statusLabel = s.active
          ? s.health_status === 'unhealthy'
            ? 'Unhealthy'
            : 'Active'
          : 'Inactive';

        var healthStatus = s.health_status || 'unknown';

        var errorCount =
          s.error_count > 0
            ? '<span class="error-count">' +
              s.error_count +
              ' error' +
              (s.error_count > 1 ? 's' : '') +
              '</span>' +
              '<button class="btn-clear-errors" data-action="clear-errors" data-id="' +
              s.id +
              '" title="Clear errors">' +
              '<span class="material-symbols-outlined" style="font-size:12px">close</span>' +
              '</button>'
            : '';

        var tags = (s.tags || [])
          .map(function (t) {
            return '<span class="tag">' + esc(t) + '</span>';
          })
          .join('');
        var tools = (s.tools || [])
          .map(function (t) {
            return (
              '<div class="tool-item"><span class="tool-name">' +
              esc(t.name) +
              '</span><span class="tool-desc">' +
              esc(t.description || '') +
              '</span></div>'
            );
          })
          .join('');
        var toolSection =
          s.tools && s.tools.length
            ? '<div class="server-tools"><div class="server-tools-title">Tools (' +
              s.tools.length +
              ')</div><div class="tool-list">' +
              tools +
              '</div></div>'
            : '';

        var actionBtn = s.active
          ? '<button class="btn-deactivate" data-action="deactivate" data-id="' +
            s.id +
            '"><span class="material-symbols-outlined" style="font-size:14px">stop_circle</span>Deactivate</button>'
          : '<button class="btn-activate" data-action="activate" data-id="' +
            s.id +
            '"><span class="material-symbols-outlined" style="font-size:14px">play_circle</span>Activate</button>';

        var healthBtn =
          '<button class="btn-health" data-action="health" data-id="' +
          s.id +
          '"><span class="material-symbols-outlined" style="font-size:14px">favorite</span>Check Health</button>';

        var deleteBtn =
          '<button class="btn-delete" data-action="delete" data-id="' +
          s.id +
          '" data-name="' +
          escAttr(s.name) +
          '"><span class="material-symbols-outlined" style="font-size:14px">delete</span>Delete</button>';

        var actionsSection =
          '<div class="server-actions">' + actionBtn + healthBtn + deleteBtn + '</div>';

        // Expandable sections
        var secretsSection = renderSection(s.id, 'secrets', 'Secrets', renderSecretsContent(s));
        var metricsSection = renderSection(s.id, 'metrics', 'Metrics', renderMetricsContent(s));
        var configSection = renderSection(s.id, 'config', 'Config', renderConfigContent(s));

        return (
          '<div class="server-card">' +
          '<div class="server-card-header">' +
          '<div style="display:flex;align-items:center;gap:8px">' +
          '<span class="server-name">' +
          esc(s.name) +
          '</span>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
          errorCount +
          '<span class="server-status"><span class="status-dot ' +
          statusClass +
          '"></span>' +
          statusLabel +
          '</span>' +
          '</div>' +
          '</div>' +
          '<div class="server-description">' +
          esc(s.description || '') +
          '</div>' +
          (tags ? '<div class="server-tags">' + tags + '</div>' : '') +
          '<div class="server-meta">' +
          '<span>' +
          esc(s.source || 'local') +
          '</span>' +
          '<span>' +
          (function () {
            var t = s.transport || 'stdio';
            if (t === 'sse') return 'remote sse';
            if (t === 'streamable-http') return 'remote http';
            return 'local stdio';
          })() +
          '</span>' +
          (s.transport && s.transport !== 'stdio' && s.homepage
            ? '<span style="font-size:11px;color:var(--text-muted)">' + esc(s.homepage) + '</span>'
            : '') +
          '</div>' +
          toolSection +
          actionsSection +
          secretsSection +
          metricsSection +
          configSection +
          '</div>'
        );
      })
      .join('');

    morph(el, html);
  }

  // -------------------------------------------------------------------------
  // Expandable section helper
  // -------------------------------------------------------------------------

  function renderSection(serverId, name, label, content) {
    var key = serverId + '-' + name;
    var isOpen = openSections[key] || false;
    return (
      '<div class="server-section">' +
      '<button class="section-toggle' +
      (isOpen ? ' open' : '') +
      '" data-action="toggle-section" data-id="' +
      serverId +
      '" data-section="' +
      name +
      '">' +
      '<span class="material-symbols-outlined">chevron_right</span>' +
      esc(label) +
      '</button>' +
      '<div class="section-content' +
      (isOpen ? ' open' : '') +
      '">' +
      content +
      '</div>' +
      '</div>'
    );
  }

  // -------------------------------------------------------------------------
  // Secrets section content
  // -------------------------------------------------------------------------

  function renderSecretsContent(server) {
    var key = server.id + '-secrets';
    if (!openSections[key]) return '<div class="loading">Click to load...</div>';

    var cached = openSections[key + '-data'];
    if (!cached) return '<div class="loading">Loading...</div>';

    var items = cached
      .map(function (s) {
        return (
          '<div class="secret-item">' +
          '<span class="secret-key">' +
          esc(s.key) +
          '</span>' +
          '<span class="secret-value">' +
          esc(s.masked_value || '********') +
          '</span>' +
          '<button class="secret-delete" data-action="delete-secret" data-id="' +
          server.id +
          '" data-key="' +
          escAttr(s.key) +
          '" title="Delete secret">' +
          '<span class="material-symbols-outlined" style="font-size:14px">close</span>' +
          '</button>' +
          '</div>'
        );
      })
      .join('');

    var addForm =
      '<div class="secret-add-form">' +
      '<input type="text" placeholder="Key" id="secret-key-' +
      server.id +
      '" />' +
      '<input type="password" placeholder="Value" id="secret-val-' +
      server.id +
      '" />' +
      '<button data-action="add-secret" data-id="' +
      server.id +
      '">Save</button>' +
      '</div>';

    return items + addForm;
  }

  // -------------------------------------------------------------------------
  // Metrics section content
  // -------------------------------------------------------------------------

  function renderMetricsContent(server) {
    var key = server.id + '-metrics';
    if (!openSections[key]) return '<div class="loading">Click to load...</div>';

    var cached = openSections[key + '-data'];
    if (!cached) return '<div class="loading">Loading...</div>';

    if (!cached.length)
      return '<div style="font-size:12px;color:var(--text-dim)">No metrics data yet</div>';

    var rows = cached
      .map(function (m) {
        return (
          '<tr>' +
          '<td>' +
          esc(m.tool || m.name || '') +
          '</td>' +
          '<td>' +
          (m.calls || m.call_count || 0) +
          '</td>' +
          '<td>' +
          (m.errors || m.error_count || 0) +
          '</td>' +
          '<td>' +
          (m.avg_latency != null ? m.avg_latency.toFixed(0) + 'ms' : '-') +
          '</td>' +
          '</tr>'
        );
      })
      .join('');

    return (
      '<table class="metrics-table">' +
      '<thead><tr><th>Tool</th><th>Calls</th><th>Errors</th><th>Avg Latency</th></tr></thead>' +
      '<tbody>' +
      rows +
      '</tbody></table>'
    );
  }

  // -------------------------------------------------------------------------
  // Config section content
  // -------------------------------------------------------------------------

  function renderConfigContent(server) {
    return (
      '<div class="config-form">' +
      '<div class="config-field"><label>Description</label>' +
      '<input type="text" id="cfg-desc-' +
      server.id +
      '" value="' +
      escAttr(server.description || '') +
      '" /></div>' +
      '<div class="config-field"><label>Command</label>' +
      '<input type="text" id="cfg-cmd-' +
      server.id +
      '" value="' +
      escAttr(server.command || '') +
      '" /></div>' +
      '<div class="config-field"><label>Args (comma-separated)</label>' +
      '<input type="text" id="cfg-args-' +
      server.id +
      '" value="' +
      escAttr((server.args || []).join(', ')) +
      '" /></div>' +
      '<div class="config-field"><label>Env vars (KEY=VALUE per line)</label>' +
      '<textarea id="cfg-env-' +
      server.id +
      '">' +
      esc(
        Object.entries(server.env || {})
          .map(function (e) {
            return e[0] + '=' + e[1];
          })
          .join('\n'),
      ) +
      '</textarea></div>' +
      '<button class="config-save" data-action="save-config" data-id="' +
      server.id +
      '">Save Config</button>' +
      '</div>'
    );
  }

  function renderPrereqBanner() {
    if (!prereqs) return '';
    var missing = [];
    if (!prereqs.npx) missing.push({ tool: 'npx', hint: 'install Node.js — npx ships with it' });
    if (!prereqs.uvx && !prereqs.uv)
      missing.push({ tool: 'uvx', hint: 'install uv: https://docs.astral.sh/uv/' });
    if (!missing.length) return '';
    return (
      '<div class="prereq-banner" style="padding:10px 14px;margin-bottom:12px;border:1px solid var(--orange,#e67e22);border-radius:6px;background:rgba(230,126,34,0.08);font-size:13px"><strong>Heads up:</strong> ' +
      missing
        .map(function (m) {
          return '<code>' + esc(m.tool) + '</code> not found on PATH (' + esc(m.hint) + ')';
        })
        .join(' &nbsp;·&nbsp; ') +
      '. Installs requiring those tools will fail until they are available.</div>'
    );
  }

  function renderBrowse() {
    var el = AD._root.getElementById('browse-list');
    var banner = renderPrereqBanner();
    if (!browseResults.length) {
      var q = AD._root.getElementById('browse-search').value.trim();
      if (!q) {
        el.innerHTML =
          banner +
          '<div class="empty-state"><span class="material-symbols-outlined empty-icon">explore</span><p>Search the official MCP registry, npm and PyPI</p><p class="hint">Type a query above to discover servers</p></div>';
      } else {
        el.innerHTML =
          banner +
          '<div class="empty-state"><span class="material-symbols-outlined empty-icon">search_off</span><p>No results found</p>' +
          '<a class="hint-link" data-action="show-npm-form">Can\'t find it? Install from npm</a>' +
          '<div class="npm-install-form" style="display:none">' +
          '<input type="text" id="npm-package-input" placeholder="npm package name (e.g. @modelcontextprotocol/server-everything)" />' +
          '<button class="btn-install" data-action="install-npm"><span class="material-symbols-outlined" style="font-size:14px">download</span> Install</button>' +
          '</div></div>';
      }
      return;
    }

    var installedNames = state.servers.map(function (s) {
      return s.name;
    });

    var html = browseResults
      .map(function (s, idx) {
        var pkgs = (s.packages || [])
          .map(function (p) {
            var rt = p.runtime || 'stdio';
            var color =
              rt === 'streamable-http'
                ? 'var(--accent, #5d8da8)'
                : rt === 'sse'
                  ? 'var(--orange, #e67e22)'
                  : 'var(--green, #27ae60)';
            return (
              '<span class="tag" style="border-color:' +
              color +
              ';color:' +
              color +
              '">' +
              esc(rt) +
              ': ' +
              esc(p.name) +
              '</span>'
            );
          })
          .join('');

        var safeName = (s.name || '').replace(/\//g, '-');
        var isInstalled =
          installedNames.indexOf(safeName) !== -1 || installedNames.indexOf(s.name) !== -1;

        // All transport types are supported (stdio, sse, streamable-http)
        var isRemoteOnly = false;

        var installBtn;
        if (isInstalled) {
          installBtn =
            '<button class="btn-install btn-installed" disabled><span class="material-symbols-outlined" style="font-size:14px">check_circle</span>Installed</button>';
        } else if (isRemoteOnly) {
          installBtn =
            '<button class="btn-install" disabled title="Remote server — not supported for local activation"><span class="material-symbols-outlined" style="font-size:14px">cloud_off</span>Remote only</button>';
        } else {
          installBtn =
            '<button class="btn-install" data-action="install-browse" data-browse-idx="' +
            idx +
            '"><span class="material-symbols-outlined" style="font-size:14px">download</span>Install</button>';
        }

        return (
          '<div class="server-card">' +
          '<div class="server-card-header">' +
          '<span class="server-name">' +
          esc(s.name) +
          '</span>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
          (s.version ? '<span class="tag">' + esc(s.version) + '</span>' : '') +
          installBtn +
          '</div>' +
          '</div>' +
          '<div class="server-description">' +
          esc(s.description || '') +
          '</div>' +
          (pkgs ? '<div class="server-tags">' + pkgs + '</div>' : '') +
          (s.repository
            ? '<div class="server-meta"><span class="material-symbols-outlined">code</span><a href="' +
              esc(s.repository) +
              '" target="_blank" style="color:var(--accent)">' +
              esc(s.repository) +
              '</a></div>'
            : '') +
          '</div>'
        );
      })
      .join('');

    morph(el, banner + html);
  }

  function esc(str) {
    if (str === null || str === undefined) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function escAttr(str) {
    return esc(str).replace(/"/g, '&quot;');
  }

  function morph(el, newInnerHTML) {
    var wrap = document.createElement(el.tagName);
    wrap.innerHTML = newInnerHTML;
    morphdom(el, wrap, { childrenOnly: true });
  }

  // -------------------------------------------------------------------------
  // Server actions
  // -------------------------------------------------------------------------

  window.__activateServer = function (id) {
    AD._fetch('/api/servers/' + id + '/activate', { method: 'POST' })
      .then(function (r) {
        return r.json().then(function (data) {
          if (data.error) {
            showToast('Activation failed: ' + data.error, 'error');
          } else if (data.status === 'activated') {
            showToast('Activated with ' + (data.tool_count || 0) + ' tools', 'success');
          }
        });
      })
      .catch(function (err) {
        showToast('Activation failed: ' + err.message, 'error');
      });
  };

  window.__deactivateServer = function (id) {
    AD._fetch('/api/servers/' + id + '/deactivate', { method: 'POST' })
      .then(function (r) {
        return r.json();
      })
      .then(function () {
        // State will refresh via WebSocket
      })
      .catch(function (err) {
        console.error('Deactivate failed:', err);
      });
  };

  window.__deleteServer = function (id, name) {
    if (!confirm('Delete server "' + name + '"?')) return;
    AD._fetch('/api/servers/' + id, { method: 'DELETE' })
      .then(function (r) {
        return r.json();
      })
      .then(function () {
        // State will refresh via WebSocket
      })
      .catch(function (err) {
        console.error('Delete failed:', err);
      });
  };

  window.__installFromBrowse = function (idx, btn) {
    var server = browseResults[idx];
    if (!server) return;

    btn.disabled = true;
    btn.innerHTML =
      '<span class="material-symbols-outlined" style="font-size:14px">hourglass_top</span>Installing...';

    var safeName = (server.name || '').replace(/@/g, '').replace(/\//g, '-');
    // Detect transport and build config
    var pkg = (server.packages || [])[0];
    var runtime = (pkg && (pkg.transport || pkg.runtime)) || 'stdio';
    var remoteUrl = pkg && pkg.url ? pkg.url : null;

    var serverData = {
      name: safeName,
      description: server.description || '',
      source: 'registry',
      transport: runtime,
      tags: ['marketplace'],
    };

    if (runtime === 'streamable-http' || runtime === 'sse') {
      serverData.homepage = remoteUrl || server.repository || '';
    } else if (runtime === 'python' || (pkg && pkg.registry_name === 'pypi')) {
      // PyPI package — install via uvx
      serverData.transport = 'stdio';
      serverData.command = 'uvx';
      serverData.args = [pkg ? pkg.name || server.name : server.name || safeName];
      serverData.tags = ['marketplace', 'pypi'];
    } else {
      // stdio / node — default to npx
      serverData.transport = 'stdio';
      serverData.command = 'npx';
      serverData.args = ['-y', pkg ? pkg.name || server.name : server.name || safeName];
    }

    AD._fetch('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serverData),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Install failed');
        return r.json();
      })
      .then(function (data) {
        if (serverData.command === 'npx' && data && data.id) {
          btn.innerHTML =
            '<span class="material-symbols-outlined" style="font-size:14px">downloading</span>Downloading...';
          return AD._fetch('/api/servers/' + data.id + '/preinstall', { method: 'POST' })
            .then(function () {
              btn.innerHTML =
                '<span class="material-symbols-outlined" style="font-size:14px">check_circle</span>Ready';
              btn.classList.add('btn-installed');
            })
            .catch(function () {
              // Download failed but install succeeded
              btn.innerHTML =
                '<span class="material-symbols-outlined" style="font-size:14px">check_circle</span>Installed';
              btn.classList.add('btn-installed');
            });
        }
        btn.innerHTML =
          '<span class="material-symbols-outlined" style="font-size:14px">check_circle</span>Installed';
        btn.classList.add('btn-installed');
      })
      .catch(function (err) {
        console.error('Install failed:', err);
        btn.disabled = false;
        btn.innerHTML =
          '<span class="material-symbols-outlined" style="font-size:14px">error</span>Failed';
        setTimeout(function () {
          btn.innerHTML =
            '<span class="material-symbols-outlined" style="font-size:14px">download</span>Install';
        }, 2000);
      });
  };

  window.__installFromNpm = function () {
    var input = AD._root.getElementById('npm-package-input');
    var pkg = (input ? input.value : '').trim();
    if (!pkg) return;

    // Find the install button and show spinner
    var btn = input ? input.parentElement.querySelector('.btn-install') : null;
    var origHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML =
        '<span class="material-symbols-outlined" style="font-size:14px">hourglass_top</span> Checking...';
    }

    AD._fetch('/api/npm-check?package=' + encodeURIComponent(pkg))
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (!data.exists) {
          showToast('Package not found on npm', 'error');
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = origHtml;
          }
          return;
        }

        var safeName = pkg.replace(/@/g, '').replace(/\//g, '-');
        return AD._fetch('/api/servers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: safeName,
            command: 'npx',
            args: ['-y', pkg],
            description: 'Installed from npm: ' + pkg,
            source: 'registry',
            tags: ['npm'],
          }),
        })
          .then(function (r) {
            if (!r.ok) throw new Error('Install failed');
            return r.json();
          })
          .then(function (data) {
            if (data && data.id) {
              if (btn) {
                btn.innerHTML =
                  '<span class="material-symbols-outlined" style="font-size:14px">downloading</span> Downloading...';
              }
              return AD._fetch('/api/servers/' + data.id + '/preinstall', { method: 'POST' })
                .then(function () {
                  showToast('Installed and downloaded ' + pkg, 'success');
                })
                .catch(function () {
                  showToast(
                    'Installed ' + pkg + ' (download will happen on first activate)',
                    'success',
                  );
                });
            }
            showToast('Installed ' + pkg, 'success');
          })
          .then(function () {
            if (input) input.value = '';
            if (btn) {
              btn.disabled = false;
              btn.innerHTML = origHtml;
            }
          });
      })
      .catch(function (err) {
        console.error('npm install failed:', err);
        showToast('Install failed: ' + err.message, 'error');
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = origHtml;
        }
      });
  };

  // -------------------------------------------------------------------------
  // Enterprise feature actions
  // -------------------------------------------------------------------------

  window.__toggleSection = function (serverId, name) {
    var key = serverId + '-' + name;
    openSections[key] = !openSections[key];
    if (openSections[key]) {
      // Load data when opening
      if (name === 'secrets') {
        fetch('/api/servers/' + serverId + '/secrets')
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            openSections[key + '-data'] = Array.isArray(data) ? data : [];
            render();
          })
          .catch(function () {
            openSections[key + '-data'] = [];
            render();
          });
      } else if (name === 'metrics') {
        fetch('/api/servers/' + serverId + '/metrics')
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            openSections[key + '-data'] = Array.isArray(data) ? data : data.tools || [];
            render();
          })
          .catch(function () {
            openSections[key + '-data'] = [];
            render();
          });
      }
    }
    render();
  };

  window.__checkHealth = function (serverId) {
    fetch('/api/servers/' + serverId + '/health', { method: 'POST' })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var status = data.health_status || data.status || 'unknown';
        showToast('Health check: ' + status, status === 'healthy' ? 'success' : 'error');
      })
      .catch(function () {
        showToast('Health check failed', 'error');
      });
  };

  window.__addSecret = function (serverId) {
    var keyEl = AD._root.getElementById('secret-key-' + serverId);
    var valEl = AD._root.getElementById('secret-val-' + serverId);
    if (!keyEl || !valEl) return;
    var key = keyEl.value.trim();
    var value = valEl.value;
    if (!key || !value) return;

    fetch('/api/servers/' + serverId + '/secrets/' + encodeURIComponent(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: value }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function () {
        showToast('Secret "' + key + '" saved', 'success');
        // Reload secrets
        return fetch('/api/servers/' + serverId + '/secrets').then(function (r) {
          return r.json();
        });
      })
      .then(function (data) {
        openSections[serverId + '-secrets-data'] = Array.isArray(data) ? data : [];
        render();
      })
      .catch(function () {
        showToast('Failed to save secret', 'error');
      });
  };

  window.__deleteSecret = function (serverId, key) {
    if (!confirm('Delete secret "' + key + '"?')) return;
    fetch('/api/servers/' + serverId + '/secrets/' + encodeURIComponent(key), {
      method: 'DELETE',
    })
      .then(function (r) {
        return r.json();
      })
      .then(function () {
        showToast('Secret "' + key + '" deleted', 'success');
        return fetch('/api/servers/' + serverId + '/secrets').then(function (r) {
          return r.json();
        });
      })
      .then(function (data) {
        openSections[serverId + '-secrets-data'] = Array.isArray(data) ? data : [];
        render();
      })
      .catch(function () {
        showToast('Failed to delete secret', 'error');
      });
  };

  window.__saveConfig = function (serverId) {
    var desc = AD._root.getElementById('cfg-desc-' + serverId);
    var cmd = AD._root.getElementById('cfg-cmd-' + serverId);
    var argsEl = AD._root.getElementById('cfg-args-' + serverId);
    var envEl = AD._root.getElementById('cfg-env-' + serverId);
    if (!desc || !cmd || !argsEl || !envEl) return;

    var args = argsEl.value
      .split(',')
      .map(function (a) {
        return a.trim();
      })
      .filter(Boolean);

    var env = {};
    envEl.value.split('\n').forEach(function (line) {
      var eq = line.indexOf('=');
      if (eq > 0) {
        env[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
      }
    });

    fetch('/api/servers/' + serverId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: desc.value,
        command: cmd.value,
        args: args,
        env: env,
      }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function () {
        showToast('Config saved', 'success');
      })
      .catch(function () {
        showToast('Failed to save config', 'error');
      });
  };

  // -------------------------------------------------------------------------
  // Toast notifications
  // -------------------------------------------------------------------------

  function showToast(message, type) {
    var existing = AD._root.querySelector('.toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.className = 'toast toast-' + (type || 'success');
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(function () {
      if (toast.parentNode) toast.remove();
    }, 3000);
  }

  // -------------------------------------------------------------------------
  // Clear errors
  // -------------------------------------------------------------------------

  window.__clearErrors = function (serverId) {
    AD._fetch('/api/servers/' + serverId + '/reset-errors', { method: 'POST' })
      .then(function (r) {
        return r.json();
      })
      .then(function () {
        showToast('Errors cleared', 'success');
      })
      .catch(function () {
        showToast('Failed to clear errors', 'error');
      });
  };

  function initAddServerForm() {
    var toggle = AD._root.getElementById('add-server-toggle');
    var panel = AD._root.getElementById('add-server-panel');
    var transport = AD._root.getElementById('add-transport');
    if (!toggle || !panel) return;

    toggle.addEventListener('click', function () {
      var visible = panel.style.display !== 'none';
      panel.style.display = visible ? 'none' : 'block';
    });

    if (transport) {
      transport.addEventListener('change', function () {
        var stdio = AD._root.getElementById('add-stdio-fields');
        var url = AD._root.getElementById('add-url-fields');
        if (this.value === 'stdio') {
          if (stdio) stdio.style.display = 'flex';
          if (url) url.style.display = 'none';
        } else {
          if (stdio) stdio.style.display = 'none';
          if (url) url.style.display = 'flex';
        }
      });
    }
  }

  window.__submitAddServer = function () {
    var name = (AD._root.getElementById('add-name') || {}).value || '';
    var transport = (AD._root.getElementById('add-transport') || {}).value || 'stdio';
    var command = (AD._root.getElementById('add-command') || {}).value || '';
    var argsStr = (AD._root.getElementById('add-args') || {}).value || '';
    var urlVal = (AD._root.getElementById('add-url') || {}).value || '';
    var desc = (AD._root.getElementById('add-desc') || {}).value || '';
    var envStr = (AD._root.getElementById('add-env') || {}).value || '';
    var tagsStr = (AD._root.getElementById('add-tags') || {}).value || '';

    if (!name.trim()) {
      showToast('Name is required', 'error');
      return;
    }

    var args = argsStr
      .split(',')
      .map(function (a) {
        return a.trim();
      })
      .filter(Boolean);
    var env = {};
    envStr.split('\n').forEach(function (line) {
      var eq = line.indexOf('=');
      if (eq > 0) env[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
    });
    var tags = tagsStr
      .split(',')
      .map(function (t) {
        return t.trim();
      })
      .filter(Boolean);

    var body = {
      name: name.trim(),
      description: desc,
      transport: transport,
      source: 'manual',
      tags: tags,
      env: env,
    };

    if (transport === 'stdio') {
      body.command = command;
      body.args = args;
    } else {
      body.homepage = urlVal;
    }

    AD._fetch('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        if (!r.ok)
          return r.json().then(function (d) {
            throw new Error(d.error || 'Failed');
          });
        return r.json();
      })
      .then(function () {
        showToast('Server registered', 'success');
        var panel = AD._root.getElementById('add-server-panel');
        if (panel) panel.style.display = 'none';
        [
          'add-name',
          'add-command',
          'add-args',
          'add-url',
          'add-desc',
          'add-env',
          'add-tags',
        ].forEach(function (id) {
          var el = AD._root.getElementById(id);
          if (el) el.value = '';
        });
      })
      .catch(function (err) {
        showToast('Register failed: ' + err.message, 'error');
      });
  };

  // -------------------------------------------------------------------------
  // Logs tab
  // -------------------------------------------------------------------------

  window.__clearLogs = function () {
    AD._fetch('/api/logs', { method: 'DELETE' })
      .then(function (r) {
        return r.json();
      })
      .then(function () {
        logEntries = [];
        updateLogCount();
        renderLogs();
        showToast('Logs cleared', 'success');
      })
      .catch(function () {
        showToast('Failed to clear logs', 'error');
      });
  };

  function initLogFilters() {
    var serverSel = AD._root.getElementById('log-filter-server');
    var statusSel = AD._root.getElementById('log-filter-status');
    var searchInput = AD._root.getElementById('log-filter-search');

    if (serverSel)
      serverSel.addEventListener('change', function () {
        logFilter.server = this.value;
        renderLogs();
      });
    if (statusSel)
      statusSel.addEventListener('change', function () {
        logFilter.status = this.value;
        renderLogs();
      });
    if (searchInput)
      searchInput.addEventListener('input', function () {
        logFilter.search = this.value;
        renderLogs();
      });

    initTimePicker();
  }

  function initTimePicker() {
    var btn = AD._root.getElementById('log-time-btn');
    var dropdown = AD._root.getElementById('log-time-dropdown');
    var label = AD._root.getElementById('log-time-label');
    var applyBtn = AD._root.getElementById('log-time-apply');
    var fromInput = AD._root.getElementById('log-time-from');
    var toInput = AD._root.getElementById('log-time-to');
    if (!btn || !dropdown) return;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });

    document.addEventListener('click', function (e) {
      if (!dropdown.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        dropdown.classList.remove('open');
      }
    });

    var presetBtns = dropdown.querySelectorAll('.log-time-presets button');
    presetBtns.forEach(function (pb) {
      pb.addEventListener('click', function () {
        var minutes = parseInt(this.dataset.minutes, 10);
        presetBtns.forEach(function (b) {
          b.classList.remove('active');
        });
        this.classList.add('active');
        if (minutes === 0) {
          logFilter.from = '';
          logFilter.to = '';
          if (label) label.textContent = 'All time';
        } else {
          logFilter.from = new Date(Date.now() - minutes * 60000).toISOString();
          logFilter.to = '';
          if (label) label.textContent = this.textContent;
        }
        if (fromInput) fromInput.value = '';
        if (toInput) toInput.value = '';
        dropdown.classList.remove('open');
        renderLogs();
      });
    });

    if (applyBtn) {
      applyBtn.addEventListener('click', function () {
        var f = fromInput ? fromInput.value : '';
        var t = toInput ? toInput.value : '';
        var fd = f ? new Date(f) : null;
        var td = t ? new Date(t) : null;
        logFilter.from = fd ? fd.toISOString() : '';
        logFilter.to = td ? td.toISOString() : '';
        presetBtns.forEach(function (b) {
          b.classList.remove('active');
        });
        function fmtShort(d) {
          return (
            d.getFullYear() +
            '-' +
            String(d.getMonth() + 1).padStart(2, '0') +
            '-' +
            String(d.getDate()).padStart(2, '0') +
            ' ' +
            String(d.getHours()).padStart(2, '0') +
            ':' +
            String(d.getMinutes()).padStart(2, '0')
          );
        }
        var rangeLabel = (fd ? fmtShort(fd) : '...') + ' \u2013 ' + (td ? fmtShort(td) : 'now');
        if (label) label.textContent = rangeLabel;
        dropdown.classList.remove('open');
        renderLogs();
      });
    }
  }

  function fetchLogs() {
    AD._fetch('/api/logs?limit=500')
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        logEntries = data.entries || [];
        updateLogCount();
        if (currentTab === 'logs') renderLogs();
      })
      .catch(function () {
        /* ignore */
      });
  }

  function renderLogs() {
    var el = AD._root.getElementById('logs-list');
    if (!el) return;

    var fromTs = logFilter.from ? new Date(logFilter.from).getTime() : 0;
    var toTs = logFilter.to ? new Date(logFilter.to).getTime() : Infinity;
    var q = (logFilter.search || '').toLowerCase();

    var filtered = logEntries.filter(function (e) {
      if (logFilter.server && e.server !== logFilter.server) return false;
      if (logFilter.status === 'success' && !e.success) return false;
      if (logFilter.status === 'fail' && e.success) return false;
      if (e.timestamp) {
        var t = new Date(e.timestamp).getTime();
        if (t < fromTs || t > toTs) return false;
      }
      if (q) {
        var haystack = (
          e.server +
          ' ' +
          e.tool +
          ' ' +
          JSON.stringify(e.args) +
          ' ' +
          (e.response || '')
        ).toLowerCase();
        if (haystack.indexOf(q) === -1) return false;
      }
      return true;
    });

    if (!filtered.length) {
      el.innerHTML =
        '<div class="empty-state"><span class="material-symbols-outlined empty-icon">receipt_long</span>' +
        '<p>No tool calls logged yet</p><p class="hint">Logs appear when proxied tools are called</p></div>';
      return;
    }

    var cols = 5;
    var rows = filtered
      .map(function (e) {
        var ts = '';
        if (e.timestamp) {
          var d = new Date(e.timestamp);
          ts =
            d.getFullYear() +
            '-' +
            String(d.getMonth() + 1).padStart(2, '0') +
            '-' +
            String(d.getDate()).padStart(2, '0') +
            ' ' +
            String(d.getHours()).padStart(2, '0') +
            ':' +
            String(d.getMinutes()).padStart(2, '0') +
            ':' +
            String(d.getSeconds()).padStart(2, '0');
        }
        var badge = e.success
          ? '<span class="log-badge log-success">OK</span>'
          : '<span class="log-badge log-fail">FAIL</span>';
        var argsText = JSON.stringify(e.args || {}, null, 2);
        var respText = (e.response || '').substring(0, 2000);
        return (
          '<tr class="log-row" data-action="toggle-log" data-log-id="' +
          e.id +
          '">' +
          '<td class="log-ts">' +
          esc(ts) +
          '</td>' +
          '<td>' +
          esc(e.server) +
          '</td>' +
          '<td><strong>' +
          esc(e.tool) +
          '</strong></td>' +
          '<td>' +
          badge +
          '</td>' +
          '<td class="log-latency">' +
          e.latency_ms +
          'ms</td>' +
          '</tr>' +
          '<tr class="log-expand" id="log-expand-' +
          e.id +
          '" style="display:none">' +
          '<td colspan="' +
          cols +
          '">' +
          '<div class="log-expand-content">' +
          '<div class="log-expand-section"><div class="log-expand-label">Args</div><pre>' +
          esc(argsText) +
          '</pre></div>' +
          '<div class="log-expand-section"><div class="log-expand-label">Response</div><pre>' +
          esc(respText) +
          '</pre></div>' +
          '</div>' +
          '</td>' +
          '</tr>'
        );
      })
      .join('');

    var html =
      '<table class="logs-table">' +
      '<thead><tr><th>Time</th><th>Server</th><th>Tool</th><th>Status</th><th>Latency</th></tr></thead>' +
      '<tbody>' +
      rows +
      '</tbody></table>';

    morph(el, html);
  }

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  function _initDelegatedClicks() {
    var root =
      AD._root.getElementById('server-list') ||
      AD._root.getElementById('tab-installed') ||
      AD._root.body ||
      AD._root;
    // Use a broad container — the main content area
    var container =
      AD._root.querySelector('.main-content') || AD._root.querySelector('.ad-wrapper') || AD._root;
    container.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;
      var id = parseInt(btn.dataset.id, 10);

      switch (action) {
        case 'activate':
          window.__activateServer(id);
          break;
        case 'deactivate':
          window.__deactivateServer(id);
          break;
        case 'health':
          window.__checkHealth(id);
          break;
        case 'delete':
          window.__deleteServer(id, btn.dataset.name);
          break;
        case 'toggle-section':
          window.__toggleSection(id, btn.dataset.section);
          break;
        case 'delete-secret':
          window.__deleteSecret(id, btn.dataset.key);
          break;
        case 'add-secret':
          window.__addSecret(id);
          break;
        case 'save-config':
          window.__saveConfig(id);
          break;
        case 'install-npm':
          window.__installFromNpm();
          break;
        case 'install-browse':
          window.__installFromBrowse(parseInt(btn.dataset.browseIdx, 10), btn);
          break;
        case 'show-npm-form':
          var form = btn.nextElementSibling;
          if (form) {
            form.style.display = 'flex';
            btn.style.display = 'none';
          }
          break;
        case 'clear-errors':
          window.__clearErrors(id);
          break;
        case 'submit-add-server':
          window.__submitAddServer();
          break;
        case 'clear-logs':
          window.__clearLogs();
          break;
        case 'toggle-log': {
          var logId = btn.dataset.logId || btn.closest('[data-log-id]')?.dataset?.logId;
          if (logId) {
            var expandRow = AD._root.getElementById('log-expand-' + logId);
            if (expandRow)
              expandRow.style.display = expandRow.style.display === 'none' ? '' : 'none';
          }
          break;
        }
      }
    });
  }

  function _init() {
    initTabs();
    initTheme();
    initSearch();
    initAddServerForm();
    initLogFilters();
    _initDelegatedClicks();
    connect();
    initThemeSync();
    fetchPrereqs();
    fetchLogs();
  }

  // -------------------------------------------------------------------------
  // Theme sync from parent (agent-desk) via executeJavaScript
  // -------------------------------------------------------------------------

  function initThemeSync() {
    // Detect external theme injection via MutationObserver on data-theme attribute
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.attributeName === 'data-theme') {
          var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
          var theme = isDark ? 'dark' : 'light';
          localStorage.setItem('agent-discover-theme', theme);
          updateThemeIcon(theme);
        }
      });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    // Listen for postMessage theme sync (same pattern as agent-comm)
    window.addEventListener('message', function (event) {
      if (!event.data || event.data.type !== 'theme-sync') return;
      var colors = event.data.colors;
      if (!colors) return;

      function ensureContrast(bg, fg) {
        var lum = function (hex) {
          if (!hex || hex.charAt(0) !== '#' || hex.length < 7) return 0.5;
          var r = parseInt(hex.slice(1, 3), 16) / 255;
          var g = parseInt(hex.slice(3, 5), 16) / 255;
          var b = parseInt(hex.slice(5, 7), 16) / 255;
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        var bgLum = lum(bg);
        return bgLum < 0.5 ? (lum(fg) < 0.4 ? '#e0e0e0' : fg) : lum(fg) > 0.6 ? '#333333' : fg;
      }

      var root = document.documentElement;
      var bgColor = colors.bg || null;

      if (colors.bg) root.style.setProperty('--bg', colors.bg);
      if (colors.bgSurface) root.style.setProperty('--bg-surface', colors.bgSurface);
      if (colors.bgElevated) root.style.setProperty('--bg-elevated', colors.bgElevated);
      if (colors.bgHover) root.style.setProperty('--bg-hover', colors.bgHover);

      if (colors.border) root.style.setProperty('--border', colors.border);
      if (colors.borderLight) root.style.setProperty('--border-light', colors.borderLight);

      if (colors.text)
        root.style.setProperty(
          '--text',
          bgColor ? ensureContrast(bgColor, colors.text) : colors.text,
        );
      if (colors.textMuted)
        root.style.setProperty(
          '--text-muted',
          bgColor ? ensureContrast(bgColor, colors.textMuted) : colors.textMuted,
        );
      if (colors.textDim)
        root.style.setProperty(
          '--text-dim',
          bgColor ? ensureContrast(bgColor, colors.textDim) : colors.textDim,
        );

      if (colors.accent) root.style.setProperty('--accent', colors.accent);
      if (colors.accentDim) root.style.setProperty('--accent-dim', colors.accentDim);

      if (colors.green) root.style.setProperty('--green', colors.green);
      if (colors.yellow) root.style.setProperty('--yellow', colors.yellow);
      if (colors.orange) root.style.setProperty('--orange', colors.orange);
      if (colors.red) root.style.setProperty('--red', colors.red);
      if (colors.purple) root.style.setProperty('--purple', colors.purple);

      if (colors.focusRing) root.style.setProperty('--focus-ring', colors.focusRing);

      if (colors.isDark !== undefined) {
        if (colors.isDark) {
          root.style.setProperty(
            '--shadow-1',
            '0px 1px 2px 0px rgba(0,0,0,0.6), 0px 1px 3px 1px rgba(0,0,0,0.3)',
          );
          root.style.setProperty(
            '--shadow-2',
            '0px 1px 2px 0px rgba(0,0,0,0.6), 0px 2px 6px 2px rgba(0,0,0,0.3)',
          );
          root.style.setProperty(
            '--shadow-3',
            '0px 1px 3px 0px rgba(0,0,0,0.6), 0px 4px 8px 3px rgba(0,0,0,0.3)',
          );
        } else {
          root.style.setProperty(
            '--shadow-1',
            '0px 1px 2px 0px rgba(0,0,0,0.3), 0px 1px 3px 1px rgba(0,0,0,0.15)',
          );
          root.style.setProperty(
            '--shadow-2',
            '0px 1px 2px 0px rgba(0,0,0,0.3), 0px 2px 6px 2px rgba(0,0,0,0.15)',
          );
          root.style.setProperty(
            '--shadow-3',
            '0px 1px 3px 0px rgba(0,0,0,0.3), 0px 4px 8px 3px rgba(0,0,0,0.15)',
          );
        }
      }

      if (colors.isDark !== undefined) {
        document.body.className =
          document.body.className.replace(/theme-\w+/, '').trim() +
          ' theme-' +
          (colors.isDark ? 'dark' : 'light');
        localStorage.setItem('agent-discover-theme', colors.isDark ? 'dark' : 'light');
        updateThemeIcon(colors.isDark ? 'dark' : 'light');
      }

      var themeToggle = AD._root.getElementById('theme-toggle');
      if (themeToggle) themeToggle.style.display = 'none';
    });
  }

  AD.mount = function (container, options) {
    options = options || {};
    AD._baseUrl = options.baseUrl || '';
    AD._wsUrl = options.wsUrl || null;

    var shadow = container.attachShadow({ mode: 'open' });

    if (options.cssUrl) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = options.cssUrl;
      shadow.appendChild(link);
    }

    var fonts = document.createElement('link');
    fonts.rel = 'stylesheet';
    fonts.href =
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap';
    shadow.appendChild(fonts);
    var icons = document.createElement('link');
    icons.rel = 'stylesheet';
    icons.href =
      'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap';
    shadow.appendChild(icons);

    var pluginStyle = document.createElement('style');
    pluginStyle.textContent =
      ':host { display:block; width:100%; height:100%; overflow:hidden; }' +
      '.ad-wrapper { font-family:var(--font-sans); font-size:14px; color:var(--text); background:var(--bg); line-height:1.5; width:100%; height:100%; overflow:hidden; }' +
      '.ad-wrapper #app { height:100%; }';
    shadow.appendChild(pluginStyle);

    if (typeof AD._template === 'function') {
      var wrapper = document.createElement('div');
      wrapper.setAttribute('data-theme', 'dark');
      wrapper.className = 'ad-wrapper';
      wrapper.innerHTML = AD._template();
      shadow.appendChild(wrapper);
    }

    AD._root = shadow;
    _init();
    var themeBtn = shadow.getElementById('theme-toggle');
    if (themeBtn) themeBtn.style.display = 'none';
  };

  AD.unmount = function () {
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    AD._root = document;
  };

  var _params = new URLSearchParams(location.search);
  if (_params.get('baseUrl')) AD._baseUrl = _params.get('baseUrl');
  if (_params.get('wsUrl')) AD._wsUrl = _params.get('wsUrl');

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _init);
    } else {
      _init();
    }
  } catch (e) {
    // standalone init may fail in file:// context (no WS host) — plugin mode uses mount()
  }
})();
