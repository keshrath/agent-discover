// =============================================================================
// agent-discover — Marketplace client
//
// Fetches MCP servers from the official MCP registry API at
// registry.modelcontextprotocol.io. Provides search and browse capabilities.
// =============================================================================

import type { MarketplaceResult } from '../types.js';

const REGISTRY_API = 'https://registry.modelcontextprotocol.io';
const NPM_SEARCH_API = 'https://registry.npmjs.org/-/v1/search';
const PYPI_JSON_API = 'https://pypi.org/pypi';
const PYPI_SEARCH_HTML = 'https://pypi.org/search/';
const REQUEST_TIMEOUT_MS = 15_000;

// Curated list of well-known Python MCP server packages on PyPI. The PyPI
// search HTML endpoint is brittle and the JSON XML-RPC search is deprecated,
// so we keep a hand-maintained index of the popular ones and resolve their
// metadata at query time via the per-package JSON API (which is stable).
const CURATED_PYPI_PACKAGES: ReadonlyArray<string> = [
  // Anthropic / official reference servers
  'mcp-server-fetch',
  'mcp-server-git',
  'mcp-server-time',
  'mcp-server-sqlite',
  'mcp-server-filesystem',
  // Community
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
  // Anthropic-flavored helpers
  'mcp-python-interpreter',
  'mcp-text-editor',
  'mcp-installer',
  'mcp-proxy',
  'mcp-cli',
];

