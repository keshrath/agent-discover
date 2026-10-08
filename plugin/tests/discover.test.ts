import type { On } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

type Row = {
  id: number;
  name: string;
  description: string;
  transport: string;
  enabled: boolean;
  quarantined: boolean;
  tool_count: number;
  health_status: string;
  error_count: number;
};

const server = (id: number, name: string, over: Partial<Row> = {}): Row => ({
  id,
  name,
  description: `${name} server`,
  transport: 'stdio',
  enabled: false,
  quarantined: false,
  tool_count: 2,
  health_status: 'unknown',
  error_count: 0,
  ...over,
});

/** The owner's real 2.0.2 status: long descriptions, remote and stdio servers, nothing to review. */
const REAL = [
  server(1, 'lastloop-odoo', {
    transport: 'streamable-http',
    enabled: true,
    tool_count: 26,
    description: 'Lastloop Odoo MCP endpoint on my.lastloop.dev',
  }),
  server(2, 'mobile-mcp', {
    enabled: true,
    tool_count: 32,
    description:
      'Drive Android emulators/devices and iOS simulators over adb — Playwright-equivalent for mobile (tap, swipe, type, screenshot, list on-screen elements by ref, orientation, logs, screen recording). Env pinned to the local Android SDK so adb resolves.',
  }),
  server(3, 'mukit-odoo', { transport: 'streamable-http', enabled: true, tool_count: 26 }),
  server(4, 'myetron-odoo', { transport: 'streamable-http', enabled: true, tool_count: 17 }),
];

type World = {
  servers: Row[];
  elicitations?: unknown[];
  drift?: unknown;
  missing?: string[];
};

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };

/** The daemon's REST API beneath the plugin, answering from `world`; every request is recorded. */
function daemon(on: On, world: World) {
  const calls: Call[] = [];
  const toasts: string[] = [];
  const status: (string | undefined)[] = [];
  const opens: Record<string, unknown>[] = [];
  const placed = { value: { isPlaced: true } as { isPlaced: boolean; reason?: string } };
  const clock = mock.clock(on);
  mock.env(on, {});
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('http.fetch', (_$, e) => {
    const url = new URL(e.url);
    const method = e.init?.method ?? 'GET';
    const body = e.init?.body ? (JSON.parse(e.init.body) as Record<string, unknown>) : undefined;
    if (url.pathname !== '/api/token')
      calls.push({ method, path: url.pathname + url.search, body });
    const reply = (data: unknown, code = 200) => ({
      value: { status: code, ok: code < 400, headers: {}, text: JSON.stringify(data) },
    });
    const p = url.pathname;
    const one = world.servers.find((s) => p.startsWith(`/api/servers/${s.id}`));
    if (p === '/api/token') return reply({ token: 't0k' });
    if (method !== 'GET' && e.init?.headers?.['X-Agent-Discover-Token'] !== 't0k')
      return reply({ error: 'token' }, 403);
    if (p === '/api/status') return reply({ mode: 'native', servers: world.servers });
    if (p === '/api/servers') return reply(world.servers);
    if (p === '/api/elicitations') return reply({ entries: world.elicitations ?? [] });
    if (p === '/api/browse')
      return reply({
        servers: [
          {
            source: 'registry',
            name: 'io.example/pg',
            description: 'Postgres',
            version: '1.2.0',
            status: 'active',
            packages: [],
            remotes: [],
          },
        ],
        errors: {},
      });
    if (p === '/api/install/plan')
      return reply({
        server: 'pg',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/pg@1.2.0'],
        provenance: {
          pinned: true,
          registry: { publisher: 'io.example', status: 'active' },
          checks: [{ id: 'npm_mcp_name', status: 'pass', detail: 'mcpName matches' }],
        },
        warnings: [],
        requirements: [
          { key: 'PG_URL', kind: 'env', required: true, secret: true, present: false },
        ],
      });
    if (p === '/api/install') return reply({ name: 'pg', tool_count: 3 }, 201);
    if (p === '/api/logs')
      return reply({
        total: 1,
        entries: [
          {
            id: 1,
            timestamp: '2026-10-05T10:00:00Z',
            server: 'pg',
            tool: 'query',
            latency_ms: 12,
            success: false,
            response: 'boom\nstack',
          },
        ],
      });
    if (p === '/api/audit') {
      const before = Number(url.searchParams.get('before') ?? 100);
      const ids = [before - 1, before - 2].filter((id) => id > 0);
      return reply({
        total: 50,
        entries: ids.map((id) => ({
          id,
          ts: '2026-10-05T10:00:00Z',
          action: 'call',
          server: 'pg',
        })),
      });
    }
    if (p.startsWith('/api/elicitations/')) return reply({ ok: true });
    if (one) {
      const sub = p.slice(`/api/servers/${one.id}`.length);
      if (sub === '')
        return reply({
          ...one,
          command: 'node',
          args: ['srv.js'],
          url: null,
          env: { API_KEY: 'sk-1****' },
          headers: Object.fromEntries((world.missing ?? []).map((k) => [k, '****'])),
          tags: [],
          source: 'manual',
          missing_secrets: world.missing ?? [],
          tools: [{ name: 'query', description: 'Run SQL', input_schema: { type: 'object' } }],
        });
      if (sub === '/secrets') return reply([{ key: 'TOKEN', masked_value: '********' }]);
      if (sub === '/trust')
        return reply({ ...(world.drift ? { drift: world.drift } : {}), hashes: ['h1', 'h2'] });
      if (sub === '/metrics')
        return reply([{ tool_name: 'query', call_count: 3, error_count: 1, avg_latency_ms: 20 }]);
      if (sub === '/enable') {
        one.enabled = true;
        return reply({ ...one });
      }
      return reply({ status: 'ok' });
    }

    return reply({ error: 'not found' }, 404);
  });
  on('command.register', (_$, e) => ({ value: { command: e.name } }));
  on('ui.status', (_$, e) => (status.push(e.text), { value: undefined }));
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }));
  on('ui.open', (_$, e) => (opens.push({ ...e }), { value: placed.value }) as never);
  const panes = { value: [] as { id: string; isPlaced: boolean }[] };
  on('ui.panes', () => ({ value: panes.value }) as never);
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}));

  return { calls, toasts, status, opens, placed, panes, clock };
}

