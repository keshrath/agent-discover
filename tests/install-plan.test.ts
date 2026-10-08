// =============================================================================
// server.json parsing (schemas 2025-09-29 and 2025-12-11) and InstallPlan
// building: exact pinning per registry type, env/header requirements,
// remotes with URL variables, refused entries.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  buildInstallPlan,
  localNameFor,
  manualPlan,
  parseRegistryFacts,
  parseServerJson,
  publisherOf,
  type InstallCandidate,
} from '../src/domain/install-plan.js';

// Shape published under schema 2025-09-29 (package versions required, no remote variables).
const SCHEMA_2025_09_29 = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json',
  name: 'io.github.acme/weather',
  title: 'Weather',
  description: 'Weather forecasts',
  version: '1.2.0',
  repository: { url: 'https://github.com/acme/weather', source: 'github' },
  websiteUrl: 'https://acme.dev/weather',
  packages: [
    {
      registryType: 'npm',
      registryBaseUrl: 'https://registry.npmjs.org',
      identifier: '@acme/weather-mcp',
      version: '1.2.0',
      transport: { type: 'stdio' },
      runtimeArguments: [{ type: 'named', name: '--node-options', value: '--no-warnings' }],
      packageArguments: [
        { type: 'positional', value: 'serve' },
        { type: 'named', name: '--units', default: 'metric' },
        { type: 'named', name: '--verbose', value: '' },
      ],
      environmentVariables: [
        { name: 'WEATHER_API_KEY', description: 'API key', isRequired: true, isSecret: true },
        { name: 'WEATHER_REGION', default: 'eu' },
      ],
    },
  ],
  remotes: [
    {
      type: 'sse',
      url: 'https://weather.acme.dev/sse',
      headers: [{ name: 'X-Api-Key', isRequired: true, isSecret: true }],
    },
  ],
};

// Shape published under schema 2025-12-11 (optional package version, remote URL variables).
const SCHEMA_2025_12_11 = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  name: 'com.example/files',
  description: 'File access',
  version: '3.0.0',
  packages: [
    {
      registryType: 'pypi',
      identifier: 'example-files-mcp',
      transport: { type: 'stdio' },
      environmentVariables: [{ name: 'FILES_ROOT', isRequired: true }],
    },
    {
      registryType: 'oci',
      identifier: 'ghcr.io/example/files:3.0.0',
      transport: { type: 'stdio' },
      environmentVariables: [{ name: 'FILES_ROOT', isRequired: true }],
    },
  ],
  remotes: [
    {
      type: 'streamable-http',
      url: 'https://{tenant}.files.example.com/mcp',
      variables: { tenant: { description: 'Tenant', isRequired: true, default: 'acme' } },
      headers: [{ name: 'Authorization', value: 'Bearer {token}', variables: { token: {} } }],
    },
  ],
};

function candidate(raw: unknown, status?: 'active' | 'deprecated' | 'deleted'): InstallCandidate {
  return {
    source: 'registry',
    server: parseServerJson(raw),
    registry: { status: status ?? 'active', isLatest: true, publishedAt: '2026-01-01T00:00:00Z' },
  };
}

