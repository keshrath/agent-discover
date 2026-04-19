/* eslint-disable */
(function () {
  'use strict';
  var AD = (window.AD = window.AD || {});
  AD._baseUrl = '';
  AD._fetch = function (url, opts) {
    return fetch(AD._baseUrl + url, opts);
  };
  AD._root = document;

  var ctx = parseContext();
  var ws = null;

  function parseContext() {
    // Accepts: /tester/<id>  and  /tester/transient/<handle>
    var parts = location.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
    if (parts[0] !== 'tester') return { mode: 'invalid' };
    if (parts[1] === 'transient' && parts[2]) {
      return { mode: 'transient', handle: parts[2] };
    }
    if (parts[1]) {
      var id = parseInt(parts[1], 10);
      if (!isNaN(id)) return { mode: 'server', id: id };
    }
    return { mode: 'invalid' };
  }

  function setConn(cls, text) {
    var el = document.getElementById('tw-conn');
    if (!el) return;
    el.className = 'tw-conn ' + cls;
    el.textContent = text;
  }

  function connectWs() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);
    ws.onopen = function () {
      setConn('connected', 'connected');
    };
    ws.onmessage = function (evt) {
      try {
        var msg = JSON.parse(evt.data);
        if ((msg.type === 'notification' || msg.type === 'progress') && AD.onTesterEvent) {
          AD.onTesterEvent(msg);
        } else if (msg.type === 'elicitation_request' && AD.onElicitationRequest) {
          AD.onElicitationRequest(msg);
        }
      } catch (e) {
        /* ignore */
      }
    };
    ws.onclose = function () {
      setConn('disconnected', 'disconnected');
      setTimeout(connectWs, 2000);
    };
    ws.onerror = function () {
      ws.close();
    };
  }

  function initTheme() {
    var toggle = document.getElementById('tw-theme');
    var saved = localStorage.getItem('agent-discover-theme');
    if (saved === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else if (saved === 'light') document.documentElement.removeAttribute('data-theme');
    if (!toggle) return;
    toggle.addEventListener('click', function () {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (isDark) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('agent-discover-theme', isDark ? 'light' : 'dark');
    });
  }

  function fetchServerName(callback) {
    if (ctx.mode === 'server') {
      AD._fetch('/api/servers/' + ctx.id)
        .then(function (r) {
          return r.json();
        })
        .then(function (body) {
          callback(body && body.name ? body.name : 'server ' + ctx.id, body);
        })
        .catch(function () {
          callback('server ' + ctx.id, null);
        });
      return;
    }
    if (ctx.mode === 'transient') {
      callback('transient ' + ctx.handle, { transient: true });
      return;
    }
    callback('invalid', null);
  }

  function mount() {
    if (ctx.mode === 'invalid') {
      document.getElementById('tw-body').innerHTML =
        '<div class="hint error">Invalid tester URL. Expected /tester/&lt;id&gt; or /tester/transient/&lt;handle&gt;.</div>';
      return;
    }

    initTheme();
    connectWs();

    fetchServerName(function (name, info) {
      document.getElementById('tw-name').textContent = name;
      document.getElementById('tw-meta').textContent =
        ctx.mode === 'transient' ? 'transient · handle ' + ctx.handle : 'registered server';
      document.title = name + ' — MCP Tester';

      // The tester module expects a numeric "serverId" key for state. For
      // transient mode we synthesise a stable negative id derived from the
      // handle so rendering paths keep working.
      var renderId = ctx.mode === 'transient' ? 't-' + ctx.handle : ctx.id;
      var serverObj = {
        id: renderId,
        name: name,
        capabilities: (info && info.capabilities) || {},
      };

      var body = document.getElementById('tw-body');
      body.innerHTML = AD.renderTesterShell(serverObj);
      if (ctx.mode === 'transient' && AD._setTesterHandle) {
        AD._setTesterHandle(renderId, ctx.handle);
      }
      // Kick off data loads
      if (AD.openTesterFor) AD.openTesterFor(renderId);
    });

    window.addEventListener('beforeunload', function () {
      if (ctx.mode === 'transient') {
        // Release the transient on the server side so we don't leak a child
        // process behind a TTL. navigator.sendBeacon survives the unload.
        try {
          navigator.sendBeacon(
            '/api/transient/' + encodeURIComponent(ctx.handle),
            new Blob([''], { type: 'application/json' }),
          );
        } catch (e) {
          /* ignore */
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
