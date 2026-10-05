// =============================================================================
// A 2025 upstream pushes elicitation/create mid-call: the gateway parks the
// call and asks the downstream client (MRTR round for 2026, the SDK legacy
// shim for 2025); a client that cannot elicit falls back to the dashboard.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Client, CallToolResult } from '@modelcontextprotocol/client';
import {
  connectClient,
  installFixture,
  startTestDaemon,
  waitFor,
  type TestDaemon,
} from './helpers.js';

let d: TestDaemon;
const clients: Client[] = [];

beforeEach(async () => {
  d = await startTestDaemon();
  await installFixture(d);
  // Force the upstream onto the 2025 era: its tool's MRTR round becomes a pushed request.
  d.ctx.servers.setEraVerdict('up', 'legacy');
  await d.ctx.lifecycle.pool.disconnect('up');
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await d.stop();
});

async function client(opts: Parameters<typeof connectClient>[1]): Promise<Client> {
  const c = await connectClient(d, opts);
  clients.push(c);
  return c;
}

const confirm = (c: Client) =>
  c.callTool({
    name: 'call_tool',
    arguments: { server: 'up', tool: 'confirm' },
  }) as Promise<CallToolResult>;

describe.each(['modern', 'legacy'] as const)('%s downstream', (era) => {
  it('forwards the pushed question to the client and resumes the parked call', async () => {
    const prompts: string[] = [];
    const c = await client({
      era,
      elicit: (m) => {
        prompts.push(m);
        return { action: 'accept', content: { yes: true } };
      },
    });
    const res = await confirm(c);
    expect(d.ctx.lifecycle.pool.info('up')?.era).toBe('legacy');
    expect(prompts).toEqual(['Proceed?']);
    expect(JSON.stringify(res.content)).toContain('confirmed=true');
    expect(d.ctx.lifecycle.pool.listPendingElicitations()).toEqual([]);
  });

  it('relays a decline', async () => {
    const c = await client({ era, elicit: () => ({ action: 'decline' }) });
    const res = await confirm(c);
    expect(JSON.stringify(res.content)).not.toContain('confirmed=true');
  });
});

describe('downstream without elicitation', () => {
  it('falls back to the dashboard queue', async () => {
    const c = await client({ era: 'modern', elicitation: false });
    const pending = confirm(c);
    await waitFor(() => d.ctx.lifecycle.pool.listPendingElicitations().length === 1);
    const [q] = d.ctx.lifecycle.pool.listPendingElicitations();
    expect(q).toMatchObject({ serverName: 'up', message: 'Proceed?' });
    d.ctx.lifecycle.pool.respondElicitation(q.id, { action: 'accept', content: { yes: true } });
    expect(JSON.stringify((await pending).content)).toContain('confirmed=true');
  });
});
