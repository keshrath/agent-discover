// =============================================================================
// agent-discover — Marketplace client
//
// Fetches MCP servers from the official MCP registry API at
// registry.modelcontextprotocol.io. Provides search and browse capabilities.
// =============================================================================

import type { MarketplaceResult } from '../types.js';

const REGISTRY_API = 'https://registry.modelcontextprotocol.io';
const NPM_SEARCH_API = 'https://registry.npmjs.org/-/v1/search';
const REQUEST_TIMEOUT_MS = 15_000;

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

    // Augment with npm search when a query is provided. The official MCP
    // registry is sparsely populated; many popular MCPs (e.g. @playwright/mcp,
    // @modelcontextprotocol/server-*) live only on npm.
    if (query && !cursor) {
      try {
        const npmResults = await this.searchNpm(query, limit);
        const seen = new Set(registryResult.servers.map((s) => s.name));
        for (const npm of npmResults) {
          if (!seen.has(npm.name)) {
            registryResult.servers.push(npm);
            seen.add(npm.name);
          }
        }
      } catch {
        // npm fallback is best-effort; never block the main response
      }
    }

    return registryResult;
  }

  private async searchNpm(query: string, limit: number): Promise<MarketplaceResult['servers']> {
    const params = new URLSearchParams();
    // Bias towards MCP-tagged packages without excluding bare matches.
    params.set('text', `${query} keywords:mcp`);
    params.set('size', String(Math.min(limit, 50)));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${NPM_SEARCH_API}?${params}`, { signal: controller.signal });
      if (!res.ok) return [];
      const data = (await res.json()) as { objects?: Array<{ package?: Record<string, unknown> }> };
      const objects = Array.isArray(data.objects) ? data.objects : [];
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