describe('parseServerJson', () => {
  it('normalizes the 2025-09-29 shape', () => {
    const s = parseServerJson(SCHEMA_2025_09_29);
    expect(s).toMatchObject({
      name: 'io.github.acme/weather',
      title: 'Weather',
      version: '1.2.0',
      repository: 'https://github.com/acme/weather',
      websiteUrl: 'https://acme.dev/weather',
    });
    const pkg = s.packages[0];
    expect(pkg).toMatchObject({
      registryType: 'npm',
      identifier: '@acme/weather-mcp',
      version: '1.2.0',
      transport: { type: 'stdio' },
    });
    expect(pkg.packageArguments.map((a) => a.type)).toEqual(['positional', 'named', 'named']);
    expect(pkg.environmentVariables[0]).toMatchObject({
      name: 'WEATHER_API_KEY',
      isRequired: true,
      isSecret: true,
    });
    expect(s.remotes[0]).toMatchObject({ type: 'sse', headers: [{ name: 'X-Api-Key' }] });
  });

  it('normalizes the 2025-12-11 shape (unversioned packages, remote variables)', () => {
    const s = parseServerJson(SCHEMA_2025_12_11);
    expect(s.packages[0].version).toBeUndefined();
    expect(s.packages[0].runtimeArguments).toEqual([]);
    expect(s.remotes[0].variables.tenant).toMatchObject({ isRequired: true, default: 'acme' });
    expect(s.remotes[0].headers[0].value).toBe('Bearer {token}');
  });

  it('tolerates junk', () => {
    expect(parseServerJson(null)).toMatchObject({ name: '', packages: [], remotes: [] });
    expect(parseServerJson({ remotes: [{ type: 'sse' }], packages: 'x' }).remotes).toEqual([]);
  });

  it('reads the official registry facts', () => {
    expect(
      parseRegistryFacts({
        'io.modelcontextprotocol.registry/official': { status: 'deleted', isLatest: false },
      }),
    ).toMatchObject({ status: 'deleted', isLatest: false });
    expect(parseRegistryFacts(undefined).status).toBe('active');
  });
});

