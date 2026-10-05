import type { On } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

type Server = { name: string; enabled: boolean; quarantined: boolean; health_status: string };

const server = (name: string, over: Partial<Server> = {}) => ({
  name,
  description: '',
  enabled: false,
  quarantined: false,
  tool_count: 4,
  health_status: 'unknown',
  ...over,
});

const value = (body: unknown) => ({
  value: { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: false },
});

/** The daemon beneath the plugin: server_status and friends answer from `world`, calls are recorded. */
function daemon(on: On, world: { servers: ReturnType<typeof server>[]; pending?: number }) {
  const calls: string[] = [];
  const toasts: string[] = [];
  const status: (string | undefined)[] = [];
  const clock = mock.clock(on);
  mock.env(on, {});
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('mcp.call', (_$, e) => {
    calls.push(`${e.tool} ${JSON.stringify(e.args)}`);
    if (e.tool === 'server_status') return value({ mode: 'native', servers: world.servers });
    if (e.tool === 'search_tools')
      return value({
        results: [
          {
            query: 'q',
            matches: [{ server: 'github', tool: 'pr', description: 'x', enabled: false }],
          },
        ],
      });
    if (e.tool === 'search_servers')
      return value({
        query: 'q',
        installed: [],
        marketplace: [{ name: 'io.example/new', description: 'd', version: '1.0.0' }],
      });
    if (e.tool === 'enable_server')
      return value({ name: e.args.name, enabled: true, tool_count: 4, tools: [] });

    return value({ name: e.args.name, enabled: false });
  });
  on('http.fetch', (_$, e) => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify(
        e.url.endsWith('/api/elicitations')
          ? { entries: new Array(world.pending ?? 0).fill({}) }
          : {},
      ),
    },
  }));
  on('command.register', (_$, e) => ({ value: { command: e.name } }));
  on('ui.status', (_$, e) => (status.push(e.text), { value: undefined }));
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('ui.panes', () => ({ value: [] }));
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}));

  return { calls, toasts, status, clock };
}

const RUN = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const;
const PANE = {
  title: 'agent-discover',
  isFocused: true,
  bodyColumns: 80,
  placement: 'inline',
  scroll: { bodyRows: 20 },
  view: {},
} as never;
const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 5,
  bodyColumns: 80,
  scroll: { bodyRows: 4 },
  view: {},
} as never;

test('/discover reports status and searches installed tools and the registry', async ($, on) => {
  const d = daemon(on, { servers: [server('postgres', { enabled: true }), server('github')] });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const out = await $.command.run({ command: 'discover', args: 'pull requests', ...RUN });

  expect(out.text).toContain('MCP 1/2');
  expect(out.text).toContain('- github__pr');
  expect(out.text).toContain('install: io.example/new 1.0.0');
  expect(d.status.at(-1)).toBe('MCP 1/2');
});

test('the panel lists servers by state and its buttons call our MCP tools', async ($, on) => {
  const d = daemon(on, {
    servers: [
      server('postgres', { enabled: true }),
      server('github'),
      server('sqlite', { enabled: true, quarantined: true }),
    ],
  });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'discover', args: '', ...RUN });
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-discover',
      surface,
      component: 'Pane',
      props: PANE,
      requestId: 'agent-discover',
    });
    expect(await ui.find({ type: 'Text', text: 'Quarantined' })).toBeDefined();
    expect(await ui.find({ key: 'toggle:sqlite' })).toBeUndefined(); // quarantined: review first, no toggle
    expect((await ui.find({ key: 'toggle:github' }))?.props.label).toBe('Enable');
    await ui.press({ key: 'toggle:github' });
    await ui.unmount();
  }
  expect(d.calls).toContain('enable_server {"name":"github"}');
});

test('the attention band appears only when something needs the user', async ($, on) => {
  const world = { servers: [server('postgres', { enabled: true })] };
  daemon(on, world);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const mount = () =>
    $.ui.mount({
      plugin: 'agent-discover',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND,
    });

  expect(await (await mount()).find({ key: 'open' })).toBeUndefined();
  world.servers = [server('postgres', { enabled: true, health_status: 'unhealthy' })];
  await $.command.run({ command: 'discover', args: '', ...RUN });
  const band = await mount();
  expect(await band.find({ type: 'Text', text: /postgres/ })).toBeDefined();
  await band.press({ key: 'dismiss' });
  expect(await (await mount()).find({ key: 'open' })).toBeUndefined();
});

test('a toast names a server that newly gets quarantined', async ($, on) => {
  const world = { servers: [server('postgres', { enabled: true })] };
  const d = daemon(on, world);
  const { clock } = d;
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await clock.advance(30_000);
  expect(d.toasts).toEqual([]);
  world.servers = [server('postgres', { enabled: true, quarantined: true })];
  await clock.advance(30_000);
  expect(d.toasts).toEqual(['agent-discover: postgres quarantined, review before use']);
  await clock.advance(30_000);
  expect(d.toasts).toHaveLength(1); // once per change
});
