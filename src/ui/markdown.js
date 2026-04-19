/* eslint-disable */
(function () {
  'use strict';
  var AD = (window.AD = window.AD || {});

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inline(s) {
    var out = esc(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    out = out.replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>',
    );
    return out;
  }

  AD.renderMarkdown = function (text) {
    if (text == null) return '';
    var lines = String(text).split(/\r?\n/);
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^```/.test(line)) {
        var lang = line.replace(/^```/, '').trim();
        var buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++;
        out.push(
          '<pre class="md-code"' +
            (lang ? ' data-lang="' + esc(lang) + '"' : '') +
            '><code>' +
            esc(buf.join('\n')) +
            '</code></pre>',
        );
        continue;
      }
      if (/^#{1,6}\s/.test(line)) {
        var m = line.match(/^(#{1,6})\s+(.*)$/);
        if (m) {
          out.push('<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>');
          i++;
          continue;
        }
      }
      if (/^\s*[-*+]\s/.test(line)) {
        var items = [];
        while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (/^\s*\d+\.\s/.test(line)) {
        var oitems = [];
        while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
          oitems.push('<li>' + inline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ol>' + oitems.join('') + '</ol>');
        continue;
      }
      if (line.trim() === '') {
        out.push('');
        i++;
        continue;
      }
      // paragraph — accumulate consecutive non-empty lines
      var pbuf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^```|^#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s/.test(lines[i])
      ) {
        pbuf.push(lines[i]);
        i++;
      }
      out.push('<p>' + inline(pbuf.join(' ')) + '</p>');
    }
    return out.join('\n');
  };

  AD.highlightJson = function (obj) {
    var txt = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    return esc(txt)
      .replace(/(&quot;[^&\n]*?&quot;)(\s*:)/g, '<span class="jk">$1</span>$2')
      .replace(/:\s*(&quot;[^&\n]*?&quot;)/g, ': <span class="js">$1</span>')
      .replace(/:\s*(true|false|null)/g, ': <span class="jb">$1</span>')
      .replace(/:\s*(-?\d+(?:\.\d+)?)/g, ': <span class="jn">$1</span>');
  };
})();
