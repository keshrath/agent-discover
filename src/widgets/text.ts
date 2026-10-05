// =============================================================================
// Markdown text of every meta tool result, for hosts that do not render MCP
// Apps (Claude Code, Cursor, Codex, ...) and for the model. Pure functions over
// the structuredContent contract in types.ts.
// =============================================================================

import type { InstallPlan, Outputs, ServerStatusRow } from './types.js';

const DESC_MAX = 90;
const LIST_MAX = 20;

/** Flatten, cut and escape untrusted text for one markdown table cell or inline span. */
export function cell(s: string | undefined, max = DESC_MAX): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
  return cut.replace(/[\\|`*_[\]<>]/g, (c) => `\\${c}`);
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function table(head: string[], rows: string[][]): string {
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function names(list: string[]): string {
  const shown = list.slice(0, LIST_MAX).map(code).join(', ');
  return list.length > LIST_MAX ? `${shown}, +${list.length - LIST_MAX} more` : shown;
}

/** One word for a server's state, most significant first. */
export function serverState(s: Pick<ServerStatusRow, 'quarantined' | 'connected' | 'enabled'>) {
  return s.quarantined
    ? 'QUARANTINED'
    : s.connected
      ? 'connected'
      : s.enabled
        ? 'enabled'
        : 'installed';
}

export function searchServersText(r: Outputs['search_servers']): string {
  const total = r.installed.length + r.marketplace.length;
  const lines: string[] = [];
  if (!total) lines.push(`No servers found for "${cell(r.query)}". Try broader terms.`);
  else {
    lines.push(
      `**${plural(total, 'server')}** for "${cell(r.query)}" (${r.installed.length} installed, ${r.marketplace.length} in registries)`,
      '',
      table(
        ['Server', 'State', 'Tools / package', 'Description'],
        [
          ...r.installed.map((s) => [
            code(s.name),
            s.enabled ? 'enabled' : 'installed',
            String(s.tool_count),
            cell(s.description),
          ]),
          ...r.marketplace.map((s) => {
            const p = s.packages[0];
            return [
              code(s.name),
              'available',
              p
                ? `${p.registry_type} ${code(p.version ? `${p.identifier}@${p.version}` : p.identifier)}`
                : s.remotes[0]
                  ? `remote ${code(s.remotes[0].url)}`
                  : '',
              cell(s.description),
            ];
          }),
        ],
      ),
    );
    const next = [
      r.installed.some((s) => !s.enabled) && '`enable_server` exposes an installed server',
      r.marketplace.length &&
        '`install_server` with `server` (exact name) installs an available one; the user confirms the command',
    ].filter(Boolean);
    if (next.length) lines.push('', `Next: ${next.join('; ')}.`);
  }
  for (const [source, error] of Object.entries(r.marketplace_errors ?? {}))
    lines.push('', `${source} search failed: ${cell(error, 200)}`);
  return lines.join('\n');
}

export function searchToolsText(r: Outputs['search_tools']): string {
  const lines: string[] = [];
  const hidden = new Set<string>();
  for (const { query, matches } of r.results) {
    if (lines.length) lines.push('');
    if (!matches.length) {
      lines.push(`No tools for "${cell(query)}".`);
      continue;
    }
    lines.push(
      `**${plural(matches.length, 'tool')}** for "${cell(query)}"`,
      '',
      table(
        ['Tool', 'Score', 'Required args', 'Description'],
        matches.map((m) => {
          if (!m.exposed) hidden.add(m.server);
          return [
            code(m.exposed ? m.name : `${m.server} / ${m.tool}`),
            m.score.toFixed(2),
            m.required_args.map((a) => code(a.name)).join(', ') +
              (m.optional_count ? ` (+${m.optional_count} optional)` : ''),
            cell(m.title ? `${m.title}: ${m.description}` : m.description),
          ];
        }),
      ),
    );
  }
  if (hidden.size)
    lines.push(
      '',
      `Not exposed: ${names([...hidden])}. Use \`call_tool\` {server, tool, arguments}, or \`enable_server\` first.`,
    );
  if (r.results.every((x) => !x.matches.length))
    lines.push('', 'Try `search_servers` to find a server that provides this capability.');
  return lines.join('\n');
}

export function serverStatusText(r: Outputs['server_status']): string {
  const s = r.servers;
  const count = (f: (x: ServerStatusRow) => boolean) => s.filter(f).length;
  const quarantined = count((x) => x.quarantined);
  const lines = [
    `**agent-discover** (${r.mode} mode): ${count((x) => x.enabled)} of ${s.length} installed servers enabled, ${count((x) => x.connected)} connected${quarantined ? `, ${quarantined} quarantined` : ''}`,
  ];
  if (!s.length)
    lines.push('', 'Nothing installed yet. `search_servers` finds servers to install.');
  else
    lines.push(
      '',
      table(
        ['Server', 'State', 'Health', 'Tools', 'Notes'],
        s.map((x) => [
          code(x.name),
          serverState(x),
          x.health
            ? `${x.health.status} ${x.health.latency_ms}ms${x.health.error ? `: ${cell(x.health.error, 60)}` : ''}`
            : x.health_status,
          String(x.tool_count),
          [!x.indexed && 'not indexed', x.error_count && plural(x.error_count, 'error')]
            .filter(Boolean)
            .join(', '),
        ]),
      ),
    );
  if (quarantined)
    lines.push(
      '',
      'Quarantined servers changed their tools since approval: `enable_server` asks the user to review and approve, or they do it in Claude Code with `/discover`.',
    );
  return lines.join('\n');
}

