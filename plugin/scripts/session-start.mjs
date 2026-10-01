#!/usr/bin/env node
/* global process, URL */
// SessionStart: one quiet context line about what is enabled, plus a visible
// notice only when servers need the user. Silent when the daemon is not up yet
// (the MCP shim starts it on demand).
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attention, base, readStatus } from './status.mjs';

// Keep the status line segment at a path that survives plugin updates.
const data = process.env.CLAUDE_PLUGIN_DATA;
if (data) {
  for (const f of ['statusline.mjs', 'status.mjs']) {
    const src = fileURLToPath(new URL(`./${f}`, import.meta.url));
    const dst = join(data, f);
    try {
      let same = false;
      try {
        same = readFileSync(dst, 'utf8') === readFileSync(src, 'utf8');
      } catch {
        /* not copied yet */
      }
      if (!same) copyFileSync(src, dst);
    } catch {
      /* best effort: the status line is optional */
    }
  }
}

const st = await readStatus(800);
if (!st) process.exit(0);

const on = st.servers.filter((s) => s.enabled).map((s) => s.name);
const shown = on.slice(0, 8).join(', ') + (on.length > 8 ? `, +${on.length - 8}` : '');
const context =
  `agent-discover: ${on.length} of ${st.servers.length} installed MCP servers enabled${on.length ? ` (${shown})` : ''}. ` +
  'When a task needs a capability you do not have, call search_tools (or search_servers for uninstalled ones) before saying it is unavailable.';

const attn = attention(st.servers);
const quarantined = attn.filter((s) => s.quarantined).length;
const issues = [
  quarantined && `${quarantined} quarantined`,
  attn.length - quarantined && `${attn.length - quarantined} unhealthy`,
].filter(Boolean);
const out = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } };
if (issues.length) out.systemMessage = `agent-discover: ${issues.join(', ')} - ${base}/#/servers`;
process.stdout.write(JSON.stringify(out));
