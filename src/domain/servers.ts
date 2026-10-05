// =============================================================================
// agent-discover — Server store
//
// SQLite-backed CRUD for server rows plus the single `toConfig` builder that
// turns a row (+ its secrets) into a connectable ServerConfig. Pure storage:
// lifecycle decisions (index, enable, connect) live in ServerLifecycle.
// =============================================================================

import type { Db } from '../storage/database.js';
import type {
  ServerConfig,
  ServerEntry,
  ServerInput,
  ServerUpdate,
  ServerTransport,
  HealthStatus,
} from '../types.js';
import { ConflictError, NotFoundError, ValidationError } from '../types.js';

const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const TRANSPORTS: ReadonlySet<string> = new Set(['stdio', 'sse', 'streamable-http']);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

interface ServerRow {
  id: number;
  name: string;
  description: string;
  source: string;
  transport: string;
  command: string | null;
  args: string;
  env: string;
  url: string | null;
  headers: string | null;
  tags: string;
  package_name: string | null;
  package_version: string | null;
  repository: string | null;
  homepage: string | null;
  registry_name: string | null;
  enabled: number;
  quarantined: number;
  indexed_at: string | null;
  health_status: string | null;
  last_health_check: string | null;
  error_count: number | null;
  created_at: string;
  updated_at: string;
}

