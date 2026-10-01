// =============================================================================
// agent-discover — Official MCP Registry mirror
//
// A local copy of the latest version of every registry entry (API v0.1), so
// search_servers answers from SQLite FTS in milliseconds and keeps working
// offline. Sync is incremental: the first run pages through
// `/v0.1/servers?version=latest`, later runs ask for `updated_since=<the
// newest updatedAt seen>` (which also returns deleted entries). Deleted
// entries stay in the table, hidden from search, so installed servers that
// were taken down can be flagged.
//
// Exact pinned versions are fetched live (`/servers/{name}/versions/{v}`);
// the mirror only holds the latest.
// =============================================================================

import type { Db } from '../storage/database.js';
import {
  parseRegistryFacts,
  parseServerJson,
  type InstallCandidate,
  type RegistryStatus,
} from './install-plan.js';

const PAGE_LIMIT = 100;
const MAX_PAGES = 2_000;
const REQUEST_TIMEOUT_MS = 20_000;
export const STALE_AFTER_MS = 60 * 60_000;

const SYNCED_AT_KEY = 'registry_synced_at';
const CURSOR_KEY = 'registry_updated_since';

interface Row {
  name: string;
  version: string;
  title: string | null;
  description: string;
  status: RegistryStatus;
  published_at: string | null;
  updated_at: string | null;
  is_latest: number;
  server_json: string;
  meta_json: string;
}

export interface MirrorStatus {
  count: number;
  synced_at: string | null;
  syncing: boolean;
  last_error: string | null;
}

export interface SyncResult {
  mode: 'full' | 'incremental';
  fetched: number;
  pages: number;
  ms: number;
}

function rowToCandidate(row: Row): InstallCandidate {
  const meta = JSON.parse(row.meta_json) as unknown;
  return {
    source: 'registry',
    server: parseServerJson(JSON.parse(row.server_json)),
    registry: parseRegistryFacts(meta),
  };
}

