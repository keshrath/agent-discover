// =============================================================================
// agent-discover — Elicitation + Sampling wiring
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { McpProxy, type PendingElicitation } from '../src/domain/proxy.js';

let proxy: McpProxy;

beforeEach(() => {
  proxy = new McpProxy();
});

describe('Elicitation', () => {
  it('listPendingElicitations starts empty', () => {
    expect(proxy.listPendingElicitations()).toEqual([]);
  });

  it('respondElicitation returns false for unknown id', () => {
    expect(proxy.respondElicitation('bogus', { action: 'cancel' })).toBe(false);
  });

  it('setElicitationListener accepts a callback', () => {
    const seen: PendingElicitation[] = [];
    proxy.setElicitationListener((p) => seen.push(p));
    expect(seen).toEqual([]);
  });
});

describe('Sampling', () => {
  it('setSamplingProvider accepts a provider', () => {
    proxy.setSamplingProvider({
      async createMessage() {
        return {
          role: 'assistant',
          content: { type: 'text', text: 'ok' },
          model: 'test',
        };
      },
    });
    expect(() =>
      proxy.setSamplingProvider({
        async createMessage() {
          return { role: 'assistant', content: { type: 'text', text: '' }, model: '' };
        },
      }),
    ).not.toThrow();
  });
});
