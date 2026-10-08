// =============================================================================
// agent-discover — stdio shim (default bin)
//
// Lets stdio-only hosts use the shared daemon: ensure the daemon is running
// (health probe, retiring an older daemon → lockfile-guarded detached spawn → readiness wait), then
// relay JSON-RPC messages verbatim between stdin/stdout and /mcp. Works for
// both protocol eras: 2026 requests carry their own envelope; 2025 sessions
// get the session id + protocol-version headers from the HTTP transport.
//
// If the daemon goes away (idle exit, crash) the next message re-ensures it
// and, for a 2025 session, replays the cached initialize handshake so the
// host never notices.
// =============================================================================

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPClientTransport, isInitializeRequest } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/server';
import { stateDir, type Config } from './config.js';
import { version } from './version.js';

const READY_TIMEOUT_MS = 20_000;
const SHUTDOWN_WAIT_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const REPLAY_ID_PREFIX = '__agent_discover_shim_';

function baseUrl(config: Config): string {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
}

interface Health {
  version: string;
  pid: number;
}

async function probe(config: Config): Promise<Health | null> {
  try {
    const res = await fetch(`${baseUrl(config)}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    const h = (await res.json()) as { status?: string; version?: string; pid?: number };
    return res.ok && h.status === 'ok' ? { version: String(h.version), pid: Number(h.pid) } : null;
  } catch {
    return null;
  }
}

/** True when version `a` is lower than `b` (numeric major.minor.patch; pre-release tags ignored). */
export function isOlder(a: string, b: string): boolean {
  const parts = (v: string) =>
    v
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

let warnedLegacy = false;

/**
 * Ask a daemon older than this shim to exit, then wait (bounded) until it is gone.
 * Returns false when it stays: it predates /api/shutdown, or never exits.
 */
async function retireOlderDaemon(config: Config, old: Health): Promise<boolean> {
  const base = baseUrl(config);
  const warn = (why: string) =>
    process.stderr.write(
      `[agent-discover shim] daemon ${old.version} (pid ${old.pid}) is older than ${version} and ${why}; ` +
        `using it anyway. Stop that process to upgrade.
`,
    );
  try {
    const t = (await (
      await fetch(`${base}/api/token`, { signal: AbortSignal.timeout(2_000) })
    ).json()) as { token: string; header: string };
    const res = await fetch(`${base}/api/shutdown`, {
      method: 'POST',
      headers: { [t.header]: t.token },
      signal: AbortSignal.timeout(2_000),
    });
    if (res.status === 404 || res.status === 405) {
      if (!warnedLegacy) warn('does not support /api/shutdown');
      warnedLegacy = true;
      return false;
    }
    // Any other failure means another shim already replaced it; the wait below sees that.
  } catch {
    /* same: the wait below decides */
  }
  const deadline = Date.now() + SHUTDOWN_WAIT_MS;
  while (Date.now() < deadline) {
    const h = await probe(config);
    if (h && !isOlder(h.version, version)) return true; // replaced by another shim
    if (!h && !pidAlive(old.pid)) return true;
    await sleep(100);
  }
  warn('did not shut down');
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Make sure a daemon answers on the configured port, spawning one if needed. */
export async function ensureDaemon(config: Config): Promise<void> {
  const running = await probe(config);
  if (running) {
    if (!isOlder(running.version, version)) return;
    if (!(await retireOlderDaemon(config, running))) return;
  }
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, `daemon-${config.port}.lock`);
  const logFile = join(dir, `daemon-${config.port}.log`);
  let owner = false;
  try {
    closeSync(openSync(lock, 'wx'));
    owner = true;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
        unlinkSync(lock);
        return ensureDaemon(config);
      }
    } catch {
      /* lock vanished between checks — another shim finished; fall through to waiting */
    }
  }
  try {
    if (owner && !(await probe(config))) {
      const log = openSync(logFile, 'a');
      const entry = fileURLToPath(new URL('./index.js', import.meta.url));
      spawn(process.execPath, [entry, 'daemon'], {
        detached: true,
        stdio: ['ignore', log, log],
        env: process.env,
        windowsHide: true,
      }).unref();
      closeSync(log);
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await probe(config)) return;
      await sleep(150);
    }
    throw new Error(
      `agent-discover daemon did not become ready on ${baseUrl(config)} (see ${logFile})`,
    );
  } finally {
    if (owner) {
      try {
        unlinkSync(lock);
      } catch {
        /* already removed */
      }
    }
  }
}

function isRequest(msg: JSONRPCMessage): msg is JSONRPCRequest {
  return 'method' in msg && 'id' in msg && msg.id !== undefined;
}

export async function runShim(config: Config): Promise<void> {
  await ensureDaemon(config);
  const stdio = new StdioServerTransport();
  const url = new URL('/mcp', baseUrl(config));
  let initRequest: JSONRPCRequest | undefined;
  let protocolVersion: string | undefined;
  let replaySeq = 0;
  let http = connectHttp();

  function connectHttp(): StreamableHTTPClientTransport {
    const t = new StreamableHTTPClientTransport(url);
    t.onmessage = (msg) => {
      if ('id' in msg && typeof msg.id === 'string' && msg.id.startsWith(REPLAY_ID_PREFIX)) return;
      if (initRequest && 'result' in msg && msg.id === initRequest.id) {
        const v = (msg.result as { protocolVersion?: unknown }).protocolVersion;
        if (typeof v === 'string') {
          protocolVersion = v;
          t.setProtocolVersion(v);
        }
      }
      void stdio.send(msg);
    };
    t.onerror = (err) => process.stderr.write(`[agent-discover shim] ${err.message}\n`);
    void t.start();
    return t;
  }

  /** Re-establish the daemon and (2025 sessions) replay the handshake; one at a time. */
  let reconnecting: Promise<void> | undefined;
  async function reconnect(replay: boolean): Promise<void> {
    await http.close().catch(() => {});
    await ensureDaemon(config);
    const next = connectHttp();
    if (replay && initRequest) {
      await next.send({ ...initRequest, id: `${REPLAY_ID_PREFIX}${++replaySeq}` });
      if (protocolVersion) next.setProtocolVersion(protocolVersion);
      await next.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }
    http = next;
  }

  async function forward(msg: JSONRPCMessage): Promise<void> {
    if (isInitializeRequest(msg)) initRequest = msg as JSONRPCRequest;
    const sent = http;
    try {
      await sent.send(msg);
    } catch {
      try {
        // Only a send on the current transport reconnects; the rest wait for it.
        if (http === sent) {
          reconnecting ??= reconnect(!isInitializeRequest(msg)).finally(() => {
            reconnecting = undefined;
          });
        }
        await reconnecting;
        await http.send(msg);
      } catch (err) {
        if (isRequest(msg)) {
          await stdio.send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: `agent-discover daemon unavailable: ${String(err)}` },
          });
        }
      }
    }
  }

  stdio.onmessage = (msg) => void forward(msg);
  stdio.onclose = () => {
    void http
      .terminateSession()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  await stdio.start();
}
