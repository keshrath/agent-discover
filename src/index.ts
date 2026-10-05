#!/usr/bin/env node

// =============================================================================
// agent-discover — CLI entry
//
//   agent-discover          stdio shim: ensures the daemon, bridges stdio ⇄ /mcp
//   agent-discover daemon   the daemon itself (REST + /mcp)
// =============================================================================

import { loadConfig } from './config.js';
import { startDaemon } from './daemon.js';
import { runShim } from './shim.js';

async function daemonMain(): Promise<void> {
  try {
    const daemon = await startDaemon();
    process.stderr.write(
      `agent-discover daemon: http://${daemon.ctx.config.host}:${daemon.port} (mcp: /mcp, pid ${process.pid})\n`,
    );
    const stop = () => void daemon.close().finally(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      process.stderr.write(`agent-discover: port ${loadConfig().port} already in use\n`);
      process.exit(0);
    }
    throw err;
  }
}

const main = process.argv[2] === 'daemon' ? daemonMain() : runShim(loadConfig());
main.catch((err: unknown) => {
  process.stderr.write(`agent-discover: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
