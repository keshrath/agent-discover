// =============================================================================
// Install provenance checks against mocked npm / PyPI / docker.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile,
}));

import { buildInstallPlan, parseServerJson } from '../src/domain/install-plan.js';
import {
  checkProvenance,
  npmLatestVersion,
  ociLabels,
  pypiLatestVersion,
} from '../src/domain/provenance.js';

const NAME = 'io.github.acme/weather';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function planFor(registryType: string, identifier: string, version?: string, registry = true) {
  return buildInstallPlan({
    source: registry ? 'registry' : registryType === 'npm' ? 'npm' : 'pypi',
    server: parseServerJson({
      name: registry ? NAME : identifier,
      description: '',
      version: '1.0.0',
      packages: [{ registryType, identifier, version, transport: { type: 'stdio' } }],
    }),
    ...(registry ? { registry: { status: 'active' as const } } : {}),
  });
}

let routes: Record<string, () => Response>;
beforeEach(() => {
  routes = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const hit = routes[url];
      return hit ? hit() : new Response('not found', { status: 404, statusText: 'Not Found' });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  execFile.mockReset();
});

describe('npm', () => {
  it('passes when the exact version declares the registry name as mcpName', async () => {
    routes['https://registry.npmjs.org/@acme%2Fweather/1.2.0'] = () => json({ mcpName: NAME });
    const plan = await checkProvenance(planFor('npm', '@acme/weather', '1.2.0'));
    expect(plan.provenance.checks).toEqual([
      expect.objectContaining({ id: 'registry_namespace', status: 'pass' }),
      expect.objectContaining({ id: 'npm_mcp_name', status: 'pass' }),
    ]);
    expect(plan.warnings.some((w) => w.startsWith('provenance'))).toBe(false);
  });

  it('fails (and warns) when the package claims another server or none', async () => {
    routes['https://registry.npmjs.org/@acme%2Fweather/1.2.0'] = () =>
      json({ mcpName: 'io.github.other/x' });
    const plan = await checkProvenance(planFor('npm', '@acme/weather', '1.2.0'));
    expect(plan.provenance.checks[1]).toMatchObject({ status: 'fail' });
    expect(plan.warnings).toContain(`provenance check failed: ${plan.provenance.checks[1].detail}`);

    routes['https://registry.npmjs.org/@acme%2Fweather/1.2.0'] = () => json({});
    const none = await checkProvenance(planFor('npm', '@acme/weather', '1.2.0'));
    expect(none.provenance.checks[1].detail).toMatch(/has no mcpName/);
  });

  it('skips the comparison for federated installs, reports network errors', async () => {
    routes['https://registry.npmjs.org/weather/1.0.0'] = () => json({ mcpName: NAME });
    const fed = await checkProvenance(planFor('npm', 'weather', '1.0.0', false));
    expect(fed.provenance.checks).toEqual([
      expect.objectContaining({ id: 'npm_mcp_name', status: 'skipped' }),
    ]);
    const err = await checkProvenance(planFor('npm', 'missing', '1.0.0'));
    expect(err.provenance.checks[1]).toMatchObject({ status: 'error', detail: '404 Not Found' });
  });

  it('npmLatestVersion reads dist-tag latest', async () => {
    routes['https://registry.npmjs.org/@acme%2Fweather/latest'] = () => json({ version: '2.0.0' });
    expect(await npmLatestVersion('@acme/weather')).toBe('2.0.0');
  });
});

describe('pypi', () => {
  it('passes when the release README carries the mcp-name marker', async () => {
    routes['https://pypi.org/pypi/weather-mcp/1.0.0/json'] = () =>
      json({ info: { description: `# Weather\n\n<!-- mcp-name: ${NAME} -->` } });
    const plan = await checkProvenance(planFor('pypi', 'weather-mcp', '1.0.0'));
    expect(plan.provenance.checks[1]).toMatchObject({ id: 'pypi_mcp_name', status: 'pass' });
  });

  it('fails without the marker; marker matching is literal (no regex injection)', async () => {
    routes['https://pypi.org/pypi/weather-mcp/1.0.0/json'] = () =>
      json({ info: { description: 'mcp-name: ioXgithubXacme/weather' } });
    const plan = await checkProvenance(planFor('pypi', 'weather-mcp', '1.0.0'));
    expect(plan.provenance.checks[1]).toMatchObject({ status: 'fail' });
  });

  it('pypiLatestVersion reads info.version', async () => {
    routes['https://pypi.org/pypi/weather-mcp/json'] = () => json({ info: { version: '0.4.1' } });
    expect(await pypiLatestVersion('weather-mcp')).toBe('0.4.1');
  });
});

describe('oci', () => {
  type Cb = (err: Error | null, stdout: string) => void;
  const image = (labels: Record<string, string>) =>
    JSON.stringify({ 'linux/amd64': { config: { Labels: labels } } });

  it('reads the server-name label without pulling (buildx imagetools inspect)', async () => {
    execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Cb) =>
      cb(null, image({ 'io.modelcontextprotocol.server.name': NAME })),
    );
    const plan = await checkProvenance(planFor('oci', 'ghcr.io/acme/weather', '1.0.0'));
    expect(execFile.mock.calls[0][0]).toBe('docker');
    expect(execFile.mock.calls[0][1]).toEqual([
      'buildx',
      'imagetools',
      'inspect',
      'ghcr.io/acme/weather:1.0.0',
      '--format',
      '{{json .Image}}',
    ]);
    expect(plan.provenance.checks[1]).toMatchObject({ id: 'oci_label', status: 'pass' });
  });

  it('fails on a foreign label, skips without docker', async () => {
    execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: Cb) =>
      cb(null, image({ 'io.modelcontextprotocol.server.name': 'io.github.evil/x' })),
    );
    const bad = await checkProvenance(planFor('oci', 'ghcr.io/acme/weather', '1.0.0'));
    expect(bad.provenance.checks[1].status).toBe('fail');

    execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: Cb) =>
      cb(Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }), ''),
    );
    const none = await checkProvenance(planFor('oci', 'ghcr.io/acme/weather', '1.0.0'));
    expect(none.provenance.checks[1]).toMatchObject({
      status: 'skipped',
      detail: 'docker is not installed',
    });
  });

  it('ociLabels handles single- and multi-platform output', () => {
    expect(ociLabels(JSON.stringify({ config: { Labels: { a: 'b' } } }))).toEqual({ a: 'b' });
    expect(ociLabels(image({ c: 'd' }))).toEqual({ c: 'd' });
    expect(ociLabels('{}')).toEqual({});
  });
});

it('blocked plans skip package checks', async () => {
  const plan = await checkProvenance(planFor('mcpb', 'https://x/y.mcpb', '1.0.0'));
  expect(plan.provenance.checks.map((c) => c.id)).toEqual(['registry_namespace']);
});
