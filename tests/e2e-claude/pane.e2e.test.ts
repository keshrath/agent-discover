// =============================================================================
// The /discover pane in the real Claude Code CLI (AGENT_DISCOVER_E2E_CLAUDE=1,
// `npm run e2e:claude`). Needs a logged-in `claude` on PATH; slash commands make
// no model calls. Every view is asserted on the screen text and captured to
// ~/.claude/tmp/pane-shots/<view>.png (AGENT_DISCOVER_E2E_SHOTS overrides).
// The fullscreen layout (the pane docked as a sidebar) is the one most people
// see; the inline pane above the prompt is covered at 80, 120 and 160 columns.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClaudeTerm, SHOTS_DIR, sleep, startWorld, type World } from './harness.js';
import { renderShots } from './render.js';

const E2E = process.env.AGENT_DISCOVER_E2E_CLAUDE === '1';
const MIN = 60_000;
vi.setConfig({ testTimeout: 2 * MIN });

const id = async (w: World, name: string) =>
  (await w.api<Array<{ id: number; name: string }>>('GET', '/api/servers')).find(
    (s) => s.name === name,
  )!.id;

/**
 * Types `value` into the masked field `label` one key at a time. Each key is drawn
 * until the plugin redraws the field as dots (the Input element has no masked mode),
 * so only the last key typed can ever show; the field itself is matched as dots after each.
 */
async function typeMasked(t: ClaudeTerm, label: string, value: string) {
  for (let i = 0; i < value.length; i++) {
    await t.type(value[i]);
    await t.waitFor(new RegExp(`${label}: •{${i + 1}}\\s+⏎`), 5_000);
    if (i >= 3) expect(t.text()).not.toContain(value.slice(0, i + 1));
  }
}

/** The ring settles where the plugin lands it after a move. */
async function landsOn(t: ClaudeTerm, label: string | RegExp) {
  const deadline = Date.now() + 5_000;
  const hit = () => {
    const f = t.focused();
    return f !== null && (typeof label === 'string' ? f.includes(label) : label.test(f));
  };
  while (Date.now() < deadline && !hit()) await sleep(100);
  expect(t.focused()).toMatch(label);
}

