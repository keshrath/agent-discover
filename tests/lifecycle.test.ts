// =============================================================================
// ServerLifecycle + ConnectionPool against a real SDK v2 upstream (fixture).
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, onTestFinished } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { startTestDaemon, installFixture, waitFor, type TestDaemon } from './helpers.js';

let d: TestDaemon;
let events: number;

beforeEach(async () => {
  d = await startTestDaemon();
  events = 0;
  d.ctx.lifecycle.onToolsChanged(() => events++);
});
afterEach(async () => d.stop());

const toolEvents = () => events;

describe('install → index → enable/disable → uninstall', () => {
  it('indexes on install and disconnects the probe connection', async () => {
    const { server, diff, index_error } = await installFixture(d);
    expect(index_error).toBeUndefined();
    expect(diff!.added).toEqual(expect.arrayContaining(['echo', 'image', 'fail', 'structured']));
    expect(server.indexed_at).not.toBeNull();
    expect(server.enabled).toBe(false);
    expect(d.ctx.lifecycle.pool.isConnected('up')).toBe(false);
    expect(d.ctx.index.get('up', 'structured')!.output_schema).toMatchObject({ type: 'object' });
    expect(d.ctx.index.get('up', 'echo')!.annotations).toEqual({ readOnlyHint: true });
  });

  it('keeps the index across disable and fires a tools event on every exposure change', async () => {
    await installFixture(d);
    expect(toolEvents()).toBe(0); // installed but not exposed
    await d.ctx.lifecycle.enable('up');
    expect(toolEvents()).toBe(1);
    await d.ctx.lifecycle.enable('up'); // idempotent: no event
    expect(toolEvents()).toBe(1);
    await d.ctx.lifecycle.disable('up');
    expect(toolEvents()).toBe(2);
    expect(d.ctx.index.list(d.ctx.servers.get('up')!.id).length).toBeGreaterThan(0);
    expect((await d.ctx.index.search('echo text'))[0].server).toBe('up');
    await d.ctx.lifecycle.enable('up');
    await d.ctx.lifecycle.uninstall('up');
    expect(toolEvents()).toBe(4);
    expect(d.ctx.servers.get('up')).toBeNull();
  });

  it('reports an index failure without losing the install', async () => {
    const { server, index_error } = await d.ctx.lifecycle.install({
      name: 'broken',
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
    });
    expect(index_error).toMatch(/Failed to connect "broken"/);
    expect(server.indexed_at).toBeNull();
    await expect(d.ctx.lifecycle.enable('broken')).rejects.toThrow(/retrying in|Failed to connect/);
  });
});

