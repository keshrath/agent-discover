// =============================================================================
// agent-discover — Playwright E2E dashboard test
//
// Boots the standalone HTTP+WS server against a temp SQLite DB on a free port,
// seeds a few mock server entries via the registry, and verifies the dashboard
// renders the installed list and lets the user click into a server card.
// =============================================================================

import { test, expect, type ConsoleMessage } from '@playwright/test';
import { createContext, type AppContext } from '../../dist/context.js';
import { startDashboard, type DashboardServer } from '../../dist/server.js';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { createServer } from 'net';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('no port'));
      }
    });
  });
}

let tempDir: string;
let ctx: AppContext;
let dashboard: DashboardServer;
let baseUrl: string;
const seededNames = ['e2e-mock-one', 'e2e-mock-two', 'e2e-mock-three'];

test.beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-discover-e2e-'));
  ctx = createContext({ path: join(tempDir, 'test.db') });

  for (const name of seededNames) {
    ctx.registry.register({
      name,
      description: `Mock MCP server ${name} for e2e`,
      command: 'echo',
      args: ['hello'],
      transport: 'stdio',
      tags: ['e2e', 'mock'],
    });
  }

  const port = await freePort();
  dashboard = await startDashboard(ctx, port);
  baseUrl = `http://localhost:${dashboard.port}`;
});

test.afterAll(async () => {
  try {
    dashboard?.close();
  } catch {
    /* ignore */
  }
  try {
    ctx?.close();
  } catch {
    /* ignore */
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

test.describe('agent-discover dashboard', () => {
  test('loads with no console errors and connects via websocket', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    let wsConnected = false;
    page.on('websocket', () => {
      wsConnected = true;
    });

    await page.goto(baseUrl + '/');
    await expect(page.locator('#tab-installed')).toBeVisible();
    await page.waitForTimeout(800);

    expect(wsConnected).toBe(true);
    expect(pageErrors).toEqual([]);
    const hardErrors = consoleErrors.filter((e) => !/favicon|404/i.test(e));
    expect(hardErrors).toEqual([]);

    const screenshotDir = join(homedir(), '.claude', 'tmp');
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: join(screenshotDir, 'e2e-agent-discover.png'),
      fullPage: true,
    });
  });

  test('REST /api/servers returns the seeded mock entries', async ({ request }) => {
    const res = await request.get(baseUrl + '/api/servers');
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as Array<{ name: string }>;
    const names = body.map((s) => s.name);
    for (const name of seededNames) {
      expect(names).toContain(name);
    }
  });

  test('installed list renders the seeded server cards', async ({ page }) => {
    await page.goto(baseUrl + '/');
    await page.waitForSelector('#installed-list', { timeout: 5000 });

    // Wait for the WS state to populate cards.
    await expect(page.locator('#installed-list .server-card').first()).toBeVisible({
      timeout: 5000,
    });

    for (const name of seededNames) {
      await expect(page.locator('#installed-list', { hasText: name })).toBeVisible();
    }
  });

  test('Browse tab switches into view', async ({ page }) => {
    await page.goto(baseUrl + '/');
    await page.click('[data-tab="browse"]');
    await expect(page.locator('#tab-browse')).toBeVisible();
  });
});
