// =============================================================================
// agent-discover — hydrateActiveServers tests (v1.2.5 regression guard)
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createContext, hydrateActiveServers, type AppContext } from '../../src/context.js';

let ctx: AppContext;

beforeEach(() => {
  ctx = createContext({ path: ':memory:' });
});

afterEach(() => {
  ctx.close();
  vi.restoreAllMocks();
});

describe('hydrateActiveServers', () => {
  it('is a no-op on an empty database', async () => {
    const activateSpy = vi.spyOn(ctx.proxy, 'activate');
    await hydrateActiveServers(ctx);
    expect(activateSpy).not.toHaveBeenCalled();
  });

  it('does not flip active=0 when proxy.activate throws (the v1.2.4 regression)', async () => {
    ctx.registry.register({
      name: 'wedged',
      command: 'nonexistent-cmd-xyzzy',
      args: ['--boom'],
    });
    ctx.registry.setActive('wedged', true);

    vi.spyOn(ctx.proxy, 'activate').mockRejectedValue(new Error('spawn ENOENT'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await hydrateActiveServers(ctx);

    const row = ctx.registry.getByName('wedged');
    expect(row!.active).toBe(true); // flag must survive — another process may own the live bridge
    expect(stderrSpy).toHaveBeenCalled();
    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('wedged');
  });

  it('skips servers already active in the current proxy map', async () => {
    ctx.registry.register({ name: 'already-up', command: 'node', args: ['x.js'] });
    ctx.registry.setActive('already-up', true);

    vi.spyOn(ctx.proxy, 'isActive').mockImplementation((n) => n === 'already-up');
    const activateSpy = vi.spyOn(ctx.proxy, 'activate');

    await hydrateActiveServers(ctx);
    expect(activateSpy).not.toHaveBeenCalled();
  });

  it('calls proxy.activate once per active server that is not yet up', async () => {
    ctx.registry.register({ name: 'cold-a', command: 'node', args: ['a.js'] });
    ctx.registry.register({ name: 'cold-b', command: 'node', args: ['b.js'] });
    ctx.registry.setActive('cold-a', true);
    ctx.registry.setActive('cold-b', true);

    const activateSpy = vi.spyOn(ctx.proxy, 'activate').mockResolvedValue([]);
    await hydrateActiveServers(ctx);

    expect(activateSpy).toHaveBeenCalledTimes(2);
    const names = activateSpy.mock.calls.map((c) => (c[0] as { name: string }).name).sort();
    expect(names).toEqual(['cold-a', 'cold-b']);
  });

  it('ignores rows with installed=1 active=0', async () => {
    ctx.registry.register({ name: 'inactive-installed', command: 'node' });
    const activateSpy = vi.spyOn(ctx.proxy, 'activate');
    await hydrateActiveServers(ctx);
    expect(activateSpy).not.toHaveBeenCalled();
  });
});
