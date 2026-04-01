// =============================================================================
// agent-discover — Local registry CRUD
//
// SQLite-backed server registry. Handles registration, listing, search,
// and uninstallation of MCP servers.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import type { ServerEntry, ServerCreateInput, ServerUpdateInput, ServerTool } from '../types.js';
import { NotFoundError, ValidationError, ConflictError } from '../types.js';

const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

interface ServerRow {
  id: number;
  name: string;
  description: string;
  source: string;
  command: string | null;
  args: string;
  env: string;
  tags: string;
  package_name: string | null;
  package_version: string | null;
  transport: string;
  repository: string | null;
  homepage: string | null;
  installed: number;
  active: number;
  latest_version: string | null;
  last_health_check: string | null;
  health_status: string;
  error_count: number;
  created_at: string;
  updated_at: string;
}

interface ToolRow {
  id: number;
  server_id: number;
  name: string;
  description: string;
  input_schema: string;
}

function rowToServer(row: ServerRow): ServerEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source as ServerEntry['source'],
    command: row.command,
    args: JSON.parse(row.args),
    env: JSON.parse(row.env),
    tags: JSON.parse(row.tags),
    package_name: row.package_name,
    package_version: row.package_version,
    transport: row.transport as ServerEntry['transport'],
    repository: row.repository,
    homepage: row.homepage,
    installed: row.installed === 1,
    active: row.active === 1,
    latest_version: row.latest_version ?? null,
    last_health_check: row.last_health_check ?? null,
    health_status: (row.health_status ?? 'unknown') as ServerEntry['health_status'],
    error_count: row.error_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToTool(row: ToolRow): ServerTool {
  return {
    id: row.id,
    server_id: row.server_id,
    name: row.name,
    description: row.description,
    input_schema: JSON.parse(row.input_schema),
  };
}

export class RegistryService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  register(input: ServerCreateInput): ServerEntry {
    if (!input.name) throw new ValidationError('Name is required');
    if (!VALID_NAME.test(input.name)) {
      throw new ValidationError(
        `Invalid name "${input.name}" — use alphanumeric, dash, underscore, dot only`,
      );
    }
    if (input.name.includes('__')) {
      throw new ValidationError('Name cannot contain "__" (reserved as tool namespace separator)');
    }

    const existing = this.getByName(input.name);
    if (existing) throw new ConflictError(`Server "${input.name}" already exists`);

