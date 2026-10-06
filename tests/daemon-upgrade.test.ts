// =============================================================================
// Daemon upgrade: a shim replaces an older running daemon (via the token-guarded
// POST /api/shutdown), keeps an equal/newer one, and warns about one that predates
// the endpoint. Daemons and shims run from built dist/ on scratch ports and dirs.
// =============================================================================

import { describe, it, expect, afterAll, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { ensureDaemon, isOlder } from '../src/shim.js';
import type { Config } from '../src/config.js';
import { version } from '../src/version.js';
import { freePort, isAlive, killTree, startTestDaemon, waitFor } from './helpers.js';

const BIN = resolve(__dirname, '..', 'dist', 'index.js');

describe('isOlder', () => {
  it('compares numeric major.minor.patch', () => {
    expect(isOlder('3.0.1', '3.1.0')).toBe(true);
    expect(isOlder('3.1.0', '3.1.0')).toBe(false);
    expect(isOlder('3.1.1', '3.1.0')).toBe(false);
    expect(isOlder('2.9.9', '10.0.0')).toBe(true);
    expect(isOlder('3.1.0-rc.1', '3.1.0')).toBe(false);
  });
});

describe('POST /api/shutdown', () => {
  it('needs the token, then answers 202, audits and exits like an idle exit', async () => {
    let exited = false;
    const d = await startTestDaemon({}, { onIdle: () => (exited = true) });
    try {
      const bare = await fetch(`${d.base}/api/shutdown`, { method: 'POST' });
      expect(bare.status).toBe(403);
      expect(exited).toBe(false);

      const res = await fetch(`${d.base}/api/shutdown`, {
        method: 'POST',
        headers: { 'x-agent-discover-token': d.restToken },
      });
      expect(res.status).toBe(202);
      await waitFor(() => exited);
      expect(d.ctx.trust.audit.list({ action: 'shutdown' }).total).toBe(1);
    } finally {
      await d.stop();
    }
  });
});

describe('legacy daemon without /api/shutdown', () => {
  let stub: Server | undefined;
  afterAll(() => void stub?.close());

  it('is kept, with one stderr line naming its pid', async () => {
    const port = await freePort();
    const hits: string[] = [];
    stub = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/health') {
        res.end(JSON.stringify({ status: 'ok', version: '3.0.1', pid: 424242 }));
      } else if (req.url === '/api/token') {
        res.end(JSON.stringify({ token: 't', header: 'x-agent-discover-token' }));
      } else {
        res.writeHead(404).end('{"error":"Not found"}');
      }
    }).listen(port, '127.0.0.1');
    await new Promise((r) => stub!.once('listening', r));
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const config = { host: '127.0.0.1', port } as Config;
      await ensureDaemon(config);
      await ensureDaemon(config);
      const warnings = write.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => /pid 424242/.test(l));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('3.0.1');
    } finally {
      write.mockRestore();
    }
    expect(hits).toContain('POST /api/shutdown');
  });
});

describe.skipIf(!existsSync(BIN))('shim vs running daemon (built dist/)', () => {
  const dirs: string[] = [];
  const clients: Client[] = [];
  const pids = new Set<number>();
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    pids.forEach((p) => killTree(p));
    await new Promise((r) => setTimeout(r, 500));
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  });

  async function scratch() {
    const dir = mkdtempSync(join(tmpdir(), 'agent-discover-upgrade-'));
    dirs.push(dir);
    const port = await freePort();
    const env = (fake?: string) => ({
      ...(process.env as Record<string, string>),
      AGENT_DISCOVER_PORT: String(port),
      AGENT_DISCOVER_DB: join(dir, 'u.db'),
      AGENT_DISCOVER_SETUP_FILE: '',
      ...(fake ? { AGENT_DISCOVER_FAKE_VERSION: fake } : {}),
    });
    const health = async () => {
      try {
        return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as {
          version: string;
          pid: number;
        };
      } catch {
        return null;
      }
    };
    const track = async () => {
      const h = await health();
      if (h) pids.add(h.pid);
      return h;
    };
    const startDaemon = async (fake: string) => {
      spawn(process.execPath, [BIN, 'daemon'], {
        env: env(fake),
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      }).unref();
      let h = null;
      for (let i = 0; i < 200 && !h; i++) {
        h = await track();
        if (!h) await new Promise((r) => setTimeout(r, 100));
      }
      return h!;
    };
    const shim = async (fake?: string) => {
      const c = new Client({ name: 'upgrade-test', version: '1' }, {});
      await c.connect(
        new StdioClientTransport({ command: process.execPath, args: [BIN], env: env(fake) }),
      );
      clients.push(c);
      return c;
    };
    return { startDaemon, shim, health, track };
  }

  it('replaces an older daemon', async () => {
    const s = await scratch();
    const old = await s.startDaemon('3.0.1');
    expect(old.version).toBe('3.0.1');
    await s.shim();
    const now = (await s.track())!;
    expect(now.version).toBe(version);
    expect(now.pid).not.toBe(old.pid);
    await waitFor(() => !isAlive(old.pid), 5_000);
  }, 60_000);

  it('keeps an equal or newer daemon', async () => {
    for (const v of [version, '99.0.0']) {
      const s = await scratch();
      const d = await s.startDaemon(v);
      await s.shim();
      expect((await s.health())!.pid).toBe(d.pid);
    }
  }, 60_000);

  it('two racing shims end on one new daemon; a connected old shim follows it', async () => {
    const s = await scratch();
    const oldShim = await s.shim('3.0.1'); // spawns a 3.0.1 daemon
    const old = (await s.track())!;
    expect(old.version).toBe('3.0.1');

    const [a, b] = await Promise.all([s.shim(), s.shim()]);
    const now = (await s.track())!;
    expect(now.version).toBe(version);
    expect(now.pid).not.toBe(old.pid);
    await new Promise((r) => setTimeout(r, 1_000));
    expect((await s.health())!.pid).toBe(now.pid); // nobody replaced it again

    for (const c of [a, b, oldShim]) {
      const res = (await c.callTool({ name: 'server_status', arguments: {} })) as CallToolResult;
      expect(res.isError).toBeFalsy();
    }
    expect((await s.health())!.pid).toBe(now.pid);
  }, 90_000);
});
