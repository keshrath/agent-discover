// =============================================================================
// agent-discover — stdio shim (default bin)
//
// Lets stdio-only hosts use the shared daemon: ensure the daemon is running
// (health probe → lockfile-guarded detached spawn → readiness wait), then
// relay JSON-RPC messages verbatim between stdin/stdout and /mcp. Works for
// both protocol eras: 2026 requests carry their own envelope; 2025 sessions
// get the session id + protocol-version headers from the HTTP transport.
//
// If the daemon goes away (idle exit, crash) the next message re-ensures it
// and, for a 2025 session, replays the cached initialize handshake so the
// host never notices.
// =============================================================================

import { spawn } from 'node:child_process';
import { closeSync, openSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPClientTransport, isInitializeRequest } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/server';
import type { Config } from './config.js';

const READY_TIMEOUT_MS = 20_000;
const STALE_LOCK_MS = 30_000;
const REPLAY_ID_PREFIX = '__agent_discover_shim_';

function baseUrl(config: Config): string {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
}

async function isHealthy(config: Config): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl(config)}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return res.ok && ((await res.json()) as { status?: string }).status === 'ok';
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Make sure a daemon answers on the configured port, spawning one if needed. */
export async function ensureDaemon(config: Config): Promise<void> {
  if (await isHealthy(config)) return;
  const lock = join(tmpdir(), `agent-discover-${config.port}.lock`);
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
    if (owner) {
      const log = openSync(join(tmpdir(), `agent-discover-${config.port}.log`), 'a');
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
      if (await isHealthy(config)) return;
      await sleep(150);
    }
    throw new Error(
      `agent-discover daemon did not become ready on ${baseUrl(config)} (see ${join(tmpdir(), `agent-discover-${config.port}.log`)})`,
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

  /** Re-establish the daemon and (2025 sessions) replay the handshake. */
  async function reconnect(replay: boolean): Promise<void> {
    await http.close().catch(() => {});
    await ensureDaemon(config);
    http = connectHttp();
    if (!replay || !initRequest) return;
    await http.send({ ...initRequest, id: `${REPLAY_ID_PREFIX}${++replaySeq}` });
    if (protocolVersion) http.setProtocolVersion(protocolVersion);
    await http.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async function forward(msg: JSONRPCMessage): Promise<void> {
    if (isInitializeRequest(msg)) initRequest = msg as JSONRPCRequest;
    try {
      await http.send(msg);
    } catch {
      try {
        await reconnect(!isInitializeRequest(msg));
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
