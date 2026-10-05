/* eslint-disable */
// =============================================================================
// agent-discover — Dashboard client
// =============================================================================

(function () {
  'use strict';

  var AD = (window.AD = window.AD || {});
  AD._baseUrl = '';
  AD._fetch = function (url, opts) {
    opts = opts || {};
    var method = (opts.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return fetch(AD._baseUrl + url, opts);
    // State-changing requests carry the per-launch token (docs/API.md); a
    // daemon restart rotates it, so a TOKEN_REQUIRED answer refetches once.
    var send = function (token) {
      var headers = Object.assign({}, opts.headers, { 'X-Agent-Discover-Token': token });
      return fetch(AD._baseUrl + url, Object.assign({}, opts, { headers: headers }));
    };
    var refresh = function () {
      return fetch(AD._baseUrl + '/api/token')
        .then(function (r) {
          return r.json();
        })
        .then(function (b) {
          return (AD._token = b.token);
        });
    };
    return (AD._token ? Promise.resolve(AD._token) : refresh()).then(send).then(function (res) {
      if (res.status !== 403) return res;
      return res
        .clone()
        .json()
        .then(
          function (b) {
            return b.code === 'TOKEN_REQUIRED' ? refresh().then(send) : res;
          },
          function () {
            return res;
          },
        );
    });
  };
  AD._wsUrl = null;
  AD._root = document;

  let state = { servers: [], version: '0.0.0', loaded: false };
  let ws = null;
  let browseResults = [];
  let browseMeta = null;
  let browseQuery = '';
  let browseSeq = 0;
  let currentTab = 'installed';
  let selectedServer = '';
  let pendingFocus = false;
  let searchTimeout = null;
  let extrasTimer = null;
  let openSections = {};
  let prereqs = null;
  let statusByName = {};
  let trustCache = {};
  let authCache = {};
  let authPending = {};
  let audit = { entries: [], total: 0, more: false, error: '' };
  let auditFilter = { server: '', action: '', tool: '' };
  let auditSeq = 0;
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
            version: msg.version || state.version,
            loaded: true,
          };
          render();
          refreshExtras();
        } else if (msg.type === 'log_entry' && msg.entry) {
          logEntries.unshift(msg.entry);
          if (logEntries.length > 500) logEntries.length = 500;
          updateLogCount();
          if (currentTab === 'logs') renderLogs();
          if (AD.onTesterLogEntry) AD.onTesterLogEntry(msg.entry);
        } else if ((msg.type === 'notification' || msg.type === 'progress') && AD.onTesterEvent) {
          AD.onTesterEvent(msg);
        } else if (msg.type === 'elicitation_request' && AD.onElicitationRequest) {
          AD.onElicitationRequest(msg);
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
  // Routing: #/servers, #/servers/<name>, #/browse?q=, #/logs, #/audit
  // -------------------------------------------------------------------------

  var TABS = { servers: 'installed', browse: 'browse', logs: 'logs', audit: 'audit' };

  function $id(id) {
    return AD._root.getElementById(id);
  }

  function parseHash() {
    var raw = location.hash.replace(/^#\/?/, '');
    var qi = raw.indexOf('?');
    var parts = (qi < 0 ? raw : raw.slice(0, qi)).split('/');
    var arg = '';
    try {
      arg = parts[1] ? decodeURIComponent(parts[1]) : '';
    } catch (e) {
      /* malformed escape: treat as no server */
    }
    var view = parts[0] === 'installed' ? 'servers' : parts[0];
    return {
      view: TABS[view] ? view : 'servers',
      arg: arg,
      q: new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1)).get('q') || '',
    };
  }

  function serverHref(name) {
    return '#/servers/' + encodeURIComponent(name);
  }

  function setHash(hash, push) {
    if (location.hash === hash) return;
    try {
      history[push ? 'pushState' : 'replaceState'](null, '', hash);
    } catch (e) {
      location.hash = hash;
    }
  }

  function navigate(hash) {
    setHash(hash, true);
    applyRoute();
  }

  function applyRoute() {
    var r = parseHash();
    currentTab = TABS[r.view];
    AD._root.querySelectorAll('.nav-item').forEach(function (n) {
      n.classList.toggle('active', n.dataset.tab === currentTab);
    });
    AD._root.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'tab-' + currentTab);
    });
    selectedServer = currentTab === 'installed' ? r.arg : '';
    if (currentTab === 'installed') {
      pendingFocus = !!selectedServer;
      renderInstalled();
    } else if (currentTab === 'logs') {
      renderLogs();
    } else if (currentTab === 'audit') {
      loadAudit(false);
    } else {
      var input = $id('browse-search');
      if (input.value.trim() !== r.q) input.value = r.q;
      if (!r.q) {
        browseQuery = '';
        browseResults = [];
        browseSeq++;
        renderBrowse();
      } else if (r.q !== browseQuery) {
        fetchBrowse(r.q);
      }
    }
  }

  function initTabs() {
    AD._root.querySelectorAll('.nav-item').forEach(function (item) {
      item.addEventListener('click', function () {
        navigate('#/' + Object.keys(TABS).filter((k) => TABS[k] === this.dataset.tab)[0]);
      });
    });
    window.addEventListener('hashchange', applyRoute);
    window.addEventListener('popstate', applyRoute);
    applyRoute();
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
    $id('browse-search').addEventListener('input', function () {
      clearTimeout(searchTimeout);
      var q = this.value.trim();
      searchTimeout = setTimeout(
        function () {
          setHash('#/browse' + (q ? '?q=' + encodeURIComponent(q) : ''), false);
          applyRoute();
        },
        q ? 400 : 0,
      );
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
    browseQuery = query;
    var seq = ++browseSeq;
    $id('browse-list').innerHTML = '<div class="loading">Searching...</div>';
    AD._fetch('/api/browse?query=' + encodeURIComponent(query) + '&limit=20')
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error((data && data.error) || 'Search failed');
          return data;
        });
      })
      .then(function (data) {
        if (seq !== browseSeq) return;
        browseResults = data.servers || [];
        browseMeta = { registry: data.registry, errors: data.errors || {} };
        renderBrowse();
      })
      .catch(function (err) {
        if (seq !== browseSeq) return;
        browseResults = [];
        browseMeta = null;
        $id('browse-list').innerHTML =
          '<div class="empty-state"><span class="material-symbols-outlined empty-icon">error</span><p>' +
          esc('Search failed: ' + err.message) +
          '</p></div>';
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
    if (currentTab === 'browse') renderBrowse();
    if (currentTab === 'audit') renderAudit();
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

  var FLAG_LABELS = {
    'invisible-chars': 'hidden characters',
    'instruction-override': 'tries to override instructions',
    'hidden-tag': 'hidden instruction tag',
    exfiltration: 'possible data exfiltration',
    'secret-access': 'reads secrets or credentials',
    'conceal-from-user': 'asks to hide actions from the user',
  };

  function banner(kind, icon, title, bodyHtml, actionsHtml) {
    return (
      '<div class="banner banner-' +
      kind +
      '"><span class="material-symbols-outlined banner-icon">' +
      icon +
      '</span><div class="banner-main"><div class="banner-title">' +
      esc(title) +
      '</div>' +
      (bodyHtml ? '<div class="banner-body">' + bodyHtml + '</div>' : '') +
      (actionsHtml ? '<div class="banner-actions">' + actionsHtml + '</div>' : '') +
      '</div></div>'
    );
  }

  // Escape, then expose characters that render as nothing (a tool-poisoning vector).
  function visible(str) {
    return esc(str).replace(/[​-‏‪-‮⁠-⁤﻿]/g, function (c) {
      return (
        '<span class="invis">U+' +
        c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') +
        '</span>'
      );
    });
  }

  function diffRow(kind, text) {
    return (
      '<div class="diff-' +
      kind +
      '"><span class="diff-sign">' +
      (kind === 'del' ? '−' : kind === 'add' ? '+' : '~') +
      '</span><span class="diff-text">' +
      visible(text) +
      '</span></div>'
    );
  }

  function renderDrift(d) {
    if (!d) return '<div class="hint">No tool diff recorded.</div>';
    var out = (d.changed || []).map(function (c) {
      var rows = '';
      if (c.description)
        rows += diffRow('del', c.description.before) + diffRow('add', c.description.after);
      if (c.input_schema) {
        (c.input_schema.added || []).forEach(function (p) {
          rows += diffRow('add', 'parameter ' + p);
        });
        (c.input_schema.removed || []).forEach(function (p) {
          rows += diffRow('del', 'parameter ' + p);
        });
        (c.input_schema.changed || []).forEach(function (p) {
          rows += diffRow('chg', 'parameter ' + p);
        });
      }
      if (c.annotations)
        rows +=
          diffRow('del', 'annotations ' + JSON.stringify(c.annotations.before)) +
          diffRow('add', 'annotations ' + JSON.stringify(c.annotations.after));
      return (
        '<div class="drift-tool"><div class="drift-tool-name">' +
        esc(c.tool) +
        ' <span class="tag">changed</span></div>' +
        rows +
        '</div>'
      );
    });
    [
      ['added', 'new tool'],
      ['removed', 'removed'],
    ].forEach(function (kind) {
      (d[kind[0]] || []).forEach(function (n) {
        out.push(
          '<div class="drift-tool"><div class="drift-tool-name">' +
            esc(n) +
            ' <span class="tag">' +
            kind[1] +
            '</span></div></div>',
        );
      });
    });
    return '<div class="drift">' + out.join('') + '</div>';
  }

  function hasAuthHeader(s) {
    return Object.keys(s.headers || {}).some(function (k) {
      return k.toLowerCase() === 'authorization';
    });
  }

  function needsSignIn(s) {
    var a = authCache[s.id];
    if (!a || s.transport === 'stdio' || !s.url) return false;
    if (a.status === 'required') return true;
    return a.status === 'unknown' && !s.indexed_at && !hasAuthHeader(s);
  }

  function renderBanners(s) {
    var out = '';
    var st = statusByName[s.name] || {};
    if (s.quarantined) {
      var t = trustCache[s.id];
      out += banner(
        'danger',
        'gpp_maybe',
        'Quarantined: tools changed since you approved them',
        '<p>Agents cannot use this server until you review the changes below.</p>' +
          renderDrift(t && t.drift),
        '<button class="btn-approve" data-action="approve" data-id="' +
          s.id +
          '"' +
          (t ? '' : ' disabled') +
          '>Approve changes</button>' +
          '<button class="btn-keep" data-action="keep-disabled" data-id="' +
          s.id +
          '">Keep disabled</button>',
      );
    }
    var flagged = st.flagged_tools || [];
    if (flagged.length) {
      out += banner(
        'warn',
        'warning',
        flagged.length +
          ' tool' +
          (flagged.length > 1 ? 's' : '') +
          ' with suspicious descriptions',
        flagged
          .map(function (f) {
            var flags = (f.flags || []).map(function (x) {
              return FLAG_LABELS[x] || x;
            });
            return (
              '<div><span class="tool-name">' +
              esc(f.tool) +
              '</span> ' +
              esc(flags.join(', ')) +
              '</div>'
            );
          })
          .join(''),
      );
    }
    if (st.registry_status === 'deleted') {
      out += banner(
        'danger',
        'report',
        'Removed from the MCP Registry',
        '<p>The registry took this entry down (takedowns are used for malware and spam). Consider uninstalling it.</p>',
      );
    } else if (st.registry_status === 'deprecated') {
      out += banner('warn', 'history', 'Deprecated in the MCP Registry', '');
    }
    if (needsSignIn(s)) {
      var waiting = !!authPending[s.id];
      out += banner(
        'info',
        'lock',
        'Sign-in required',
        '<p>This remote server uses OAuth. Sign in to let agent-discover connect.</p>',
        '<button class="btn-signin" data-action="sign-in" data-id="' +
          s.id +
          '"' +
          (waiting ? ' disabled' : '') +
          '>' +
          (waiting ? 'Waiting for sign-in...' : 'Sign in') +
          '</button>',
      );
    }
    return out;
  }

  function renderInstalled() {
    var el = $id('installed-list');
    var notFound =
      selectedServer && state.loaded && !state.servers.some((s) => s.name === selectedServer)
        ? '<div class="banner banner-warn grid-wide"><span class="material-symbols-outlined banner-icon">search_off</span><div class="banner-main"><div class="banner-title">' +
          esc('No server named "' + selectedServer + '"') +
          '</div></div></div>'
        : '';
    if (!state.servers.length) {
      morph(
        el,
        notFound +
          '<div class="empty-state"><span class="material-symbols-outlined empty-icon">dns</span><p>No servers registered</p><p class="hint">Use install_server or browse the marketplace</p></div>',
      );
      return;
    }

    var html = state.servers
      .map(function (s) {
        var statusClass = s.quarantined
          ? 'quarantined'
          : s.enabled
            ? s.health_status === 'unhealthy'
              ? 'unhealthy'
              : 'enabled'
            : 'disabled';
        var statusLabel = s.quarantined
          ? 'Quarantined'
          : s.enabled
            ? s.health_status === 'unhealthy'
              ? 'Unhealthy'
              : s.connected
                ? 'Enabled · connected'
                : 'Enabled'
            : 'Disabled';

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
        var flaggedTools = {};
        ((statusByName[s.name] || {}).flagged_tools || []).forEach(function (f) {
          flaggedTools[f.tool] = true;
        });
        var tools = (s.tools || [])
          .map(function (t) {
            return (
              '<div class="tool-item"><span class="tool-name">' +
              esc(t.name) +
              (flaggedTools[t.name] ? ' <span class="tag tag-warn">flagged</span>' : '') +
              '</span><span class="tool-desc">' +
              visible(t.description || '') +
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

        var actionBtn = s.enabled
          ? '<button class="btn-disable" data-action="disable" data-id="' +
            s.id +
            '"><span class="material-symbols-outlined" style="font-size:14px">stop_circle</span>Disable</button>'
          : '<button class="btn-enable" data-action="enable" data-id="' +
            s.id +
            '"' +
            (s.quarantined ? ' disabled title="Review the quarantine first"' : '') +
            '><span class="material-symbols-outlined" style="font-size:14px">play_circle</span>Enable</button>';

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

        var secretsSection = renderSection(s.id, 'secrets', 'Secrets', renderSecretsContent(s));
        var metricsSection = renderSection(s.id, 'metrics', 'Metrics', renderMetricsContent(s));
        var testerSection = renderSection(
          s.id,
          'tester',
          'Test',
          AD.renderTesterShell
            ? AD.renderTesterShell(s)
            : '<div class="hint">tester unavailable</div>',
        );
        var configSection = renderSection(s.id, 'config', 'Config', renderConfigContent(s));

        return (
          '<div class="server-card' +
          (s.name === selectedServer ? ' selected' : '') +
          '" data-server="' +
          escAttr(s.name) +
          '">' +
          '<div class="server-card-header">' +
          '<a class="server-name" href="' +
          escAttr(serverHref(s.name)) +
          '">' +
          esc(s.name) +
          '</a>' +
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
          renderBanners(s) +
          (tags ? '<div class="server-tags">' + tags + '</div>' : '') +
          '<div class="server-meta">' +
          '<span>' +
          esc(s.source || 'local') +
          '</span>' +
          '<span>' +
          (s.transport === 'sse'
            ? 'remote sse'
            : s.transport === 'streamable-http'
              ? 'remote http'
              : 'local stdio') +
          '</span>' +
          (s.transport && s.transport !== 'stdio' && s.url
            ? '<span style="font-size:11px;color:var(--text-muted)">' + esc(s.url) + '</span>'
            : '') +
          '</div>' +
          toolSection +
          '<div class="server-actions">' +
          actionBtn +
          healthBtn +
          deleteBtn +
          '</div>' +
          testerSection +
          secretsSection +
          metricsSection +
          configSection +
          '</div>'
        );
      })
      .join('');

    morph(el, notFound + html);
    if (pendingFocus) {
      var card = el.querySelector('.server-card.selected');
      if (card) {
        pendingFocus = false;
        card.scrollIntoView({ block: 'start' });
      }
    }
  }

  // Status (flagged tools, registry_status), per-server trust reports (drift plus the
  // hashes an approval must echo) and OAuth state come from REST, not the WS push.
  function getJson(url) {
    return AD._fetch(url)
      .then(function (r) {
        return r.json();
      })
      .catch(function () {
        return {};
      });
  }

  function changed(a, b) {
    return JSON.stringify(a) !== JSON.stringify(b);
  }

  function refreshExtras() {
    clearTimeout(extrasTimer);
    extrasTimer = setTimeout(function () {
      getJson('/api/status').then(function (data) {
        var next = {};
        (data.servers || []).forEach(function (s) {
          next[s.name] = s;
        });
        if (changed(statusByName, next)) {
          statusByName = next;
          renderInstalled();
        }
      });
      state.servers.forEach(function (s) {
        if (s.quarantined) {
          getJson('/api/servers/' + s.id + '/trust').then(function (t) {
            if (changed(trustCache[s.id], t)) {
              trustCache[s.id] = t;
              renderInstalled();
            }
          });
        } else {
          delete trustCache[s.id];
        }
        if (s.transport !== 'stdio' && s.url) {
          getJson('/api/servers/' + s.id + '/auth').then(function (a) {
            if (changed(authCache[s.id], a)) {
              authCache[s.id] = a;
              renderInstalled();
            }
          });
        }
      });
    }, 100);
  }

  window.__approve = function (id) {
    var t = trustCache[id];
    if (!t) return;
    AD._fetch('/api/servers/' + id + '/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: t.hashes }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) {
            if (r.status === 409) refreshExtras();
            throw new Error(
              r.status === 409 ? 'tools changed again, review the new diff' : data.error,
            );
          }
          showToast('Approved: quarantine lifted', 'success');
        });
      })
      .catch(function (err) {
        showToast('Approve failed: ' + err.message, 'error');
      });
  };

  window.__keepDisabled = function (id) {
    AD._fetch('/api/servers/' + id + '/disable', { method: 'POST' }).then(function () {
      showToast('Server stays disabled and quarantined', 'success');
    });
  };

  // POST /auth returns the URL to open; the callback page finishes sign-in, so poll for it.
  window.__signIn = function (id) {
    authPending[id] = true;
    renderInstalled();
    var done = function () {
      delete authPending[id];
      refreshExtras();
    };
    AD._fetch('/api/servers/' + id + '/auth', { method: 'POST' })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data.error || 'Sign-in failed');
          return data;
        });
      })
      .then(function (a) {
        if (a.status === 'authorized') {
          showToast('Signed in', 'success');
          return done();
        }
        if (!/^https?:\/\//i.test(a.authorize_url || '')) throw new Error('no authorization URL');
        window.open(a.authorize_url, '_blank', 'noopener');
        var tries = 0;
        var poll = setInterval(function () {
          getJson('/api/servers/' + id + '/auth').then(function (s) {
            if (s.status === 'authorized') {
              clearInterval(poll);
              showToast('Signed in', 'success');
              done();
            } else if (++tries > 150) {
              clearInterval(poll);
              done();
            }
          });
        }, 2000);
      })
      .catch(function (err) {
        showToast('Sign-in failed: ' + err.message, 'error');
        done();
      });
  };

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
    if (!prereqs.npx) missing.push({ tool: 'npx', hint: 'install Node.js, npx ships with it' });
    if (!prereqs.uvx && !prereqs.uv)
      missing.push({ tool: 'uvx', hint: 'install uv: https://docs.astral.sh/uv/' });
    if (!missing.length) return '';
    return banner(
      'warn',
      'warning',
      'Missing tools on PATH',
      missing
        .map(function (m) {
          return '<div><code>' + esc(m.tool) + '</code> (' + esc(m.hint) + ')</div>';
        })
        .join('') + '<div>Installs that need them will fail until they are available.</div>',
    );
  }

  function renderBrowseMeta() {
    if (!browseMeta) return '';
    var out = '';
    Object.keys(browseMeta.errors).forEach(function (src) {
      out += banner(
        'warn',
        'cloud_off',
        'Could not search ' + src,
        '<div>' + esc(browseMeta.errors[src]) + '</div>',
      );
    });
    return out;
  }

  function tag(kind, text) {
    return '<span class="tag tag-' + kind + '">' + esc(text) + '</span>';
  }

  function renderBrowse() {
    var el = $id('browse-list');
    var head = renderPrereqBanner() + renderBrowseMeta();
    if (!browseResults.length) {
      var q = $id('browse-search').value.trim();
      morph(
        el,
        head +
          (q
            ? '<div class="empty-state"><span class="material-symbols-outlined empty-icon">search_off</span><p>No results found</p>' +
              '<a class="hint-link" data-action="show-npm-form">Can\'t find it? Install from npm</a>' +
              '<div class="npm-install-form" style="display:none">' +
              '<input type="text" id="npm-package-input" placeholder="npm package name (e.g. @modelcontextprotocol/server-everything)" />' +
              '<button class="btn-install" data-action="install-npm"><span class="material-symbols-outlined" style="font-size:14px">download</span> Install</button>' +
              '</div></div>'
            : '<div class="empty-state"><span class="material-symbols-outlined empty-icon">explore</span><p>Search the official MCP registry, npm and PyPI</p><p class="hint">Type a query above to discover servers</p></div>'),
      );
      return;
    }

    var installedNames = state.servers.map(function (s) {
      return s.name;
    });

    var html = browseResults
      .map(function (s, idx) {
        var chips =
          tag('source', s.source) +
          (s.status && s.status !== 'active' ? tag(s.status, s.status) : '') +
          (s.packages || [])
            .map(function (p) {
              return tag(
                'pkg',
                p.registry_type + ': ' + p.identifier + (p.version ? '@' + p.version : ''),
              );
            })
            .join('') +
          (s.remotes || [])
            .map(function (r) {
              return tag(r.type === 'sse' ? 'sse' : 'remote', r.type + ': ' + r.url);
            })
            .join('');

        // The daemon names the local server after the last path segment (localNameFor).
        var isInstalled = installedNames.indexOf((s.name || '').split('/').pop()) !== -1;
        var installBtn = isInstalled
          ? '<button class="btn-install btn-installed" disabled><span class="material-symbols-outlined" style="font-size:14px">check_circle</span>Installed</button>'
          : '<button class="btn-install" data-action="install-browse" data-browse-idx="' +
            idx +
            '"><span class="material-symbols-outlined" style="font-size:14px">download</span>Install</button>';
        var repo = safeHref(s.repository);

        return (
          '<div class="server-card' +
          (s.status === 'deleted' ? ' card-deleted' : '') +
          '">' +
          '<div class="server-card-header">' +
          '<span class="server-name">' +
          esc(s.title && s.title !== s.name ? s.title : s.name) +
          '</span>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
          (s.version ? '<span class="tag">' + esc(s.version) + '</span>' : '') +
          installBtn +
          '</div></div>' +
          (s.title && s.title !== s.name
            ? '<div class="server-meta mono">' + esc(s.name) + '</div>'
            : '') +
          '<div class="server-description">' +
          esc(s.description || '') +
          '</div>' +
          '<div class="server-tags">' +
          chips +
          '</div>' +
          (repo
            ? '<div class="server-meta"><span class="material-symbols-outlined">code</span><a href="' +
              escAttr(repo) +
              '" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">' +
              esc(repo) +
              '</a></div>'
            : '') +
          '</div>'
        );
      })
      .join('');

    morph(el, head + html);
  }

  function safeHref(url) {
    return /^https?:\/\//i.test(url || '') ? url : '';
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
    morphdom(el, wrap, {
      childrenOnly: true,
      // Pushed state must not wipe what the user is typing into a form control.
      onBeforeElUpdated: function (from) {
        // tester.js renders its own subtree; a pushed state must not reset it to the placeholder.
        if (from.classList && from.classList.contains('tester-shell')) return false;
        if (from.tagName === 'INPUT' && (from.type === 'checkbox' || from.type === 'radio'))
          return from.checked === from.defaultChecked;
        if (from.tagName === 'INPUT' || from.tagName === 'TEXTAREA')
          return from.value === from.defaultValue;
        return true;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Server actions
  // -------------------------------------------------------------------------

  window.__enableServer = function (id) {
    AD._fetch('/api/servers/' + id + '/enable', { method: 'POST' })
      .then(function (r) {
        return r.json().then(function (data) {
          if (data.error) {
            showToast('Enable failed: ' + data.error, 'error');
          } else {
            showToast('Enabled with ' + (data.tool_count || 0) + ' tools', 'success');
          }
        });
      })
      .catch(function (err) {
        showToast('Enable failed: ' + err.message, 'error');
      });
  };

  window.__disableServer = function (id) {
    AD._fetch('/api/servers/' + id + '/disable', { method: 'POST' })
      .then(function (r) {
        return r.json();
      })
      .then(function () {
        // State will refresh via WebSocket
      })
      .catch(function (err) {
        console.error('Disable failed:', err);
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

  // -------------------------------------------------------------------------
  // DOM builder: everything untrusted (registry text, plans) goes through
  // textContent, never innerHTML.
  // -------------------------------------------------------------------------

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (kid) {
      if (kid == null || kid === false) return;
      el.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
    });
    return el;
  }

  function icon(name) {
    return h('span', { class: 'material-symbols-outlined' }, [name]);
  }

  function overlayHost() {
    return AD._root.querySelector('.layout') || document.body;
  }

  // -------------------------------------------------------------------------
  // Install consent: shows GET /api/install/plan, installs via POST /api/install
  // -------------------------------------------------------------------------

  function shellQuote(tok) {
    return /^[\w@%+=:,./-]+$/.test(tok) ? tok : "'" + tok.replace(/'/g, "'\\''") + "'";
  }

  function transportOptions(entry) {
    var opts = [];
    if ((entry.packages || []).length) opts.push('stdio');
    (entry.remotes || []).forEach(function (r) {
      if (opts.indexOf(r.type) === -1) opts.push(r.type);
    });
    return opts;
  }

  function openConsent(entry) {
    var form = {
      local_name: '',
      transport: '',
      enable: true,
      secrets: {},
    };
    var plan = null;
    var error = '';
    var busy = false;
    var seq = 0;
    var backdrop;
    var body = h('div', { class: 'consent-body' });
    var errorEl = h('div', { class: 'consent-error', 'data-consent': 'error' });
    var installBtn = h(
      'button',
      { class: 'btn-primary', 'data-consent': 'install', onclick: install },
      ['Install'],
    );

    function planQuery() {
      var q = new URLSearchParams({ source: entry.source, name: entry.name });
      if (form.local_name) q.set('local_name', form.local_name);
      if (form.transport) q.set('transport', form.transport);
      return q.toString();
    }

    function missingRequired() {
      return ((plan && plan.requirements) || []).some(function (r) {
        return r.required && !r.present && !form.secrets[r.key];
      });
    }

    function close() {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
    }

    function onKey(e) {
      if (e.key === 'Escape') close();
    }

    function loadPlan() {
      var mine = ++seq;
      plan = null;
      error = '';
      draw();
      AD._fetch('/api/install/plan?' + planQuery())
        .then(function (r) {
          return r.json().then(function (data) {
            if (!r.ok) throw new Error(data.error || 'Could not build the install plan');
            return data;
          });
        })
        .then(function (p) {
          if (mine !== seq) return;
          plan = p;
          if (!form.local_name) form.local_name = p.server;
          draw();
        })
        .catch(function (err) {
          if (mine !== seq) return;
          error = err.message;
          draw();
        });
    }

    function install() {
      busy = true;
      error = '';
      draw();
      var secrets = {};
      Object.keys(form.secrets).forEach(function (k) {
        if (form.secrets[k]) secrets[k] = form.secrets[k];
      });
      AD._fetch('/api/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: entry.source,
          name: entry.name,
          local_name: form.local_name || undefined,
          transport: form.transport || undefined,
          enable: form.enable,
          secrets: secrets,
        }),
      })
        .then(function (r) {
          return r.json().then(function (data) {
            if (!r.ok) throw new Error(data.error || 'Install failed');
            return data;
          });
        })
        .then(function (data) {
          close();
          showToast(
            data.index_error
              ? 'Installed ' + data.name + ', indexing failed: ' + data.index_error
              : 'Installed ' + data.name + ' (' + (data.tool_count || 0) + ' tools)',
            data.index_error ? 'error' : 'success',
          );
          renderBrowse();
          navigate(serverHref(data.name));
        })
        .catch(function (err) {
          busy = false;
          error = err.message;
          draw();
        });
    }

    function section(title, kids) {
      return h(
        'div',
        { class: 'consent-section' },
        [h('div', { class: 'consent-label' }, [title])].concat(kids),
      );
    }

    function requirementRow(req) {
      var input = h('input', {
        type: req.secret ? 'password' : 'text',
        class: 'consent-input',
        'data-req': req.key,
        autocomplete: 'off',
        placeholder: req.present ? 'already set' : req.required ? 'required' : 'optional',
        oninput: function () {
          form.secrets[req.key] = this.value;
          var btn = backdrop.querySelector('[data-consent="install"]');
          if (btn) btn.disabled = busy || !!plan.blocked || missingRequired();
        },
      });
      input.value = form.secrets[req.key] || '';
      return h('div', { class: 'consent-req' }, [
        h('div', { class: 'consent-req-head' }, [
          h('code', {}, [req.key]),
          h('span', { class: 'tag' }, [req.kind]),
          req.secret ? h('span', { class: 'tag tag-warn' }, ['secret']) : null,
          req.required ? h('span', { class: 'tag tag-deprecated' }, ['required']) : null,
        ]),
        req.description ? h('div', { class: 'hint' }, [req.description]) : null,
        input,
      ]);
    }

    function provenanceFacts(p) {
      var rows = [];
      var fact = function (k, v) {
        if (v != null && v !== '')
          rows.push(h('div', { class: 'fact' }, [h('span', {}, [k]), h('span', {}, [v])]));
      };
      if (p.registry) {
        fact('Registry entry', p.registry.name + ' (' + p.registry.status + ')');
        fact('Verified publisher', p.registry.publisher);
      }
      if (p.package)
        fact(
          'Package',
          p.package.ecosystem + ': ' + p.package.name + '@' + (p.package.version || 'latest'),
        );
      if (p.remote) fact('Endpoint', p.remote.type + ' ' + p.remote.url);
      fact('Version pinned', p.pinned ? 'yes' : 'no (resolved at launch)');
      fact('Image digest', p.digest);
      var repo = safeHref(p.repository);
      if (repo) fact('Repository', repo);
      (p.checks || []).forEach(function (c) {
        rows.push(
          h('div', { class: 'fact check-' + c.status }, [
            h('span', {}, [(c.status === 'pass' ? 'pass ' : c.status + ' ') + c.id]),
            h('span', {}, [c.detail]),
          ]),
        );
      });
      return rows;
    }

    function draw() {
      installBtn.disabled = busy || !plan || !!plan.blocked || missingRequired();
      installBtn.textContent = busy ? 'Installing...' : 'Install';
      errorEl.textContent = plan ? error : '';
      body.textContent = '';
      var opts = transportOptions(entry);
      if (!plan) {
        body.appendChild(
          error
            ? h('div', { class: 'banner banner-danger' }, [
                icon('error'),
                h('div', { class: 'banner-main' }, [h('div', { class: 'banner-title' }, [error])]),
              ])
            : h('div', { class: 'loading' }, ['Building install plan...']),
        );
        return;
      }
      var cmd = plan.command
        ? [plan.command]
            .concat(plan.args || [])
            .map(shellQuote)
            .join(' ')
        : plan.url + '  (' + plan.transport + ')';
      body.appendChild(h('p', { class: 'consent-desc' }, [plan.description || '']));
      if (plan.blocked)
        body.appendChild(
          h('div', { class: 'banner banner-danger', 'data-consent': 'blocked' }, [
            icon('block'),
            h('div', { class: 'banner-main' }, [
              h('div', { class: 'banner-title' }, ['Cannot be installed']),
              h('div', { class: 'banner-body' }, [plan.blocked]),
            ]),
          ]),
        );
      (plan.warnings || []).forEach(function (w) {
        body.appendChild(
          h('div', { class: 'banner banner-warn', 'data-consent': 'warning' }, [
            icon('warning'),
            h('div', { class: 'banner-main' }, [h('div', { class: 'banner-title' }, [w])]),
          ]),
        );
      });
      body.appendChild(
        section(plan.command ? 'Runs this command on your machine' : 'Connects to', [
          h('pre', { class: 'consent-cmd', 'data-consent': 'command' }, [cmd]),
        ]),
      );
      var nameInput = h('input', {
        class: 'consent-input',
        'data-consent': 'local-name',
        value: form.local_name,
        onchange: function () {
          form.local_name = this.value.trim();
          loadPlan();
        },
      });
      var nameRow = [h('label', {}, ['Local name ', nameInput])];
      if (opts.length > 1)
        nameRow.push(
          h('label', {}, [
            ' Install as ',
            h(
              'select',
              {
                class: 'consent-input',
                onchange: function () {
                  form.transport = this.value;
                  loadPlan();
                },
              },
              opts.map(function (o) {
                return h('option', { value: o, selected: o === plan.transport }, [o]);
              }),
            ),
          ]),
        );
      body.appendChild(h('div', { class: 'consent-row' }, nameRow));
      if ((plan.requirements || []).length)
        body.appendChild(section('Needs these values', plan.requirements.map(requirementRow)));
      body.appendChild(
        section('Provenance', [
          h('div', { class: 'facts' }, provenanceFacts(plan.provenance || {})),
        ]),
      );
    }

    var enableBox = h('input', {
      type: 'checkbox',
      checked: true,
      onchange: function () {
        form.enable = this.checked;
      },
    });

    backdrop = h(
      'div',
      {
        class: 'modal-backdrop',
        onmousedown: function (e) {
          if (e.target === backdrop) close();
        },
      },
      [
        h(
          'div',
          {
            class: 'modal consent',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': 'Install ' + entry.name,
          },
          [
            h('div', { class: 'modal-header' }, [
              h('div', {}, [
                h('div', { class: 'modal-title' }, ['Install ' + (entry.title || entry.name)]),
                h('div', { class: 'modal-sub' }, [
                  entry.source + (entry.version ? ' · ' + entry.version : ''),
                ]),
              ]),
              h('button', { class: 'modal-close', title: 'Close', onclick: close }, [
                icon('close'),
              ]),
            ]),
            body,
            errorEl,
            h('div', { class: 'modal-footer' }, [
              h('label', { class: 'consent-check' }, [enableBox, ' Enable after install']),
              h('div', { class: 'modal-actions' }, [
                h('button', { class: 'btn-secondary', onclick: close }, ['Cancel']),
                installBtn,
              ]),
            ]),
          ],
        ),
      ],
    );
    document.addEventListener('keydown', onKey);
    overlayHost().appendChild(backdrop);
    loadPlan();
  }

  // -------------------------------------------------------------------------
  // Enterprise feature actions
  // -------------------------------------------------------------------------

  window.__toggleSection = function (serverId, name) {
    var key = serverId + '-' + name;
    openSections[key] = !openSections[key];
    if (openSections[key]) {
      // Load data when opening
      if (name === 'secrets') {
        AD._fetch('/api/servers/' + serverId + '/secrets')
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
        AD._fetch('/api/servers/' + serverId + '/metrics')
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
    AD._fetch('/api/servers/' + serverId + '/health', { method: 'POST' })
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

    AD._fetch('/api/servers/' + serverId + '/secrets/' + encodeURIComponent(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: value }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function () {
        keyEl.value = valEl.value = '';
        showToast('Secret "' + key + '" saved', 'success');
        // Reload secrets
        return AD._fetch('/api/servers/' + serverId + '/secrets').then(function (r) {
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
    AD._fetch('/api/servers/' + serverId + '/secrets/' + encodeURIComponent(key), {
      method: 'DELETE',
    })
      .then(function (r) {
        return r.json();
      })
      .then(function () {
        showToast('Secret "' + key + '" deleted', 'success');
        return AD._fetch('/api/servers/' + serverId + '/secrets').then(function (r) {
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

    AD._fetch('/api/servers/' + serverId, {
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
    overlayHost().appendChild(toast);

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
      body.url = urlVal;
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
  // Audit tab (GET /api/audit, newest first, paged backwards with before=<id>)
  // -------------------------------------------------------------------------

  var AUDIT_PAGE = 50;

  function loadAudit(more) {
    var q = new URLSearchParams({ limit: String(AUDIT_PAGE) });
    ['server', 'action', 'tool'].forEach(function (k) {
      if (auditFilter[k]) q.set(k, auditFilter[k]);
    });
    if (more && audit.entries.length)
      q.set('before', String(audit.entries[audit.entries.length - 1].id));
    var seq = ++auditSeq;
    AD._fetch('/api/audit?' + q.toString())
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data.error || 'Failed to load audit log');
          return data;
        });
      })
      .then(function (data) {
        if (seq !== auditSeq) return;
        var page = data.entries || [];
        audit = {
          entries: more ? audit.entries.concat(page) : page,
          total: data.total || 0,
          more: page.length === AUDIT_PAGE,
          error: '',
        };
        renderAudit();
      })
      .catch(function (err) {
        if (seq !== auditSeq) return;
        audit.error = err.message;
        renderAudit();
      });
  }

  function renderAudit() {
    var el = $id('audit-list');
    if (!el) return;
    var sel = $id('audit-filter-server');
    if (sel) {
      var names = state.servers.map(function (s) {
        return s.name;
      });
      if (auditFilter.server && names.indexOf(auditFilter.server) === -1)
        names.push(auditFilter.server);
      morph(
        sel,
        '<option value="">All servers</option>' +
          names
            .map(function (n) {
              return (
                '<option value="' +
                escAttr(n) +
                '"' +
                (n === auditFilter.server ? ' selected' : '') +
                '>' +
                esc(n) +
                '</option>'
              );
            })
            .join(''),
      );
    }
    var count = $id('audit-count');
    if (count) count.textContent = audit.total ? audit.total + ' entries' : '';
    if (audit.error) {
      el.innerHTML =
        '<div class="empty-state"><span class="material-symbols-outlined empty-icon">error</span><p>' +
        esc(audit.error) +
        '</p></div>';
      return;
    }
    if (!audit.entries.length) {
      el.innerHTML =
        '<div class="empty-state"><span class="material-symbols-outlined empty-icon">fact_check</span><p>No audit entries</p><p class="hint">Installs, approvals, quarantines, secret changes and tool calls are recorded here</p></div>';
      return;
    }
    var rows = audit.entries
      .map(function (e) {
        var detail = e.detail ? JSON.stringify(e.detail) : '';
        var result =
          e.is_error === true
            ? '<span class="log-badge log-fail">ERROR</span>'
            : e.is_error === false
              ? '<span class="log-badge log-success">OK</span>'
              : '';
        return (
          '<tr class="audit-row" data-audit-id="' +
          e.id +
          '"><td class="log-ts">' +
          esc(formatTs(e.ts)) +
          '</td><td><span class="tag audit-action audit-' +
          escAttr(e.action) +
          '">' +
          esc(e.action) +
          '</span></td><td>' +
          (e.server
            ? '<a href="' + escAttr(serverHref(e.server)) + '">' + esc(e.server) + '</a>'
            : '') +
          '</td><td>' +
          esc(e.tool || '') +
          '</td><td>' +
          result +
          '</td><td class="log-latency">' +
          (e.duration_ms != null ? esc(e.duration_ms) + 'ms' : '') +
          '</td><td class="audit-detail">' +
          esc(detail) +
          '</td></tr>'
        );
      })
      .join('');
    morph(
      el,
      '<table class="logs-table"><thead><tr><th>Time</th><th>Action</th><th>Server</th><th>Tool</th><th>Result</th><th>Duration</th><th>Detail</th></tr></thead><tbody>' +
        rows +
        '</tbody></table>' +
        (audit.more
          ? '<div class="audit-more"><button class="btn-secondary" data-action="audit-more">Load older</button></div>'
          : ''),
    );
  }

  function formatTs(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts || '');
    var p = function (n) {
      return String(n).padStart(2, '0');
    };
    return (
      d.getFullYear() +
      '-' +
      p(d.getMonth() + 1) +
      '-' +
      p(d.getDate()) +
      ' ' +
      p(d.getHours()) +
      ':' +
      p(d.getMinutes()) +
      ':' +
      p(d.getSeconds())
    );
  }

  function initAuditFilters() {
    var bind = function (id, key, evt) {
      var el = $id(id);
      if (!el) return;
      var t;
      el.addEventListener(evt, function () {
        auditFilter[key] = this.value.trim();
        clearTimeout(t);
        t = setTimeout(
          function () {
            loadAudit(false);
          },
          evt === 'input' ? 300 : 0,
        );
      });
    };
    bind('audit-filter-server', 'server', 'change');
    bind('audit-filter-action', 'action', 'change');
    bind('audit-filter-tool', 'tool', 'input');
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
        case 'enable':
          window.__enableServer(id);
          break;
        case 'disable':
          window.__disableServer(id);
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
        case 'install-npm': {
          var pkg = ($id('npm-package-input') || {}).value;
          if (pkg && pkg.trim()) openConsent({ source: 'npm', name: pkg.trim() });
          break;
        }
        case 'install-browse':
          openConsent(browseResults[parseInt(btn.dataset.browseIdx, 10)]);
          break;
        case 'approve':
          window.__approve(id);
          break;
        case 'keep-disabled':
          window.__keepDisabled(id);
          break;
        case 'sign-in':
          window.__signIn(id);
          break;
        case 'audit-more':
          loadAudit(true);
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
    if (!$id('tab-installed')) document.body.insertAdjacentHTML('afterbegin', AD._template());
    initTabs();
    initTheme();
    initSearch();
    initAuditFilters();
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
