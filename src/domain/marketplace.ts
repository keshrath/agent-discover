// =============================================================================
// agent-discover — Marketplace
//
// search: the local MCP Registry mirror first (FTS, offline), then npm and
// PyPI federation for servers that only live in a package registry. Every
// result — registry or federated — is a normalized server.json, so install
// plans are built by one builder (install-plan.ts).
//
// resolve/plan: exact-name lookup only (no fuzzy matching) of the entry to
// install, then the InstallPlan with provenance checks.
// =============================================================================

import {
  buildInstallPlan,
  type InstallCandidate,
  type InstallPlan,
  type InstallSource,
  type RegistryStatus,
  type ServerJson,
} from './install-plan.js';
import { checkProvenance, npmLatestVersion, pypiLatestVersion } from './provenance.js';
import type { RegistryMirror } from './registry.js';
import type { ServerTransport } from '../types.js';
import { NotFoundError, ValidationError } from '../types.js';

const NPM_SEARCH_API = 'https://registry.npmjs.org/-/v1/search';
const NPM_REGISTRY = 'https://registry.npmjs.org';
const PYPI_JSON_API = 'https://pypi.org/pypi';
const PYPI_SEARCH_HTML = 'https://pypi.org/search/';
const REQUEST_TIMEOUT_MS = 15_000;

// Well-known Python MCP servers. PyPI has no search API (XML-RPC search is
// gone, the HTML page is best-effort), so these are matched locally and
// resolved through the stable per-project JSON API.
const CURATED_PYPI_PACKAGES: ReadonlyArray<string> = [
  'mcp-server-fetch',
  'mcp-server-git',
  'mcp-server-time',
  'mcp-server-sqlite',
  'mcp-server-filesystem',
  'mcp-server-aws',
  'mcp-server-bigquery',
  'mcp-server-docker',
  'mcp-server-elasticsearch',
  'mcp-server-fhir',
  'mcp-server-github',
  'mcp-server-jira',
  'mcp-server-kubernetes',
  'mcp-server-langgraph',
  'mcp-server-mongodb',
  'mcp-server-openapi',
  'mcp-server-openai',
  'mcp-server-postgres',
  'mcp-server-puppeteer',
  'mcp-server-rag-web-browser',
  'mcp-server-redis',
  'mcp-server-rememberizer',
  'mcp-server-shell',
  'mcp-server-slack',
  'mcp-server-snowflake',
  'mcp-server-spotify',
  'mcp-server-todoist',
  'mcp-server-weather',
  'mcp-python-interpreter',
  'mcp-text-editor',
  'mcp-installer',
  'mcp-proxy',
  'mcp-cli',
];

const SAFE_PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** One search result, any source. */
export interface MarketplaceEntry {
  source: InstallSource;
  name: string;
  title?: string;
  description: string;
  version: string;
  status: RegistryStatus;
  repository: string | null;
  packages: Array<{
    registry_type: string;
    identifier: string;
    version: string | null;
    transport: string;
  }>;
  remotes: Array<{ type: string; url: string }>;
}

export interface MarketplaceSearch {
  servers: MarketplaceEntry[];
  /** Where registry results came from, and per-source errors (federation is best-effort). */
  registry: 'mirror' | 'live';
  errors: Partial<Record<InstallSource, string>>;
}

export interface PlanRequest {
  source?: InstallSource;
  /** Exact registry name / npm package / PyPI project. */
  name: string;
  version?: string;
  /** Local server name. */
  local_name?: string;
  transport?: ServerTransport;
  storedSecrets?: string[];
}

function toEntry(c: InstallCandidate): MarketplaceEntry {
  const s = c.server;
  return {
    source: c.source,
    name: s.name,
    ...(s.title ? { title: s.title } : {}),
    description: s.description,
    version: s.version,
    status: c.registry?.status ?? 'active',
    repository: s.repository ?? null,
    packages: s.packages.map((p) => ({
      registry_type: p.registryType,
      identifier: p.identifier,
      version: p.version ?? null,
      transport: p.transport.type,
    })),
    remotes: s.remotes.map((r) => ({ type: r.type, url: r.url })),
  };
}

