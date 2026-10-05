// =============================================================================
// OAuth 2.1 for remote upstreams against an in-process authorization server:
// 401 → authorization URL (never opened by us), loopback /oauth/callback with
// state + iss checks, tokens persisted per issuer, URL-mode elicitation.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { startTestDaemon, waitFor, type TestDaemon } from './helpers.js';
import { startMockOAuth, type MockOAuth } from './fixtures/oauth-server.js';

let d: TestDaemon;
let as: MockOAuth;
let serverId: number;

beforeEach(async () => {
  as = await startMockOAuth();
  d = await startTestDaemon();
  const { server, index_error } = await d.ctx.lifecycle.install({
    name: 'secure',
    transport: 'streamable-http',
    url: as.mcpUrl,
  });
  serverId = server.id;
  expect(index_error).toMatch(/requires sign-in/);
});
afterEach(async () => {
  await d.stop();
  await as.close();
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(d.base + path, {
    ...init,
    headers: { ...init.headers, 'x-agent-discover-token': d.restToken },
  });

/** Play the user's browser: follow the AS redirect back to the daemon. */
async function signIn(authorizeUrl: string): Promise<Response> {
  const redirect = await fetch(authorizeUrl, { redirect: 'manual' });
  expect(redirect.status).toBe(302);
  const callback = new URL(redirect.headers.get('location')!);
  expect(callback.origin).toBe(d.base);
  expect(callback.pathname).toBe('/oauth/callback');
  return fetch(callback);
}

async function authorizeUrl(): Promise<string> {
  const status = await (await api(`/api/servers/${serverId}/auth`)).json();
  expect(status.status).toBe('required');
  expect(status.authorize_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/authorize\?/);
  return status.authorize_url;
}

describe('dashboard sign-in', () => {
  it('registers dynamically, signs in through the loopback callback and indexes', async () => {
    const url = new URL(await authorizeUrl());
    expect(as.registrations).toBe(1);
    expect(url.searchParams.get('redirect_uri')).toBe(`${d.base}/oauth/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(as.mcpUrl);

    const done = await signIn(url.href);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('authorized for &quot;secure&quot;');
    await waitFor(() => d.ctx.index.count(serverId) === 1, 10_000);

    const keys = d.ctx.secrets.list({ id: serverId, name: 'secure' }).map((s) => s.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        `oauth:client:${as.base}`,
        `oauth:tokens:${as.base}`,
        'oauth:issuer',
        'oauth:discovery',
      ]),
    );
    expect(keys).not.toContain('oauth:verifier');
    expect(d.ctx.secrets.getEnvForServer({ id: serverId, name: 'secure' })).toEqual({});
    expect(await (await api(`/api/servers/${serverId}/auth`)).json()).toMatchObject({
      status: 'authorized',
      issuer: as.base,
    });
    const result = await d.ctx.lifecycle.callTool('secure', 'whoami', {});
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'authorized' }] });
  });

  it('rejects a callback whose iss names another authorization server (mix-up)', async () => {
    const url = await authorizeUrl();
    as.redirectIss = 'https://evil.example';
    const res = await signIn(url);
    expect(res.status).toBe(400);
    expect(as.tokensIssued).toBe(0);
    expect((await (await api(`/api/servers/${serverId}/auth`)).json()).status).not.toBe(
      'authorized',
    );
  });

  it('rejects unknown and replayed state', async () => {
    const bad = await api('/oauth/callback?code=x&state=forged');
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('unknown or expired OAuth state');

    const redirect = await fetch(await authorizeUrl(), { redirect: 'manual' });
    const callback = redirect.headers.get('location')!;
    expect((await fetch(callback)).status).toBe(200);
    expect((await fetch(callback)).status).toBe(400);
    await waitFor(() => d.ctx.index.count(serverId) === 1, 10_000);
  });

  it('POST /api/servers/:id/auth starts a fresh authorization; stdio servers have none', async () => {
    const res = await (await api(`/api/servers/${serverId}/auth`, { method: 'POST' })).json();
    expect(res.status).toBe('required');
    const stdio = await d.ctx.lifecycle.install({ name: 'local', command: 'node', args: ['-v'] });
    expect((await api(`/api/servers/${stdio.server.id}/auth`)).status).toBe(400);
  });
});

describe('MCP sign-in', () => {
  async function mcpClient(url: boolean, onUrl: (u: string) => void): Promise<Client> {
    const client = new Client(
      { name: 'test-url', version: '1.0.0' },
      {
        capabilities: { elicitation: url ? { form: {}, url: {} } : { form: {} } },
        versionNegotiation: { mode: 'auto' },
      },
    );
    client.setRequestHandler('elicitation/create', async (req) => {
      const p = req.params as { mode?: string; url?: string };
      if (p.mode === 'url' && p.url) onUrl(p.url);
      return { action: 'accept' } as never;
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${d.base}/mcp`)));
    return client;
  }

  it('hands the authorization URL out via URL-mode elicitation and retries after sign-in', async () => {
    const opened: string[] = [];
    const client = await mcpClient(true, (u) => {
      opened.push(u);
      void signIn(u); // the user signs in while the retry waits for the callback
    });
    const res = (await client.callTool({
      name: 'call_tool',
      arguments: { server: 'secure', tool: 'whoami' },
    })) as CallToolResult;
    await client.close();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/authorize\?/);
    expect(res.content).toEqual([{ type: 'text', text: 'authorized' }]);
    await waitFor(() => d.ctx.index.count(serverId) === 1, 10_000);
  });

  it('without URL elicitation the error carries the URL', async () => {
    const client = await mcpClient(false, () => {});
    const res = (await client.callTool({
      name: 'call_tool',
      arguments: { server: 'secure', tool: 'whoami' },
    })) as CallToolResult;
    await client.close();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/requires sign-in\. Open http:\/\/127\.0\.0\.1/);
  });
});
