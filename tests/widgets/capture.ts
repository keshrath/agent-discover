// =============================================================================
// Real meta tool results for the widget contract test and the Playwright shots:
// a temp daemon with the fixture upstream (descriptions carry XSS payloads) and
// a canned registry answer, driven by an SDK client. Nothing here is a
// hand-written structuredContent.
// =============================================================================

import type { CallToolResult, Client } from '@modelcontextprotocol/client';
import type { MarketplaceResult } from '../../src/types.js';
import { FIXTURE, connectClient, startTestDaemon, type TestDaemon } from '../helpers.js';

export const XSS = '<img src=x onerror="document.body.dataset.pwned=1"><script>alert(1)</script>';

const REGISTRY: MarketplaceResult = {
  next_cursor: null,
  servers: [
    {
      name: 'io.github.example/weather',
      description: `Weather forecasts and alerts. ${XSS}`,
      version: '2.1.3',
      repository: 'https://github.com/example/weather-mcp',
      packages: [
        {
          registry_name: 'npm',
          name: '@example/weather-mcp',
          version: '2.1.3',
          runtime: 'node',
          license: 'MIT',
          url: null,
        },
      ],
    },
    {
      name: 'io.github.example/remote-notes',
      description: 'Hosted notes service',
      version: '1.0.0',
      repository: null,
      packages: [
        {
          registry_name: 'remote',
          name: 'notes',
          version: '1.0.0',
          runtime: 'streamable-http',
          license: null,
          url: 'https://notes.example.com/mcp',
        },
      ],
    },
  ],
};

export type Captured = Record<string, CallToolResult>;

export interface CaptureSession {
  daemon: TestDaemon;
  client: Client;
  /** Elicitation messages the client was shown (install consent). */
  prompts: string[];
  results: Captured;
  close(): Promise<void>;
}

/** Start the daemon, run every meta tool once per result variant, keep the session open. */
export async function capture(): Promise<CaptureSession> {
  const daemon = await startTestDaemon();
  daemon.ctx.marketplace.browse = async () => REGISTRY;
  const prompts: string[] = [];
  let answer: 'accept' | 'decline' = 'accept';
  const client = await connectClient(daemon, {
    era: 'modern',
    elicit: (message) => {
      prompts.push(message);
      return answer === 'accept'
        ? { action: 'accept', content: { confirm: true } }
        : { action: 'decline' };
    },
  });
  const noElicit = await connectClient(daemon, { era: 'modern', elicitation: false });
  const call = async (name: string, args: Record<string, unknown>, c = client) =>
    (await c.callTool({ name, arguments: args })) as CallToolResult;

  const upstream = {
    command: process.execPath,
    args: [FIXTURE],
    env: { FIXTURE_DESCRIPTION: `Echo text back. ${XSS}`, API_TOKEN: 'secret-value' },
  };
  const results: Captured = {};
  results.server_status_empty = await call('server_status', {});
  results.install_server = await call('install_server', {
    name: 'fixture',
    description: `Fixture upstream for widget shots. ${XSS}`,
    ...upstream,
  });
  results.install_server_already = await call('install_server', { name: 'fixture', ...upstream });
  answer = 'decline';
  results.install_server_declined = await call('install_server', {
    name: 'declined',
    package: '@example/weather-mcp@2.1.3',
  });
  answer = 'accept';
  results.install_server_consent = await call(
    'install_server',
    { name: 'weather', package: '@example/weather-mcp' },
    noElicit,
  );
  await daemon.ctx.lifecycle.install({ name: 'spare', ...upstream });
  results.enable_server = await call('enable_server', { name: 'fixture' });
  results.search_servers = await call('search_servers', { query: 'fixture' });
  results.search_tools = await call('search_tools', { queries: ['echo text', 'weather data'] });
  results.search_tools_empty = await call('search_tools', { queries: ['zzqx nothing'] });
  results.server_status = await call('server_status', { check_health: true });
  results.get_tool = await call('get_tool', { server: 'fixture', tool: 'structured' });
  results.get_tool_missing = await call('get_tool', { server: 'fixture', tool: 'nope' });
  results.call_tool = await call('call_tool', {
    server: 'fixture',
    tool: 'structured',
    arguments: { city: 'Graz' },
  });
  results.disable_server = await call('disable_server', { name: 'spare' });
  await noElicit.close();

  return {
    daemon,
    client,
    prompts,
    results,
    async close() {
      await client.close().catch(() => {});
      await daemon.stop();
    },
  };
}

/** The meta tool a captured variant came from (`install_server_declined` → `install_server`). */
export function toolOf(variant: string): string {
  return variant.replace(/_(empty|already|declined|consent|missing)$/, '');
}
