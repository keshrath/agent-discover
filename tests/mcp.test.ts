// =============================================================================
// MCP surface over /mcp, driven by real SDK v2 clients of both eras.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Client, CallToolResult } from '@modelcontextprotocol/client';
import {
  FIXTURE,
  connectClient,
  installFixture,
  startTestDaemon,
  waitFor,
  type TestDaemon,
} from './helpers.js';

let d: TestDaemon;
const clients: Client[] = [];

async function client(opts: Parameters<typeof connectClient>[1]): Promise<Client> {
  const c = await connectClient(d, opts);
  clients.push(c);
  return c;
}

beforeEach(async () => {
  d = await startTestDaemon();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await d.stop();
});

const META = [
  'call_tool',
  'disable_server',
  'enable_server',
  'get_tool',
  'install_server',
  'search_servers',
  'search_tools',
  'server_status',
];

describe.each(['modern', 'legacy'] as const)('%s client', (era) => {
  it('negotiates its era and lists the meta tools in deterministic order', async () => {
    const c = await client({ era });
    expect(c.getProtocolEra()).toBe(era);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(META);
    const search = tools.find((t) => t.name === 'search_tools')!;
    expect(search.annotations).toMatchObject({ readOnlyHint: true });
    expect(search.outputSchema).toMatchObject({ type: 'object' });
    expect(tools.find((t) => t.name === 'call_tool')!.outputSchema).toBeUndefined();
    expect(c.getInstructions()).toMatch(/search_tools/);
  });

  it('exposes enabled servers natively and emits list_changed on enable/disable', async () => {
    let changes = 0;
    const c = await client({ era, onToolsChanged: () => changes++ });
    await installFixture(d);
    expect((await c.listTools()).tools).toHaveLength(META.length);

    await c.callTool({ name: 'enable_server', arguments: { name: 'up' } });
    await waitFor(() => changes >= 1);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain('up__echo');
    expect(names).toEqual([...names].sort());

    const res = (await c.callTool({
      name: 'up__echo',
      arguments: { text: 'native' },
    })) as CallToolResult;
    expect(res.content).toEqual([{ type: 'text', text: 'native' }]);

    await c.callTool({ name: 'disable_server', arguments: { name: 'up' } });
    await waitFor(() => changes >= 2);
    expect((await c.listTools()).tools).toHaveLength(META.length);
    await expect(c.callTool({ name: 'up__echo', arguments: { text: 'x' } })).rejects.toThrow();
  });

  it('finds tools of disabled servers and calls them through call_tool verbatim', async () => {
    const c = await client({ era });
    await installFixture(d);
    const found = (await c.callTool({
      name: 'search_tools',
      arguments: { queries: ['echo text back', 'weather data'] },
    })) as CallToolResult;
    const results = (
      found.structuredContent as { results: Array<{ matches: Array<Record<string, unknown>> }> }
    ).results;
    expect(results[0].matches[0]).toMatchObject({
      server: 'up',
      tool: 'echo',
      exposed: false,
      enabled: false,
    });
    expect(results[1].matches[0]).toMatchObject({ tool: 'structured' });

    const tool = (
      await c.callTool({ name: 'get_tool', arguments: { server: 'up', tool: 'structured' } })
    ).structuredContent as Record<string, unknown>;
    expect(tool).toMatchObject({ found: true, name: 'up__structured' });
    expect(tool.output_schema).toMatchObject({ type: 'object' });

    const image = (await c.callTool({
      name: 'call_tool',
      arguments: { server: 'up', tool: 'image' },
    })) as CallToolResult;
    expect(image.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const fail = (await c.callTool({
      name: 'call_tool',
      arguments: { server: 'up', tool: 'fail' },
    })) as CallToolResult;
    expect(fail.isError).toBe(true);
    const structured = (await c.callTool({
      name: 'call_tool',
      arguments: { server: 'up', tool: 'structured', arguments: { city: 'Graz' } },
    })) as CallToolResult;
    expect(structured.structuredContent).toEqual({ city: 'Graz', celsius: 21 });
  });

  it('installs only after the user confirms via elicitation', async () => {
    const prompts: string[] = [];
    let answer: 'accept' | 'decline' = 'decline';
    const c = await client({
      era,
      elicit: (m) => {
        prompts.push(m);
        return answer === 'accept'
          ? { action: 'accept', content: { confirm: true } }
          : { action: 'decline' };
      },
    });
    const args = {
      name: 'viaMcp',
      command: process.execPath,
      args: [FIXTURE],
      env: { SOME_KEY: 'x' },
    };
    const declined = (await c.callTool({
      name: 'install_server',
      arguments: args,
    })) as CallToolResult;
    expect(declined.structuredContent).toMatchObject({ status: 'declined' });
    expect(d.ctx.servers.get('viaMcp')).toBeNull();
    expect(prompts[0]).toContain(FIXTURE);
    expect(prompts[0]).toContain('SOME_KEY');

    answer = 'accept';
    const ok = (await c.callTool({ name: 'install_server', arguments: args })) as CallToolResult;
    expect(ok.structuredContent).toMatchObject({ status: 'installed', enabled: false });
    expect((ok.structuredContent as { tool_count: number }).tool_count).toBeGreaterThan(3);
  });

  it('refuses install when the client cannot elicit', async () => {
    const c = await client({ era, elicitation: false });
    const res = (await c.callTool({
      name: 'install_server',
      arguments: { name: 'nope', command: process.execPath, args: [FIXTURE] },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/cannot show confirmation prompts/);
    expect(d.ctx.servers.get('nope')).toBeNull();
  });

  it('relays an upstream elicitation round (MRTR) to the client', async () => {
    const prompts: string[] = [];
    const c = await client({
      era,
      elicit: (m) => {
        prompts.push(m);
        return { action: 'accept', content: { yes: true } };
      },
    });
    await installFixture(d);
    const res = (await c.callTool({
      name: 'call_tool',
      arguments: { server: 'up', tool: 'confirm' },
    })) as CallToolResult;
    expect(prompts).toEqual(['Proceed?']);
    expect(res.content).toEqual([{ type: 'text', text: 'confirmed=true state=upstream-state-1' }]);
  });
});

describe('server surface', () => {
  it('serves prompts and server_status', async () => {
    const c = await client({ era: 'modern' });
    await installFixture(d);
    expect((await c.listPrompts()).prompts.map((p) => p.name)).toEqual([
      'discover',
      'install',
      'status',
    ]);
    const p = await c.getPrompt({ name: 'discover', arguments: { task: 'post to slack' } });
    expect(JSON.stringify(p.messages)).toContain('post to slack');
    const status = (await c.callTool({ name: 'server_status', arguments: {} }))
      .structuredContent as {
      mode: string;
      servers: Array<Record<string, unknown>>;
    };
    expect(status.mode).toBe('native');
    expect(status.servers[0]).toMatchObject({ name: 'up', indexed: true, enabled: false });
  });

  it('install is allowed without elicitation only with the operator opt-in', async () => {
    await d.stop();
    d = await startTestDaemon({ allowUnconfirmedInstall: true });
    const c = await client({ era: 'modern', elicitation: false });
    const res = (await c.callTool({
      name: 'install_server',
      arguments: { name: 'op', command: process.execPath, args: [FIXTURE], enable: true },
    })) as CallToolResult;
    expect(res.structuredContent).toMatchObject({ status: 'installed', enabled: true });
  });

  it('proxy mode keeps tools/list to the meta tools', async () => {
    await d.stop();
    d = await startTestDaemon({ mode: 'proxy' });
    await installFixture(d);
    await d.ctx.lifecycle.enable('up');
    const c = await client({ era: 'modern' });
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(META);
    const found = (await c.callTool({ name: 'search_tools', arguments: { queries: ['echo'] } }))
      .structuredContent as {
      results: Array<{ matches: Array<{ exposed: boolean; enabled: boolean }> }>;
    };
    expect(found.results[0].matches[0]).toMatchObject({ enabled: true, exposed: false });
  });
});
