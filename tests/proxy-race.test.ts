// =============================================================================
// agent-discover — Concurrent activate() race regression
//
// Two parallel activate(name) calls used to both pass the
// `if (activeServers.has(name))` guard before either awaited, causing two
// child processes to spawn for the same logical server. The fix reserves
// the name in a separate `activating` set synchronously, so the second
// caller rejects immediately. This test mocks the MCP SDK Client so the
// "connect" step is a controllable promise we can hold open across both
// calls.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

let resolveConnect: (() => void) | null = null;
let connectCalls = 0;

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class FakeClient {
    async connect(): Promise<void> {
      connectCalls++;
      return new Promise<void>((resolve) => {
        resolveConnect = resolve;
      });
    }
    async listTools(): Promise<{ tools: Array<{ name: string }> }> {
      return { tools: [{ name: 'echo' }] };
    }
    async close(): Promise<void> {}
  }
  return { Client: FakeClient };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(_opts: unknown) {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    constructor(_url: URL, _init?: unknown) {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(_url: URL, _init?: unknown) {}
  },
}));

import { McpProxy } from '../src/domain/proxy.js';

beforeEach(() => {
  resolveConnect = null;
  connectCalls = 0;
});

describe('McpProxy.activate — concurrent activation race', () => {
  it('only one of two parallel activates wins; the other rejects synchronously', async () => {
    const proxy = new McpProxy();
    const config = { name: 'race-srv', command: 'node', args: [] };

    // Fire both before either has a chance to await — the second must hit
    // the activating-set guard and reject before connect even runs.
    const p1 = proxy.activate(config);
    const p2 = proxy.activate(config);

    // Settle the loser first (it should reject without spawning a 2nd connect).
    const settled = await Promise.allSettled([p2]);
    expect(settled[0].status).toBe('rejected');
    if (settled[0].status === 'rejected') {
      expect(String(settled[0].reason)).toMatch(/already active/);
    }

    // Connect was invoked exactly once.
    expect(connectCalls).toBe(1);

    // Now let the winner finish.
    expect(resolveConnect).not.toBeNull();
    resolveConnect!();
    const tools = await p1;
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(proxy.isActive('race-srv')).toBe(true);
  });

  it('a failed activation releases the activating slot so a retry can succeed', async () => {
    const proxy = new McpProxy();
    // First call: stdio with no command → createTransport throws synchronously
    // BEFORE we add to activating (transport is created after the add). The
    // finally block must still release the slot.
    await expect(
      proxy.activate({ name: 'retry-srv', command: undefined as unknown as string }),
    ).rejects.toThrow();

    // Second call with a real command should not see "already active".
    const p = proxy.activate({ name: 'retry-srv', command: 'node', args: [] });
    // Resolve the held connect promise from the fake Client.
    // (The fake's connect captures the latest resolver — give the mock a tick.)
    await new Promise((r) => setTimeout(r, 5));
    if (resolveConnect) resolveConnect();
    await expect(p).resolves.toBeDefined();
  });
});
