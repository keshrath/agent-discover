#!/usr/bin/env node
// =============================================================================
// A 2025-only stdio server that exits on any request before `initialize`
// (like servers built on older SDKs), so a server/discover probe kills it.
// Each spawn appends a line to $SPAWN_LOG.
// =============================================================================

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.env.SPAWN_LOG) appendFileSync(process.env.SPAWN_LOG, 'spawn\n');

let initialized = false;
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    initialized = true;
    return send({
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'strict-legacy', version: '1.0.0' },
      },
    });
  }
  if (!initialized) process.exit(1);
  if (msg.method === 'tools/list') {
    return send({
      id: msg.id,
      result: { tools: [{ name: 'hello', inputSchema: { type: 'object' } }] },
    });
  }
  if (msg.method === 'tools/call') {
    return send({ id: msg.id, result: { content: [{ type: 'text', text: 'hi' }] } });
  }
  if (msg.method === 'ping') return send({ id: msg.id, result: {} });
  send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
});
