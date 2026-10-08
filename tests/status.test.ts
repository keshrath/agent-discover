// GET /api/status: what the Claude Code mod polls for its status entry, band and context.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installFixture, startTestDaemon, type TestDaemon } from './helpers.js';

let d: TestDaemon;

beforeAll(async () => {
  d = await startTestDaemon();
  await installFixture(d, 'alpha');
  await installFixture(d, 'beta');
  await installFixture(d, 'gamma');
  await d.ctx.lifecycle.enable('alpha');
  d.ctx.servers.setQuarantined(d.ctx.servers.get('gamma')!.id, true);
}, 60_000);
afterAll(() => d?.stop());

describe('GET /api/status', () => {
  it('has the server_status shape and answers without upstream calls', async () => {
    const st = await (await fetch(`${d.base}/api/status`)).json();
    for (const name of ['alpha', 'beta', 'gamma'])
      expect(d.ctx.lifecycle.pool.isConnected(name)).toBe(false);
    expect(st.mode).toBe('native');
    expect(st.servers.map((s: { name: string }) => s.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(st.servers[0]).toMatchObject({ enabled: true, quarantined: false, indexed: true });
    expect(st.servers[2]).toMatchObject({ quarantined: true });
  });
});