/** A federated package as a server.json with one stdio package. */
function packageServer(
  registryType: 'npm' | 'pypi',
  name: string,
  version: string,
  description: string,
  repository: string | null,
): ServerJson {
  return {
    name,
    description,
    version,
    ...(repository ? { repository } : {}),
    packages: [
      {
        registryType,
        identifier: name,
        version: version || undefined,
        transport: { type: 'stdio' },
        runtimeArguments: [],
        packageArguments: [],
        environmentVariables: [],
      },
    ],
    remotes: [],
  };
}

function looksMcp(text: string): boolean {
  const t = text.toLowerCase();
  return /\bmcp\b|mcp-|-mcp|model context protocol/.test(t);
}

function tokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && t !== 'mcp' && t !== 'server');
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

export class MarketplaceClient {
  constructor(private readonly mirror: RegistryMirror) {}

  async search(query: string, limit = 20): Promise<MarketplaceSearch> {
    const errors: MarketplaceSearch['errors'] = {};
    const synced = this.mirror.status().synced_at !== null;
    this.mirror.syncIfStale();
    // Until the first sync lands, search live; if that fails, the partly filled mirror answers.
    const registry: Promise<InstallCandidate[]> = synced
      ? Promise.resolve(this.mirror.search(query, limit))
      : this.mirror.searchLive(query, limit).catch((err: unknown) => {
          if (this.mirror.status().count === 0) throw err;
          return this.mirror.search(query, limit);
        });
    const [reg, npm, pypi] = await Promise.all([
      registry.catch((err: unknown) => {
        errors.registry = err instanceof Error ? err.message : String(err);
        return [];
      }),
      this.searchNpm(query, limit).catch((err: unknown) => {
        errors.npm = err instanceof Error ? err.message : String(err);
        return [];
      }),
      this.searchPypi(query, limit).catch((err: unknown) => {
        errors.pypi = err instanceof Error ? err.message : String(err);
        return [];
      }),
    ]);
    // A federated package already published through a registry entry is the same artifact.
    const published = new Set(
      reg.flatMap((c) => c.server.packages.map((p) => `${p.registryType}:${p.identifier}`)),
    );
    const extra = [...npm, ...pypi].filter(
      (c) => !published.has(`${c.source}:${c.server.packages[0]?.identifier}`),
    );
    return {
      servers: [...reg, ...extra].slice(0, limit).map(toEntry),
      registry: synced ? 'mirror' : 'live',
      errors,
    };
  }

  /** Exact-name lookup of an installable entry. */
  async resolve(source: InstallSource, name: string, version?: string): Promise<InstallCandidate> {
    if (source === 'registry') {
      let candidate: InstallCandidate | null;
      try {
        candidate = await this.mirror.fetchVersion(name, version ?? 'latest');
      } catch (err) {
        // Offline: the mirror still knows the latest version.
        candidate = version ? null : this.mirror.get(name);
        if (!candidate) throw err;
      }
      if (!candidate) {
        throw new NotFoundError('MCP Registry server', version ? `${name}@${version}` : name);
      }
      return candidate;
    }
    if (!SAFE_PACKAGE_NAME.test(name)) throw new ValidationError(`Invalid package name: "${name}"`);
    if (source === 'npm') {
      const path = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : name;
      const data = (await getJson(`${NPM_REGISTRY}/${path}/${version ?? 'latest'}`)) as {
        name?: string;
        version?: string;
        description?: string;
        repository?: { url?: string } | string;
      } | null;
      if (!data?.version || data.name !== name) throw new NotFoundError('npm package', name);
      const repo = typeof data.repository === 'string' ? data.repository : data.repository?.url;
      return {
        source,
        server: packageServer('npm', name, data.version, data.description ?? '', repo ?? null),
      };
    }
    const data = (await getJson(
      `${PYPI_JSON_API}/${encodeURIComponent(name)}${version ? `/${encodeURIComponent(version)}` : ''}/json`,
    )) as {
      info?: {
        name?: string;
        version?: string;
        summary?: string;
        project_urls?: Record<string, string>;
      };
    } | null;
    const info = data?.info;
    if (!info?.version || info.name?.toLowerCase() !== name.toLowerCase()) {
      throw new NotFoundError('PyPI project', name);
    }
    const repo = info.project_urls?.Repository ?? info.project_urls?.Source ?? null;
    return {
      source,
      server: packageServer('pypi', info.name, info.version, info.summary ?? '', repo),
    };
  }

