// Claude Code plugin scripts against a real daemon's GET /api/status.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { installFixture, startTestDaemon, type TestDaemon } from '../helpers.js';

const run = promisify(execFile);
const SCRIPTS = join(import.meta.dirname, '..', '..', 'plugin', 'scripts');
let d: TestDaemon;

async function script(name: string, env: Record<string, string>, args: string[] = []) {
  const { stdout } = await run(process.execPath, [join(SCRIPTS, name), ...args], {
    env: { ...process.env, NO_COLOR: '', ...env },
  });
  return stdout;
}

beforeAll(async () => {
  d = await startTestDaemon();
  await installFixture(d, 'alpha');
  await installFixture(d, 'beta');
  await installFixture(d, 'gamma');
  await d.ctx.lifecycle.enable('alpha');
  d.ctx.servers.setQuarantined(d.ctx.servers.get('gamma')!.id, true);
}, 60_000);
afterAll(() => d?.stop());

const port = () => String(d.port);

describe('GET /api/status', () => {
  it('has the server_status shape and answers without upstream calls', async () => {
    const t = Date.now();
    const st = await (await fetch(`${d.base}/api/status`)).json();
    expect(Date.now() - t).toBeLessThan(500);
    expect(st.mode).toBe('native');
    expect(st.servers.map((s: { name: string }) => s.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(st.servers[0]).toMatchObject({ enabled: true, quarantined: false, indexed: true });
  });
});

describe('session-start hook', () => {
  it('adds one context line and a visible notice only for attention items', async () => {
    const data = mkdtempSync(join(tmpdir(), 'ad-plugin-'));
    onTestFinished(() => rmSync(data, { recursive: true, force: true }));
    const out = JSON.parse(
      await script('session-start.mjs', { AGENT_DISCOVER_PORT: port(), CLAUDE_PLUGIN_DATA: data }),
    );
    expect(out.hookSpecificOutput.additionalContext).toMatch(
      /^agent-discover: 1 of 3 installed MCP servers enabled \(alpha\)\./,
    );
    expect(out.hookSpecificOutput.additionalContext).toContain('search_tools');
    expect(out.systemMessage).toBe('agent-discover: 1 quarantined - /discover to review');
    for (const f of ['statusline.mjs', 'status.mjs'])
      expect(readFileSync(join(data, f), 'utf8')).toBe(readFileSync(join(SCRIPTS, f), 'utf8'));
    const copied = await run(process.execPath, [join(data, 'statusline.mjs'), '--plain'], {
      env: { ...process.env, AGENT_DISCOVER_PORT: port() },
    });
    expect(copied.stdout).toBe('MCP 1/3 !1');
  });

  it('is silent when the daemon is down', async () => {
    expect(await script('session-start.mjs', { AGENT_DISCOVER_PORT: '1' })).toBe('');
  });
});

describe('statusline segment', () => {
  it('prints a colored count, or plain text with --plain', async () => {
    const fancy = await script('statusline.mjs', { AGENT_DISCOVER_PORT: port() });
    expect(fancy).toContain('\u001b[36mMCP 1/3');
    expect(fancy).not.toContain('\u001b]8;;');
    expect(await script('statusline.mjs', { AGENT_DISCOVER_PORT: port() }, ['--plain'])).toBe(
      'MCP 1/3 !1',
    );
  });

  it('prints nothing when the daemon is down', async () => {
    expect(await script('statusline.mjs', { AGENT_DISCOVER_PORT: '1' }, ['--plain'])).toBe('');
  });
});