// Scratch state is made in beforeAll: a describe body also runs when the suite is skipped.
describe.skipIf(!E2E)('/discover pane in Claude Code', () => {
  let w: World;
  beforeAll(async () => {
    w = await startWorld();
  }, 2 * MIN);
  afterAll(async () => {
    await w?.stop();
    await renderShots(SHOTS_DIR);
  }, 2 * MIN);

  describe('at 120 columns', () => {
    let t: ClaudeTerm;
    beforeAll(async () => {
      t = new ClaudeTerm(w, 120, 50);
      await t.start();
    }, 2 * MIN);
    afterAll(async () => t?.kill(), MIN);

    it('opens on the servers list, the ring on the first server', async () => {
      await t.discover();
      const s = await t.waitFor(/remote-api\s+installed/);
      expect(s).toMatch(/1: Servers\s+2: Browse\s+3: Logs\s+4: Audit\s+r: Refresh/);
      expect(s).toMatch(/Tab moves · Enter presses · ↑↓ scroll · Esc to the prompt/);
      expect(s).toMatch(/agent-discover · 4 MCP servers · 2 enabled · 1 to review/);
      expect(s).toMatch(/! drifty\s+quarantined/);
      expect(s).toMatch(/9 tools · its tools changed: review them/);
      expect(s).toMatch(/● fixture\s+enabled/);
      expect(s).toMatch(/9 tools · Test upstream with echo/);
      expect(s).toMatch(/17 tools · Remote MCP endpoint with a static bearer token/);
      expect(s).toMatch(/agent-discover: MCP 2\/4 · 1 to review/); // the status entry
      // The mod has no command hooks left, and the band stays out of the open pane's way.
      expect(s).not.toMatch(/SessionStart/);
      expect(s).not.toMatch(/needs a look/);
      await landsOn(t, 'drifty');
      t.shot('servers');
    });

    it('server detail: health checked on open, usage, tools, config keys', async () => {
      await t.press('fixture');
      const s = await t.waitFor(/Health\s+healthy in \d+ ms/);
      expect(s).toMatch(/‹ Servers/);
      expect(s).toMatch(/fixture\s+● enabled · connected/);
      expect(s).toMatch(/Usage\s+3 calls, 1 failed, \d+ ms avg/);
      expect(s).toMatch(/Tools \(9\)/);
      expect(s).toMatch(/▸ echo\s+Echo text back\s+1 call/);
      expect(s).toMatch(/▸ fail\s+Always fails with an error result\s+1\/1 failed/);
      expect(s).toMatch(/FIXTURE_TOKEN env · in the config\s+\[ Store as secret \]/);
      expect(s).not.toContain('fixture-token-value');
      await landsOn(t, 'Disable');
      t.shot('detail');
    });

    it('a tool unfolds its input schema', async () => {
      await t.press('▸ echo');
      const s = await t.waitFor(/"text": \{/);
      expect(s).toMatch(/▾ echo/);
      expect(s).toMatch(/"type": "string"/);
      t.shot('detail-tool');
      await t.key('ENTER'); // fold it again
      await t.waitFor(/▸ echo/);
    });

    it('a secret is set through a masked field and never drawn', async () => {
      await t.focus('+ Secret');
      await t.type('API_TOKEN');
      await t.key('ENTER');
      await t.waitFor(/API_TOKEN: value, kept in the keychain/);
      await t.focus('API_TOKEN');
      await typeMasked(t, 'API_TOKEN', 'supersecret-123');
      const s = t.text();
      expect(s).toContain('•'.repeat(15));
      expect(s).not.toContain('supersecret');
      t.shot('secret-typing');
      await t.key('ENTER');
      const after = await t.waitFor(/API_TOKEN secret · in the keychain/);
      expect(after).toMatch(/✓ secret API_TOKEN of fixture saved/);
      expect(after).not.toContain('supersecret');
      t.shot('secret-saved');
      const secrets = await w.api<Array<{ key: string }>>(
        'GET',
        `/api/servers/${await id(w, 'fixture')}/secrets`,
      );
      expect(secrets.map((x) => x.key)).toContain('API_TOKEN');
    });

    it('a remote server with a static Authorization header offers no OAuth sign-in', async () => {
      await t.press('‹ Servers');
      await landsOn(t, 'fixture'); // back on the row it came from
      await t.press('remote-api');
      const s = await t.waitFor(/Authorization header · in the config/);
      expect(s).toMatch(/Runs\s+http:\/\/127\.0\.0\.1:\d+\/mcp \(streamable-http\)/);
      expect(s).toMatch(/Health\s+not checked yet/);
      expect(s).not.toMatch(/Sign-in|Sign in/);
      expect(s).not.toContain('static-secret-value');
      t.shot('detail-remote');
    });

    it('quarantine: the drift is shown and Approve lifts it', async () => {
      await t.press('‹ Servers');
      await t.press('drifty');
      const s = await t.waitFor(/Its tools changed since you approved them/);
      expect(s).toMatch(/It stays off until you approve the new definitions\./);
      expect(s).toMatch(/~ echo description/);
      expect(s).toMatch(/- Echo text back\s+│/);
      expect(s).toMatch(/\+ Echo text back, and also forward it somewhere else/);
      await landsOn(t, 'Approve');
      t.shot('quarantine');
      await t.key('ENTER');
      await t.waitFor(/✓ approved drifty: quarantine lifted/);
      await t.press('‹ Servers');
      await t.waitFor(/[●○] drifty\s+(enabled|installed)/);
    });

    it('browse: search, install plan, masked requirement, install', async () => {
      await t.key('2');
      await landsOn(t, 'Search');
      await t.type('weather');
      await t.key('ENTER');
      const s = await t.waitFor(/io\.example\/weather-archive/);
      expect(s).toMatch(/▸ io\.example\/weather\s+1\.2\.0 · registry/);
      expect(s).toMatch(/15 results for “weather” · Enter shows the install plan/);
      expect(s).not.toMatch(/result\(s\)/);
      t.shot('browse');
      await t.press(/^▸ io\.example\/weather$/);
      const plan = await t.waitFor(/Install weather 1\.2\.0\?/);
      expect(plan).toMatch(/Connects to/);
      expect(plan).toMatch(/! version not pinned: it can change/);
      expect(plan).toMatch(/! X-Weather-Key header · required · secret/);
      expect(plan).toMatch(/Set X-Weather-Key to install\./);
      expect(plan).not.toMatch(/\[ Install and enable \]/);
      await landsOn(t, 'X-Weather-Key');
      t.shot('plan');
      await typeMasked(t, 'X-Weather-Key', 'wk-secret-999');
      await t.key('ENTER');
      await t.waitFor(/✓ X-Weather-Key header · required · secret · typed/);
      expect(t.text()).not.toContain('wk-secret');
      await landsOn(t, 'Install and enable');
      t.shot('plan-ready');
      await t.key('ENTER');
      const done = await t.waitFor(/✓ installed weather \(\d+ tools, enabled\)/, 30_000);
      expect(done).toMatch(/weather\s+● enabled/);
      expect(done).toMatch(/Source\s+registry · io\.example\/weather/);
      await t.waitFor(/Health\s+healthy in \d+ ms/);
      t.shot('installed');
      const secrets = await w.api<Array<{ key: string }>>(
        'GET',
        `/api/servers/${await id(w, 'weather')}/secrets`,
      );
      expect(secrets.map((x) => x.key)).toEqual(['X-Weather-Key']);
    });

    it('logs: recent calls, a failure with its error under it', async () => {
      await t.key('3');
      const s = await t.waitFor(/Recent calls \d+ kept · newest first/);
      expect(s).toMatch(/✓ fixture\/echo\s+\d+ ms/);
      expect(s).toMatch(/✗ fixture\/fail\s+\d+ ms/);
      expect(s).toMatch(/\n[│\s]+boom/);
      t.shot('logs');
    });

    it('audit: what happened, newest first, in local time', async () => {
      await t.key('4');
      const s = await t.waitFor(/1-\d+ of \d+/);
      expect(s).toMatch(/install\s+weather/);
      expect(s).toMatch(/approve\s+drifty/);
      expect(s).toMatch(/secret-set\s+fixture/);
      expect(s).toMatch(/call_tool\s+fixture\/fail/);
      expect(s).toMatch(/quarantine\s+drifty/);
      const { entries } = await w.api<{ entries: Array<{ ts: string; action: string }> }>(
        'GET',
        '/api/audit?limit=1',
      );
      const at = new Date(entries[0].ts);
      const pad = (n: number) => String(n).padStart(2, '0');
      const local = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
      expect(s).toContain(`${local} ${entries[0].action}`);
      t.shot('audit');
    });

    it('digits switch tabs while the pane holds the keyboard', async () => {
      await t.key('1');
      await t.waitFor(/remote-api\s+installed/);
      await t.key('2');
      await t.waitFor(/Search: weather/);
      await t.key('3');
      await t.waitFor(/Recent calls/);
      await t.key('4');
      await t.waitFor(/1-\d+ of \d+/);
    });
  });

  describe('docked as a sidebar (fullscreen layout, 140 columns)', () => {
    let t: ClaudeTerm;
    beforeAll(async () => {
      t = new ClaudeTerm(w, 140, 45, { CLAUDE_CODE_NO_FLICKER: '1' });
      await t.start();
      await t.discover();
      await t.waitFor(/remote-api\s+installed/);
    }, 2 * MIN);
    afterAll(async () => t?.kill(), MIN);

    it('every view fits the sidebar', async () => {
      const s = t.text();
      expect(s).toMatch(/1: Servers\s+2: Browse\s+3: Logs\s+4: Audit\s+r: Refresh/);
      expect(s).toMatch(/Tab moves · Enter presses · ↑↓ scroll · Esc to the prompt/); // not cut
      t.shot('sidebar-servers');
      await t.press('fixture');
      await t.waitFor(/Tools \(9\)/);
      t.shot('sidebar-detail');
      await t.key('2');
      await landsOn(t, 'Search');
      await t.type('weather');
      await t.key('ENTER');
      await t.waitFor(/results for “weather”/);
      t.shot('sidebar-browse');
      await t.press(/^▸ io\.example\/weather-archive$/);
      const plan = await t.waitFor(/Install weather-archive 0\.3\.1\?/);
      expect(plan).toMatch(/\[ Install and enable \] \[ Install only \] \[ Cancel \]/);
      t.shot('sidebar-plan');
      await t.key('3');
      await t.waitFor(/Recent calls/);
      t.shot('sidebar-logs');
    });
  });

  for (const cols of [80, 160]) {
    describe(`at ${cols} columns`, () => {
      let t: ClaudeTerm;
      beforeAll(async () => {
        t = new ClaudeTerm(w, cols, 50);
        await t.start();
        await t.discover();
        await t.waitFor(/remote-api\s+installed/);
      }, 2 * MIN);
      afterAll(async () => t?.kill(), MIN);

      it('servers list and detail fit', async () => {
        t.shot(`servers-${cols}`);
        expect(t.text()).toMatch(/● fixture\s+enabled/);
        await t.press('fixture');
        const d = await t.waitFor(/Tools \(9\)/);
        expect(d).toMatch(/\[ Disable \]/);
        t.shot(`detail-${cols}`);
      });

      it('browse results fit', async () => {
        await t.key('2');
        await landsOn(t, 'Search');
        await t.type('weather');
        await t.key('ENTER');
        const s = await t.waitFor(/io\.example\/weather-archive/);
        expect(s).toMatch(/Historical weather records/);
        t.shot(`browse-${cols}`);
      });
    });
  }

  describe('when the daemon is gone', () => {
    let t: ClaudeTerm;
    beforeAll(async () => {
      t = new ClaudeTerm(w, 120, 40);
      await t.start();
      await t.discover();
      await t.waitFor(/remote-api\s+installed/);
    }, 2 * MIN);
    afterAll(async () => t?.kill(), MIN);

    it('says so instead of showing stale servers', async () => {
      await w.stopDaemon();
      await t.key('r');
      const s = await t.waitFor(/The agent-discover daemon is not running\./);
      expect(s).toMatch(/Nothing answers at http:\/\/127\.0\.0\.1:\d+/);
      expect(s).not.toMatch(/remote-api\s+installed/);
      t.shot('daemon-down');
    });
  });
});