function rowToServer(row: ServerRow): ServerEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    source: row.source as ServerEntry['source'],
    transport: row.transport as ServerTransport,
    command: row.command,
    args: JSON.parse(row.args ?? '[]'),
    env: JSON.parse(row.env ?? '{}'),
    url: row.url,
    headers: JSON.parse(row.headers ?? '{}'),
    tags: JSON.parse(row.tags ?? '[]'),
    package_name: row.package_name,
    package_version: row.package_version,
    repository: row.repository,
    homepage: row.homepage,
    registry_name: row.registry_name ?? null,
    enabled: row.enabled === 1,
    quarantined: row.quarantined === 1,
    indexed_at: row.indexed_at,
    health_status: (row.health_status ?? 'unknown') as HealthStatus,
    last_health_check: row.last_health_check,
    error_count: row.error_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateShape(s: {
  name: string;
  transport: ServerTransport;
  command?: string | null;
  args?: string[];
  url?: string | null;
  headers?: Record<string, string>;
}): void {
  if (!TRANSPORTS.has(s.transport)) {
    throw new ValidationError(`transport must be stdio, sse or streamable-http`);
  }
  if (s.transport === 'stdio') {
    if (!s.command) throw new ValidationError('command is required for stdio transport');
  } else {
    if (!s.url) throw new ValidationError(`url is required for ${s.transport} transport`);
    let parsed: URL;
    try {
      parsed = new URL(s.url);
    } catch {
      throw new ValidationError(`invalid url: ${s.url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ValidationError('url must be http(s)');
    }
  }
  for (const [k, v] of Object.entries(s.headers ?? {})) {
    if (!HEADER_NAME.test(k) || typeof v !== 'string' || /[\r\n]/.test(v)) {
      throw new ValidationError(`invalid header "${k}"`);
    }
  }
}

/** Throws ValidationError unless `input` describes a connectable server. */
export function validateServerInput(input: ServerInput): void {
  if (!input.name) throw new ValidationError('name is required');
  if (!VALID_NAME.test(input.name)) {
    throw new ValidationError(
      `Invalid name "${input.name}" — use alphanumeric, dash, underscore, dot only`,
    );
  }
  if (input.name.includes('__')) {
    throw new ValidationError('Name cannot contain "__" (reserved as tool namespace separator)');
  }
  validateShape({
    name: input.name,
    transport: input.transport ?? 'stdio',
    command: input.command,
    args: input.args,
    url: input.url,
    headers: input.headers,
  });
}

/**
 * The ONE builder from a stored server (+ its secrets) to a connectable
 * config. stdio: secrets are merged into the child env. Remote: only declared
 * header names are sent — a secret whose key matches a declared header
 * (case-insensitive) fills its value — plus `Authorization` from the
 * AUTHORIZATION secret or `Bearer <API_KEY>`. Other secrets never leave.
 */
export function toConfig(server: ServerEntry, secrets: Record<string, string>): ServerConfig {
  if (server.transport === 'stdio') {
    return {
      name: server.name,
      transport: 'stdio',
      command: server.command ?? undefined,
      args: server.args,
      env: { ...server.env, ...secrets },
      headers: {},
    };
  }
  const bySecretKey = new Map(Object.entries(secrets).map(([k, v]) => [k.toLowerCase(), v]));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(server.headers)) {
    headers[name] = bySecretKey.get(name.toLowerCase()) ?? value;
  }
  const auth = secrets.AUTHORIZATION ?? (secrets.API_KEY ? `Bearer ${secrets.API_KEY}` : undefined);
  if (auth && !Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) {
    headers.Authorization = auth;
  }
  // Declared-but-unfilled headers (registry secrets not set yet) are not sent empty.
  for (const [k, v] of Object.entries(headers)) if (v === '' || /[\r\n]/.test(v)) delete headers[k];
  return {
    name: server.name,
    transport: server.transport,
    url: server.url ?? undefined,
    args: [],
    env: {},
    headers,
  };
}

export class ServerStore {
  constructor(private readonly db: Db) {}

  create(input: ServerInput): ServerEntry {
    validateServerInput(input);
    const transport = input.transport ?? 'stdio';
    if (this.get(input.name)) throw new ConflictError(`Server "${input.name}" already exists`);

    const result = this.db.run(
      `INSERT INTO servers (name, description, source, transport, command, args, env, url, headers,
        tags, package_name, package_version, repository, homepage, registry_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.description ?? '',
        input.source ?? 'local',
        transport,
        transport === 'stdio' ? (input.command ?? null) : null,
        JSON.stringify(transport === 'stdio' ? (input.args ?? []) : []),
        JSON.stringify(input.env ?? {}),
        transport === 'stdio' ? null : (input.url ?? null),
        JSON.stringify(input.headers ?? {}),
        JSON.stringify(input.tags ?? []),
        input.package_name ?? null,
        input.package_version ?? null,
        input.repository ?? null,
        input.homepage ?? null,
        input.registry_name ?? null,
      ],
    );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  update(name: string, updates: ServerUpdate): ServerEntry {
    const existing = this.require(name);
    const merged = {
      name: existing.name,
      transport: updates.transport ?? existing.transport,
      command: updates.command ?? existing.command,
      args: updates.args ?? existing.args,
      url: updates.url ?? existing.url,
      headers: updates.headers ?? existing.headers,
    };
    validateShape(merged);

    const columns: Array<[string, unknown]> = [];
    const json = (v: unknown) => JSON.stringify(v);
    if (updates.description !== undefined) columns.push(['description', updates.description]);
    if (updates.transport !== undefined) columns.push(['transport', updates.transport]);
    if (updates.command !== undefined) columns.push(['command', updates.command]);
    if (updates.args !== undefined) columns.push(['args', json(updates.args)]);
    if (updates.env !== undefined) columns.push(['env', json(updates.env)]);
    if (updates.url !== undefined) columns.push(['url', updates.url]);
    if (updates.headers !== undefined) columns.push(['headers', json(updates.headers)]);
    if (updates.tags !== undefined) columns.push(['tags', json(updates.tags)]);
    if (updates.package_name !== undefined) columns.push(['package_name', updates.package_name]);
    if (updates.package_version !== undefined) {
      columns.push(['package_version', updates.package_version]);
    }
    if (updates.repository !== undefined) columns.push(['repository', updates.repository]);
    if (updates.homepage !== undefined) columns.push(['homepage', updates.homepage]);
    if (columns.length === 0) return existing;

    this.db.run(
      `UPDATE servers SET ${columns.map(([c]) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      [...columns.map(([, v]) => v), existing.id],
    );
    return this.getById(existing.id)!;
  }

  remove(name: string): void {
    const existing = this.require(name);
    this.db.run('DELETE FROM servers WHERE id = ?', [existing.id]);
  }

  get(name: string): ServerEntry | null {
    const row = this.db.queryOne<ServerRow>('SELECT * FROM servers WHERE name = ?', [name]);
    return row ? rowToServer(row) : null;
  }

  getById(id: number): ServerEntry | null {
    const row = this.db.queryOne<ServerRow>('SELECT * FROM servers WHERE id = ?', [id]);
    return row ? rowToServer(row) : null;
  }

  require(name: string): ServerEntry {
    const server = this.get(name);
    if (!server) throw new NotFoundError('Server', name);
    return server;
  }

  list(options: { query?: string; source?: string } = {}): ServerEntry[] {
    if (options.query) return this.search(options.query, options.source);
    const rows = options.source
      ? this.db.queryAll<ServerRow>('SELECT * FROM servers WHERE source = ? ORDER BY name', [
          options.source,
        ])
      : this.db.queryAll<ServerRow>('SELECT * FROM servers ORDER BY name');
    return rows.map(rowToServer);
  }

  /** FTS5 prefix search over name/description/tags, LIKE fallback for queries FTS rejects. */
  search(query: string, source?: string): ServerEntry[] {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0);
    if (tokens.length > 0) {
      try {
        const rows = this.db.queryAll<ServerRow>(
          `SELECT s.* FROM servers s JOIN servers_fts f ON s.id = f.rowid
           WHERE servers_fts MATCH ? ${source ? 'AND s.source = ?' : ''} ORDER BY rank`,
          source
            ? [tokens.map((t) => `"${t}"*`).join(' OR '), source]
            : [tokens.map((t) => `"${t}"*`).join(' OR ')],
        );
        if (rows.length > 0) return rows.map(rowToServer);
      } catch {
        /* fall through to LIKE */
      }
    }
    const q = `%${query}%`;
    const rows = this.db.queryAll<ServerRow>(
      `SELECT * FROM servers WHERE (name LIKE ? OR description LIKE ? OR tags LIKE ?)
       ${source ? 'AND source = ?' : ''} ORDER BY name`,
      source ? [q, q, q, source] : [q, q, q],
    );
    return rows.map(rowToServer);
  }

  enabledNames(): string[] {
    return this.db
      .queryAll<{
        name: string;
      }>('SELECT name FROM servers WHERE enabled = 1 AND quarantined = 0 ORDER BY name')
      .map((r) => r.name);
  }

  setEnabled(id: number, enabled: boolean): void {
    this.db.run("UPDATE servers SET enabled = ?, updated_at = datetime('now') WHERE id = ?", [
      enabled ? 1 : 0,
      id,
    ]);
  }

  setQuarantined(id: number, quarantined: boolean): void {
    this.db.run("UPDATE servers SET quarantined = ?, updated_at = datetime('now') WHERE id = ?", [
      quarantined ? 1 : 0,
      id,
    ]);
  }

  markIndexed(id: number): void {
    this.db.run(
      "UPDATE servers SET indexed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      [id],
    );
  }

  recordHealth(id: number, status: HealthStatus): void {
    this.db.run(
      `UPDATE servers SET health_status = ?, last_health_check = datetime('now'),
         error_count = CASE WHEN ? = 'healthy' THEN 0 ELSE error_count + 1 END,
         updated_at = datetime('now') WHERE id = ?`,
      [status, status, id],
    );
  }

  resetErrorCount(id: number): void {
    this.db.run("UPDATE servers SET error_count = 0, updated_at = datetime('now') WHERE id = ?", [
      id,
    ]);
  }

  // -- protocol-era verdict cache (SDK `connect({ prior })`) -----------------

  getEraVerdict(
    name: string,
  ): { era: 'modern' | 'legacy'; discover: unknown; checked_at: string } | null {
    const row = this.db.queryOne<{
      protocol_era: string | null;
      discover_result: string | null;
      era_checked_at: string | null;
    }>('SELECT protocol_era, discover_result, era_checked_at FROM servers WHERE name = ?', [name]);
    if (!row?.protocol_era || !row.era_checked_at) return null;
    return {
      era: row.protocol_era === 'modern' ? 'modern' : 'legacy',
      discover: row.discover_result ? JSON.parse(row.discover_result) : null,
      checked_at: row.era_checked_at,
    };
  }

  setEraVerdict(name: string, era: 'modern' | 'legacy' | null, discover?: unknown): void {
    this.db.run(
      `UPDATE servers SET protocol_era = ?, discover_result = ?,
         era_checked_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END WHERE name = ?`,
      [era, discover === undefined ? null : JSON.stringify(discover), era, name],
    );
  }
}
