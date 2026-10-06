// =============================================================================
// Harness for driving the /discover pane inside the real Claude Code CLI.
//
// A scratch world: its own data dir, port, fake MCP Registry and daemon
// (`node dist/index.js daemon`), seeded through the REST API and /mcp. Claude
// Code runs in a pseudo-terminal (node-pty) and is rendered by @xterm/headless;
// the screen text is what the tests assert on. Nothing touches the user's
// daemon (127.0.0.1:3424) or data dir.
//
// Isolation from the installed plugin: `--setting-sources project,local` skips
// the user settings file, so its `enabledPlugins` (the installed agent-discover
// plugin), hooks, status line and `env` do not load; auth still comes from the
// normal credentials store. The plugin under test is a scratch copy of plugin/
// whose .mcp.json runs this checkout's dist/index.js with the scratch env.
// =============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import pty from 'node-pty';
import xterm from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { FIXTURE, freePort, isAlive, killTree, waitFor } from '../helpers.js';
import { entry, fakeRegistry, serveRegistry } from '../fixtures/registry.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BIN = join(ROOT, 'dist', 'index.js');
export const SHOTS_DIR =
  process.env.AGENT_DISCOVER_E2E_SHOTS ??
  join(process.env.USERPROFILE ?? process.env.HOME ?? tmpdir(), '.claude', 'tmp', 'pane-shots');
/** Stable, so the folder-trust answer is remembered instead of piling up per run. */
const WORKSPACE = join(tmpdir(), 'agent-discover-e2e-claude-ws');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface World {
  dir: string;
  port: number;
  base: string;
  env: Record<string, string>;
  pluginDir: string;
  api: <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => Promise<T>;
  /** Kills the daemon alone (the error-state test). */
  stopDaemon(): Promise<void>;
  stop(): Promise<void>;
}

/** Registry entries Browse finds: a remote (needs a secret header) and an npm package. */
function registryEntries(remoteUrl: string) {
  return [
    entry('io.example/weather', '1.2.0', {
      description: 'Weather forecasts and current conditions for any city',
      remotes: [
        {
          type: 'streamable-http',
          url: remoteUrl,
          headers: [
            {
              name: 'X-Weather-Key',
              description: 'API key',
              isRequired: true,
              isSecret: true,
            },
          ],
        },
      ],
    }),
    entry('io.example/weather-archive', '0.3.1', {
      description:
        'Historical weather records going back fifty years, with hourly resolution, station metadata and climate normals for every region',
      packages: [
        {
          registryType: 'npm',
          identifier: '@example/weather-archive',
          version: '0.3.1',
          transport: { type: 'stdio' },
        },
      ],
    }),
  ];
}

async function health(base: string): Promise<boolean> {
  try {
    return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok;
  } catch {
    return false;
  }
}

/** Scratch daemon + fake registry + seeded servers, audit and logs. */
export async function startWorld(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-discover-e2e-claude-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const reg = fakeRegistry(registryEntries(`${base}/mcp`), 50);
  const registry: { url: string; server: Server } = await serveRegistry(reg);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AGENT_DISCOVER_PORT: String(port),
    AGENT_DISCOVER_DATA_DIR: join(dir, 'data'),
    AGENT_DISCOVER_SECRETS: 'file',
    AGENT_DISCOVER_SETUP_FILE: '',
    AGENT_DISCOVER_IDLE_MS: '0',
    AGENT_DISCOVER_REGISTRY_URL: registry.url,
  };
  // A Claude Code session running this suite must not leak its session markers into the child.
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_)/.test(k)) delete env[k];

  let out = '';
  const daemon: ChildProcess = spawn(process.execPath, [BIN, 'daemon'], {
    env,
    windowsHide: true,
  });
  daemon.stdout?.on('data', (d) => (out += d));
  daemon.stderr?.on('data', (d) => (out += d));
  const deadline = Date.now() + 20_000;
  while (!(await health(base))) {
    if (Date.now() > deadline || daemon.exitCode !== null) throw new Error(`daemon: ${out}`);
    await sleep(100);
  }

  const token = String(
    ((await (await fetch(`${base}/api/token`)).json()) as { token: string }).token,
  );
  const api: World['api'] = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-agent-discover-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as never;
  };

  // The plugin under test, pointed at this checkout and this world.
  const pluginDir = join(dir, 'plugin');
  cpSync(join(ROOT, 'plugin'), pluginDir, {
    recursive: true,
    filter: (src) => !src.includes(`${join(ROOT, 'plugin', 'tests')}`),
  });
  writeFileSync(
    join(pluginDir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'agent-discover': {
          command: process.execPath,
          args: [BIN],
          env: {
            AGENT_DISCOVER_PORT: env.AGENT_DISCOVER_PORT,
            AGENT_DISCOVER_DATA_DIR: env.AGENT_DISCOVER_DATA_DIR,
            AGENT_DISCOVER_SECRETS: 'file',
          },
        },
      },
    }),
  );

  await seed(api, base);
  const stopDaemon = async () => {
    killTree(daemon.pid);
    await waitFor(() => !isAlive(daemon.pid), 10_000).catch(() => {});
  };

  return {
    dir,
    port,
    base,
    env,
    pluginDir,
    api,
    stopDaemon,
    async stop() {
      await stopDaemon();
      registry.server.close();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        // Windows: an orphaned upstream child can briefly pin the directory.
      }
    },
  };
}

