// =============================================================================
// agent-discover — Marketplace client
//
// Fetches MCP servers from the official MCP registry API at
// registry.modelcontextprotocol.io. Provides search and browse capabilities.
// =============================================================================

import type { MarketplaceResult } from '../types.js';

const REGISTRY_API = 'https://registry.modelcontextprotocol.io';
const REQUEST_TIMEOUT_MS = 15_000;

export class MarketplaceClient {
  async browse(query?: string, limit = 20, cursor?: string): Promise<MarketplaceResult> {
    const params = new URLSearchParams();
    if (query) params.set('search', query);
    params.set('limit', String(Math.min(limit, 100)));
    if (cursor) params.set('cursor', cursor);

    const url = `${REGISTRY_API}/v0/servers?${params}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Registry API error: ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      return this.parseResponse(data);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Registry API request timed out', { cause: err });
      }
      throw err;
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

    return {
      servers: rawServers.map((entry: unknown) => {
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
            };
          }),
        };
      }),
      next_cursor: metadata.nextCursor ? String(metadata.nextCursor) : null,
    };
  }
}
