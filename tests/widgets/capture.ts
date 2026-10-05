// =============================================================================
// Real meta tool results for the widget contract test and the Playwright shots:
// a temp daemon with the fixture upstream (descriptions carry XSS payloads) and
// a canned registry answer, driven by an SDK client. Nothing here is a
// hand-written structuredContent.
// =============================================================================

import type { CallToolResult, Client } from '@modelcontextprotocol/client';
import {
  buildInstallPlan,
  type InstallCandidate,
  type PackageSpec,
} from '../../src/domain/install-plan.js';
import type { MarketplaceEntry } from '../../src/domain/marketplace.js';
import { FIXTURE, connectClient, startTestDaemon, type TestDaemon } from '../helpers.js';

export const XSS = '<img src=x onerror="document.body.dataset.pwned=1"><script>alert(1)</script>';

const pkg = (identifier: string, version?: string): PackageSpec => ({
  registryType: 'npm',
  identifier,
  version,
  transport: { type: 'stdio' },
  runtimeArguments: [],
  packageArguments: [],
  environmentVariables: [],
});

/** Canned marketplace answers: no network, deterministic plans. */
const CANDIDATES: InstallCandidate[] = [
  {
    source: 'registry',
    registry: { status: 'active' },
    server: {
      name: 'io.github.example/weather',
      description: `Weather forecasts and alerts. ${XSS}`,
      version: '2.1.3',
      repository: 'https://github.com/example/weather-mcp',
      packages: [pkg('@example/weather-mcp', '2.1.3')],
      remotes: [],
    },
  },
  {
    source: 'registry',
    registry: { status: 'active' },
    server: {
      name: 'io.github.example/remote-notes',
      description: 'Hosted notes service',
      version: '1.0.0',
      packages: [],
      remotes: [
        {
          type: 'streamable-http',
          url: 'https://notes.example.com/mcp',
          headers: [],
          variables: {},
        },
      ],
    },
  },
  {
    source: 'npm',
    server: {
      name: '@example/weather-mcp',
      description: 'Weather over npm',
      version: '2.1.3',
      packages: [pkg('@example/weather-mcp')],
      remotes: [],
    },
  },
];

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
  daemon.ctx.marketplace.search = async () => ({
    servers: CANDIDATES.map(
      (c): MarketplaceEntry => ({
        source: c.source,
        name: c.server.name,
        description: c.server.description,
        version: c.server.version,
        status: c.registry?.status ?? 'active',
        repository: c.server.repository ?? null,
        packages: c.server.packages.map((p) => ({
          registry_type: p.registryType,
          identifier: p.identifier,
          version: p.version ?? null,
          transport: p.transport.type,
        })),
        remotes: c.server.remotes.map((r) => ({ type: r.type, url: r.url })),
      }),
    ),
    registry: 'mirror',
    errors: {},
  });
  daemon.ctx.marketplace.plan = async (req) => {
    const hit = CANDIDATES.find(
      (c) => c.source === (req.source ?? 'registry') && c.server.name === req.name,
    );
    if (!hit) throw new Error(`no canned candidate ${req.name}`);
    const server = structuredClone(hit.server);
    if (req.version) for (const p of server.packages) p.version = req.version;
    return buildInstallPlan({ ...hit, server }, { name: req.local_name });
  };
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
    server: '@example/weather-mcp',
    source: 'npm',
    version: '2.1.3',
    name: 'declined',
  });
  answer = 'accept';
  results.install_server_consent = await call(
    'install_server',
    { server: '@example/weather-mcp', source: 'npm', name: 'weather' },
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
