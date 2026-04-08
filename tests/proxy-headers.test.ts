// =============================================================================
// agent-discover — Proxy header / transport unit tests
//
// Exercises the private createTransport() helper to lock in the v1.1.0
// CRLF header sanitization on the SSE / streamable-http remote transport
// path. Avoids spinning up a real MCP child by inspecting the transport
// object directly via private-field access.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { McpProxy, type ServerConfig } from '../src/domain/proxy.js';

interface TransportLike {
  _requestInit?: { headers?: Record<string, string> };
  requestInit?: { headers?: Record<string, string> };
  // The MCP SDK transports stash requestInit somewhere on the instance —
  // we accept either name to be resilient to internal renames.
  [k: string]: unknown;
}

// Walk the transport's own + prototype enumerable props looking for the
// requestInit object the constructor stored. We throw if nothing is found
// rather than returning {} — otherwise an SDK rename would silently turn
// this whole test file into a no-op while still reporting green.
function readHeaders(t: TransportLike): Record<string, string> {
  for (const v of Object.values(t)) {
    if (v && typeof v === 'object' && 'headers' in (v as object)) {
      const h = (v as { headers?: Record<string, string> }).headers;
      if (h && typeof h === 'object') return h;
    }
  }
  throw new Error(
    'Could not locate headers on transport — SDK internals likely changed; update readHeaders',
  );
}

let proxy: McpProxy;

beforeEach(() => {
  proxy = new McpProxy();
});

describe('McpProxy.createTransport — header sanitization', () => {
  it('strips header values containing CR or LF', () => {
    const config: ServerConfig = {
      name: 'remote-srv',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: {
        Good: 'value',
        Evil: 'innocent\r\nX-Injected: yes',
        AlsoEvil: 'line1\nline2',
      },
    };
    const t = (
      proxy as unknown as { createTransport: (c: ServerConfig) => TransportLike }
    ).createTransport(config);
    const headers = readHeaders(t);
    // Positive: clean header survives (proves we located the right object).
    expect(headers.Good).toBe('value');
    // Negative: anything containing CR or LF must be dropped entirely —
    // not escaped, not truncated, dropped — so a downstream HTTP layer
    // can't reinterpret an attacker-controlled fragment as a new header.
    expect(headers.Evil).toBeUndefined();
    expect(headers.AlsoEvil).toBeUndefined();
    expect('X-Injected' in headers).toBe(false);
  });

  it('builds a streamable-http transport when url is set', () => {
    const t = (
      proxy as unknown as { createTransport: (c: ServerConfig) => TransportLike }
    ).createTransport({
      name: 'r',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
    });
    expect(t).toBeTruthy();
  });

  it('builds an SSE transport when transport=sse', () => {
    const t = (
      proxy as unknown as { createTransport: (c: ServerConfig) => TransportLike }
    ).createTransport({
      name: 'r',
      transport: 'sse',
      url: 'https://example.test/mcp',
    });
    expect(t).toBeTruthy();
  });

  it('throws on stdio transport with no command', () => {
    expect(() =>
      (proxy as unknown as { createTransport: (c: ServerConfig) => TransportLike }).createTransport(
        { name: 'no-cmd' },
      ),
    ).toThrow(/no command configured/);
  });
});
