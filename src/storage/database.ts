// =============================================================================
// agent-discover — Storage layer
//
// Thin wrapper around agent-common's createDb. Pre-migration shim seeds the
// `_meta.schema_version` row from the legacy `pragma user_version` value so
// existing installations migrate cleanly to agent-common's _meta-table runner
// without re-running migrations against tables that already have the columns.
// All ALTER TABLE statements in v2/v3 use PRAGMA table_info guards to stay
// idempotent on partially-migrated DBs.
// =============================================================================

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { createDb as createKitDb, type Db, type Migration } from 'agent-common';

export type { Db } from 'agent-common';

export interface DbOptions {
  /** Use ':memory:' for tests, or a file path. Defaults to ~/.claude/agent-discover.db */
  path?: string;
  /** Enable verbose logging to stderr */
  verbose?: boolean;
}

export function createDb(options: DbOptions = {}): Db {
  const path = resolveDbPath(options.path);
  seedMetaFromUserVersion(path);
  return createKitDb({ path, migrations, verbose: options.verbose });
}

function resolveDbPath(path?: string): string {
  if (path) return path;
  const envPath = process.env.AGENT_DISCOVER_DB;
  if (envPath) return envPath;
  const dir = join(homedir(), '.claude');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'agent-discover.db');
}

/**
 * Bridge legacy pragma user_version DBs into agent-common's _meta table.
 * Opens the DB once, copies user_version → _meta.schema_version (if _meta is
 * empty), then closes. Safe on fresh DBs (both values are 0). Skipped for
 * in-memory DBs.
 */
function seedMetaFromUserVersion(path: string): void {
  if (path === ':memory:') return;
  const raw = new Database(path);
  try {
    raw.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const existing = raw.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    if (existing) return;
    const userVersion = raw.pragma('user_version', { simple: true }) as number;
    if (userVersion > 0) {
      raw
        .prepare(`INSERT INTO _meta (key, value) VALUES ('schema_version', ?)`)
        .run(String(userVersion));
    }
  } finally {
    raw.close();
  }
}

// ---------------------------------------------------------------------------
// Migrations — version-ordered, applied by agent-common's runner.
// All ALTER TABLE statements are guarded so they're safe to re-run on DBs
// that legacy pragma-user_version code already touched.
// ---------------------------------------------------------------------------

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

const migrations: Migration[] = [
  {
    version: 1,
    up: (db: Database.Database) => {
      db.exec(`
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
    },
  },
  {
    version: 2,
    up: (db: Database.Database) => {
      if (!hasColumn(db, 'servers', 'approval_status')) {
        db.exec(`ALTER TABLE servers ADD COLUMN approval_status TEXT DEFAULT 'experimental'`);
      }
      if (!hasColumn(db, 'servers', 'latest_version')) {
        db.exec(`ALTER TABLE servers ADD COLUMN latest_version TEXT`);
      }
      if (!hasColumn(db, 'servers', 'last_health_check')) {
        db.exec(`ALTER TABLE servers ADD COLUMN last_health_check TEXT`);
      }
      if (!hasColumn(db, 'servers', 'health_status')) {
        db.exec(`ALTER TABLE servers ADD COLUMN health_status TEXT DEFAULT 'unknown'`);
      }
      if (!hasColumn(db, 'servers', 'error_count')) {
        db.exec(`ALTER TABLE servers ADD COLUMN error_count INTEGER DEFAULT 0`);
      }

      db.exec(`
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
    },
  },
  {
    version: 3,
    up: (db: Database.Database) => {
      if (hasColumn(db, 'servers', 'approval_status')) {
        db.exec(`ALTER TABLE servers DROP COLUMN approval_status`);
      }
    },
  },
];
