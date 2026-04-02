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

  let state = { servers: [], active: [], version: '0.0.0' };
  let ws = null;
  let browseResults = [];
  let currentTab = 'installed';
  let searchTimeout = null;
  let openSections = {}; // track open sections per server: { "serverId-sectionName": true }

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
    var el = document.getElementById('conn-status');
    if (!el) return;
    el.className = 'connection-status ' + cls;
    el.innerHTML = '<span class="conn-dot"></span>' + text;
  }

  // -------------------------------------------------------------------------
  // Tab navigation
  // -------------------------------------------------------------------------

  function initTabs() {
    var navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(function (item) {
      item.addEventListener('click', function () {
        var tab = this.dataset.tab;
        currentTab = tab;

        navItems.forEach(function (n) {
          n.classList.remove('active');
        });
        this.classList.add('active');

        document.querySelectorAll('.tab-panel').forEach(function (p) {
          p.classList.remove('active');
        });
        document.getElementById('tab-' + tab).classList.add('active');
      });
    });
  }

  // -------------------------------------------------------------------------
  // Theme toggle
  // -------------------------------------------------------------------------

  function initTheme() {
    var toggle = document.getElementById('theme-toggle');
    var saved = localStorage.getItem('agent-discover-theme');
    if (saved === 'light') {
      document.body.className = 'theme-light';
    } else if (saved === 'dark') {
      document.body.className = 'theme-dark';
    }
    updateThemeIcon(document.body.classList.contains('theme-light') ? 'light' : 'dark');

    toggle.addEventListener('click', function () {
      var isDark = document.body.classList.contains('theme-dark');
      var next = isDark ? 'light' : 'dark';
      document.body.className = 'theme-' + next;
      localStorage.setItem('agent-discover-theme', next);
      updateThemeIcon(next);
      // Reverse sync — notify agent-desk shell
      console.log('__agent_desk_theme__:' + next);
    });
  }

  function updateThemeIcon(theme) {
    var toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    var icon = toggle.querySelector('.material-symbols-outlined');
    if (icon) icon.textContent = theme === 'dark' ? 'dark_mode' : 'light_mode';
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  function initSearch() {
    var input = document.getElementById('browse-search');
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

  function fetchBrowse(query) {
    var el = document.getElementById('browse-list');
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
    document.getElementById('version').textContent = 'v' + state.version;
    document.getElementById('installed-count').textContent = String(state.servers.length);

    renderInstalled();
  }

  function renderInstalled() {
    var el = document.getElementById('installed-list');
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

        // Error count
        var errorCount =
          s.error_count > 0
            ? '<span class="error-count">' +
              s.error_count +
              ' error' +
              (s.error_count > 1 ? 's' : '') +
              '</span>'
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
          ? '<button class="btn-deactivate" onclick="window.__deactivateServer(' +
            s.id +
            ')"><span class="material-symbols-outlined" style="font-size:14px">stop_circle</span>Deactivate</button>'
          : '<button class="btn-activate" onclick="window.__activateServer(' +
            s.id +
            ')"><span class="material-symbols-outlined" style="font-size:14px">play_circle</span>Activate</button>';

        var healthBtn =
          '<button class="btn-health" onclick="window.__checkHealth(' +
          s.id +
          ')"><span class="material-symbols-outlined" style="font-size:14px">favorite</span>Check Health</button>';

        var deleteBtn =
          '<button class="btn-delete" onclick="window.__deleteServer(' +
          s.id +
          ", '" +
          esc(s.name).replace(/'/g, "\\'") +
          '\')"><span class="material-symbols-outlined" style="font-size:14px">delete</span>Delete</button>';

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

    morphdom(el, '<div id="installed-list" class="server-grid">' + html + '</div>');
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
      '" onclick="window.__toggleSection(' +
      serverId +
      ", '" +
      name +
      '\')">' +
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
          '<button class="secret-delete" onclick="window.__deleteSecret(' +
          server.id +
          ", '" +
          esc(s.key).replace(/'/g, "\\'") +
          '\')" title="Delete secret">' +
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
      '<button onclick="window.__addSecret(' +
      server.id +
      ')">Save</button>' +
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
      return '<div style="font-size:12px;color:var(--text-tertiary)">No metrics data yet</div>';

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
      esc(server.description || '').replace(/"/g, '&quot;') +
      '" /></div>' +
      '<div class="config-field"><label>Command</label>' +
      '<input type="text" id="cfg-cmd-' +
      server.id +
      '" value="' +
      esc(server.command || '').replace(/"/g, '&quot;') +
      '" /></div>' +
      '<div class="config-field"><label>Args (comma-separated)</label>' +
      '<input type="text" id="cfg-args-' +
      server.id +
      '" value="' +
      esc((server.args || []).join(', ')).replace(/"/g, '&quot;') +
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
      '<button class="config-save" onclick="window.__saveConfig(' +
      server.id +
      ')">Save Config</button>' +
      '</div>'
    );
  }

  function renderBrowse() {
    var el = document.getElementById('browse-list');
    if (!browseResults.length) {
      var q = document.getElementById('browse-search').value.trim();
      if (!q) {
        el.innerHTML =
          '<div class="empty-state"><span class="material-symbols-outlined empty-icon">explore</span><p>Search the official MCP registry</p><p class="hint">Type a query above to discover servers</p></div>';
      } else {
        el.innerHTML =
          '<div class="empty-state"><span class="material-symbols-outlined empty-icon">search_off</span><p>No results in MCP registry</p>' +
          "<a class=\"hint-link\" onclick=\"this.nextElementSibling.style.display='flex';this.style.display='none'\">Can't find it? Install from npm</a>" +
          '<div class="npm-install-form" style="display:none">' +
          '<input type="text" id="npm-package-input" placeholder="npm package name (e.g. @modelcontextprotocol/server-everything)" />' +
          '<button class="btn-install" onclick="window.__installFromNpm()"><span class="material-symbols-outlined" style="font-size:14px">download</span> Install</button>' +
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
            '<button class="btn-install" data-browse-idx="' +
            idx +
            '" onclick="window.__installFromBrowse(' +
            idx +
            ', this)"><span class="material-symbols-outlined" style="font-size:14px">download</span>Install</button>';
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

    morphdom(el, '<div id="browse-list" class="server-grid">' + html + '</div>');
  }

  function esc(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
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

    var safeName = (server.name || '').replace(/\//g, '-');
    // Detect transport and build config
    var pkg = (server.packages || [])[0];
    var transport = (pkg && (pkg.transport || pkg.runtime)) || 'stdio';
    var remoteUrl = pkg && pkg.url ? pkg.url : null;

    var serverData = {
      name: safeName,
      description: server.description || '',
      source: 'registry',
      transport: transport,
      tags: ['marketplace'],
    };

    if (transport === 'streamable-http' || transport === 'sse') {
      serverData.homepage = remoteUrl || server.repository || '';
    } else {
      // stdio / node / python — default to npx
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
    var input = document.getElementById('npm-package-input');
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
    var keyEl = document.getElementById('secret-key-' + serverId);
    var valEl = document.getElementById('secret-val-' + serverId);
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
    var desc = document.getElementById('cfg-desc-' + serverId);
    var cmd = document.getElementById('cfg-cmd-' + serverId);
    var argsEl = document.getElementById('cfg-args-' + serverId);
    var envEl = document.getElementById('cfg-env-' + serverId);
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
    var existing = document.querySelector('.toast');
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
  // Init
  // -------------------------------------------------------------------------

  function _init() {
    initTabs();
    initTheme();
    initSearch();
    connect();
    initThemeSync();
  }

  // Auto-init for standalone
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  // -------------------------------------------------------------------------
  // Theme sync from parent (agent-desk) via executeJavaScript
  // -------------------------------------------------------------------------

  function initThemeSync() {
    // Detect external theme injection via MutationObserver on body class
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.attributeName === 'class') {
          var isDark = document.body.classList.contains('theme-dark');
          var theme = isDark ? 'dark' : 'light';
          localStorage.setItem('agent-discover-theme', theme);
          updateThemeIcon(theme);
        }
      });
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

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
        root.style.setProperty('--shadow-sm', 'var(--shadow-1)');
        root.style.setProperty('--shadow-md', 'var(--shadow-2)');
        root.style.setProperty('--shadow-hover', 'var(--shadow-3)');
      }

      if (colors.isDark !== undefined) {
        document.body.className =
          document.body.className.replace(/theme-\w+/, '').trim() +
          ' theme-' +
          (colors.isDark ? 'dark' : 'light');
        localStorage.setItem('agent-discover-theme', colors.isDark ? 'dark' : 'light');
        updateThemeIcon(colors.isDark ? 'dark' : 'light');
      }

      var themeToggle = document.getElementById('theme-toggle');
      if (themeToggle) themeToggle.style.display = 'none';
    });
  }

  AD.mount = function (container, options) {
    options = options || {};
    AD._baseUrl = options.baseUrl || '';
    AD._wsUrl = options.wsUrl || null;
    if (options.cssUrl && !document.getElementById('ad-plugin-css')) {
      var link = document.createElement('link');
      link.id = 'ad-plugin-css';
      link.rel = 'stylesheet';
      link.href = options.cssUrl;
      document.head.appendChild(link);
    }
    if (typeof AD._template === 'function') {
      container.innerHTML = AD._template();
    }
    _init();
  };

  AD.unmount = function () {
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  };
})();
