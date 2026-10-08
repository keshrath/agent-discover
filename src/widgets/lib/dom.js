/* global document, Node */
// Tiny XSS-safe DOM builder shared by every widget.
// Untrusted strings only ever become text nodes or attribute values; there is no
// HTML-string path at all. `href`/`src` are restricted to safe schemes.

export const SAFE_HREF = /^(https?:|mailto:)/i;
const SAFE_IMG = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/**
 * h('div', { class: 'row', on: { click }, dataset: { id } }, 'text', childNode, [more])
 * Props: class, on (event map), dataset, style (object), href/src (scheme-checked),
 * DOM properties for non-string values (checked, disabled, value), everything else
 * via setAttribute. `on*` attribute strings are rejected.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') Object.assign(el.style, v);
      else if (k === 'href') {
        if (SAFE_HREF.test(String(v))) el.setAttribute('href', String(v));
      } else if (k === 'src') {
        if (SAFE_IMG.test(String(v))) el.setAttribute('src', String(v));
      } else if (/^on/i.test(k)) throw new Error(`inline handler "${k}" not allowed; use on:{}`);
      else if (typeof v !== 'string' && k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of [children].flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function mount(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}