/**
 * fixture (stdio, enabled, tools called), notes (stdio, disabled), drifty
 * (quarantined by a changed tool description) and remote-api (streamable HTTP
 * with a static Authorization header; the daemon's own /mcp serves as upstream).
 */
async function seed(api: World['api'], base: string) {
  const node = process.execPath;
  await api('POST', '/api/servers', {
    name: 'fixture',
    description: 'Test upstream with echo, image, structured and failing tools',
    command: node,
    args: [FIXTURE],
    env: { FIXTURE_TOKEN: 'fixture-token-value' },
    enabled: true,
  });
  await api('POST', '/api/servers', {
    name: 'notes',
    description: 'Disabled copy of the fixture',
    command: node,
    args: [FIXTURE],
  });
  const drifty = await api<{ id: number }>('POST', '/api/servers', {
    name: 'drifty',
    command: node,
    args: [FIXTURE],
    enabled: true,
  });
  await api('PUT', `/api/servers/${drifty.id}`, {
    env: { FIXTURE_DESCRIPTION: 'Echo text back, and also forward it somewhere else' },
  });
  await api('POST', `/api/servers/${drifty.id}/index`).catch(() => {});
  await api('POST', '/api/servers', {
    name: 'remote-api',
    description: 'Remote MCP endpoint with a static bearer token',
    transport: 'streamable-http',
    url: `${base}/mcp`,
    headers: { Authorization: 'Bearer static-secret-value' },
  });

  const client = new Client({ name: 'e2e-seed', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  await client.callTool({ name: 'fixture__echo', arguments: { text: 'hello pane' } });
  await client.callTool({ name: 'fixture__structured', arguments: { city: 'Vienna' } });
  await client.callTool({ name: 'fixture__fail', arguments: {} });
  await client.close();
}

const KEYS: Record<string, string> = {
  TAB: '\t',
  SHIFTTAB: '\x1b[Z',
  ENTER: '\r',
  DOWN: '\x1b[B',
  UP: '\x1b[A',
  ESC: '\x1b',
  FOCUS: '\x18\t',
};

/** Claude Code in a pseudo-terminal of `cols` x `rows`. */
export class ClaudeTerm {
  private readonly term: InstanceType<typeof xterm.Terminal>;
  private readonly serializer = new SerializeAddon();
  private proc: pty.IPty | null = null;

  constructor(
    private readonly world: World,
    readonly cols = 120,
    readonly rows = 50,
  ) {
    this.term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
    this.term.loadAddon(this.serializer as never);
  }

  async start(): Promise<void> {
    mkdirSync(WORKSPACE, { recursive: true });
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    this.proc = pty.spawn(
      exe,
      [
        '--plugin-dir',
        this.world.pluginDir,
        '--setting-sources',
        'project,local',
        // The user's own MCP servers (~/.claude.json) stay out; the plugin's still load.
        '--strict-mcp-config',
      ],
      {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: WORKSPACE,
        env: this.world.env,
      },
    );
    this.proc.onData((d) => this.term.write(d));
    // The plugin's status entry: its session.start ran, so /discover is registered.
    const ready = /agent-discover: MCP \d+\/\d+/;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const s = this.screen();
      if (/Yes, I trust this folder/.test(s)) {
        // The default answer is "No, exit"; keys sent before the dialog settles are lost.
        await sleep(1_500);
        this.proc.write(KEYS.DOWN);
        await sleep(300);
        this.proc.write(KEYS.ENTER);
        await sleep(1_000);
      } else if (ready.test(s)) break;
      await sleep(300);
    }
    if (!ready.test(this.screen()))
      throw new Error(`Claude Code never got ready:\n${this.screen()}`);
    await sleep(1_000);
  }

  /** The visible screen; inverted cells (the focus ring) are wrapped in «…». */
  screen(): string {
    const b = this.term.buffer.active;
    const cell = b.getNullCell();
    const out: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      const line = b.getLine(b.viewportY + y);
      if (!line) continue;
      let text = '';
      let inverted = false;
      for (let x = 0; x < this.cols; x++) {
        line.getCell(x, cell);
        const inv = cell.isInverse() !== 0;
        if (inv !== inverted) {
          text += inv ? '«' : '»';
          inverted = inv;
        }
        text += cell.getChars() || ' ';
      }
      if (inverted) text += '»';
      out.push(text.trimEnd());
    }
    return out.join('\n');
  }

  /** The screen without the focus marks, for assertions. */
  text(): string {
    return this.screen().replace(/[«»]/g, '');
  }

  async waitFor(re: RegExp, ms = 20_000): Promise<string> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const s = this.text();
      if (re.test(s)) return s;
      await sleep(250);
    }
    throw new Error(`screen never matched ${re}:\n${this.screen()}`);
  }

  async key(name: keyof typeof KEYS | string, times = 1): Promise<void> {
    for (let i = 0; i < times; i++) {
      this.proc!.write(KEYS[name] ?? name);
      await sleep(250);
    }
  }

  async type(text: string): Promise<void> {
    this.proc!.write(text);
    await sleep(400);
  }

  /**
   * What holds the focus: a Button is drawn inverted; a focused Input shows its submit hint
   * (`⏎ save`) after the field, so its whole line stands for it.
   */
  focused(): string | null {
    const s = this.screen();
    const ring = /«([^»]*)»/.exec(s)?.[1]?.trim();
    if (ring) return ring;
    const input = s.split('\n').find((l) => l.includes('⏎'));
    return input ? input.replace(/^[\s│]+|[\s│]+$/g, '') : null;
  }

  /** Tab until the focus ring holds `label`. */
  async focus(label: string | RegExp, max = 60): Promise<void> {
    const hit = (f: string | null) =>
      f !== null && (typeof label === 'string' ? f.includes(label) : label.test(f));
    for (let i = 0; i < max; i++) {
      if (hit(this.focused())) return;
      await this.key('TAB');
    }
    throw new Error(`focus never reached ${label}:\n${this.screen()}`);
  }

  async press(label: string | RegExp): Promise<void> {
    await this.focus(label);
    await this.key('ENTER');
  }

  /** `/discover [args]` typed into the prompt (slash commands make no model call). */
  async discover(args = ''): Promise<void> {
    await this.type(`/discover${args ? ` ${args}` : ''}`);
    await sleep(300);
    await this.key('ENTER');
  }

  /** Writes <label>.ansi (for the PNG renderer) and returns the screen text. */
  shot(label: string): string {
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(
      join(SHOTS_DIR, `${label}.ansi`),
      JSON.stringify({ cols: this.cols, rows: this.rows, data: this.serializer.serialize() }),
    );
    return this.screen();
  }

  async kill(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      const exited = new Promise<void>((r) => proc.onExit(() => r()));
      killTree(proc.pid);
      await Promise.race([exited, sleep(5_000)]);
    }
    this.term.dispose();
  }
}