describe('buildInstallPlan', () => {
  it('npm: exact pin, argv order, env defaults, secret requirements', () => {
    const plan = buildInstallPlan(candidate(SCHEMA_2025_09_29));
    expect(plan).toMatchObject({
      server: 'weather',
      source: 'registry',
      registry_name: 'io.github.acme/weather',
      transport: 'stdio',
      command: 'npx',
      version: '1.2.0',
    });
    expect(plan.args).toEqual([
      '-y',
      '--node-options=--no-warnings',
      '@acme/weather-mcp@1.2.0',
      'serve',
      '--units=metric',
      '--verbose',
    ]);
    expect(plan.input.env).toEqual({ WEATHER_API_KEY: '', WEATHER_REGION: 'eu' });
    expect(plan.requirements).toEqual([
      {
        key: 'WEATHER_API_KEY',
        kind: 'env',
        required: true,
        secret: true,
        description: 'API key',
        present: false,
      },
      { key: 'WEATHER_REGION', kind: 'env', required: false, secret: false, present: true },
    ]);
    expect(plan.warnings).toContain('requires env WEATHER_API_KEY');
    expect(plan.provenance).toMatchObject({
      registry: { name: 'io.github.acme/weather', publisher: 'github:acme', status: 'active' },
      package: { ecosystem: 'npm', name: '@acme/weather-mcp', version: '1.2.0' },
      pinned: true,
      repository: 'https://github.com/acme/weather',
    });
    expect(plan.input).toMatchObject({
      registry_name: 'io.github.acme/weather',
      tags: ['registry'],
    });
  });

  it('stored secrets satisfy requirements', () => {
    const plan = buildInstallPlan(candidate(SCHEMA_2025_09_29), {
      storedSecrets: ['weather_api_key'],
    });
    expect(plan.requirements[0].present).toBe(true);
    expect(plan.warnings).not.toContain('requires env WEATHER_API_KEY');
  });

  it('remote: picked by transport, headers declared empty until a secret fills them', () => {
    const plan = buildInstallPlan(candidate(SCHEMA_2025_09_29), { transport: 'sse' });
    expect(plan).toMatchObject({ transport: 'sse', url: 'https://weather.acme.dev/sse' });
    expect(plan.command).toBeUndefined();
    expect(plan.input.headers).toEqual({ 'X-Api-Key': '' });
    expect(plan.provenance.remote).toEqual({ url: 'https://weather.acme.dev/sse', type: 'sse' });
    expect(plan.requirements[0]).toMatchObject({ kind: 'header', secret: true, present: false });
  });

  it('remote URL variables use defaults; unresolved header templates are not sent', () => {
    const plan = buildInstallPlan(candidate(SCHEMA_2025_12_11), {
      transport: 'streamable-http',
      name: 'files',
    });
    expect(plan.url).toBe('https://acme.files.example.com/mcp');
    expect(plan.input.headers).toEqual({ Authorization: '' });
    expect(plan.provenance.registry?.publisher).toBe('domain:example.com');
  });

  it('pypi: pins with ==, unpinned when the version is missing', () => {
    const raw = structuredClone(SCHEMA_2025_12_11);
    const unpinned = buildInstallPlan(candidate(raw));
    expect(unpinned).toMatchObject({ command: 'uvx', args: ['example-files-mcp'] });
    expect(unpinned.provenance.pinned).toBe(false);
    expect(unpinned.warnings).toContain('the package version is not pinned');
    raw.packages[0] = { ...raw.packages[0], version: '3.0.0' } as (typeof raw.packages)[0];
    expect(buildInstallPlan(candidate(raw)).args).toEqual(['example-files-mcp==3.0.0']);
  });

  it('ranges and "latest" never count as pinned', () => {
    for (const version of ['latest', '1', '1.x', '2.*', '1.2', '1.2.x', '1.x.x', 'next', 'beta']) {
      const raw = structuredClone(SCHEMA_2025_09_29);
      raw.packages[0].version = version;
      const plan = buildInstallPlan(candidate(raw));
      expect(plan.provenance.pinned).toBe(false);
      expect(plan.args).toContain('@acme/weather-mcp');
    }
  });

  it('exact versions pin: full semver for npm, PEP 440 releases for PyPI', () => {
    for (const version of ['1.2.3', '1.2.3-rc.1', '0.0.1+build.5']) {
      const raw = structuredClone(SCHEMA_2025_09_29);
      raw.packages[0].version = version;
      expect(buildInstallPlan(candidate(raw)).provenance.pinned).toBe(true);
    }
    const pypi = (version: string) => {
      const raw = structuredClone(SCHEMA_2025_12_11);
      raw.packages = [{ ...raw.packages[0], version } as (typeof raw.packages)[0]];
      return buildInstallPlan(candidate(raw)).provenance.pinned;
    };
    for (const v of ['3.0', '3.0.0rc1', '1!2.0.post1', '2.0.dev3']) expect(pypi(v)).toBe(true);
    for (const v of ['latest', '3.x', '3.*', 'beta', '~=3.0']) expect(pypi(v)).toBe(false);
  });

  it('oci: tag pins with a mutability warning, digest pins exactly, env forwarded with -e', () => {
    const raw = structuredClone(SCHEMA_2025_12_11);
    raw.packages = [raw.packages[1]];
    const tagged = buildInstallPlan(candidate(raw));
    expect(tagged).toMatchObject({ command: 'docker', version: null });
    expect(tagged.args).toEqual([
      'run',
      '-i',
      '--rm',
      '-e',
      'FILES_ROOT',
      'ghcr.io/example/files:3.0.0',
    ]);
    expect(tagged.provenance.pinned).toBe(true);
    expect(tagged.warnings).toContain('image tags are mutable; only a digest pins the image');

    const digest = `sha256:${'a'.repeat(64)}`;
    raw.packages[0] = { ...raw.packages[0], identifier: `ghcr.io/example/files@${digest}` };
    const pinned = buildInstallPlan(candidate(raw));
    expect(pinned.provenance).toMatchObject({ pinned: true, digest });
    expect(pinned.version).toBe(digest);

    raw.packages[0] = { ...raw.packages[0], identifier: 'ghcr.io/example/files' };
    const versioned = buildInstallPlan(
      candidate({ ...raw, packages: [{ ...raw.packages[0], version: '3.0.0' }] }),
    );
    expect(versioned.args).toContain('ghcr.io/example/files:3.0.0');
  });

  it('refuses mcpb, nuget, local-http packages, missing required args and deleted entries', () => {
    const pkg = (p: Record<string, unknown>) => ({
      name: 'io.github.x/y',
      description: '',
      version: '1.0.0',
      packages: [{ identifier: 'y', version: '1.0.0', transport: { type: 'stdio' }, ...p }],
    });
    expect(buildInstallPlan(candidate(pkg({ registryType: 'mcpb' }))).blocked).toMatch(/MCPB/);
    expect(buildInstallPlan(candidate(pkg({ registryType: 'nuget' }))).blocked).toMatch(/nuget/);
    expect(
      buildInstallPlan(
        candidate(pkg({ registryType: 'npm', transport: { type: 'streamable-http' } })),
      ).blocked,
    ).toMatch(/streamable-http transport/);
    expect(
      buildInstallPlan(
        candidate(
          pkg({
            registryType: 'npm',
            packageArguments: [{ type: 'positional', valueHint: 'directory', isRequired: true }],
          }),
        ),
      ).blocked,
    ).toMatch(/directory/);
    const deleted = buildInstallPlan(candidate(pkg({ registryType: 'npm' }), 'deleted'));
    expect(deleted.blocked).toMatch(/removed from the MCP Registry/);
    const deprecated = buildInstallPlan(candidate(pkg({ registryType: 'npm' }), 'deprecated'));
    expect(deprecated.blocked).toBeUndefined();
    expect(deprecated.warnings[0]).toMatch(/deprecated/);
    expect(
      buildInstallPlan(candidate({ name: 'a/b', description: '', version: '1' })).blocked,
    ).toMatch(/neither packages nor remotes/);
  });

  it('refuses non-http remote URLs, warns on plain http', () => {
    const remote = (url: string) =>
      buildInstallPlan(
        candidate({ name: 'a/b', description: '', version: '1', remotes: [{ type: 'sse', url }] }),
      );
    expect(remote('file:///etc/passwd').blocked).toMatch(/not an http/);
    expect(remote('http://example.com/sse').warnings).toContain(
      'remote endpoint is not served over https',
    );
  });

  it('stores the parsed remote URL, so no control character reaches the plan', () => {
    const plan = buildInstallPlan(
      candidate({
        name: 'a/b',
        description: '',
        version: '1',
        remotes: [{ type: 'sse', url: 'https://x.example/a\n✓ Version pinned' }],
      }),
    );
    expect(plan.url).toBe('https://x.example/a%E2%9C%93%20Version%20pinned');
    expect(plan.input.url).toBe(plan.url);
    expect(plan.provenance.remote?.url).toBe(plan.url);
  });

  it('warns about non-default package registries', () => {
    const raw = structuredClone(SCHEMA_2025_09_29);
    raw.packages[0].registryBaseUrl = 'https://npm.evil.example';
    expect(buildInstallPlan(candidate(raw)).warnings[0]).toMatch(/not the default/);
  });
});

describe('helpers', () => {
  it('publisherOf / localNameFor', () => {
    expect(publisherOf('io.github.Acme/x')).toBe('github:Acme');
    expect(publisherOf('com.example.api/x')).toBe('domain:api.example.com');
    expect(localNameFor('io.github.acme/weather')).toBe('weather');
    expect(localNameFor('@scope/pkg')).toBe('pkg');
    expect(localNameFor('///')).toBe('server');
  });

  it('manualPlan reports keys, nothing pinned', () => {
    const plan = manualPlan({
      name: 'm',
      command: 'node',
      args: ['s.js'],
      env: { A: '1' },
      source: 'manual',
    });
    expect(plan).toMatchObject({
      source: 'manual',
      command: 'node',
      args: ['s.js'],
      provenance: { pinned: false, checks: [] },
    });
    expect(plan.requirements).toEqual([
      { key: 'A', kind: 'env', required: false, secret: false, present: true },
    ]);
  });
});
