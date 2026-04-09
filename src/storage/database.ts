// =============================================================================
// agent-discover — Storage layer
//
// Thin wrapper around agent-common's createDb. Uses adoptUserVersion so
// existing installations that previously tracked schema via `pragma
// user_version` migrate cleanly to agent-common's _meta-table runner without
// re-running migrations against tables that already have the columns. All
// ALTER TABLE statements in v2/v3 use addColumnIfMissing to stay idempotent
// on partially-migrated DBs.
// =============================================================================

import type Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';
import {
  createDb as createKitDb,
  addColumnIfMissing,
  hasColumn,
  type Db,
  type Migration,
} from 'agent-common';

export type { Db } from 'agent-common';

export interface DbOptions {
  /** Use ':memory:' for tests, or a file path. Defaults to ~/.claude/agent-discover.db */
  path?: string;
  /** Enable verbose logging to stderr */
  verbose?: boolean;
}

export function createDb(options: DbOptions = {}): Db {
  const path = resolveDbPath(options.path);
  return createKitDb({ path, migrations, verbose: options.verbose, adoptUserVersion: true });
}

function resolveDbPath(path?: string): string {
  if (path) return path;
  const envPath = process.env.AGENT_DISCOVER_DB;
  if (envPath) return envPath;
  const dir = join(homedir(), '.claude');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'agent-discover.db');
}

// ---------------------------------------------------------------------------
// Migrations — version-ordered, applied by agent-common's runner.
// All ALTER TABLE statements are guarded so they're safe to re-run on DBs
// that legacy pragma-user_version code already touched.
// ---------------------------------------------------------------------------

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
      addColumnIfMissing(db, 'servers', 'approval_status', "TEXT DEFAULT 'experimental'");
      addColumnIfMissing(db, 'servers', 'latest_version', 'TEXT');
      addColumnIfMissing(db, 'servers', 'last_health_check', 'TEXT');
      addColumnIfMissing(db, 'servers', 'health_status', "TEXT DEFAULT 'unknown'");
      addColumnIfMissing(db, 'servers', 'error_count', 'INTEGER DEFAULT 0');

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
  {
    version: 4,
    up: (db: Database.Database) => {
      // FTS5 over the per-tool catalog so find_tool can rank with BM25
      // instead of substring LIKE. Column-weighted: name >> description so
      // "slack post message" → slack_post_message ranks higher than a tool
      // that merely mentions Slack in its description. Backfilled from any
      // existing server_tools rows so existing installs work after migration.
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS server_tools_fts USING fts5(
          name, description,
          content=server_tools, content_rowid=id,
          tokenize='unicode61 remove_diacritics 1'
        );

        CREATE TRIGGER IF NOT EXISTS server_tools_ai AFTER INSERT ON server_tools BEGIN
          INSERT INTO server_tools_fts(rowid, name, description)
          VALUES (new.id, new.name, new.description);
        END;

        CREATE TRIGGER IF NOT EXISTS server_tools_ad AFTER DELETE ON server_tools BEGIN
          INSERT INTO server_tools_fts(server_tools_fts, rowid, name, description)
          VALUES ('delete', old.id, old.name, old.description);
        END;

        CREATE TRIGGER IF NOT EXISTS server_tools_au AFTER UPDATE ON server_tools BEGIN
          INSERT INTO server_tools_fts(server_tools_fts, rowid, name, description)
          VALUES ('delete', old.id, old.name, old.description);
          INSERT INTO server_tools_fts(rowid, name, description)
          VALUES (new.id, new.name, new.description);
        END;

        INSERT INTO server_tools_fts(rowid, name, description)
        SELECT id, name, description FROM server_tools;
      `);
    },
  },
];
