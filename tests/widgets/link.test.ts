// =============================================================================
// Widget links: only http(s)/mailto URLs become clickable; anything else
// (javascript:, file:, ...) from a registry or an upstream is plain text.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { link } from '../../src/widgets/lib/ui.js';

class FakeNode {
  attrs: Record<string, string> = {};
  listeners: Record<string, (e: { preventDefault(): void }) => void> = {};
  children: unknown[] = [];
  className = '';
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(ev: string, fn: (e: { preventDefault(): void }) => void) {
    this.listeners[ev] = fn;
  }
  append(...c: unknown[]) {
    this.children.push(...c);
  }
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeNode(tag) });
  vi.stubGlobal('Node', FakeNode);
});
afterEach(() => vi.unstubAllGlobals());

describe('link', () => {
  it('opens http(s) URLs through the host', () => {
    const openLink = vi.fn();
    const el = link({ openLink }, 'source', 'https://github.com/acme/x') as unknown as FakeNode;
    expect(el.attrs.href).toBe('https://github.com/acme/x');
    el.listeners.click({ preventDefault() {} });
    expect(openLink).toHaveBeenCalledWith('https://github.com/acme/x');
  });

  it('renders any other scheme as plain text with no click handler', () => {
    const openLink = vi.fn();
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      const el = link({ openLink }, 'source', url) as unknown as FakeNode;
      expect(el.tag).toBe('span');
      expect(el.attrs.href).toBeUndefined();
      expect(el.listeners.click).toBeUndefined();
      expect(el.children).toEqual(['source']);
    }
    expect(openLink).not.toHaveBeenCalled();
  });
});
