// =============================================================================
// ServerLifecycle + ConnectionPool against a real SDK v2 upstream (fixture).
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { startTestDaemon, installFixture, waitFor, type TestDaemon } from './helpers.js';
import type { LifecycleEvent } from '../src/domain/lifecycle.js';

let d: TestDaemon;
let events: LifecycleEvent['type'][];

beforeEach(async () => {
  d = await startTestDaemon();
  events = [];
  d.ctx.lifecycle.onChange((e) => events.push(e.type));
});
afterEach(async () => d.stop());

const toolEvents = () => events.filter((e) => e === 'tools').length;

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