// Compare two semver-ish strings; returns >0 if a is newer
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export class MarketplaceClient {
  async browse(query?: string, limit = 20, cursor?: string): Promise<MarketplaceResult> {
    const params = new URLSearchParams();
    if (query) params.set('search', query);
    params.set('limit', String(Math.min(limit, 100)));
    if (cursor) params.set('cursor', cursor);

    const url = `${REGISTRY_API}/v0/servers?${params}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let registryResult: MarketplaceResult;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Registry API error: ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      registryResult = this.parseResponse(data);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Registry API request timed out', { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    // Augment with npm + PyPI search when a query is provided. The official
    // MCP registry is sparsely populated; many popular MCPs live only on
    // npm (@playwright/mcp, @modelcontextprotocol/server-*) or PyPI
    // (mcp-server-fetch, mcp-server-git, …).
    //
    // Dedupe key is `<source>:<name>` so cross-source name collisions
    // (e.g. mcp-server-sqlite on both npm and PyPI as different projects)
    // both remain visible, while same-source version dupes still collapse.
    if (query && !cursor) {
      const [npmResults, pypiResults] = await Promise.all([
        this.searchNpm(query, limit).catch(() => []),
        this.searchPypi(query, limit).catch(() => []),
      ]);
      const keyOf = (s: MarketplaceResult['servers'][number]): string => {
        const runtime = (s.packages?.[0]?.runtime ?? '').toLowerCase();
        const source = runtime === 'python' ? 'pypi' : runtime === 'node' ? 'npm' : 'registry';
        return `${source}:${s.name}`;
      };
      const seen = new Set(registryResult.servers.map(keyOf));
      for (const extra of [...npmResults, ...pypiResults]) {
        const k = keyOf(extra);
        if (!seen.has(k)) {
          registryResult.servers.push(extra);
          seen.add(k);
        }
      }
    }

    return registryResult;
  }

  /**
   * Search for Python MCP servers via PyPI.
   *
   * Strategy (best-effort, never blocks the main response):
   *   1. Match the query against a curated list of well-known Python MCP
   *      package names.
   *   2. In parallel, fetch live metadata for each match from the PyPI JSON
   *      API (`/pypi/<name>/json`) — this endpoint IS stable, unlike the
   *      deprecated XML-RPC search.
   *   3. Also try the public PyPI search HTML page and parse out package
   *      names with a forgiving regex; merge any extras found there.
   */
  private async searchPypi(query: string, limit: number): Promise<MarketplaceResult['servers']> {
    const q = query.toLowerCase().trim();
    const candidates = new Set<string>();

    // (1) curated list — substring match against package name
    for (const name of CURATED_PYPI_PACKAGES) {
      if (!q || name.includes(q) || q.includes('mcp')) {
        candidates.add(name);
      }
    }

    // (2) HTML search — best-effort scrape; PyPI returns a deterministic
    // listing with `<a class="package-snippet" href="/project/<name>/">`.
    try {
      const params = new URLSearchParams({ q: `${query} mcp` });
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(`${PYPI_SEARCH_HTML}?${params}`, {
          signal: controller.signal,
          headers: { Accept: 'text/html', 'User-Agent': 'agent-discover/1.x' },
        });
        if (res.ok) {
          const html = await res.text();
          const re = /<a[^>]+class="package-snippet"[^>]+href="\/project\/([^/"]+)\//g;
          let match: RegExpExecArray | null;
          let added = 0;
          while ((match = re.exec(html)) && added < limit) {
            const name = match[1].toLowerCase();
            if (name.includes('mcp') || name.includes(q)) {
              candidates.add(name);
              added++;
            }
          }
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      /* HTML scrape failure is fine, fall back to curated list only */
    }

    if (candidates.size === 0) return [];

    // (3) Resolve metadata for each candidate via the PyPI JSON API
    const names = [...candidates].slice(0, limit);
    const entries = await Promise.all(
      names.map(async (name) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const res = await fetch(`${PYPI_JSON_API}/${encodeURIComponent(name)}/json`, {
            signal: controller.signal,
          });
          if (!res.ok) return null;
          const data = (await res.json()) as {
            info?: {
              name?: string;
              version?: string;
              summary?: string;
              project_urls?: Record<string, string>;
              home_page?: string;
            };
          };
          const info = data.info ?? {};
          const repository =
            info.project_urls?.Repository ??
            info.project_urls?.Source ??
            info.project_urls?.Homepage ??
            info.home_page ??
            null;
          return {
            name: String(info.name ?? name),
            description: String(info.summary ?? ''),
            version: String(info.version ?? ''),
            repository,
            packages: [
              {
                registry_name: 'pypi',
                name: String(info.name ?? name),
                version: String(info.version ?? ''),
                runtime: 'python',
                license: null,
                url: null,
              },
            ],
          };
        } catch {
          return null;
        } finally {
          clearTimeout(timeoutId);
        }
      }),
    );

    // Filter out lookups that failed AND only keep entries that look
    // MCP-related (defensive — the curated list is trusted, but the HTML
    // scrape can pull in noise).
    const result: MarketplaceResult['servers'] = [];
    for (const e of entries) {
      if (!e) continue;
      const haystack = `${e.name} ${e.description}`.toLowerCase();
      if (!haystack.includes('mcp') && !haystack.includes('model context protocol')) continue;
      result.push(e);
    }
    return result;
  }

  private async searchNpm(query: string, limit: number): Promise<MarketplaceResult['servers']> {
    // Run two searches in parallel: one biased to keywords:mcp (catches
    // packages that opted in) and one with " mcp" appended to the text
    // (catches packages that mention MCP in name/description but didn't
    // tag themselves — e.g. @playwright/mcp). Merge and dedupe.
    const size = String(Math.min(limit, 50));
    const variants = [`${query} keywords:mcp`, `${query} mcp`];
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const responses = await Promise.all(
        variants.map(async (text) => {
          const params = new URLSearchParams({ text, size });
          try {
            const res = await fetch(`${NPM_SEARCH_API}?${params}`, { signal: controller.signal });
            if (!res.ok) return [] as Array<{ package?: Record<string, unknown> }>;
            const data = (await res.json()) as {
              objects?: Array<{ package?: Record<string, unknown> }>;
            };
            return Array.isArray(data.objects) ? data.objects : [];
          } catch {
            return [] as Array<{ package?: Record<string, unknown> }>;
          }
        }),
      );

      const seen = new Set<string>();
      const objects: Array<{ package?: Record<string, unknown> }> = [];
      for (const list of responses) {
        for (const entry of list) {
          const name = String((entry.package as Record<string, unknown> | undefined)?.name ?? '');
          if (!name || seen.has(name)) continue;
          // Filter out packages that don't appear to be MCP-related: keep
          // those whose name contains "mcp" OR whose keywords include "mcp"
          // OR whose description mentions "MCP" / "Model Context Protocol".
          const pkg = (entry.package ?? {}) as Record<string, unknown>;
          const kw = Array.isArray(pkg.keywords) ? (pkg.keywords as string[]).join(' ') : '';
          const desc = String(pkg.description ?? '');
          const haystack = `${name} ${kw} ${desc}`.toLowerCase();
          if (!haystack.includes('mcp') && !haystack.includes('model context protocol')) {
            continue;
          }
          seen.add(name);
          objects.push(entry);
        }
      }

      return objects.map((entry) => {
        const pkg = (entry.package ?? {}) as Record<string, unknown>;
        const name = String(pkg.name ?? '');
        const version = String(pkg.version ?? '');
        const description = String(pkg.description ?? '');
        const links = (pkg.links ?? {}) as Record<string, string>;
        return {
          name,
          description,
          version,
          repository: links.repository ?? null,
          packages: [
            {
              registry_name: 'npm',
              name,
              version,
              runtime: 'node',
              license: null,
              url: null,
            },
          ],
        };
      });
    } catch {
      return [];
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getServer(name: string): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${REGISTRY_API}/v0/servers/${encodeURIComponent(name)}`, {
        signal: controller.signal,
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`Registry API error: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Registry API request timed out', { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private parseResponse(data: unknown): MarketplaceResult {
    if (!data || typeof data !== 'object') {
      return { servers: [], next_cursor: null };
    }

    const obj = data as Record<string, unknown>;
    const rawServers = Array.isArray(obj.servers) ? obj.servers : [];

    // API returns { servers: [{ server: {...}, _meta: {...} }], metadata: { nextCursor } }
    const metadata = (obj.metadata ?? {}) as Record<string, unknown>;

    const mapped = rawServers.map((entry: unknown) => {
      const wrapper = entry as Record<string, unknown>;
      // Each entry wraps the actual server data under a "server" key
      const server = (wrapper.server ?? wrapper) as Record<string, unknown>;
      const repo = server.repository as Record<string, unknown> | null;
      const remotes = Array.isArray(server.remotes) ? server.remotes : [];
      return {
        name: String(server.name ?? ''),
        description: String(server.description ?? ''),
        version: String(server.version ?? ''),
        repository: repo?.url ? String(repo.url) : null,
        packages: remotes.map((r: unknown) => {
          const remote = r as Record<string, unknown>;
          return {
            registry_name: String(remote.type ?? ''),
            name: String(server.name ?? ''),
            version: String(server.version ?? ''),
            runtime: String(remote.type ?? ''),
            license: null,
            url: remote.url ? String(remote.url) : null,
          };
        }),
      };
    });

    // Dedupe by name; the registry returns one row per version. Keep the
    // entry with the highest version so the UI shows each package once.
    const dedup = new Map<string, (typeof mapped)[number]>();
    for (const s of mapped) {
      if (!s.name) continue;
      const existing = dedup.get(s.name);
      if (!existing || compareVersions(s.version, existing.version) > 0) {
        dedup.set(s.name, s);
      }
    }

    return {
      servers: [...dedup.values()],
      next_cursor: metadata.nextCursor ? String(metadata.nextCursor) : null,
    };
  }
}