export class RegistryMirror {
  private running: Promise<SyncResult> | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly baseUrl: string,
  ) {}

  private getMeta(key: string): string | null {
    return (
      this.db.queryOne<{ value: string }>('SELECT value FROM _meta WHERE key = ?', [key])?.value ??
      null
    );
  }

  private setMeta(key: string, value: string): void {
    this.db.run('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)', [key, value]);
  }

  status(): MirrorStatus {
    const count =
      this.db.queryOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM registry_servers WHERE status != 'deleted'",
      )?.n ?? 0;
    return {
      count,
      synced_at: this.getMeta(SYNCED_AT_KEY),
      syncing: this.running !== null,
      last_error: this.lastError,
    };
  }

  isStale(now = Date.now()): boolean {
    const at = this.getMeta(SYNCED_AT_KEY);
    return !at || now - Date.parse(at) > STALE_AFTER_MS;
  }

  /** Sync now (joins a running sync). */
  sync(): Promise<SyncResult> {
    this.running ??= this.doSync()
      .then(
        (r) => {
          this.lastError = null;
          return r;
        },
        (err: unknown) => {
          this.lastError = err instanceof Error ? err.message : String(err);
          throw err;
        },
      )
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** Background sync when stale; never throws. */
  syncIfStale(): void {
    if (this.running || !this.isStale()) return;
    this.sync().catch((err) =>
      process.stderr.write(`[agent-discover] registry sync failed: ${String(err)}\n`),
    );
  }

  private async fetchJson(path: string, params?: URLSearchParams): Promise<unknown> {
    const url = `${this.baseUrl}${path}${params ? `?${params}` : ''}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`MCP Registry ${res.status} ${res.statusText} for ${path}`);
    return res.json();
  }

  private async doSync(): Promise<SyncResult> {
    const start = Date.now();
    const since = this.getMeta(CURSOR_KEY);
    const mode = since ? 'incremental' : 'full';
    let cursor: string | undefined;
    let pages = 0;
    let fetched = 0;
    let newest = since ?? '';
    do {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (since) params.set('updated_since', since);
      else params.set('version', 'latest');
      if (cursor) params.set('cursor', cursor);
      const page = (await this.fetchJson('/v0.1/servers', params)) as {
        servers?: unknown[];
        metadata?: { nextCursor?: string };
      } | null;
      const entries = Array.isArray(page?.servers) ? page.servers : [];
      this.db.transaction(() => {
        for (const entry of entries) {
          const updatedAt = this.upsert(entry);
          if (updatedAt && updatedAt > newest) newest = updatedAt;
        }
      });
      fetched += entries.length;
      pages++;
      cursor = page?.metadata?.nextCursor || undefined;
    } while (cursor && pages < MAX_PAGES);
    if (newest) this.setMeta(CURSOR_KEY, newest);
    this.setMeta(SYNCED_AT_KEY, new Date().toISOString());
    return { mode, fetched, pages, ms: Date.now() - start };
  }

  /**
   * Store one `{server, _meta}` entry. The mirror keeps the latest version per
   * name: an entry replaces the row when it is the latest, or when it is the
   * stored version (status changes such as deprecated/deleted).
   */
  private upsert(entry: unknown): string | undefined {
    const e = (entry ?? {}) as { server?: Record<string, unknown>; _meta?: unknown };
    const raw = e.server;
    if (!raw || typeof raw.name !== 'string' || typeof raw.version !== 'string') return undefined;
    const facts = parseRegistryFacts(e._meta);
    const stored = this.db.queryOne<{ version: string }>(
      'SELECT version FROM registry_servers WHERE name = ?',
      [raw.name],
    );
    const isLatest = facts.isLatest !== false;
    if (stored && !isLatest && stored.version !== raw.version) return facts.updatedAt;
    this.db.run(
      `INSERT INTO registry_servers
         (name, version, title, description, status, published_at, updated_at, is_latest, server_json, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         version = excluded.version, title = excluded.title, description = excluded.description,
         status = excluded.status, published_at = excluded.published_at,
         updated_at = excluded.updated_at, is_latest = excluded.is_latest,
         server_json = excluded.server_json, meta_json = excluded.meta_json`,
      [
        raw.name,
        raw.version,
        typeof raw.title === 'string' ? raw.title : null,
        typeof raw.description === 'string' ? raw.description : '',
        facts.status,
        facts.publishedAt ?? null,
        facts.updatedAt ?? null,
        isLatest ? 1 : 0,
        JSON.stringify(raw),
        JSON.stringify(e._meta ?? {}),
      ],
    );
    return facts.updatedAt;
  }

  /** Full-text search over the mirror (deleted entries hidden, deprecated ranked last). */
  search(query: string, limit: number): InstallCandidate[] {
    const tokens = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t}"*`).join(' OR ');
    const rows = this.db.queryAll<Row>(
      `SELECT r.* FROM registry_servers r JOIN registry_servers_fts f ON r.rowid = f.rowid
       WHERE registry_servers_fts MATCH ? AND r.status != 'deleted'
       ORDER BY (r.status = 'deprecated'), bm25(registry_servers_fts, 6.0, 4.0, 1.0)
       LIMIT ?`,
      [match, limit],
    );
    return rows.map(rowToCandidate);
  }

  /** Mirror row by exact name (including deleted entries). */
  get(name: string): InstallCandidate | null {
    const row = this.db.queryOne<Row>('SELECT * FROM registry_servers WHERE name = ?', [name]);
    return row ? rowToCandidate(row) : null;
  }

  /** Registry status per name (for flagging installed servers). */
  statuses(names: string[]): Map<string, RegistryStatus> {
    const out = new Map<string, RegistryStatus>();
    if (names.length === 0) return out;
    const rows = this.db.queryAll<{ name: string; status: RegistryStatus }>(
      `SELECT name, status FROM registry_servers WHERE name IN (${names.map(() => '?').join(',')})`,
      names,
    );
    for (const r of rows) out.set(r.name, r.status);
    return out;
  }

  /** Live lookup of an exact version (or 'latest'); refreshes the mirror row for latest. */
  async fetchVersion(name: string, version = 'latest'): Promise<InstallCandidate | null> {
    const data = (await this.fetchJson(
      `/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
    )) as { server?: unknown; _meta?: unknown } | null;
    if (!data?.server) return null;
    const candidate: InstallCandidate = {
      source: 'registry',
      server: parseServerJson(data.server),
      registry: parseRegistryFacts(data._meta),
    };
    if (candidate.server.name !== name) return null;
    if (version === 'latest' || candidate.registry?.isLatest) {
      this.db.transaction(() => this.upsert(data));
    }
    return candidate;
  }

  /** Live substring search (used only while the mirror has never synced). */
  async searchLive(query: string, limit: number): Promise<InstallCandidate[]> {
    const params = new URLSearchParams({
      search: query,
      version: 'latest',
      limit: String(Math.min(limit, PAGE_LIMIT)),
    });
    const page = (await this.fetchJson('/v0.1/servers', params)) as { servers?: unknown[] } | null;
    return (Array.isArray(page?.servers) ? page.servers : [])
      .map((entry) => {
        const e = (entry ?? {}) as { server?: unknown; _meta?: unknown };
        return {
          source: 'registry' as const,
          server: parseServerJson(e.server),
          registry: parseRegistryFacts(e._meta),
        };
      })
      .filter((c) => c.server.name && c.registry.status !== 'deleted');
  }
}
