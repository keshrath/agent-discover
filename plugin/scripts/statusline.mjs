#!/usr/bin/env node
/* global process */
// Status line segment: "MCP <enabled>/<installed>" (+ " !<n>" when servers need
// attention). Prints nothing when the daemon is down.
// Plugins cannot register a status line; compose this into yours (see README):
//   node "<plugin data dir>/statusline.mjs" [--plain]
import { attention, readStatus } from './status.mjs';

const plain = process.argv.includes('--plain') || Boolean(process.env.NO_COLOR);
const st = await readStatus(300);
if (st) {
  const text = `MCP ${st.servers.filter((s) => s.enabled).length}/${st.servers.length}`;
  const attn = attention(st.servers).length;
  if (plain) process.stdout.write(attn ? `${text} !${attn}` : text);
  else
    process.stdout.write(`\u001b[36m${text}\u001b[0m${attn ? ` \u001b[33m!${attn}\u001b[0m` : ''}`);
}
