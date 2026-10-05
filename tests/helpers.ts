// =============================================================================
// Shared test helpers: temp daemon, SDK clients of both eras, fixture upstream.
// =============================================================================

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startDaemon, type Daemon, type DaemonOptions } from '../src/daemon.js';
import type { Config } from '../src/config.js';

export const FIXTURE = resolve(import.meta.dirname, 'fixtures', 'upstream.mjs').replace(/\\/g, '/');

export interface TestDaemon extends Daemon {
  base: string;
  dir: string;
  stop(): Promise<void>;
}

export async function startTestDaemon(
  config: Partial<Config> = {},
  options: DaemonOptions = {},
): Promise<TestDaemon> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-discover-test-'));
  const daemon = await startDaemon({
    path: join(dir, 'test.db'),
    skipStartupTasks: true,
    ...options,
    config: { port: 0, idleMs: 0, connIdleMs: 0, ...config },
  });
  return Object.assign(daemon, {
    base: `http://127.0.0.1:${daemon.port}`,
    dir,
    async stop() {
      await daemon.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  });
}

export function installFixture(d: Daemon, name = 'up', env: Record<string, string> = {}) {
  return d.ctx.lifecycle.install({ name, command: process.execPath, args: [FIXTURE], env });
}

export interface ClientOptions {
  era: 'modern' | 'legacy';
  elicit?: (message: string) => {
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
  };
  onToolsChanged?: () => void;
  elicitation?: boolean;
}

export async function connectClient(d: TestDaemon, opts: ClientOptions): Promise<Client> {
  const client = new Client(
    { name: `test-${opts.era}`, version: '1.0.0' },
    {
      capabilities: opts.elicitation === false ? {} : { elicitation: { form: {} } },
      ...(opts.era === 'modern' ? { versionNegotiation: { mode: 'auto' as const } } : {}),
      ...(opts.onToolsChanged
        ? {
            listChanged: {
              tools: { autoRefresh: false, debounceMs: 0, onChanged: opts.onToolsChanged },
            },
          }
        : {}),
    },
  );
  if (opts.elicitation !== false) {
    client.setRequestHandler('elicitation/create', async (req) => {
      const answer = opts.elicit?.(req.params.message) ?? {
        action: 'accept',
        content: { confirm: true },
      };
      return answer as never;
    });
  }
  await client.connect(new StreamableHTTPClientTransport(new URL(`${d.base}/mcp`)));
  return client;
}

export async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