describe('calls', () => {
  beforeEach(async () => {
    await installFixture(d);
  });

  it('passes CallToolResult through verbatim (image, isError, structuredContent)', async () => {
    const image = (await d.ctx.lifecycle.callTool('up', 'image', {})) as CallToolResult;
    expect(image.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const fail = (await d.ctx.lifecycle.callTool('up', 'fail', {})) as CallToolResult;
    expect(fail.isError).toBe(true);
    expect(fail.content).toEqual([{ type: 'text', text: 'boom' }]);
    const structured = (await d.ctx.lifecycle.callTool('up', 'structured', {
      city: 'Vienna',
    })) as CallToolResult;
    expect(structured.structuredContent).toEqual({ city: 'Vienna', celsius: 21 });
  });

  it('drops a crashed child and reconnects on the next call', async () => {
    await d.ctx.lifecycle.callTool('up', 'echo', { text: 'a' });
    expect(d.ctx.lifecycle.pool.isConnected('up')).toBe(true);
    await d.ctx.lifecycle.callTool('up', 'crash', {});
    await waitFor(() => !d.ctx.lifecycle.pool.isConnected('up'));
    const again = (await d.ctx.lifecycle.callTool('up', 'echo', {
      text: 'back',
    })) as CallToolResult;
    expect(again.content).toEqual([{ type: 'text', text: 'back' }]);
  });

  it('re-indexes when the upstream announces list_changed', async () => {
    await d.ctx.lifecycle.enable('up');
    const before = toolEvents();
    await d.ctx.lifecycle.callTool('up', 'grow', {});
    await waitFor(() => d.ctx.index.get('up', 'extra') !== null);
    await waitFor(() => toolEvents() > before);
  });

  it('health is a real probe and is persisted', async () => {
    expect((await d.ctx.lifecycle.health('up')).status).toBe('healthy');
    expect(d.ctx.servers.get('up')!.health_status).toBe('healthy');
  });

  it('quarantine blocks calls and exposure; trust hooks run', async () => {
    await d.ctx.lifecycle.callTool('up', 'echo', { text: 'x' });
    expect(d.ctx.trust.audit.list({ action: 'call_tool' }).entries.map((e) => e.tool)).toEqual([
      'echo',
    ]);

    await d.ctx.lifecycle.update('up', { env: { FIXTURE_DESCRIPTION: 'drifted' } });
    await d.ctx.lifecycle.reindex('up');
    expect(d.ctx.servers.get('up')!.quarantined).toBe(true);
    await expect(d.ctx.lifecycle.callTool('up', 'echo', { text: 'x' })).rejects.toThrow(
      /quarantined/,
    );
    await expect(d.ctx.lifecycle.enable('up')).rejects.toThrow(/quarantined/);
  });
});

describe('call and connection races', () => {
  beforeEach(async () => {
    await installFixture(d);
  });

  const pool = () => d.ctx.lifecycle.pool;
  const text = (r: unknown) => JSON.stringify((r as CallToolResult).content);

  it('call_tool refuses tools that are not in the index (never pinned)', async () => {
    const server = d.ctx.servers.get('up')!;
    const kept = (await pool().listTools('up')).filter((t) => t.name !== 'echo');
    await d.ctx.index.save(server.id, kept);
    await expect(d.ctx.lifecycle.callTool('up', 'echo', { text: 'x' })).rejects.toThrow(
      /not found/,
    );
  });

  it('a probe that joins a pending connect leaves the other caller its connection', async () => {
    d.ctx.servers.setEraVerdict('up', 'legacy'); // `confirm` parks on a pushed question
    const call = d.ctx.lifecycle.callTool('up', 'confirm', {});
    await pool().probe('up', (c) => c.listTools());
    await waitFor(() => pool().listPendingElicitations().length === 1);
    const [q] = pool().listPendingElicitations();
    pool().respondElicitation(q.id, { action: 'accept', content: { yes: true } });
    expect(text(await call)).toContain('confirmed=true');
  });

  it('a disconnect during a pending connect drops the stale connection', async () => {
    const connecting = pool().connect('up');
    await d.ctx.lifecycle.setSecret('up', 'FIXTURE_SECRET', 'fresh');
    await connecting;
    const res = await d.ctx.lifecycle.callTool('up', 'env', { name: 'FIXTURE_SECRET' });
    expect(text(res)).toContain('fresh');
  });

  it("a stdio server gets its own env and the safe defaults, never the daemon's other variables", async () => {
    process.env.AGENT_DISCOVER_TEST_LEAK = 'daemon-only-token';
    onTestFinished(() => delete process.env.AGENT_DISCOVER_TEST_LEAK);
    await d.ctx.lifecycle.setSecret('up', 'FIXTURE_SECRET', 'own');
    const leak = await d.ctx.lifecycle.callTool('up', 'env', { name: 'AGENT_DISCOVER_TEST_LEAK' });
    expect(text(leak)).not.toContain('daemon-only-token');
    expect(text(await d.ctx.lifecycle.callTool('up', 'env', { name: 'FIXTURE_SECRET' }))).toContain(
      'own',
    );
    expect(text(await d.ctx.lifecycle.callTool('up', 'env', { name: 'PATH' }))).not.toBe('');
  });

  it('routes a pushed question to the queue while other calls are in flight', async () => {
    d.ctx.servers.setEraVerdict('up', 'legacy');
    let release: (() => void) | undefined;
    const asked: string[] = [];
    const first = d.ctx.lifecycle.callTool(
      'up',
      'confirm',
      {},
      {
        onElicit: (q) => {
          asked.push(q.message);
          return new Promise((r) => {
            release = () => r({ action: 'accept', content: { yes: true } });
          });
        },
      },
    );
    await waitFor(() => asked.length === 1);
    const second = d.ctx.lifecycle.callTool('up', 'confirm', {}); // its caller cannot answer
    await waitFor(() => pool().listPendingElicitations().length === 1);
    expect(asked).toHaveLength(1);
    const [q] = pool().listPendingElicitations();
    pool().respondElicitation(q.id, { action: 'accept', content: { yes: true } });
    release!();
    expect(text(await first)).toContain('confirmed=true');
    expect(text(await second)).toContain('confirmed=true');
  });

  it('uninstall moves the index generation so rankers drop the server', async () => {
    const generation = () =>
      d.ctx.db.queryOne<{ value: string }>(
        "SELECT value FROM _meta WHERE key = 'tool_index_generation'",
      )?.value;
    const before = generation();
    await d.ctx.lifecycle.uninstall('up');
    expect(generation()).not.toBe(before);
  });

  it('the call log keeps neither arguments nor successful output', async () => {
    await d.ctx.lifecycle.callTool('up', 'echo', { text: 'private-payload' });
    await d.ctx.lifecycle.callTool('up', 'fail', {});
    const entries = d.ctx.logs.list();
    expect(JSON.stringify(entries)).not.toContain('private-payload');
    expect(entries.find((e) => e.tool === 'fail')).toMatchObject({
      success: false,
      response: 'boom',
    });
  });

  it('a command with spaces in its path that exits early is not reported as missing', async () => {
    const { index_error } = await d.ctx.lifecycle.install({
      name: 'early',
      command: process.execPath,
      args: ['-e', 'process.exit(3)'],
    });
    expect(index_error).not.toMatch(/not found on PATH/);
  });
});
