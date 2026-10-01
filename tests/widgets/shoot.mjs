/* global console, process, document, window */
// Screenshots every widget view (light + dark) plus the main interactions through the
// AppBridge harness, and fails on XSS / console errors.
//   node tests/widgets/shoot.mjs [outDir]   (default ~/.claude/tmp/w4-shots)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildHarness } from './harness/build.mjs';

const out = process.argv[2] ?? join(homedir(), '.claude', 'tmp', 'w4-shots');
mkdirSync(out, { recursive: true });
const url = pathToFileURL(await buildHarness()).href;
const browser = await chromium.launch();
const errors = [];
const shots = [];

async function open(only, theme) {
  const page = await browser.newPage({
    viewport: { width: 720, height: 900 },
    deviceScaleFactor: 2,
  });
  page.on('console', (m) => m.type() === 'error' && errors.push(`${only}/${theme}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${only}/${theme}: ${e.message}`));
  await page.goto(`${url}?only=${only}&theme=${theme}`);
  await page.waitForSelector(`#p-${only}[data-ready="1"]`, { timeout: 15_000 });
  await page.waitForTimeout(400);
  const frame = page.frameLocator(`#p-${only} iframe`);
  return { page, frame, panel: page.locator(`#p-${only}`) };
}

async function shot(panel, name) {
  const file = join(out, `${name}.png`);
  await panel.screenshot({ path: file });
  shots.push(file);
}

for (const theme of ['light', 'dark']) {
  for (const id of [
    'search_servers',
    'search_tools',
    'server_status',
    'install_plan',
    'get_tool',
  ]) {
    const { page, panel, frame } = await open(id, theme);
    await shot(panel, `${id}-${theme}`);
    if (id === 'search_servers') {
      if ((await frame.locator('img').count()) !== 0)
        errors.push('XSS: <img> from description was rendered');
      const pwned = await frame.locator('body').evaluate(() => document.body.dataset.pwned);
      if (pwned) errors.push('XSS: onerror executed');
      if (theme === 'light') {
        await frame.getByRole('button', { name: 'Install' }).click();
        await frame.getByText('Consent required').waitFor();
        await page.waitForTimeout(300);
        await shot(panel, 'search_servers-install-inline-light');
      }
    }
    if (id === 'install_plan' && theme === 'light') {
      await frame.getByRole('button', { name: 'Approve & install' }).click();
      await frame.getByText('installed', { exact: false }).first().waitFor();
      await page.waitForTimeout(300);
      await shot(panel, 'install_plan-approved-light');
    }
    if (id === 'get_tool') {
      await frame.locator('textarea').first().fill('select id, email from users limit 2');
      await frame.getByRole('button', { name: 'Run' }).click();
      await frame.getByText('structuredContent', { exact: true }).waitFor();
      await page.waitForTimeout(300);
      await shot(panel, `get_tool-result-${theme}`);
      const calls = await page.evaluate(() => window.__calls);
      const run = calls.find((c) => c.name === 'call_tool');
      if (
        !run ||
        run.arguments.arguments.sql !== 'select id, email from users limit 2' ||
        run.arguments.arguments.limit !== 100
      ) {
        errors.push(`tester sent wrong call_tool args: ${JSON.stringify(run)}`);
      }
    }
    if (id === 'server_status' && theme === 'light') {
      await frame.getByRole('button', { name: 'Enable' }).click();
      await frame.getByRole('button', { name: 'Disable' }).nth(1).waitFor();
      await page.waitForTimeout(300);
      await shot(panel, 'server_status-enabled-light');
    }
    await page.close();
  }
}

await browser.close();
console.log(shots.join('\n'));
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
