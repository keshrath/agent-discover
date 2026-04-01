// =============================================================================
// agent-discover — Storage layer
//
// Thin wrapper around better-sqlite3 with schema management.
// Provides a simplified query interface used by domain services.
// =============================================================================

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

export interface DbOptions {
  /** Use ':memory:' for tests, or a file path. Defaults to ~/.claude/agent-discover.db */
  path?: string;
  /** Enable verbose logging to stderr */
  verbose?: boolean;
}

export interface Db {
  readonly raw: Database.Database;
  run(sql: string, params?: unknown[]): Database.RunResult;
  queryAll<T>(sql: string, params?: unknown[]): T[];
  queryOne<T>(sql: string, params?: unknown[]): T | null;
  transaction<T>(fn: () => T): T;
  close(): void;
}

const SCHEMA_VERSION = 3;

export function createDb(options: DbOptions = {}): Db {
  const dbPath = resolveDbPath(options.path);
  const raw = new Database(dbPath, {
    verbose: options.verbose ? (msg) => process.stderr.write(`[sql] ${msg}\n`) : undefined,
  });

  raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');

  applySchema(raw);

  return {
    raw,

    run(sql: string, params?: unknown[]): Database.RunResult {
      const stmt = raw.prepare(sql);
      return params?.length ? stmt.run(...params) : stmt.run();
    },

    queryAll<T>(sql: string, params?: unknown[]): T[] {
      const stmt = raw.prepare(sql);
      return (params?.length ? stmt.all(...params) : stmt.all()) as T[];
    },

    queryOne<T>(sql: string, params?: unknown[]): T | null {
      const stmt = raw.prepare(sql);
      const row = params?.length ? stmt.get(...params) : stmt.get();
      return (row as T) ?? null;
    },

    transaction<T>(fn: () => T): T {
      return raw.transaction(fn)();
    },

    close(): void {
      try {
        raw.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function resolveDbPath(path?: string): string {
  if (path) return path;
  const envPath = process.env.AGENT_DISCOVER_DB;
  if (envPath) return envPath;
  const dir = join(homedir(), '.claude');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'agent-discover.db');
}

function applySchema(raw: Database.Database): void {
  const currentVersion = (raw.pragma('user_version', { simple: true }) as number) ?? 0;

  if (currentVersion >= SCHEMA_VERSION) return;

  raw.transaction(() => {
    if (currentVersion < 1) {
      raw.exec(`
        CREATE TABLE IF NOT EXISTS servers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          description TEXT DEFAULT '',
          source TEXT DEFAULT 'local',
          command TEXT,
          args TEXT DEFAULT '[]',
          env TEXT DEFAULT '{}',
          tags TEXT DEFAULT '[]',
          package_name TEXT,
          package_version TEXT,
          transport TEXT DEFAULT 'stdio',
          repository TEXT,
          homepage TEXT,
          installed BOOLEAN DEFAULT 0,
          active BOOLEAN DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS server_tools (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          input_schema TEXT DEFAULT '{}',
          UNIQUE(server_id, name)
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS servers_fts USING fts5(
          name, description, tags,
          content=servers, content_rowid=id
        );

        -- FTS triggers
        CREATE TRIGGER IF NOT EXISTS servers_ai AFTER INSERT ON servers BEGIN
          INSERT INTO servers_fts(rowid, name, description, tags)
          VALUES (new.id, new.name, new.description, new.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS servers_ad AFTER DELETE ON servers BEGIN
          INSERT INTO servers_fts(servers_fts, rowid, name, description, tags)
          VALUES ('delete', old.id, old.name, old.description, old.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS servers_au AFTER UPDATE ON servers BEGIN
          INSERT INTO servers_fts(servers_fts, rowid, name, description, tags)
          VALUES ('delete', old.id, old.name, old.description, old.tags);
          INSERT INTO servers_fts(rowid, name, description, tags)
          VALUES (new.id, new.name, new.description, new.tags);
        END;
      `);
    }

    if (currentVersion < 2) {
      migrateV2(raw);
    }

    if (currentVersion < 3) {
      migrateV3(raw);
    }

    raw.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

function migrateV2(raw: Database.Database): void {
  // New columns on servers table
  raw.exec(`
    ALTER TABLE servers ADD COLUMN approval_status TEXT DEFAULT 'experimental';
    ALTER TABLE servers ADD COLUMN latest_version TEXT;
    ALTER TABLE servers ADD COLUMN last_health_check TEXT;
    ALTER TABLE servers ADD COLUMN health_status TEXT DEFAULT 'unknown';
    ALTER TABLE servers ADD COLUMN error_count INTEGER DEFAULT 0;
  `);

  // Secrets table
  raw.exec(`
    CREATE TABLE IF NOT EXISTS server_secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      masked BOOLEAN DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(server_id, key)
    );
  `);

  // Metrics table
  raw.exec(`
    CREATE TABLE IF NOT EXISTS server_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      call_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      total_latency_ms INTEGER DEFAULT 0,
      last_called_at TEXT,
      UNIQUE(server_id, tool_name)
    );
  `);
}

function migrateV3(raw: Database.Database): void {
  raw.exec(`ALTER TABLE servers DROP COLUMN approval_status;`);
}
