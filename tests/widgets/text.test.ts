import { describe, expect, it } from 'vitest';
import {
  cell,
  commandLine,
  enableServerText,
  getToolText,
  installPlanText,
  installServerText,
  searchServersText,
  searchToolsText,
  serverStatusText,
} from '../../src/widgets/text.js';
import type { Outputs, ServerStatusRow } from '../../src/widgets/types.js';

const row = (over: Partial<ServerStatusRow>): ServerStatusRow => ({
  name: 'pg',
  description: '',
  source: 'manual',
  transport: 'stdio',
  enabled: false,
  quarantined: false,
  indexed: true,
  indexed_at: '2026-10-01 10:00:00',
  connected: false,
  tool_count: 3,
  health_status: 'unknown',
  last_health_check: null,
  error_count: 0,
  ...over,
});

describe('markdown escaping', () => {
  it('keeps untrusted text inside its table cell', () => {
    expect(cell('a | b <img src=x> `c` [l](u)\n*x*')).toBe(
      'a \\| b \\<img src=x\\> \\`c\\` \\[l\\](u) \\*x\\*',
    );
    expect(cell('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('shows argument boundaries and control characters in commands', () => {
    expect(commandLine('C:\\Program Files\\node.exe', ['a b', '', 'ok', 'x\ny'])).toBe(
      '"C:\\Program Files\\node.exe" "a b" "" ok "x\\x0ay"',
    );
  });
});

describe('renderers', () => {
  it('search_servers: one table for installed and registry servers, browse link', () => {
    const text = searchServersText({
      query: 'pg',
      installed: [{ name: 'pg', description: 'Postgres | SQL', enabled: false, tool_count: 4 }],
      marketplace: [
        {
          source: 'npm',
          name: '@neon/mcp',
          description: 'Neon',
          version: '1.0.0',
          status: 'active',
          repository: null,
          packages: [
            {
              registry_type: 'npm',
              identifier: '@neon/mcp',
              version: '1.0.0',
              transport: 'stdio',
            },
          ],
          remotes: [],
        },
      ],
      marketplace_errors: { npm: 'timeout' },
    });
    expect(text).toContain('| `pg` | installed | 4 | Postgres \\| SQL |');
    expect(text).toContain('| `@neon/mcp` | available | npm `@neon/mcp@1.0.0` | Neon |');
    expect(text).toContain('npm search failed: timeout');
    expect(text).not.toContain('http');
  });

  it('search_tools: per-query tables and a hint for servers that are not exposed', () => {
    const text = searchToolsText({
      results: [
        {
          query: 'run sql',
          matches: [
            {
              server: 'pg',
              tool: 'query',
              name: 'pg__query',
              description: 'Run SQL',
              score: 0.91,
              enabled: false,
              exposed: false,
              required_args: [{ name: 'sql', type: 'string' }],
              optional_count: 1,
            },
          ],
        },
        { query: 'nothing', matches: [] },
      ],
    });
    expect(text).toContain('| `pg / query` | 0.91 | `sql` (+1 optional) | Run SQL |');
    expect(text).toContain('No tools for "nothing".');
    expect(text).toContain('Not exposed: `pg`.');
  });

  it('server_status: state words and where to review a quarantined server', () => {
    const text = serverStatusText({
      mode: 'native',
      servers: [
        row({ name: 'a/b', quarantined: true, enabled: true }),
        row({ name: 'c', enabled: true, connected: true, health_status: 'healthy' }),
      ],
    });
    expect(text).toMatch(/2 of 2 installed servers enabled, 1 connected, 1 quarantined/);
    expect(text).toContain('| `a/b` | QUARANTINED |');
    expect(text).toContain('| `c` | connected | healthy | 3 |');
    expect(text).toMatch(/`enable_server` asks the user to review.*`\/discover`/);
  });

  it('install plan: exact command, keys never values, provenance marks', () => {
    const text = installPlanText({
      name: 'w',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@x/w'],
      package: '@x/w',
      env_keys: ['TOKEN'],
      header_keys: [],
      provenance: [{ label: 'Unpinned version', level: 'warn', detail: 'latest' }],
    });
    expect(text.split('\n')).toEqual([
      'Install MCP server "w"?',
      'Runs on this machine: npx -y @x/w',
      'Env vars: TOKEN',
      '! Unpinned version (latest)',
      'The server is started now to index its tools.',
    ]);
  });

  it('install outcomes tell the model what to do next', () => {
    const base: Outputs['install_server'] = {
      name: 'w',
      status: 'declined',
      enabled: false,
      tool_count: 0,
      tools: [],
    };
    expect(installServerText(base)).toMatch(/declined.*do not retry/);
    expect(installServerText({ ...base, status: 'consent_required' })).toMatch(
      /`\/discover w`.*AGENT_DISCOVER_ALLOW_UNCONFIRMED_INSTALL=1/,
    );
    expect(
      installServerText({ ...base, status: 'installed', tool_count: 2, tools: ['a', 'b'] }),
    ).toMatch(/Installed `w`: 2 tools indexed \(`a`, `b`\)\.\nCall `enable_server`/);
  });

  it('get_tool: full input schema for the model', () => {
    const text = getToolText({
      found: true,
      server: 'pg',
      tool: 'query',
      name: 'pg__query',
      description: 'Run SQL',
      input_schema: { type: 'object', properties: { sql: { type: 'string' } } },
      enabled: true,
      exposed: true,
    });
    expect(text).toContain('Call it directly as `pg__query`.');
    expect(text).toContain('"sql": {');
    expect(getToolText({ found: false, server: 'pg', tool: 'x' })).toMatch(/No indexed tool/);
  });

  it('quarantined servers: no "enabled" claim, no call hint', () => {
    const declined = enableServerText({
      name: 'fx',
      enabled: true,
      quarantined: true,
      tool_count: 0,
      tools: [],
    });
    expect(declined).toMatch(/^`fx` stays quarantined/);
    expect(declined).not.toMatch(/Enabled/);
    const withheld = getToolText({ found: true, server: 'fx', tool: 'echo', quarantined: true });
    expect(withheld).toMatch(/quarantined/);
    expect(withheld).not.toMatch(/call_tool|Input schema/);
  });
});
