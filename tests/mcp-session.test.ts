// =============================================================================
// 2025 HTTP sessions: idle sessions (no open stream) are closed after
// sessionIdleMs; sessions holding a GET stream stay.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers.js';

let d: TestDaemon;
beforeEach(async () => {
  d = await startTestDaemon({ sessionIdleMs: 400 });
});
afterEach(async () => d.stop());

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

async function initialize(): Promise<string> {
  const res = await fetch(`${d.base}/mcp`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1' },
      },
    }),
  });
  expect(res.status).toBe(200);
  await res.text();
  const sid = res.headers.get('mcp-session-id');
  expect(sid).toBeTruthy();
  return sid!;
}

function ping(sid: string): Promise<Response> {
  return fetch(`${d.base}/mcp`, {
    method: 'POST',
    headers: { ...HEADERS, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
  });
}

describe('legacy session TTL', () => {
  it('closes a session idle past the TTL; its client gets 404', async () => {
    const sid = await initialize();
    expect(d.mcp.sessionCount()).toBe(1);
    expect((await ping(sid)).status).toBe(200);
    await waitFor(() => d.mcp.sessionCount() === 0, 5_000);
    const gone = await ping(sid);
    expect(gone.status).toBe(404);
  });

  it('keeps a session whose GET stream is open', async () => {
    const sid = await initialize();
    const ac = new AbortController();
    const stream = await fetch(`${d.base}/mcp`, {
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sid,
        'mcp-protocol-version': '2025-06-18',
      },
      signal: ac.signal,
    });
    expect(stream.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(d.mcp.sessionCount()).toBe(1);
    ac.abort();
    await waitFor(() => d.mcp.sessionCount() === 0, 5_000);
  });
});