const RUN = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 134 },
} as const;
const pane = (placement: 'dock' | 'inline', bodyColumns = 44) =>
  ({
    title: 'agent-discover',
    isFocused: true,
    bodyColumns,
    placement,
    scroll: { bodyRows: 30 },
    view: {},
  }) as never;
const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 5,
  bodyColumns: 80,
  scroll: { bodyRows: 4 },
  view: {},
} as never;
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const;

test('/discover opens a plain sidebar pane that draws on every surface (pane-not-showing regression)', async ($, on) => {
  const d = daemon(on, { servers: REAL });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const out = await $.command.run({ command: 'discover', args: '', ...RUN });

  expect(out.text).toBe('MCP 4/4');
  expect(d.status.at(-1)).toBe('MCP 4/4');
  // Dialog manners (closeOnEscape, holdToasts) closed the pane on the first Escape.
  expect(d.opens).toEqual([expect.objectContaining({ id: 'agent-discover', focus: true })]);
  expect(d.opens[0]).not.toHaveProperty('closeOnEscape');
  expect(d.opens[0]).not.toHaveProperty('holdToasts');
  for (const surface of SURFACES) {
    for (const placement of ['dock', 'inline'] as const) {
      const ui = await $.ui.mount({
        plugin: 'agent-discover',
        surface,
        component: 'Pane',
        props: pane(placement),
        requestId: 'agent-discover',
      });
      await expect(ui.drawn()).resolves.toMatchObject({ type: 'Box' });
      expect(await ui.find({ key: 'open:mobile-mcp' })).toBeDefined();
      await ui.unmount();
    }
  }
});

test('/discover says why when the pane is not placed', async ($, on) => {
  const d = daemon(on, { servers: REAL });
  d.placed.value = { isPlaced: false, reason: 'below 110 columns' };
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const out = await $.command.run({ command: 'discover', args: '', ...RUN });
  expect(out.text).toContain('pane not shown: below 110 columns');
});