    const result = this.db.run(
      `INSERT INTO servers (name, description, source, command, args, env, tags,
        package_name, package_version, transport, repository, homepage, installed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.description ?? '',
        input.source ?? 'local',
        input.command ?? null,
        JSON.stringify(input.args ?? []),
        JSON.stringify(input.env ?? {}),
        JSON.stringify(input.tags ?? []),
        input.package_name ?? null,
        input.package_version ?? null,
        input.transport ?? 'stdio',
        input.repository ?? null,
        input.homepage ?? null,
        input.command || input.transport === 'sse' || input.transport === 'streamable-http' ? 1 : 0,
      ],
    );

    const server = this.getById(result.lastInsertRowid as number)!;
    this.events.emit('server:registered', { server });
    return server;
  }

  update(name: string, updates: ServerUpdateInput): ServerEntry {
    const existing = this.getByName(name);
    if (!existing) throw new NotFoundError('Server', name);

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.description !== undefined) {
      fields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.command !== undefined) {
      fields.push('command = ?');
      values.push(updates.command);
    }
    if (updates.args !== undefined) {
      fields.push('args = ?');
      values.push(JSON.stringify(updates.args));
    }
    if (updates.env !== undefined) {
      fields.push('env = ?');
      values.push(JSON.stringify(updates.env));
    }
    if (updates.tags !== undefined) {
      fields.push('tags = ?');
      values.push(JSON.stringify(updates.tags));
    }
    if (updates.transport !== undefined) {
      fields.push('transport = ?');
      values.push(updates.transport);
    }
    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(existing.id);

    this.db.run(`UPDATE servers SET ${fields.join(', ')} WHERE id = ?`, values);

    const server = this.getById(existing.id)!;
    this.events.emit('server:updated', { server });
    return server;
  }

  updateById(id: number, updates: ServerUpdateInput): ServerEntry {
    const existing = this.getById(id);
    if (!existing) throw new NotFoundError('Server', String(id));
    return this.update(existing.name, updates);
  }

  unregister(name: string): void {
    const existing = this.getByName(name);
    if (!existing) throw new NotFoundError('Server', name);

    this.db.run('DELETE FROM servers WHERE id = ?', [existing.id]);
    this.events.emit('server:unregistered', { name });
  }

  list(options?: { query?: string; source?: string; installedOnly?: boolean }): ServerEntry[] {
    if (options?.query) {
      return this.search(options.query, options);
    }

    let sql = 'SELECT * FROM servers';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.source) {
      conditions.push('source = ?');
      params.push(options.source);
    }
    if (options?.installedOnly) {
      conditions.push('installed = 1');
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY name';

    return this.db.queryAll<ServerRow>(sql, params).map(rowToServer);
  }

  search(query: string, options?: { source?: string; installedOnly?: boolean }): ServerEntry[] {
    // Use FTS for search
    let sql = `
      SELECT s.* FROM servers s
      JOIN servers_fts fts ON s.id = fts.rowid
      WHERE servers_fts MATCH ?
    `;
    const params: unknown[] = [query + '*'];

    if (options?.source) {
      sql += ' AND s.source = ?';
      params.push(options.source);
    }
    if (options?.installedOnly) {
      sql += ' AND s.installed = 1';
    }

    sql += ' ORDER BY rank';

    try {
      return this.db.queryAll<ServerRow>(sql, params).map(rowToServer);
    } catch {
      // Fallback to LIKE search if FTS fails
      return this.fallbackSearch(query, options);
    }
  }

  private fallbackSearch(
    query: string,
    options?: { source?: string; installedOnly?: boolean },
  ): ServerEntry[] {
    const q = `%${query}%`;
    let sql = `
      SELECT * FROM servers
      WHERE (name LIKE ? OR description LIKE ? OR tags LIKE ?)
    `;
    const params: unknown[] = [q, q, q];

    if (options?.source) {
      sql += ' AND source = ?';
      params.push(options.source);
    }
    if (options?.installedOnly) {
      sql += ' AND installed = 1';
    }

    sql += ' ORDER BY name';

    return this.db.queryAll<ServerRow>(sql, params).map(rowToServer);
  }

  getByName(name: string): ServerEntry | null {
    const row = this.db.queryOne<ServerRow>('SELECT * FROM servers WHERE name = ?', [name]);
    return row ? rowToServer(row) : null;
  }

  getById(id: number): ServerEntry | null {
    const row = this.db.queryOne<ServerRow>('SELECT * FROM servers WHERE id = ?', [id]);
    return row ? rowToServer(row) : null;
  }

  setActive(name: string, active: boolean): void {
    this.db.run("UPDATE servers SET active = ?, updated_at = datetime('now') WHERE name = ?", [
      active ? 1 : 0,
      name,
    ]);
  }

  incrementErrorCount(id: number): void {
    this.db.run(
      "UPDATE servers SET error_count = error_count + 1, updated_at = datetime('now') WHERE id = ?",
      [id],
    );
  }

  setInstalled(name: string, installed: boolean): void {
    this.db.run("UPDATE servers SET installed = ?, updated_at = datetime('now') WHERE name = ?", [
      installed ? 1 : 0,
      name,
    ]);
  }

  // -------------------------------------------------------------------------
  // Server tools
  // -------------------------------------------------------------------------

  saveTools(
    serverId: number,
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>,
  ): void {
    this.db.run('DELETE FROM server_tools WHERE server_id = ?', [serverId]);
    for (const tool of tools) {
      this.db.run(
        'INSERT INTO server_tools (server_id, name, description, input_schema) VALUES (?, ?, ?, ?)',
        [serverId, tool.name, tool.description ?? '', JSON.stringify(tool.inputSchema ?? {})],
      );
    }
  }

  getTools(serverId: number): ServerTool[] {
    return this.db
      .queryAll<ToolRow>('SELECT * FROM server_tools WHERE server_id = ? ORDER BY name', [serverId])
      .map(rowToTool);
  }

  clearTools(serverId: number): void {
    this.db.run('DELETE FROM server_tools WHERE server_id = ?', [serverId]);
  }
}
