// Screenshots every widget view (light + dark) plus the main interactions through the
// AppBridge harness, and fails on XSS / console errors. The widget is fed real tool results
// (capture.ts) and its tool calls are answered by a real daemon through the SDK client.
//   npm run widgets:shots [outDir]   (default ~/.claude/tmp/w4-shots-v2)
import { chromium, type Locator } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildHarness } from './harness/build.mjs';
import { capture } from './capture.js';
import { connectClient } from '../helpers.js';

const out = process.argv[2] ?? join(homedir(), '.claude', 'tmp', 'w4-shots-v2');
mkdirSync(out, { recursive: true });

const session = await capture();
// The widget host has no elicitation: install goes through the in-widget consent card.
const widgetClient = await connectClient(session.daemon, { era: 'modern', elicitation: false });
const url = pathToFileURL(await buildHarness()).href;
const browser = await chromium.launch();
const errors: string[] = [];
const shots: string[] = [];

async function open(only: string, theme: string) {
  const page = await browser.newPage({
    viewport: { width: 720, height: 900 },
    deviceScaleFactor: 2,
  });
  page.on('console', (m) => m.type() === 'error' && errors.push(`${only}/${theme}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${only}/${theme}: ${e.message}`));
  await page.exposeFunction('__callTool', (name: string, args: Record<string, unknown>) =>
    widgetClient.callTool({ name, arguments: args }),
  );
  await page.addInitScript(
    (fx) => ((window as never as { __fx: unknown }).__fx = fx),
    session.results,
  );
  await page.goto(`${url}?only=${only}&theme=${theme}`);
  await page.waitForSelector(`#p-${only}[data-ready="1"]`, { timeout: 15_000 });
  await page.waitForTimeout(400);
  return { page, frame: page.frameLocator(`#p-${only} iframe`), panel: page.locator(`#p-${only}`) };
}

async function shot(panel: Locator, name: string) {
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
      if (await frame.locator('body').evaluate(() => document.body.dataset.pwned))
        errors.push('XSS: onerror executed');
      if (theme === 'light') {
        await frame.getByRole('button', { name: 'Install' }).first().click();
        await frame.getByText('cannot show the confirmation prompt').waitFor();
        await page.waitForTimeout(300);
        await shot(panel, 'search_servers-install-inline-light');
      }
    }
    if (id === 'get_tool') {
      await frame.getByLabel('city').fill('Graz');
      await frame.getByRole('button', { name: 'Run' }).click();
      await frame.getByText('structuredContent', { exact: true }).waitFor();
      await page.waitForTimeout(300);
      await shot(panel, `get_tool-result-${theme}`);
      const calls = await page.evaluate(
        () =>
          (
            window as never as {
              __calls: { name: string; arguments: { arguments?: { city?: string } } }[];
            }
          ).__calls,
      );
      const run = calls.find((c) => c.name === 'call_tool');
      if (run?.arguments.arguments?.city !== 'Graz')
        errors.push(`tester sent wrong call_tool args: ${JSON.stringify(run)}`);
    }
    if (id === 'server_status' && theme === 'light') {
      await frame.getByRole('button', { name: 'Disable' }).first().click();
      await frame.getByRole('button', { name: 'Enable' }).first().waitFor();
      await page.waitForTimeout(300);
      await shot(panel, 'server_status-toggled-light');
    }
    await page.close();
  }
}

await browser.close();
await widgetClient.close();
await session.close();
console.error(shots.join('\n'));
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