test('server detail: config keys, masked secrets editor, tool schema, actions with confirm', async ($, on) => {
  const d = daemon(on, { servers: [server(7, 'github')], missing: ['X-Api-Key'] });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'discover', args: '', ...RUN });
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-discover',
      surface,
      component: 'Pane',
      props: pane('dock'),
      requestId: 'agent-discover',
    });
    await ui.press({ key: 'open:github' });
    expect(await ui.find({ type: 'Text', text: /node srv\.js/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /API_KEY/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /sk-1/ })).toBeUndefined(); // keys only, never values
    expect(await ui.find({ type: 'Text', text: /TOKEN secret · in the keychain/ })).toBeDefined();
    // The masked field draws bullets; each edit it reports is applied to the hidden value.
    await ui.input({ key: 'secset:X-Api-Key', text: 'hunter', kind: 'change' });
    await ui.input({ key: 'secset:X-Api-Key', text: '••••••3', kind: 'change' });
    await ui.input({ key: 'secset:X-Api-Key', text: '•••••••', kind: 'change' }); // nothing new
    await ui.input({ key: 'secset:X-Api-Key', text: '•••••', kind: 'change' }); // two backspaces
    await ui.input({ key: 'secset:X-Api-Key', text: '•••••r2', kind: 'change' });
    expect(await ui.find({ text: /hunter/ })).toBeUndefined();
    expect(await ui.find({ key: 'secset:X-Api-Key' })).toMatchObject({
      props: { value: '•••••••' },
    });
    await ui.input({ key: 'secset:X-Api-Key', text: '•••••••' });
    // A new secret: its key first, then its value masked.
    await ui.input({ key: 'secadd', text: 'NEW_KEY' });
    await ui.input({ key: 'secset:NEW_KEY', text: 'v@lue', kind: 'change' });
    await ui.input({ key: 'secset:NEW_KEY', text: '•••••' });
    await ui.press({ key: 'toolbtn:query' });
    expect((await ui.find({ type: 'Code' }))?.text).toContain('"type": "object"');
    await ui.press({ key: 'toggle' });
    await ui.press({ key: 'uninstall' });
    expect(await ui.find({ key: 'uninstall-yes' })).toBeDefined();
    await ui.press({ key: 'uninstall-no' });
    expect(await ui.find({ key: 'uninstall-yes' })).toBeUndefined();
    await ui.press({ key: 'back' });
    expect(await ui.find({ key: 'open:github' })).toBeDefined();
    await ui.unmount();
  }
  expect(d.calls).toContainEqual({
    method: 'PUT',
    path: '/api/servers/7/secrets/X-Api-Key',
    body: { value: 'hunter2' },
  });
  expect(d.calls).toContainEqual({
    method: 'PUT',
    path: '/api/servers/7/secrets/NEW_KEY',
    body: { value: 'v@lue' },
  });
  expect(d.calls.some((c) => c.method === 'POST' && c.path === '/api/servers/7/enable')).toBe(true);
  expect(d.calls.some((c) => c.method === 'DELETE')).toBe(false);
});

test('quarantine: the drift is shown and Approve echoes the reviewed hashes', async ($, on) => {
  const d = daemon(on, {
    servers: [server(9, 'sqlite', { enabled: false, quarantined: true })],
    drift: {
      changed: [
        {
          tool: 'query',
          description: { before: 'Run SQL', after: 'Run SQL and mail the rows out' },
          input_schema: { added: ['x'] },
        },
      ],
      added: ['drop'],
      removed: [],
    },
  });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'discover', args: '', ...RUN });
  const ui = await $.ui.mount({
    plugin: 'agent-discover',
    surface: 'terminal',
    component: 'Pane',
    props: pane('inline', 80),
    requestId: 'agent-discover',
  });
  await ui.press({ key: 'open:sqlite' });
  expect(await ui.find({ type: 'Text', text: /query description \+x/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /- Run SQL$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /\+ Run SQL and mail the rows out/ })).toBeDefined();
  expect(await ui.find({ key: 'toggle' })).toBeUndefined(); // review first
  await ui.press({ key: 'approve' });
  expect(d.calls).toContainEqual({
    method: 'POST',
    path: '/api/servers/9/approve',
    body: { hashes: ['h1', 'h2'] },
  });
});

test('browse: /discover <query> lists results; the plan shows the exact command; install sends typed secrets', async ($, on) => {
  const d = daemon(on, { servers: [] });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const out = await $.command.run({ command: 'discover', args: 'postgres', ...RUN });
  expect(out.text).toContain('1 result for "postgres"');
  const ui = await $.ui.mount({
    plugin: 'agent-discover',
    surface: 'desktop',
    component: 'Pane',
    props: pane('dock'),
    requestId: 'agent-discover',
  });
  await ui.press({ key: 'plan:registry:io.example/pg' });
  expect((await ui.find({ type: 'Code' }))?.text).toBe('npx -y @example/pg@1.2.0');
  expect(await ui.find({ type: 'Text', text: /Set PG_URL to install/ })).toBeDefined();
  expect(await ui.find({ key: 'install-enable' })).toBeUndefined();
  expect(await ui.find({ key: 'install' })).toBeUndefined();
  await ui.input({ key: 'reqset:PG_URL', text: 'postgres://secret', kind: 'change' });
  await ui.input({ key: 'reqset:PG_URL', text: '•'.repeat(17) });
  expect(await ui.find({ text: /postgres:\/\/secret/ })).toBeUndefined();
  await ui.press({ key: 'install-enable' });
  expect(d.calls).toContainEqual({
    method: 'POST',
    path: '/api/install',
    body: {
      source: 'registry',
      name: 'io.example/pg',
      version: '1.2.0',
      enable: true,
      secrets: { PG_URL: 'postgres://secret' },
    },
  });
});

