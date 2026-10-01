// =============================================================================
// Daemon + stdio shim end-to-end (built dist/): two hosts share one daemon,
// the shim survives a daemon restart, and the daemon idle-exits.
// =============================================================================

import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { FIXTURE, startTestDaemon, waitFor } from './helpers.js';

const BIN = resolve(__dirname, '..', 'dist', 'index.js');

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
}

function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!existsSync(BIN))('stdio shim → shared daemon', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-discover-shim-'));
  let port = 0;
  const clients: Client[] = [];

  const env = () => ({
    ...(process.env as Record<string, string>),
    AGENT_DISCOVER_PORT: String(port),
    AGENT_DISCOVER_DB: join(dir, 'shim.db'),
    AGENT_DISCOVER_ALLOW_UNCONFIRMED_INSTALL: '1',
    AGENT_DISCOVER_SETUP_FILE: '',
  });

  async function shimClient(onToolsChanged?: () => void): Promise<Client> {
    const c = new Client(
      { name: 'shim-test', version: '1' },
      onToolsChanged
        ? {
            listChanged: {
              tools: { autoRefresh: false, debounceMs: 0, onChanged: onToolsChanged },
            },
          }
        : {},
    );
    await c.connect(
      new StdioClientTransport({ command: process.execPath, args: [BIN], env: env() }),
    );
    clients.push(c);
    return c;
  }

  async function daemonPid(): Promise<number | null> {
    try {
      return (
        (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { pid: number }
      ).pid;
    } catch {
      return null;
    }
  }

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    const pid = await daemonPid();
    if (pid) process.kill(pid);
    await waitFor(() => !isAlive(pid), 10_000).catch(() => {});
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch {
      // Windows: a hard-killed daemon's orphaned upstream child can briefly pin the temp dir.
    }
  });

  it('spawns one daemon that both hosts share, with list_changed fan-out', async () => {
    port = await freePort();
    let changes = 0;
    const a = await shimClient();
    const b = await shimClient(() => changes++);
    const pid = await daemonPid();
    expect(pid).toBeGreaterThan(0);

    const installed = (await a.callTool({
      name: 'install_server',
      arguments: { name: 'up', command: process.execPath, args: [FIXTURE], enable: true },
    })) as CallToolResult;
    expect(installed.structuredContent).toMatchObject({ status: 'installed', enabled: true });

    await waitFor(() => changes > 0, 10_000);
    expect((await b.listTools()).tools.map((t) => t.name)).toContain('up__echo');
    const res = (await b.callTool({
      name: 'up__echo',
      arguments: { text: 'shared' },
    })) as CallToolResult;
    expect(res.content).toEqual([{ type: 'text', text: 'shared' }]);
    expect(await daemonPid()).toBe(pid); // still one daemon
  }, 60_000);

  it('re-spawns the daemon and replays the handshake after it dies', async () => {
    const a = clients[0];
    const pid = (await daemonPid())!;
    process.kill(pid);
    await new Promise((r) => setTimeout(r, 500));
    const status = (await a.callTool({ name: 'server_status', arguments: {} })) as CallToolResult;
    expect((status.structuredContent as { servers: Array<{ name: string }> }).servers[0].name).toBe(
      'up',
    );
    expect(await daemonPid()).not.toBe(pid);
  }, 60_000);
});

describe('idle exit', () => {
  it('fires with no MCP streams and no WS clients', async () => {
    let fired = false;
    const d = await startTestDaemon({ idleMs: 300 }, { onIdle: () => (fired = true) });
    try {
      await waitFor(() => fired, 5_000);
    } finally {
      await d.stop();
    }
  });
});
