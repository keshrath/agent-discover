// JSON-Schema driven form, DOM-only (no HTML strings). Each field is a closure
// { el, read() } so values are collected structurally instead of by path-walking
// the DOM. Unsupported shapes (oneOf/anyOf/allOf/$ref/patternProperties, non-object
// roots) fall back to a raw JSON textarea for that subtree only.
import { h } from './dom.js';

let seq = 0;
const uid = () => `sf${++seq}`;

function typeOf(s) {
  if (Array.isArray(s.type)) return s.type.find((t) => t !== 'null') ?? 'string';
  return s.type ?? (s.properties ? 'object' : s.items ? 'array' : 'string');
}

const isComplex = (s) => s.oneOf || s.anyOf || s.allOf || s.$ref || s.patternProperties;

/** buildForm(schema, initial?) -> { el, read(): object } ; read() throws Error on invalid input. */
export function buildForm(schema, initial) {
  const root = schema && typeof schema === 'object' ? schema : {};
  if (typeOf(root) !== 'object' || isComplex(root) || !root.properties) {
    return jsonField('arguments', root, initial ?? {}, true);
  }
  const f = objectFields(root, initial ?? {});
  return { el: h('div', { class: 'sf' }, f.el), read: f.read };
}

function objectFields(schema, value) {
  const req = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties ?? {}).map(([key, sub]) => ({
    key,
    ...field(key, sub ?? {}, req.has(key), value?.[key]),
  }));
  return {
    el: fields.map((f) => f.el),
    read() {
      const out = {};
      for (const f of fields) {
        const v = f.read();
        if (v !== undefined) out[f.key] = v;
      }
      return out;
    },
  };
}

function wrap(label, required, schema, id, control, extraClass) {
  return h(
    'div',
    { class: ['sf-field', extraClass] },
    h(
      'label',
      { for: id, class: 'sf-label' },
      label,
      required ? h('span', { class: 'sf-req' }, ' *') : null,
    ),
    control,
    schema.description ? h('div', { class: 'sf-desc' }, schema.description) : null,
  );
}

function field(key, schema, required, value) {
  if (isComplex(schema)) return jsonField(key, schema, value, required);
  const t = typeOf(schema);
  const id = uid();
  const init = value ?? schema.default;

  if (Array.isArray(schema.enum)) {
    const sel = h(
      'select',
      { id, class: 'sf-input' },
      required ? null : h('option', { value: '' }, '—'),
      schema.enum.map((v, i) => h('option', { value: String(i), selected: init === v }, String(v))),
    );
    return {
      el: wrap(key, required, schema, id, sel),
      read: () => (sel.value === '' ? undefined : schema.enum[Number(sel.value)]),
    };
  }
  if (t === 'boolean') {
    const cb = h('input', { id, type: 'checkbox', class: 'sf-check', checked: init === true });
    return {
      el: wrap(key, required, schema, id, cb, 'sf-bool'),
      read: () => (cb.checked ? true : required ? false : undefined),
    };
  }
  if (t === 'number' || t === 'integer') {
    const inp = h('input', {
      id,
      type: 'number',
      class: 'sf-input',
      step: t === 'integer' ? '1' : 'any',
      value: init === undefined ? '' : String(init),
      min: schema.minimum === undefined ? null : String(schema.minimum),
      max: schema.maximum === undefined ? null : String(schema.maximum),
    });
    return {
      el: wrap(key, required, schema, id, inp),
      read() {
        if (inp.value === '') return need(key, required);
        const n = Number(inp.value);
        if (!Number.isFinite(n) || (t === 'integer' && !Number.isInteger(n)))
          throw new Error(`${key}: expected ${t}`);
        return n;
      },
    };
  }
  if (t === 'object') {
    if (!schema.properties) return jsonField(key, schema, value, required);
    const inner = objectFields(schema, value ?? {});
    return {
      el: h('fieldset', { class: 'sf-group wide' }, h('legend', null, key), inner.el),
      read: () => {
        const v = inner.read();
        return Object.keys(v).length || required ? v : undefined;
      },
    };
  }
  if (t === 'array') {
    const items = schema.items ?? {};
    if (typeOf(items) === 'object' || isComplex(items))
      return jsonField(key, schema, value, required);
    const rows = [];
    const list = h('div', { class: 'sf-rows' });
    const addRow = (v) => {
      const f = field(`${key}[${rows.length}]`, items, false, v);
      const row = { ...f };
      const rm = h(
        'button',
        { type: 'button', class: 'btn ghost sm', 'aria-label': 'Remove' },
        '×',
      );
      row.node = h('div', { class: 'sf-row' }, f.el, rm);
      rm.addEventListener('click', () => {
        rows.splice(rows.indexOf(row), 1);
        row.node.remove();
      });
      rows.push(row);
      list.append(row.node);
    };
    (Array.isArray(init) ? init : []).forEach(addRow);
    const add = h(
      'button',
      { type: 'button', class: 'btn ghost sm', on: { click: () => addRow(undefined) } },
      '+ Add',
    );
    return {
      el: wrap(key, required, schema, id, h('div', { id }, list, add), 'wide'),
      read() {
        const vals = rows.map((r) => r.read()).filter((v) => v !== undefined);
        return vals.length || required ? vals : undefined;
      },
    };
  }
  // string (+ format hints)
  const long = schema.maxLength === undefined || schema.maxLength > 120;
  const ctl =
    long && /desc|body|text|content|query|prompt|code|sql|script/i.test(key) ? 'textarea' : 'input';
  const inp = h(ctl, {
    id,
    class: 'sf-input',
    type: ctl === 'input' ? inputType(schema.format) : null,
    rows: ctl === 'textarea' ? '3' : null,
    placeholder: schema.examples?.[0] === undefined ? null : String(schema.examples[0]),
  });
  inp.value = init === undefined ? '' : String(init);
  return {
    el: wrap(key, required, schema, id, inp, ctl === 'textarea' ? 'wide' : null),
    read: () => (inp.value === '' ? need(key, required) : inp.value),
  };
}

function inputType(format) {
  return (
    { uri: 'url', email: 'email', date: 'date', 'date-time': 'datetime-local' }[format] ?? 'text'
  );
}

function need(key, required) {
  if (required) throw new Error(`${key} is required`);
  return undefined;
}

function jsonField(key, schema, value, required) {
  const id = uid();
  const ta = h('textarea', { id, class: 'sf-input mono', rows: '4', spellcheck: 'false' });
  ta.value = value === undefined ? '' : JSON.stringify(value, null, 2);
  return {
    el: wrap(`${key} (JSON)`, required, schema, id, ta, 'wide'),
    read() {
      if (ta.value.trim() === '') return need(key, required);
      try {
        return JSON.parse(ta.value);
      } catch {
        throw new Error(`${key}: invalid JSON`);
      }
    },
  };
}