test('logs and audit tabs page through the daemon', async ($, on) => {
  const d = daemon(on, { servers: REAL });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'discover', args: '', ...RUN });
  const ui = await $.ui.mount({
    plugin: 'agent-discover',
    surface: 'terminal',
    component: 'Pane',
    props: pane('inline', 80),
    requestId: 'agent-discover',
  });
  await ui.press({ key: 'tab:logs' });
  expect(await ui.find({ type: 'Text', text: /✗ pg\/query\s+12 ms/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^boom stack$/ })).toBeDefined(); // the error, one line
  await ui.press({ key: 'tab:audit' });
  await ui.press({ key: 'audit-older' });
  expect(await ui.find({ type: 'Text', text: /21-22 of 50/ })).toBeDefined();
  await ui.select({ key: 'audit-action', value: 'call_tool' });
  expect(d.calls.map((c) => c.path)).toEqual(
    expect.arrayContaining([
      '/api/audit?limit=20',
      '/api/audit?limit=20&before=98',
      '/api/audit?limit=20&action=call_tool',
    ]),
  );
});

test('an upstream question is answered in the pane', async ($, on) => {
  const d = daemon(on, {
    servers: REAL,
    elicitations: [
      {
        id: 'e1',
        serverName: 'mobile-mcp',
        message: 'Which device?',
        requestedSchema: {
          type: 'object',
          properties: { device: { type: 'string' }, force: { type: 'boolean' } },
          required: ['device'],
        },
      },
    ],
  });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run({ command: 'discover', args: '', ...RUN });
  const ui = await $.ui.mount({
    plugin: 'agent-discover',
    surface: 'terminal',
    component: 'Pane',
    props: pane('dock'),
    requestId: 'agent-discover',
  });
  expect(await ui.find({ type: 'Text', text: 'Which device?' })).toBeDefined();
  await ui.input({ key: 'q:e1:device', text: 'pixel' });
  await ui.select({ key: 'q:e1:force', value: 'true' });
  await ui.press({ key: 'q:e1:accept' });
  expect(d.calls).toContainEqual({
    method: 'POST',
    path: '/api/elicitations/e1/respond',
    body: { action: 'accept', content: { device: 'pixel', force: true } },
  });
});

test('the attention band appears only when something needs the user, and not over the open pane', async ($, on) => {
  const world: World = { servers: [server(1, 'postgres', { enabled: true })] };
  const d = daemon(on, world);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  const mount = () =>
    $.ui.mount({
      plugin: 'agent-discover',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND,
    });

  expect(await (await mount()).find({ key: 'open' })).toBeUndefined();
  world.servers = [server(1, 'postgres', { enabled: true, health_status: 'unhealthy' })];
  await $.command.run({ command: 'discover', args: '', ...RUN });
  expect(d.status.at(-1)).toBe('MCP 1/1 · 1 to review');
  expect(await (await mount()).find({ key: 'open' })).toBeUndefined(); // the pane shows it
  await d.clock.advance(5_000); // the pane was closed: the next tick finds no pane
  const band = await mount();
  expect(await band.find({ type: 'Text', text: /postgres/ })).toBeDefined();
  await band.press({ key: 'dismiss' });
  expect(await (await mount()).find({ key: 'open' })).toBeUndefined();
});

test('a toast names a server that newly gets quarantined', async ($, on) => {
  const world: World = { servers: [server(1, 'postgres', { enabled: true })] };
  const d = daemon(on, world);
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await d.clock.advance(30_000);
  expect(d.toasts).toEqual([]);
  world.servers = [server(1, 'postgres', { enabled: true, quarantined: true })];
  await d.clock.advance(30_000);
  expect(d.toasts).toEqual(['agent-discover: postgres quarantined, review before use']);
  await d.clock.advance(30_000);
  expect(d.toasts).toHaveLength(1); // once per change
});