export function enableServerText(r: Outputs['enable_server']): string {
  if (r.quarantined)
    return `${code(r.name)} stays quarantined: the changed tools were not approved, so they stay hidden and cannot be called.`;
  return `Enabled ${code(r.name)}: ${plural(r.tool_count, 'tool')}${r.tools.length ? ` (${names(r.tools)})` : ''}.`;
}

export function disableServerText(r: Outputs['disable_server']): string {
  return `Disabled ${code(r.name)}. It stays installed; its tools stay searchable and callable via \`call_tool\`.`;
}

const MARK = { ok: '✓', warn: '!', info: '·' } as const;

/** Control characters made visible, so nothing in a command can hide on a new line. */
const visible = (s: string) =>
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  s.replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

/** Shell-like rendering that keeps every argument boundary visible. */
export function commandLine(command: string, args: string[] = []): string {
  return [command, ...args]
    .map((a) => (/[\s"'`$]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a))
    .map(visible)
    .join(' ');
}

/**
 * The consent text: plain lines that read the same in an elicitation dialog
 * and in a markdown result. Values of env vars and headers are never shown.
 */
export function installPlanText(p: InstallPlan): string {
  const lines = [`Install MCP server "${p.name}"?`];
  if (p.command) lines.push(`Runs on this machine: ${commandLine(p.command, p.args)}`);
  if (p.url) lines.push(`Connects to: ${p.url} (${p.transport})`);
  if (p.env_keys?.length) lines.push(`Env vars: ${p.env_keys.join(', ')}`);
  if (p.header_keys?.length) lines.push(`Headers: ${p.header_keys.join(', ')}`);
  for (const f of p.provenance ?? [])
    lines.push(`${MARK[f.level] ?? '·'} ${f.label}${f.detail ? ` (${f.detail})` : ''}`);
  lines.push('The server is started now to index its tools.');
  return lines.join('\n');
}

export function installServerText(r: Outputs['install_server']): string {
  switch (r.status) {
    case 'installed':
      return [
        `Installed ${code(r.name)}: ${plural(r.tool_count, 'tool')} indexed${r.enabled ? ' and exposed' : ''}${r.tools.length ? ` (${names(r.tools)})` : ''}.`,
        r.index_error ? `Indexing failed: ${cell(r.index_error, 300)}` : '',
        r.enabled ? '' : 'Call `enable_server` to expose its tools, or `call_tool` them directly.',
      ]
        .filter(Boolean)
        .join('\n');
    case 'already_installed':
      return `${code(r.name)} is already installed (${plural(r.tool_count, 'tool')}, ${r.enabled ? 'enabled' : 'not enabled'}).`;
    case 'declined':
      return `The user declined installing ${code(r.name)}. Nothing was installed; do not retry without asking.`;
    case 'consent_required':
      return [
        `Not installed: this client cannot show the confirmation prompt that install_server needs.`,
        ...(r.plan ? ['', '```', installPlanText(r.plan), '```'] : []),
        '',
        `In Claude Code the user can install it with \`/discover ${r.plan?.package ?? r.name}\`; elsewhere an operator can set AGENT_DISCOVER_ALLOW_UNCONFIRMED_INSTALL=1.`,
      ].join('\n');
  }
}

export function getToolText(r: Outputs['get_tool']): string {
  if (!r.found)
    return `No indexed tool ${code(`${r.server} / ${r.tool}`)}. \`search_tools\` lists what exists.`;
  if (r.quarantined)
    return `${code(r.server)} is quarantined: its tools changed since approval, so the definition of ${code(r.tool)} is withheld. The user re-approves with \`enable_server\` or in Claude Code with \`/discover\`.`;
  const how = r.exposed
    ? `Call it directly as ${code(r.name ?? r.tool)}.`
    : `Call it with \`call_tool\` {server: "${r.server}", tool: "${r.tool}", arguments}.`;
  return [
    `**${code(r.name ?? `${r.server}__${r.tool}`)}**${r.title ? ` (${cell(r.title, 60)})` : ''} on ${code(r.server)} (${r.enabled ? 'enabled' : 'not enabled'}). ${how}`,
    r.description ? `\n${r.description.trim()}` : '',
    '',
    'Input schema:',
    '```json',
    JSON.stringify(r.input_schema ?? {}, null, 1),
    '```',
    ...(r.output_schema
      ? ['Output schema:', '```json', JSON.stringify(r.output_schema, null, 1), '```']
      : []),
  ].join('\n');
}

/** Text block for a meta tool's structuredContent. */
export function resultText<K extends keyof Outputs>(tool: K, sc: Outputs[K]): string {
  const r = sc as never;
  switch (tool) {
    case 'search_servers':
      return searchServersText(r);
    case 'search_tools':
      return searchToolsText(r);
    case 'server_status':
      return serverStatusText(r);
    case 'enable_server':
      return enableServerText(r);
    case 'disable_server':
      return disableServerText(r);
    case 'install_server':
      return installServerText(r);
    case 'get_tool':
      return getToolText(r);
  }
  return JSON.stringify(sc);
}
