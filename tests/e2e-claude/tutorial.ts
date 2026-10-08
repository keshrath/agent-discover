// =============================================================================
// Records the /discover tutorial: one scripted session in the real Claude Code
// CLI (fullscreen layout, the pane docked as a sidebar) against a scratch world,
// filmed as a captioned WebM plus one PNG per step.
//
//   npx tsx tests/e2e-claude/tutorial.ts           record and render -> ~/.claude/tmp/tutorial/
//   npx tsx tests/e2e-claude/tutorial.ts --render  render the last recording again
//
// Slash commands and the pane make no model calls; a run costs no tokens.
// =============================================================================

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeTerm, SHOTS_DIR, sleep, startWorld } from './harness.js';
import { renderShots, renderVideo, type Caption, type Frame } from './render.js';

const OUT = join(SHOTS_DIR, '..', 'tutorial');
const COLS = 150;
const ROWS = 42;

type Step = { label: string; text: string };
type Recording = { frames: Frame[]; captions: Caption[]; steps: Step[] };

/** The scripted session: each step captions what comes, plays it, and keeps a still. */
async function record(): Promise<Recording> {
  const world = await startWorld();
  // Full repaints: without them the headless terminal keeps stale cells beside the pane.
  const t = new ClaudeTerm(world, COLS, ROWS, {
    CLAUDE_CODE_NO_FLICKER: '1',
    CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: '1',
  });
  await t.start();
  const rec: Recording = { frames: [], captions: [], steps: [] };
  const t0 = Date.now();
  const recorder = setInterval(() => {
    const data = t.serialize();
    if (rec.frames.at(-1)?.data !== data) rec.frames.push({ at: Date.now() - t0, data });
  }, 80);

  const step = async (label: string, text: string, act: () => Promise<void>, hold = 2_500) => {
    rec.captions.push({ at: Date.now() - t0, text });
    await act();
    await sleep(hold);
    rec.steps.push({ label, text });
    writeFileSync(
      join(OUT, `${String(rec.steps.length).padStart(2, '0')}-${label}.ansi`),
      JSON.stringify({ cols: COLS, rows: ROWS, data: t.serialize() }),
    );
  };
  // Typed like a person, so the video shows it.
  const typeSlowly = async (text: string, ms = 60) => {
    for (const ch of text) {
      await t.type(ch);
      await sleep(ms);
    }
  };

  try {
    await step('start', 'Claude Code with the agent-discover plugin', async () => {}, 1_500);
    await step(
      'open',
      'Type /discover and press Enter: the pane opens beside the conversation',
      async () => {
        await typeSlowly('/discover');
        await sleep(400);
        await t.key('ENTER');
        await t.waitFor(/remote-api\s+installed/);
      },
    );
    await step(
      'servers',
      'Your MCP servers, what needs a look first. The focus starts on the first one',
      async () => {},
      3_500,
    );
    await step(
      'move',
      'Tab moves the focus; Enter opens the server under it',
      async () => {
        await t.focus('fixture');
        await sleep(700);
        await t.key('ENTER');
        await t.waitFor(/Tools \(9\)/);
      },
      3_000,
    );
    await step(
      'detail',
      'A server: Enable or Disable, health, usage, tools, configuration',
      async () => {},
      3_500,
    );
    await step('tool', 'Enter on a tool shows its full description and input schema', async () => {
      await t.focus('▸ echo');
      await sleep(500);
      await t.key('ENTER');
      await t.waitFor(/"text": \{/);
    });
    await step(
      'back',
      '‹ Servers (or the 1 key) goes back to the list',
      async () => {
        await t.key('1');
        await t.waitFor(/remote-api\s+installed/);
      },
      1_800,
    );
    await step(
      'quarantine',
      'A quarantined server: its tools changed since you approved them. Read the diff',
      async () => {
        await t.focus('drifty');
        await sleep(500);
        await t.key('ENTER');
        await t.waitFor(/Its tools changed since you approved them/);
      },
      4_000,
    );
    await step(
      'approve',
      'Approve accepts the new definitions; Keep disabled leaves it off',
      async () => {
        await t.key('ENTER');
        await t.waitFor(/approved drifty/);
      },
    );
    await step(
      'browse',
      'The 2 key opens Browse: search the MCP Registry, npm and PyPI',
      async () => {
        await t.key('2');
        await sleep(600);
        await typeSlowly('weather');
        await t.key('ENTER');
        await t.waitFor(/results for “weather”/);
      },
      3_000,
    );
    await step(
      'plan',
      'Enter on a result shows exactly what would run, and its checks',
      async () => {
        await t.focus(/^▸ io\.example\/weather$/);
        await sleep(500);
        await t.key('ENTER');
        await t.waitFor(/Install weather 1\.2\.0\?/);
      },
      3_500,
    );
    await step(
      'secret',
      'A required secret goes into a masked field: only dots are drawn',
      async () => {
        await typeSlowly('wk-secret-999', 90);
        await sleep(400);
        await t.key('ENTER');
        await t.waitFor(/secret · typed/);
      },
    );
    await step(
      'install',
      'Install and enable: installed, indexed and ready to use',
      async () => {
        await t.key('ENTER');
        await t.waitFor(/installed weather/, 30_000);
      },
      3_500,
    );
    await step(
      'logs',
      'The 3 key: recent tool calls through agent-discover, failures in red',
      async () => {
        await t.key('3');
        await t.waitFor(/Recent calls/);
      },
      3_000,
    );
    await step(
      'audit',
      'The 4 key: the audit log of installs, approvals, secrets and calls',
      async () => {
        await t.key('4');
        await t.waitFor(/1-\d+ of \d+/);
      },
      3_000,
    );
    await step(
      'esc',
      'Esc hands the keyboard back to the prompt; ctrl+x tab takes it again',
      async () => {
        await t.key('ESC');
        await t.waitFor(/ctrl\+x tab to work this pane/);
      },
      3_000,
    );
  } finally {
    clearInterval(recorder);
    await t.kill();
    await world.stop();
  }
  return rec;
}

if (!process.argv.includes('--render')) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'recording.json'), JSON.stringify(await record()));
}
const rec = JSON.parse(readFileSync(join(OUT, 'recording.json'), 'utf8')) as Recording;
const pngs = await renderShots(OUT);
const video = await renderVideo(
  join(OUT, 'discover-tutorial.webm'),
  { cols: COLS, rows: ROWS },
  rec.frames,
  rec.captions,
);
writeFileSync(join(OUT, 'steps.json'), JSON.stringify(rec.steps, null, 2));
const seconds = Math.round((rec.frames.at(-1)?.at ?? 0) / 1000);
process.stdout.write(
  `${video}\n${pngs.length} stills, ${rec.frames.length} frames, ${seconds} s\n`,
);
process.exit(0); // a pty or browser handle can outlive the run