  /** Resolve + build + verify the plan for one install request. */
  async plan(req: PlanRequest): Promise<InstallPlan> {
    const candidate = await this.resolve(req.source ?? 'registry', req.name, req.version);
    // Registry packages without a version (allowed since schema 2025-12-11) are pinned to the
    // package registry's current release so the consent shows exactly what runs.
    for (const pkg of candidate.server.packages) {
      if (pkg.version) continue;
      if (pkg.registryType === 'npm')
        pkg.version = (await npmLatestVersion(pkg.identifier)) ?? undefined;
      if (pkg.registryType === 'pypi')
        pkg.version = (await pypiLatestVersion(pkg.identifier)) ?? undefined;
    }
    const plan = buildInstallPlan(candidate, {
      name: req.local_name,
      transport: req.transport,
      storedSecrets: req.storedSecrets,
    });
    return checkProvenance(plan);
  }

  // ---------------------------------------------------------------------------
  // Federation
  // ---------------------------------------------------------------------------

  private async searchNpm(query: string, limit: number): Promise<InstallCandidate[]> {
    // `keywords:mcp` catches packages that opted in; the plain variant catches
    // MCP servers that mention MCP only in their name/description (@playwright/mcp).
    const size = String(Math.min(limit, 50));
    const responses = await Promise.all(
      [`${query} keywords:mcp`, `${query} mcp`].map(async (text) => {
        const data = (await getJson(
          `${NPM_SEARCH_API}?${new URLSearchParams({ text, size })}`,
        )) as {
          objects?: Array<{ package?: Record<string, unknown> }>;
        } | null;
        return Array.isArray(data?.objects) ? data.objects : [];
      }),
    );
    // Interleave the two rankings: appending would bury the plain query's top hits
    // (@modelcontextprotocol/server-everything has no mcp keyword) below the limit.
    const ranked = Array.from({ length: Math.max(...responses.map((r) => r.length)) }, (_, i) =>
      responses.map((r) => r[i]).filter(Boolean),
    ).flat();
    const seen = new Set<string>();
    const out: InstallCandidate[] = [];
    for (const { package: pkg = {} } of ranked) {
      const name = String(pkg.name ?? '');
      if (!name || seen.has(name)) continue;
      const kw = Array.isArray(pkg.keywords) ? pkg.keywords.join(' ') : '';
      const description = String(pkg.description ?? '');
      if (!looksMcp(`${name} ${kw} ${description}`)) continue;
      seen.add(name);
      const links = (pkg.links ?? {}) as Record<string, string>;
      out.push({
        source: 'npm',
        server: packageServer(
          'npm',
          name,
          String(pkg.version ?? ''),
          description,
          links.repository ?? null,
        ),
      });
    }
    return out;
  }

  private async searchPypi(query: string, limit: number): Promise<InstallCandidate[]> {
    const words = tokens(query);
    const candidates = new Set<string>(
      CURATED_PYPI_PACKAGES.filter((name) => words.some((w) => name.includes(w))),
    );
    try {
      const res = await fetch(`${PYPI_SEARCH_HTML}?${new URLSearchParams({ q: `${query} mcp` })}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: 'text/html', 'User-Agent': 'agent-discover' },
      });
      if (res.ok) {
        const html = await res.text();
        for (const m of html.matchAll(/class="package-snippet"[^>]+href="\/project\/([^/"]+)\//g)) {
          if (candidates.size >= limit) break;
          if (looksMcp(m[1])) candidates.add(m[1].toLowerCase());
        }
      }
    } catch {
      /* the HTML page is best-effort (bot challenges); curated matches remain */
    }
    const resolved = await Promise.all(
      [...candidates].slice(0, limit).map((name) => this.resolve('pypi', name).catch(() => null)),
    );
    return resolved.filter(
      (c): c is InstallCandidate =>
        c !== null && looksMcp(`${c.server.name} ${c.server.description}`),
    );
  }
}
