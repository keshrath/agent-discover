/* eslint-disable */
(function () {
  'use strict';
  var AD = (window.AD = window.AD || {});

  var state = {};
  var eventBuffers = {};
  var presetsCache = {};
  var elicitationModalOpen = null;
  var PRESET_KEY = 'agent-discover-tester-presets-v1';
  var PRESET_MIGRATED_KEY = 'agent-discover-presets-migrated-v2';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getState(serverId) {
    if (!state[serverId]) {
      state[serverId] = {
        subtab: 'tools',
        tools: null,
        resources: null,
        resourceCursor: null,
        prompts: null,
        info: null,
        selectedTool: null,
        selectedPrompt: null,
        selectedResource: null,
        result: null,
        resultMode: 'pretty',
        pingRtt: null,
        loggingLevel: 'info',
        loading: false,
        error: null,
        floating: false,
        handle: null,
        serverName: null,
      };
    }
    return state[serverId];
  }

  function baseUrl(serverId, handle) {
    return handle ? '/api/transient/' + encodeURIComponent(handle) : '/api/servers/' + serverId;
  }

  function doFetch(url, opts) {
    return AD._fetch(url, opts).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + r.status);
        return body;
      });
    });
  }

  AD.renderTesterShell = function (server) {
    var s = getState(server.id);
    s.serverName = server.name;
    var capsKnown = s.info && s.info !== 'error' && s.info.capabilities;
    var caps = capsKnown ? s.info.capabilities : null;
    // When capabilities are not yet known, show all tabs optimistically.
    // The server will 400 on unsupported methods and the UI will surface it.
    var hasResources = caps ? !!caps.resources : true;
    var hasPrompts = caps ? !!caps.prompts : true;
    return (
      '<div class="tester-shell" data-tester-id="' +
      server.id +
      '">' +
      '<div class="tester-tabs">' +
      tabBtn(server.id, 'tools', 'Tools', true) +
      tabBtn(server.id, 'info', 'Info', true) +
      tabBtn(
        server.id,
        'resources',
        'Resources',
        hasResources,
        !hasResources ? 'Server does not advertise resources' : '',
      ) +
      tabBtn(
        server.id,
        'prompts',
        'Prompts',
        hasPrompts,
        !hasPrompts ? 'Server does not advertise prompts' : '',
      ) +
      tabBtn(server.id, 'events', 'Events', true) +
      tabBtn(server.id, 'export', 'Export', true) +
      tabBtn(server.id, 'diagnostics', 'Diagnostics', true) +
      '<button class="tester-popout" data-action="tester-popout" data-id="' +
      server.id +
      '" title="Open in floating panel"><span class="material-symbols-outlined" style="font-size:14px">open_in_new</span></button>' +
      '</div>' +
      '<div class="tester-body" data-tester-body="' +
      server.id +
      '">' +
      '<div class="hint">Expand to load...</div>' +
      '</div>' +
      '</div>'
    );
  };

  function tabBtn(serverId, name, label, enabled, title) {
    var st = getState(serverId);
    return (
      '<button class="tester-tab' +
      (st.subtab === name ? ' active' : '') +
      (enabled ? '' : ' disabled') +
      '"' +
      (enabled
        ? ' data-action="tester-subtab" data-id="' + serverId + '" data-subtab="' + name + '"'
        : ' disabled') +
      (title ? ' title="' + esc(title) + '"' : '') +
      '>' +
      esc(label) +
      '</button>'
    );
  }

  AD.openTesterFor = function (serverId) {
    var s = getState(serverId);
    renderBody(serverId);
    if (!s.info) loadInfo(serverId);
  };

  function renderBody(serverId) {
    var bodies = document.querySelectorAll('[data-tester-body="' + serverId + '"]');
    if (!bodies.length) return;
    var s = getState(serverId);
    var html;
    switch (s.subtab) {
      case 'tools':
        html = renderToolsTab(serverId);
        break;
      case 'info':
        html = renderInfoTab(serverId);
        break;
      case 'resources':
        html = renderResourcesTab(serverId);
        break;
      case 'prompts':
        html = renderPromptsTab(serverId);
        break;
      case 'events':
        html = renderEventsTab(serverId);
        break;
      case 'export':
        html = renderExportTab(serverId);
        break;
      case 'diagnostics':
        html = renderDiagnosticsTab(serverId);
        break;
      default:
        html = '<div class="hint">Unknown tab</div>';
    }
    for (var i = 0; i < bodies.length; i++) {
      bodies[i].innerHTML = html;
    }
    syncTabHighlight(serverId);
    bindBody(serverId);
  }

  function syncTabHighlight(serverId) {
    var s = getState(serverId);
    var shells = document.querySelectorAll('[data-tester-id="' + serverId + '"]');
    shells.forEach(function (shell) {
      shell.querySelectorAll('.tester-tab').forEach(function (b) {
        if (b.getAttribute('data-subtab') === s.subtab) b.classList.add('active');
        else b.classList.remove('active');
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Tools tab
  // ---------------------------------------------------------------------------

  function renderToolsTab(serverId) {
    var s = getState(serverId);
    if (s.tools == null) {
      loadTools(serverId);
      return '<div class="hint">Loading tools...</div>';
    }
    if (s.tools.length === 0) return '<div class="hint">This server exposes no tools.</div>';
    var list = s.tools
      .map(function (t) {
        return (
          '<button class="tester-listitem' +
          (s.selectedTool === t.name ? ' active' : '') +
          '" data-action="tester-select-tool" data-id="' +
          serverId +
          '" data-name="' +
          esc(t.name) +
          '">' +
          '<div class="tester-listitem-name">' +
          esc(t.name) +
          '</div>' +
          (t.description
            ? '<div class="tester-listitem-desc">' + esc(t.description) + '</div>'
            : '') +
          '</button>'
        );
      })
      .join('');
    var panel = s.selectedTool
      ? renderToolForm(serverId)
      : '<div class="hint">Select a tool to call.</div>';
    return (
      '<div class="tester-split">' +
      '<div class="tester-list">' +
      list +
      '</div>' +
      '<div class="tester-detail">' +
      panel +
      '</div>' +
      '</div>'
    );
  }

  function renderToolForm(serverId) {
    var s = getState(serverId);
    var tool = s.tools.find(function (t) {
      return t.name === s.selectedTool;
    });
    if (!tool) return '<div class="hint">Tool disappeared.</div>';
    var presets = loadPresets(s.serverName, 'tool', tool.name);
    var presetList = Object.keys(presets);
    var presetOpts =
      '<option value="">Preset…</option>' +
      presetList
        .map(function (k) {
          return '<option value="' + esc(k) + '">' + esc(k) + '</option>';
        })
        .join('');
    return (
      '<div class="tester-form">' +
      '<div class="tester-form-head"><strong>' +
      esc(tool.name) +
      '</strong>' +
      (tool.description ? '<p class="tester-desc">' + esc(tool.description) + '</p>' : '') +
      '</div>' +
      '<div class="tester-form-fields" data-form-for="' +
      esc(tool.name) +
      '"></div>' +
      '<div class="tester-form-actions">' +
      '<button class="btn-activate" data-action="tester-call" data-id="' +
      serverId +
      '">Call tool</button>' +
      '<select class="tester-preset-sel" data-action="tester-preset-load" data-id="' +
      serverId +
      '">' +
      presetOpts +
      '</select>' +
      '<button class="btn-health" data-action="tester-preset-save" data-id="' +
      serverId +
      '">Save as preset</button>' +
      '</div>' +
      renderResult(serverId) +
      '</div>'
    );
  }

  // ---------------------------------------------------------------------------
  // Info tab
  // ---------------------------------------------------------------------------

  function renderInfoTab(serverId) {
    var s = getState(serverId);
    if (s.info == null) {
      loadInfo(serverId);
      return '<div class="hint">Loading server info...</div>';
    }
    if (s.info === 'error')
      return '<div class="hint error">' + esc(s.error || 'Failed to load info') + '</div>';
    var caps = s.info.capabilities || {};
    var capRows = Object.keys(caps)
      .map(function (k) {
        return (
          '<div class="tester-cap-row"><span class="tester-cap-name">' +
          esc(k) +
          '</span><span class="tester-cap-val">' +
          esc(JSON.stringify(caps[k])) +
          '</span></div>'
        );
      })
      .join('');
    return (
      '<div class="tester-info">' +
      '<div class="tester-info-grid">' +
      '<div><span class="tester-info-k">Name</span><span class="tester-info-v">' +
      esc(s.info.name) +
      '</span></div>' +
      '<div><span class="tester-info-k">Version</span><span class="tester-info-v">' +
      esc(s.info.version) +
      '</span></div>' +
      '</div>' +
      (s.info.instructions
        ? '<div class="tester-info-instr"><h4>Instructions</h4><div class="md">' +
          (AD.renderMarkdown ? AD.renderMarkdown(s.info.instructions) : esc(s.info.instructions)) +
          '</div></div>'
        : '') +
      '<h4>Capabilities</h4>' +
      '<div class="tester-caps">' +
      (capRows || '<div class="hint">(none)</div>') +
      '</div>' +
      '</div>'
    );
  }

  // ---------------------------------------------------------------------------
  // Resources tab
  // ---------------------------------------------------------------------------

  function renderResourcesTab(serverId) {
    var s = getState(serverId);
    if (s.resources == null) {
      loadResources(serverId);
      return '<div class="hint">Loading resources...</div>';
    }
    var list = s.resources
      .map(function (r) {
        return (
          '<button class="tester-listitem' +
          (s.selectedResource === r.uri ? ' active' : '') +
          '" data-action="tester-select-resource" data-id="' +
          serverId +
          '" data-uri="' +
          esc(r.uri) +
          '">' +
          '<div class="tester-listitem-name">' +
          esc(r.name || r.uri) +
          '</div>' +
          '<div class="tester-listitem-desc">' +
          esc(r.uri) +
          (r.mimeType ? ' — ' + esc(r.mimeType) : '') +
          '</div>' +
          '</button>'
        );
      })
      .join('');
    var more = s.resourceCursor
      ? '<button class="btn-health" data-action="tester-resources-more" data-id="' +
        serverId +
        '">Load more</button>'
      : '';
    var detail = s.selectedResource
      ? renderResourceDetail(serverId)
      : '<div class="hint">Pick a resource to read. You can also subscribe for live updates.</div>';
    return (
      '<div class="tester-split">' +
      '<div class="tester-list">' +
      (list || '<div class="hint">No resources.</div>') +
      more +
      '</div>' +
      '<div class="tester-detail">' +
      detail +
      '</div>' +
      '</div>'
    );
  }

  function renderResourceDetail(serverId) {
    var s = getState(serverId);
    var contents = s.resourceContents;
    var body;
    if (!contents) body = '<div class="hint">Click Read to load.</div>';
    else {
      body =
        '<div class="tester-result-raw"><pre>' +
        esc(JSON.stringify(contents, null, 2)) +
        '</pre></div>';
    }
    return (
      '<div class="tester-form">' +
      '<div class="tester-form-head"><strong>' +
      esc(s.selectedResource) +
      '</strong></div>' +
      '<div class="tester-form-actions">' +
      '<button class="btn-activate" data-action="tester-resource-read" data-id="' +
      serverId +
      '">Read</button>' +
      '<button class="btn-health" data-action="tester-resource-subscribe" data-id="' +
      serverId +
      '">Subscribe</button>' +
      '<button class="btn-delete" data-action="tester-resource-unsubscribe" data-id="' +
      serverId +
      '">Unsubscribe</button>' +
      '</div>' +
      body +
      '</div>'
    );
  }

  // ---------------------------------------------------------------------------
  // Prompts tab
  // ---------------------------------------------------------------------------

  function renderPromptsTab(serverId) {
    var s = getState(serverId);
    if (s.prompts == null) {
      loadPrompts(serverId);
      return '<div class="hint">Loading prompts...</div>';
    }
    var list = s.prompts
      .map(function (p) {
        return (
          '<button class="tester-listitem' +
          (s.selectedPrompt === p.name ? ' active' : '') +
          '" data-action="tester-select-prompt" data-id="' +
          serverId +
          '" data-name="' +
          esc(p.name) +
          '">' +
          '<div class="tester-listitem-name">' +
          esc(p.name) +
          '</div>' +
          (p.description
            ? '<div class="tester-listitem-desc">' + esc(p.description) + '</div>'
            : '') +
          '</button>'
        );
      })
      .join('');
    var detail = s.selectedPrompt
      ? renderPromptForm(serverId)
      : '<div class="hint">Pick a prompt.</div>';
    return (
      '<div class="tester-split">' +
      '<div class="tester-list">' +
      (list || '<div class="hint">No prompts.</div>') +
      '</div>' +
      '<div class="tester-detail">' +
      detail +
      '</div>' +
      '</div>'
    );
  }

  function renderPromptForm(serverId) {
    var s = getState(serverId);
    var prompt = s.prompts.find(function (p) {
      return p.name === s.selectedPrompt;
    });
    if (!prompt) return '<div class="hint">Prompt missing.</div>';
    var argsRows = (prompt.arguments || [])
      .map(function (a) {
        return (
          '<div class="sf-field" data-type="string" data-path="' +
          esc(a.name) +
          '">' +
          '<label>' +
          esc(a.name) +
          (a.required ? ' <span class="sf-req">*</span>' : '') +
          '</label>' +
          '<input type="text" class="sf-input" data-path="' +
          esc(a.name) +
          '" />' +
          (a.description ? '<div class="sf-desc">' + esc(a.description) + '</div>' : '') +
          '</div>'
        );
      })
      .join('');
    var msgs = s.promptMessages;
    var msgRender = '';
    if (msgs) {
      msgRender =
        '<div class="tester-messages">' +
        msgs
          .map(function (m) {
            var body = '';
            if (m.content && m.content.type === 'text')
              body = AD.renderMarkdown ? AD.renderMarkdown(m.content.text) : esc(m.content.text);
            else body = '<pre>' + esc(JSON.stringify(m.content, null, 2)) + '</pre>';
            return (
              '<div class="tester-message tester-message-' +
              esc(m.role) +
              '"><div class="tester-msg-role">' +
              esc(m.role) +
              '</div><div class="tester-msg-body">' +
              body +
              '</div></div>'
            );
          })
          .join('') +
        '</div>';
    }
    return (
      '<div class="tester-form">' +
      '<div class="tester-form-head"><strong>' +
      esc(prompt.name) +
      '</strong>' +
      (prompt.description ? '<p class="tester-desc">' + esc(prompt.description) + '</p>' : '') +
      '</div>' +
      '<div class="tester-prompt-fields">' +
      (argsRows || '<div class="hint">No arguments.</div>') +
      '</div>' +
      '<div class="tester-form-actions">' +
      '<button class="btn-activate" data-action="tester-prompt-get" data-id="' +
      serverId +
      '">Get prompt</button>' +
      '</div>' +
      msgRender +
      '</div>'
    );
  }

  // ---------------------------------------------------------------------------
  // Events / Export / Diagnostics
  // ---------------------------------------------------------------------------

  function renderEventsTab(serverId) {
    var s = getState(serverId);
    var buf = eventBuffers[s.serverName] || [];
    if (buf.length === 0)
      return '<div class="hint">No events yet. Server notifications and progress updates will appear here.</div>';
    var rows = buf
      .slice(0, 100)
      .map(function (e) {
        return (
          '<div class="tester-event tester-event-' +
          esc(e.type) +
          '">' +
          '<span class="tester-event-ts">' +
          esc((e.ts || '').substr(11, 8)) +
          '</span>' +
          '<span class="tester-event-kind">' +
          esc(e.type) +
          '</span>' +
          '<span class="tester-event-method">' +
          esc(e.method || (e.payload && e.payload.token) || '') +
          '</span>' +
          '<pre class="tester-event-payload">' +
          esc(JSON.stringify(e.params || e.payload || {}, null, 2)) +
          '</pre>' +
          '</div>'
        );
      })
      .join('');
    return '<div class="tester-events">' + rows + '</div>';
  }

  function renderExportTab(serverId) {
    var s = getState(serverId);
    if (!s.exportFormat) s.exportFormat = 'mcp-json';
    var fmt = s.exportFormat;
    if (!s.exportBody || s.exportBody.format !== fmt) {
      exportConfig(serverId, fmt);
    }
    var formats = [
      {
        id: 'mcp-json',
        label: 'mcp.json',
        hint: 'Generic MCP client config — Claude Desktop, Claude Code, Cursor, Windsurf.',
      },
      {
        id: 'agent-discover',
        label: 'agent-discover',
        hint: 'Declarative setup file (AGENT_DISCOVER_SETUP_FILE).',
      },
    ];
    var seg = formats
      .map(function (f) {
        return (
          '<button class="tester-seg' +
          (fmt === f.id ? ' active' : '') +
          '" data-action="tester-export" data-id="' +
          serverId +
          '" data-format="' +
          f.id +
          '">' +
          esc(f.label) +
          '</button>'
        );
      })
      .join('');
    var hint = formats.find(function (f) {
      return f.id === fmt;
    });
    var body =
      s.exportBody && s.exportBody.format === fmt
        ? '<div class="tester-result-raw"><pre>' +
          (AD.highlightJson
            ? AD.highlightJson(s.exportBody.config)
            : esc(JSON.stringify(s.exportBody.config, null, 2))) +
          '</pre></div>'
        : '<div class="hint">Loading…</div>';
    return (
      '<div class="tester-export">' +
      '<div class="tester-export-head">' +
      '<div class="tester-segmented">' +
      seg +
      '</div>' +
      '<button class="tester-copy-btn" data-action="tester-export-copy" data-id="' +
      serverId +
      '" title="Copy to clipboard">' +
      '<span class="material-symbols-outlined" style="font-size:14px">content_copy</span>' +
      ' Copy' +
      '</button>' +
      '</div>' +
      (hint ? '<div class="tester-export-hint">' + esc(hint.hint) + '</div>' : '') +
      body +
      '</div>'
    );
  }

  function renderDiagnosticsTab(serverId) {
    var s = getState(serverId);
    var rtt =
      s.pingRtt != null
        ? '<strong>' + esc(s.pingRtt) + ' ms</strong>'
        : '<span class="hint">not pinged yet</span>';
    return (
      '<div class="tester-diagnostics">' +
      '<div class="tester-form-row"><label>Last ping</label>' +
      rtt +
      ' <button class="btn-activate" data-action="tester-ping" data-id="' +
      serverId +
      '">Ping</button></div>' +
      '<div class="tester-form-row"><label>Logging level</label>' +
      '<select data-action="noop" data-tester-logging="' +
      serverId +
      '">' +
      ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']
        .map(function (l) {
          return (
            '<option value="' +
            l +
            '"' +
            (l === s.loggingLevel ? ' selected' : '') +
            '>' +
            l +
            '</option>'
          );
        })
        .join('') +
      '</select> <button class="btn-activate" data-action="tester-set-logging" data-id="' +
      serverId +
      '">Apply</button></div>' +
      '</div>'
    );
  }

  // ---------------------------------------------------------------------------
  // Result pane
  // ---------------------------------------------------------------------------

  function renderResult(serverId) {
    var s = getState(serverId);
    if (s.loading) return '<div class="tester-result loading">Calling…</div>';
    if (s.error) return '<div class="tester-result error">' + esc(s.error) + '</div>';
    if (!s.result) return '';
    var mode = s.resultMode || 'pretty';
    var pretty = renderPrettyResult(s.result);
    var raw =
      '<pre class="tester-result-raw">' +
      (AD.highlightJson ? AD.highlightJson(s.result) : esc(JSON.stringify(s.result, null, 2))) +
      '</pre>';
    var curl = renderCurl(serverId, s.selectedTool, s.lastArgs);
    var body = mode === 'raw' ? raw : mode === 'curl' ? curl : pretty;
    var pill = s.result.isError
      ? '<span class="tester-pill fail">error</span>'
      : '<span class="tester-pill ok">ok</span>';
    var latency =
      s.lastLatency != null
        ? '<span class="tester-latency">' + esc(s.lastLatency) + ' ms</span>'
        : '';
    return (
      '<div class="tester-result">' +
      '<div class="tester-result-tabs">' +
      '<button class="' +
      (mode === 'pretty' ? 'active' : '') +
      '" data-action="tester-result-mode" data-id="' +
      serverId +
      '" data-mode="pretty">Pretty</button>' +
      '<button class="' +
      (mode === 'raw' ? 'active' : '') +
      '" data-action="tester-result-mode" data-id="' +
      serverId +
      '" data-mode="raw">Raw</button>' +
      '<button class="' +
      (mode === 'curl' ? 'active' : '') +
      '" data-action="tester-result-mode" data-id="' +
      serverId +
      '" data-mode="curl">cURL</button>' +
      pill +
      latency +
      '</div>' +
      '<div class="tester-result-body">' +
      body +
      '</div>' +
      '</div>'
    );
  }

  function renderPrettyResult(result) {
    if (!result.content || !Array.isArray(result.content)) {
      return '<pre>' + esc(JSON.stringify(result, null, 2)) + '</pre>';
    }
    return result.content
      .map(function (c) {
        if (c.type === 'text')
          return (
            '<div class="tester-content-text">' +
            (AD.renderMarkdown ? AD.renderMarkdown(c.text) : esc(c.text)) +
            '</div>'
          );
        if (c.type === 'image')
          return (
            '<img class="tester-content-img" src="data:' +
            esc(c.mimeType) +
            ';base64,' +
            esc(c.data) +
            '"/>'
          );
        if (c.type === 'audio')
          return (
            '<audio class="tester-content-audio" controls src="data:' +
            esc(c.mimeType) +
            ';base64,' +
            esc(c.data) +
            '"></audio>'
          );
        if (c.type === 'resource')
          return (
            '<div class="tester-content-resource">Resource: <code>' +
            esc(c.resource && c.resource.uri) +
            '</code></div>'
          );
        if (c.type === 'resource_link')
          return (
            '<div class="tester-content-resource">Link: <a href="' +
            esc(c.uri) +
            '" target="_blank">' +
            esc(c.name || c.uri) +
            '</a></div>'
          );
        return '<pre>' + esc(JSON.stringify(c, null, 2)) + '</pre>';
      })
      .join('');
  }

  function renderCurl(serverId, tool, args) {
    var url = (location.origin || '') + '/api/servers/' + serverId + '/call';
    var body = JSON.stringify({ tool: tool, args: args || {} });
    return (
      '<pre class="tester-curl">curl -X POST ' +
      esc(url) +
      " \\\n  -H 'Content-Type: application/json' \\\n  -d '" +
      esc(body) +
      "'</pre>"
    );
  }

  // ---------------------------------------------------------------------------
  // Data loads
  // ---------------------------------------------------------------------------

  function loadInfo(serverId) {
    var s = getState(serverId);
    doFetch(baseUrl(serverId, s.handle) + '/info')
      .then(function (body) {
        s.info =
          body && body.capabilities ? body : { name: s.serverName, version: '', capabilities: {} };
        renderBody(serverId);
      })
      .catch(function (err) {
        s.info = 'error';
        s.error = err.message;
        renderBody(serverId);
      });
  }

  function loadTools(serverId) {
    var s = getState(serverId);
    doFetch(baseUrl(serverId, s.handle) + '/tools')
      .then(function (body) {
        s.tools = body.tools || [];
        renderBody(serverId);
      })
      .catch(function (err) {
        s.tools = [];
        s.error = err.message;
        renderBody(serverId);
      });
  }

  function loadResources(serverId, append) {
    var s = getState(serverId);
    var url =
      baseUrl(serverId, s.handle) +
      '/resources' +
      (s.resourceCursor && append ? '?cursor=' + encodeURIComponent(s.resourceCursor) : '');
    doFetch(url)
      .then(function (body) {
        var incoming = body.resources || [];
        s.resources = append ? (s.resources || []).concat(incoming) : incoming;
        s.resourceCursor = body.nextCursor || null;
        renderBody(serverId);
      })
      .catch(function (err) {
        s.resources = [];
        s.error = err.message;
        renderBody(serverId);
      });
  }

  function loadPrompts(serverId) {
    var s = getState(serverId);
    doFetch(baseUrl(serverId, s.handle) + '/prompts')
      .then(function (body) {
        s.prompts = body.prompts || [];
        renderBody(serverId);
      })
      .catch(function (err) {
        s.prompts = [];
        s.error = err.message;
        renderBody(serverId);
      });
  }

  // ---------------------------------------------------------------------------
  // Presets (localStorage)
  // ---------------------------------------------------------------------------

  function presetCacheKey(serverName, kind, targetName) {
    return (serverName || '') + '::' + kind + '::' + (targetName || '');
  }

  function loadPresets(serverName, kind, targetName) {
    var key = presetCacheKey(serverName, kind, targetName);
    if (presetsCache[key]) return presetsCache[key];
    // Kick an async fetch; return empty until it resolves.
    fetchPresets(serverName, kind, targetName);
    return {};
  }

  function fetchPresets(serverName, kind, targetName) {
    var key = presetCacheKey(serverName, kind, targetName);
    var url =
      '/api/presets?server=' +
      encodeURIComponent(serverName || '') +
      '&kind=' +
      encodeURIComponent(kind) +
      '&target=' +
      encodeURIComponent(targetName || '');
    AD._fetch(url)
      .then(function (r) {
        return r.json();
      })
      .then(function (body) {
        var map = {};
        (body.entries || []).forEach(function (e) {
          map[e.preset_name] = { id: e.id, payload: e.payload };
        });
        presetsCache[key] = map;
        // Re-render any tester whose tool form shows this server.
        Object.keys(state).forEach(function (serverId) {
          var s = state[serverId];
          if (s.serverName === serverName && s.selectedTool === targetName && s.subtab === 'tools')
            renderBody(serverId);
        });
      })
      .catch(function () {
        presetsCache[key] = {};
      });
  }

  function savePresetRemote(serverName, kind, targetName, presetName, payload) {
    return AD._fetch('/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server: serverName,
        kind: kind,
        target: targetName,
        preset: presetName,
        payload: payload,
      }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (body) {
        if (body && body.id != null) {
          var key = presetCacheKey(serverName, kind, targetName);
          if (!presetsCache[key]) presetsCache[key] = {};
          presetsCache[key][presetName] = { id: body.id, payload: payload };
        }
        return body;
      });
  }

  function migrateLocalStoragePresets() {
    try {
      if (localStorage.getItem(PRESET_MIGRATED_KEY)) return;
      var raw = localStorage.getItem(PRESET_KEY);
      if (!raw) {
        localStorage.setItem(PRESET_MIGRATED_KEY, '1');
        return;
      }
      var parsed = JSON.parse(raw);
      var uploads = [];
      Object.keys(parsed || {}).forEach(function (groupKey) {
        var parts = groupKey.split('::');
        if (parts.length < 3) return;
        var serverName = parts[0];
        var kind = parts[1];
        var targetName = parts[2];
        if (kind !== 'tool' && kind !== 'prompt') return;
        var group = parsed[groupKey] || {};
        Object.keys(group).forEach(function (presetName) {
          uploads.push({
            server: serverName,
            kind: kind,
            target: targetName,
            preset: presetName,
            payload: group[presetName],
          });
        });
      });
      if (uploads.length === 0) {
        localStorage.setItem(PRESET_MIGRATED_KEY, '1');
        return;
      }
      Promise.all(
        uploads.map(function (u) {
          return AD._fetch('/api/presets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(u),
          }).catch(function () {
            /* best-effort */
          });
        }),
      ).then(function () {
        localStorage.setItem(PRESET_MIGRATED_KEY, '1');
        localStorage.removeItem(PRESET_KEY);
      });
    } catch (e) {
      /* ignore */
    }
  }

  migrateLocalStoragePresets();

  // ---------------------------------------------------------------------------
  // Bindings
  // ---------------------------------------------------------------------------

  function bindBody(serverId) {
    var s = getState(serverId);
    if (s.subtab === 'tools' && s.selectedTool) {
      var tool = s.tools.find(function (t) {
        return t.name === s.selectedTool;
      });
      if (tool) {
        var containers = document.querySelectorAll('[data-form-for="' + cssEsc(tool.name) + '"]');
        containers.forEach(function (container) {
          if (AD.renderSchemaForm) {
            AD.renderSchemaForm(
              tool.inputSchema || { type: 'object', properties: {} },
              container,
              s.lastArgs || null,
            );
          }
        });
      }
    }
  }

  function scopeFor(btn) {
    return (btn && btn.closest && btn.closest('.tester-shell')) || document;
  }

  function cssEsc(n) {
    return String(n).replace(/"/g, '\\"');
  }

  // Delegated handler
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    if (!action || action.indexOf('tester-') !== 0) return;
    var rawId = btn.getAttribute('data-id');
    var id = /^-?\d+$/.test(rawId || '') ? parseInt(rawId, 10) : rawId;
    if (id == null || id === '') return;
    e.preventDefault();
    handleAction(action, id, btn);
  });

  function handleAction(action, id, btn) {
    var s = getState(id);
    switch (action) {
      case 'tester-subtab':
        s.subtab = btn.getAttribute('data-subtab');
        renderBody(id);
        break;
      case 'tester-select-tool':
        s.selectedTool = btn.getAttribute('data-name');
        s.result = null;
        s.error = null;
        renderBody(id);
        break;
      case 'tester-call':
        callTool(id, btn);
        break;
      case 'tester-result-mode':
        s.resultMode = btn.getAttribute('data-mode');
        renderBody(id);
        break;
      case 'tester-select-resource':
        s.selectedResource = btn.getAttribute('data-uri');
        s.resourceContents = null;
        renderBody(id);
        break;
      case 'tester-resource-read':
        resourceRead(id);
        break;
      case 'tester-resource-subscribe':
        resourceSubscribe(id, 'subscribe');
        break;
      case 'tester-resource-unsubscribe':
        resourceSubscribe(id, 'unsubscribe');
        break;
      case 'tester-resources-more':
        loadResources(id, true);
        break;
      case 'tester-select-prompt':
        s.selectedPrompt = btn.getAttribute('data-name');
        s.promptMessages = null;
        renderBody(id);
        break;
      case 'tester-prompt-get':
        promptGet(id, btn);
        break;
      case 'tester-preset-save':
        presetSave(id);
        break;
      case 'tester-preset-load':
        /* handled via change, but button also triggers no-op */
        break;
      case 'tester-export':
        exportConfig(id, btn.getAttribute('data-format'));
        break;
      case 'tester-export-copy':
        copyExport(id);
        break;
      case 'tester-ping':
        ping(id);
        break;
      case 'tester-set-logging':
        setLogging(id, btn);
        break;
      case 'tester-popout':
        popOut(id);
        break;
    }
  }

  // preset-load is a <select> change, not a click
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!el.getAttribute) return;
    var action = el.getAttribute('data-action');
    var id = parseInt(el.getAttribute('data-id'), 10);
    if (action === 'tester-preset-load' && !isNaN(id)) {
      var name = el.value;
      if (!name) return;
      var s = getState(id);
      var presets = loadPresets(s.serverName, 'tool', s.selectedTool);
      var entry = presets[name];
      s.lastArgs = entry && entry.payload ? entry.payload : {};
      renderBody(id);
    }
  });

  function callTool(serverId, btn) {
    var s = getState(serverId);
    if (!s.selectedTool) return;
    var tool = s.tools.find(function (t) {
      return t.name === s.selectedTool;
    });
    if (!tool) return;
    var scope = scopeFor(btn);
    var container = scope.querySelector('[data-form-for="' + cssEsc(tool.name) + '"]');
    var args = {};
    try {
      args = AD.collectSchemaForm(container) || {};
    } catch (err) {
      s.error = err.message;
      renderBody(serverId);
      return;
    }
    s.loading = true;
    s.error = null;
    s.lastArgs = args;
    renderBody(serverId);
    var start = Date.now();
    doFetch(baseUrl(serverId, s.handle) + '/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: tool.name, args: args }),
    })
      .then(function (body) {
        s.loading = false;
        s.result = body;
        s.lastLatency = Date.now() - start;
        renderBody(serverId);
      })
      .catch(function (err) {
        s.loading = false;
        s.error = err.message;
        renderBody(serverId);
      });
  }

  function resourceRead(serverId) {
    var s = getState(serverId);
    if (!s.selectedResource) return;
    doFetch(baseUrl(serverId, s.handle) + '/resource/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: s.selectedResource }),
    })
      .then(function (body) {
        s.resourceContents = body.contents;
        renderBody(serverId);
      })
      .catch(function (err) {
        s.error = err.message;
        renderBody(serverId);
      });
  }

  function resourceSubscribe(serverId, op) {
    var s = getState(serverId);
    if (!s.selectedResource) return;
    doFetch(baseUrl(serverId, s.handle) + '/resource/' + op, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: s.selectedResource }),
    }).catch(function (err) {
      s.error = err.message;
      renderBody(serverId);
    });
  }

  function promptGet(serverId, btn) {
    var s = getState(serverId);
    if (!s.selectedPrompt) return;
    var scope = scopeFor(btn);
    var container = scope.querySelector('.tester-prompt-fields');
    var args = {};
    if (container) {
      try {
        var inputs = container.querySelectorAll('[data-path]');
        for (var i = 0; i < inputs.length; i++) {
          var p = inputs[i].getAttribute('data-path');
          if (!p) continue;
          var v = inputs[i].value;
          if (v) args[p] = v;
        }
      } catch (err) {
        s.error = err.message;
        renderBody(serverId);
        return;
      }
    }
    doFetch(baseUrl(serverId, s.handle) + '/prompt/get', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: s.selectedPrompt, arguments: args }),
    })
      .then(function (body) {
        s.promptMessages = body.messages || [];
        renderBody(serverId);
      })
      .catch(function (err) {
        s.error = err.message;
        renderBody(serverId);
      });
  }

  function ping(serverId) {
    var s = getState(serverId);
    doFetch(baseUrl(serverId, s.handle) + '/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then(function (body) {
        s.pingRtt = body.rtt_ms;
        renderBody(serverId);
      })
      .catch(function (err) {
        s.error = err.message;
        renderBody(serverId);
      });
  }

  function setLogging(serverId, btn) {
    var s = getState(serverId);
    var scope = scopeFor(btn);
    var sel = scope.querySelector('[data-tester-logging="' + serverId + '"]');
    if (!sel) return;
    var level = sel.value;
    doFetch(baseUrl(serverId, s.handle) + '/logging-level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: level }),
    })
      .then(function () {
        s.loggingLevel = level;
        renderBody(serverId);
      })
      .catch(function (err) {
        s.error = err.message;
        renderBody(serverId);
      });
  }

  function exportConfig(serverId, format) {
    var s = getState(serverId);
    s.exportFormat = format;
    // Mark loading so renderExportTab shows the hint, not stale JSON
    s.exportBody = null;
    doFetch(baseUrl(serverId, s.handle) + '/export?format=' + encodeURIComponent(format))
      .then(function (body) {
        s.exportBody = body;
        renderBody(serverId);
      })
      .catch(function (err) {
        s.error = err.message;
        renderBody(serverId);
      });
  }

  function copyExport(serverId) {
    var s = getState(serverId);
    if (!s.exportBody) return;
    var txt = JSON.stringify(s.exportBody.config, null, 2);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(txt).then(function () {
        flashCopyButton(serverId);
      });
    }
  }

  function flashCopyButton(serverId) {
    var btn = document.querySelector(
      '.tester-copy-btn[data-action="tester-export-copy"][data-id="' + serverId + '"]',
    );
    if (!btn) return;
    btn.classList.add('copied');
    var orig = btn.innerHTML;
    btn.innerHTML =
      '<span class="material-symbols-outlined" style="font-size:14px">check</span> Copied';
    setTimeout(function () {
      btn.classList.remove('copied');
      btn.innerHTML = orig;
    }, 1200);
  }

  function presetSave(serverId) {
    var s = getState(serverId);
    if (!s.selectedTool) return;
    var name = prompt('Preset name:');
    if (!name) return;
    savePresetRemote(s.serverName, 'tool', s.selectedTool, name, s.lastArgs || {}).then(
      function () {
        renderBody(serverId);
      },
    );
  }

  function popOut(serverId) {
    var url = '/tester/' + encodeURIComponent(serverId);
    var win = window.open(
      url,
      'mcp-tester-' + serverId,
      'width=1000,height=720,resizable=yes,scrollbars=yes,menubar=no,toolbar=no,location=no',
    );
    if (!win) {
      alert(
        'Popup blocked. Allow popups for this site and try again (the tester opens in its own window).',
      );
    }
  }

  // Exposed for tester-window.js bootstrap to associate a non-numeric render
  // key with a transient handle so baseUrl resolution still works.
  AD._setTesterHandle = function (serverId, handle) {
    var s = getState(serverId);
    s.handle = handle;
  };

  // ---------------------------------------------------------------------------
  // WS event ingestion
  // ---------------------------------------------------------------------------

  AD.onTesterEvent = function (msg) {
    var name = msg.serverName || '';
    if (!eventBuffers[name]) eventBuffers[name] = [];
    eventBuffers[name].unshift(msg);
    if (eventBuffers[name].length > 500) eventBuffers[name].length = 500;
    // Refresh any tester whose events tab is open for this server
    Object.keys(state).forEach(function (serverId) {
      var s = state[serverId];
      if (s.serverName === name && s.subtab === 'events') renderBody(serverId);
    });
  };

  AD.onTesterLogEntry = function (entry) {
    if (!entry || entry.kind !== 'resource-read') return;
    /* placeholder hook for future per-resource refresh */
  };

  // ---------------------------------------------------------------------------
  // Auto-load on section expand
  // ---------------------------------------------------------------------------

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-action="toggle-section"]');
    if (!btn) return;
    if (btn.getAttribute('data-section') !== 'tester') return;
    var id = parseInt(btn.getAttribute('data-id'), 10);
    setTimeout(function () {
      AD.openTesterFor(id);
    }, 20);
  });

  // ---------------------------------------------------------------------------
  // Elicitation modal — server → human round-trip (transient connections only)
  // ---------------------------------------------------------------------------

  AD.onElicitationRequest = function (msg) {
    showElicitationModal({
      id: msg.id,
      serverName: msg.serverName,
      message: msg.message,
      requestedSchema: msg.requestedSchema || { type: 'object', properties: {} },
    });
  };

  function showElicitationModal(req) {
    hideElicitationModal();
    var backdrop = document.createElement('div');
    backdrop.className = 'tester-elicit-backdrop';
    backdrop.innerHTML =
      '<div class="tester-elicit-modal">' +
      '<div class="tester-elicit-head">' +
      '<span class="material-symbols-outlined">chat</span>' +
      '<strong>Server request</strong>' +
      '<span class="tester-pill">' +
      esc(req.serverName) +
      '</span>' +
      '</div>' +
      '<div class="tester-elicit-message">' +
      (AD.renderMarkdown ? AD.renderMarkdown(req.message) : esc(req.message)) +
      '</div>' +
      '<div class="tester-elicit-form"></div>' +
      '<div class="tester-elicit-actions">' +
      '<button class="btn-activate" data-elicit="accept">Accept</button>' +
      '<button class="btn-health" data-elicit="decline">Decline</button>' +
      '<button class="btn-delete" data-elicit="cancel">Cancel</button>' +
      '</div></div>';
    document.body.appendChild(backdrop);
    var formEl = backdrop.querySelector('.tester-elicit-form');
    if (formEl && AD.renderSchemaForm) {
      AD.renderSchemaForm(req.requestedSchema, formEl, null);
    }
    var handleClick = function (e) {
      var btn = e.target.closest && e.target.closest('[data-elicit]');
      if (!btn) return;
      e.preventDefault();
      var action = btn.getAttribute('data-elicit');
      var payload = { action: action };
      if (action === 'accept' && formEl && AD.collectSchemaForm) {
        try {
          payload.content = AD.collectSchemaForm(formEl);
        } catch (err) {
          alert('Form invalid: ' + err.message);
          return;
        }
      }
      AD._fetch('/api/elicitations/' + encodeURIComponent(req.id) + '/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function () {
          hideElicitationModal();
        })
        .catch(function (err) {
          alert('Elicitation reply failed: ' + err.message);
        });
    };
    backdrop.addEventListener('click', handleClick);
    elicitationModalOpen = { backdrop: backdrop, handler: handleClick, req: req };
  }

  function hideElicitationModal() {
    if (!elicitationModalOpen) return;
    elicitationModalOpen.backdrop.removeEventListener('click', elicitationModalOpen.handler);
    elicitationModalOpen.backdrop.remove();
    elicitationModalOpen = null;
  }
})();
