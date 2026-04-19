/* eslint-disable */
(function () {
  'use strict';
  var AD = (window.AD = window.AD || {});

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function typeOf(schema) {
    if (!schema) return 'unknown';
    if (Array.isArray(schema.type)) {
      return (
        schema.type.filter(function (t) {
          return t !== 'null';
        })[0] || 'string'
      );
    }
    return schema.type || (schema.properties ? 'object' : 'string');
  }

  function fieldId(path) {
    return 'fld-' + path.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  function renderField(schema, path, required, value) {
    if (!schema) schema = {};
    var t = typeOf(schema);
    var id = fieldId(path);
    var label = path.split('.').pop() || path;
    var desc = schema.description
      ? '<div class="sf-desc">' + escHtml(schema.description) + '</div>'
      : '';
    var req = required ? ' <span class="sf-req">*</span>' : '';
    var defaultVal = value != null ? value : schema.default;

    if (schema.enum) {
      var opts = schema.enum
        .map(function (v) {
          var sel = String(defaultVal) === String(v) ? ' selected' : '';
          return '<option value="' + escHtml(v) + '"' + sel + '>' + escHtml(v) + '</option>';
        })
        .join('');
      var blank = required ? '' : '<option value=""></option>';
      return (
        '<div class="sf-field" data-path="' +
        escHtml(path) +
        '" data-type="enum">' +
        '<label for="' +
        id +
        '">' +
        escHtml(label) +
        req +
        '</label>' +
        '<select id="' +
        id +
        '" class="sf-input" data-path="' +
        escHtml(path) +
        '">' +
        blank +
        opts +
        '</select>' +
        desc +
        '</div>'
      );
    }

    if (t === 'boolean') {
      var checked = defaultVal === true ? ' checked' : '';
      return (
        '<div class="sf-field sf-field-bool" data-path="' +
        escHtml(path) +
        '" data-type="boolean">' +
        '<label class="sf-bool-label"><input type="checkbox" id="' +
        id +
        '" class="sf-input" data-path="' +
        escHtml(path) +
        '"' +
        checked +
        '/> ' +
        escHtml(label) +
        req +
        '</label>' +
        desc +
        '</div>'
      );
    }

    if (t === 'integer' || t === 'number') {
      var step = t === 'integer' ? '1' : 'any';
      var v = defaultVal != null ? escHtml(defaultVal) : '';
      return (
        '<div class="sf-field" data-path="' +
        escHtml(path) +
        '" data-type="' +
        t +
        '">' +
        '<label for="' +
        id +
        '">' +
        escHtml(label) +
        req +
        '</label>' +
        '<input type="number" step="' +
        step +
        '" id="' +
        id +
        '" class="sf-input" data-path="' +
        escHtml(path) +
        '" value="' +
        v +
        '"/>' +
        desc +
        '</div>'
      );
    }

    if (t === 'array') {
      var itemSchema = schema.items || {};
      var arr = Array.isArray(defaultVal) ? defaultVal : [];
      var rows = arr
        .map(function (item, i) {
          return renderArrayRow(path + '[' + i + ']', itemSchema, item);
        })
        .join('');
      return (
        '<div class="sf-field sf-field-array" data-path="' +
        escHtml(path) +
        '" data-type="array">' +
        '<label>' +
        escHtml(label) +
        req +
        '</label>' +
        '<div class="sf-array-rows" data-array-path="' +
        escHtml(path) +
        '">' +
        rows +
        '</div>' +
        '<button type="button" class="sf-array-add" data-array-path="' +
        escHtml(path) +
        '">+ Add</button>' +
        desc +
        '</div>'
      );
    }

    if (t === 'object' && schema.properties) {
      var inner = renderObject(schema, path, defaultVal || {});
      return (
        '<fieldset class="sf-field sf-field-object" data-path="' +
        escHtml(path) +
        '" data-type="object">' +
        '<legend>' +
        escHtml(label) +
        req +
        '</legend>' +
        inner +
        desc +
        '</fieldset>'
      );
    }

    // oneOf / anyOf / complex: raw JSON textarea fallback
    if (schema.oneOf || schema.anyOf || schema.allOf || schema.patternProperties) {
      var txt = defaultVal != null ? JSON.stringify(defaultVal, null, 2) : '';
      return (
        '<div class="sf-field" data-path="' +
        escHtml(path) +
        '" data-type="json">' +
        '<label for="' +
        id +
        '">' +
        escHtml(label) +
        req +
        ' <span class="sf-hint">(raw JSON)</span></label>' +
        '<textarea id="' +
        id +
        '" class="sf-input sf-textarea" data-path="' +
        escHtml(path) +
        '" rows="3">' +
        escHtml(txt) +
        '</textarea>' +
        desc +
        '</div>'
      );
    }

    // string (default)
    var sv = defaultVal != null ? escHtml(defaultVal) : '';
    var inputType = 'text';
    if (schema.format === 'date-time') inputType = 'datetime-local';
    else if (schema.format === 'date') inputType = 'date';
    else if (schema.format === 'email') inputType = 'email';
    else if (schema.format === 'uri' || schema.format === 'url') inputType = 'url';
    return (
      '<div class="sf-field" data-path="' +
      escHtml(path) +
      '" data-type="string">' +
      '<label for="' +
      id +
      '">' +
      escHtml(label) +
      req +
      '</label>' +
      '<input type="' +
      inputType +
      '" id="' +
      id +
      '" class="sf-input" data-path="' +
      escHtml(path) +
      '" value="' +
      sv +
      '" placeholder="' +
      escHtml(schema.examples ? schema.examples[0] || '' : '') +
      '"/>' +
      desc +
      '</div>'
    );
  }

  function renderArrayRow(path, itemSchema, value) {
    return (
      '<div class="sf-array-row" data-row-path="' +
      escHtml(path) +
      '">' +
      renderField(itemSchema, path, false, value) +
      '<button type="button" class="sf-array-remove" data-remove-path="' +
      escHtml(path) +
      '" title="Remove">×</button>' +
      '</div>'
    );
  }

  function renderObject(schema, basePath, value) {
    var props = schema.properties || {};
    var required = schema.required || [];
    var html = '';
    Object.keys(props).forEach(function (key) {
      var childPath = basePath ? basePath + '.' + key : key;
      var childValue = value && value[key];
      html += renderField(props[key], childPath, required.indexOf(key) >= 0, childValue);
    });
    return html;
  }

  AD.renderSchemaForm = function (schema, container, initialValue) {
    if (!schema || typeof schema !== 'object') {
      container.innerHTML = '<div class="sf-empty">No input schema — call with empty args.</div>';
      return;
    }
    if (schema.type !== 'object' || !schema.properties) {
      // root is not an object — fall back to JSON textarea
      container.innerHTML =
        '<div class="sf-field" data-path="__root__" data-type="json">' +
        '<label>Arguments (raw JSON)</label>' +
        '<textarea class="sf-input sf-textarea" data-path="__root__" rows="6">' +
        escHtml(initialValue ? JSON.stringify(initialValue, null, 2) : '') +
        '</textarea>' +
        '</div>';
      return;
    }
    container.innerHTML =
      '<div class="sf-form-root">' + renderObject(schema, '', initialValue || {}) + '</div>';
    wireArrayButtons(container, schema);
  };

  function wireArrayButtons(container, schema) {
    container.addEventListener('click', function (ev) {
      var add = ev.target.closest && ev.target.closest('.sf-array-add');
      if (add) {
        ev.preventDefault();
        var path = add.getAttribute('data-array-path');
        var rows = container.querySelector('.sf-array-rows[data-array-path="' + path + '"]');
        if (!rows) return;
        var itemSchema = resolveSchema(schema, path);
        var n = rows.children.length;
        rows.insertAdjacentHTML(
          'beforeend',
          renderArrayRow(
            path + '[' + n + ']',
            itemSchema && itemSchema.items ? itemSchema.items : {},
            undefined,
          ),
        );
        return;
      }
      var rm = ev.target.closest && ev.target.closest('.sf-array-remove');
      if (rm) {
        ev.preventDefault();
        var row = rm.closest('.sf-array-row');
        if (row) row.remove();
        return;
      }
    });
  }

  function resolveSchema(rootSchema, path) {
    var parts = path
      .replace(/\[\d+\]/g, '')
      .split('.')
      .filter(Boolean);
    var current = rootSchema;
    for (var i = 0; i < parts.length && current; i++) {
      current = current.properties && current.properties[parts[i]];
    }
    return current;
  }

  AD.collectSchemaForm = function (container) {
    var result = {};
    var rootInput = container.querySelector('[data-path="__root__"]');
    if (rootInput && rootInput.tagName === 'TEXTAREA') {
      var raw = rootInput.value.trim();
      if (!raw) return {};
      try {
        return JSON.parse(raw);
      } catch (e) {
        throw new Error('Arguments JSON is invalid: ' + e.message);
      }
    }
    // Walk every input/select/textarea in DOM order, respecting array indices.
    var inputs = container.querySelectorAll('.sf-input[data-path]');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var path = el.getAttribute('data-path');
      if (!path || path === '__root__') continue;
      var val = readValue(el);
      if (val === undefined) continue;
      setPath(result, path, val);
    }
    return result;
  };

  function readValue(el) {
    var field = el.closest('.sf-field');
    var t = field ? field.getAttribute('data-type') : 'string';
    if (el.tagName === 'SELECT') {
      var v = el.value;
      if (v === '') return undefined;
      return v;
    }
    if (t === 'boolean') return el.checked;
    if (t === 'integer') {
      if (el.value === '') return undefined;
      var n = parseInt(el.value, 10);
      return isNaN(n) ? undefined : n;
    }
    if (t === 'number') {
      if (el.value === '') return undefined;
      var f = parseFloat(el.value);
      return isNaN(f) ? undefined : f;
    }
    if (t === 'json') {
      var raw = el.value.trim();
      if (!raw) return undefined;
      try {
        return JSON.parse(raw);
      } catch (e) {
        throw new Error('Invalid JSON at ' + el.getAttribute('data-path') + ': ' + e.message);
      }
    }
    if (el.value === '') return undefined;
    return el.value;
  }

  function setPath(obj, path, value) {
    var parts = path.split(/\.|(?=\[)/).filter(Boolean);
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var isLast = i === parts.length - 1;
      if (p.charAt(0) === '[') {
        var idx = parseInt(p.slice(1, -1), 10);
        if (!Array.isArray(cur)) return;
        if (isLast) cur[idx] = value;
        else {
          if (cur[idx] == null) cur[idx] = parts[i + 1].charAt(0) === '[' ? [] : {};
          cur = cur[idx];
        }
      } else {
        if (isLast) cur[p] = value;
        else {
          if (cur[p] == null) cur[p] = parts[i + 1] && parts[i + 1].charAt(0) === '[' ? [] : {};
          cur = cur[p];
        }
      }
    }
  }
})();
