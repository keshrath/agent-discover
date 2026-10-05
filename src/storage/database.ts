// =============================================================================
// agent-discover — Storage layer
//
// better-sqlite3 (WAL) with a small version-ordered migration runner. The
// schema version lives in `_meta.schema_version` (where 1.x DBs already
// track it); DBs older than that, which used `pragma user_version`, are
// adopted from it. Every ALTER is guarded so partially-migrated DBs re-run
// cleanly.
//
// Migration 7 is the 2.0 schema: proper url/headers columns (1.x stored the
// remote URL in `homepage`), `enabled` separate from connection state,
// per-server protocol-era cache, and a tool index with tool_hash. It alters
// in place (never drops `servers`, which would cascade-delete secrets and
// metrics through the ON DELETE CASCADE foreign keys).
//
// Migration 8 is the trust schema: tool pins (rug-pull defense), the
// append-only audit log and the secrets backend marker (values leave the DB;
// SecretsService moves legacy plaintext on startup). Servers indexed before 8 are pinned to their current tools: they
// were installed by the user, so the upgrade trusts what is there.
// =============================================================================

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { dataDir } from '../config.js';
import { join } from 'path';
import { existsSync, mkdirSync, renameSync } from 'fs';
import { toolHash } from '../domain/tool-hash.js';
import { buildDocument, FTS_SCHEMA } from '../domain/tool-doc.js';

export interface Db {
  readonly raw: Database.Database;
  run(sql: string, params?: unknown[]): Database.RunResult;
  queryAll<T>(sql: string, params?: unknown[]): T[];
  queryOne<T>(sql: string, params?: unknown[]): T | null;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface Migration {
  version: number;
  up: (raw: Database.Database) => void;
}

export interface DbOptions {
  /** ':memory:' for tests, or a file path. Defaults to $AGENT_DISCOVER_DB, else agent-discover.db in dataDir(). */
  path?: string;
}

export function createDb(options: DbOptions = {}): Db {
  const raw = new Database(resolveDbPath(options.path));
  raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');
  runMigrations(raw, migrations);
  return {
    raw,
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    queryAll: <T>(sql: string, params: unknown[] = []) => raw.prepare(sql).all(...params) as T[],
    queryOne: <T>(sql: string, params: unknown[] = []) =>
      (raw.prepare(sql).get(...params) as T | undefined) ?? null,
    transaction: <T>(fn: () => T) => raw.transaction(fn)(),
    close: () => {
      if (raw.open) raw.close();
    },
  };
}

const DB_FILE = 'agent-discover.db';
/** Files that live next to the DB: SQLite WAL/SHM and the file secret store (secret-store.ts). */
const COMPANIONS = [`${DB_FILE}-wal`, `${DB_FILE}-shm`];
const SECRET_FILES = ['agent-discover-secrets.json', 'agent-discover-secrets.key'];

/** Whether another process has the SQLite DB open (a 1.x daemon still running). */
function inUse(path: string): boolean {
  const probe = new Database(path, { timeout: 0, fileMustExist: true });
  try {
    probe.pragma('locking_mode = EXCLUSIVE');
    probe.exec('BEGIN EXCLUSIVE');
    probe.exec('COMMIT');
    return false;
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_BUSY') return true;
    throw err;
  } finally {
    probe.close();
  }
}

/**
 * 1.x kept its DB in ~/.claude. Move it (with WAL/SHM and the secret files) into
 * the data dir once. Never while another process uses it: migrating the schema
 * under a running 1.x would break that process.
 */
function adoptLegacyDb(legacyDir: string, dir: string): void {
  const legacy = join(legacyDir, DB_FILE);
  if (!existsSync(legacy)) return;
  if (inUse(legacy)) {
    throw new Error(
      `${legacy} is in use by another process (agent-discover 1.x still running?). Stop it and start again; the database then moves to ${dir}.`,
    );
  }
  for (const f of [DB_FILE, ...COMPANIONS, ...SECRET_FILES]) {
    if (existsSync(join(legacyDir, f))) renameSync(join(legacyDir, f), join(dir, f));
  }
  process.stderr.write(`[agent-discover] moved the 1.x database from ${legacyDir} to ${dir}\n`);
}

/**
 * $AGENT_DISCOVER_DB, else agent-discover.db in dataDir(). The 1.x DB is adopted
 * only into the default data dir: an explicit AGENT_DISCOVER_DATA_DIR is a
 * separate instance (tests, a second profile) and must not take the user's data.
 */
export function resolveDbPath(
  path?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  if (path) return path;
  if (env.AGENT_DISCOVER_DB) return env.AGENT_DISCOVER_DB;
  const dir = dataDir(env, platform, home);
  mkdirSync(dir, { recursive: true });
  const db = join(dir, DB_FILE);
  if (!existsSync(db) && !env.AGENT_DISCOVER_DATA_DIR) adoptLegacyDb(join(home, '.claude'), dir);
  return db;
}

/** Apply every migration above the stored version, in one transaction. */
export function runMigrations(raw: Database.Database, list: Migration[]): void {
  raw.exec('CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = raw.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const current = row
    ? parseInt(row.value, 10)
    : (raw.pragma('user_version', { simple: true }) as number) || 0;
  const pending = [...list]
    .sort((a, b) => a.version - b.version)
    .filter((m) => m.version > current);
  if (pending.length === 0) return;
  raw.transaction(() => {
    for (const m of pending) m.up(raw);
    raw
      .prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)")
      .run(String(pending[pending.length - 1].version));
  })();
}

function hasColumn(raw: Database.Database, table: string, column: string): boolean {
  return (raw.pragma(`table_info(${table})`) as Array<{ name: string }>).some(
    (c) => c.name === column,
  );
}

function addColumnIfMissing(
  raw: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  if (!hasColumn(raw, table, column)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// ---------------------------------------------------------------------------
// Migrations — version-ordered. Guarded so they're safe to re-run on DBs
// that legacy pragma-user_version code already touched.
// ---------------------------------------------------------------------------

export const migrations: Migration[] = [
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
  {
    version: 5,
    up: (db: Database.Database) => {
      // Tier 3: semantic search via embeddings. Each tool gets a vector
      // representation of its name+description, stored as a JSON-encoded
      // float32 array. Brute-force cosine similarity at query time — fast
      // enough for any realistic catalog (~10ms for N=10k on modern CPUs)
      // and avoids a native ANN dependency. Embeddings are optional: tools
      // without an embedding fall back to BM25 ranking only.
      addColumnIfMissing(db, 'server_tools', 'embedding', 'TEXT');
      addColumnIfMissing(db, 'server_tools', 'embedding_model', 'TEXT');
    },
  },
  {
    version: 6,
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS test_presets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_name TEXT NOT NULL,
          kind TEXT NOT NULL,
          target_name TEXT NOT NULL,
          preset_name TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(server_name, kind, target_name, preset_name)
        );

        CREATE INDEX IF NOT EXISTS idx_test_presets_lookup
          ON test_presets(server_name, kind, target_name);
      `);
    },
  },
  {
    version: 7,
    up: (db: Database.Database) => {
      addColumnIfMissing(db, 'servers', 'url', 'TEXT');
      addColumnIfMissing(db, 'servers', 'headers', "TEXT DEFAULT '{}'");
      addColumnIfMissing(db, 'servers', 'enabled', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'servers', 'quarantined', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'servers', 'indexed_at', 'TEXT');
      addColumnIfMissing(db, 'servers', 'protocol_era', 'TEXT');
      addColumnIfMissing(db, 'servers', 'discover_result', 'TEXT');
      addColumnIfMissing(db, 'servers', 'era_checked_at', 'TEXT');

      if (hasColumn(db, 'servers', 'active')) {
        // 1.x: `active` meant "exposed to hosts"; remote URLs lived in `homepage`;
        // tools were only persisted while active, so those servers are indexed.
        db.exec(`
          UPDATE servers SET enabled = active;
          UPDATE servers SET url = homepage, homepage = NULL
            WHERE transport IN ('sse', 'streamable-http') AND url IS NULL;
          UPDATE servers SET source = 'registry' WHERE source = 'smithery';
          UPDATE servers SET indexed_at = datetime('now')
            WHERE id IN (SELECT DISTINCT server_id FROM server_tools);
        `);
        db.exec('ALTER TABLE servers DROP COLUMN active');
      }
      if (hasColumn(db, 'servers', 'installed'))
        db.exec('ALTER TABLE servers DROP COLUMN installed');
      if (hasColumn(db, 'servers', 'latest_version')) {
        db.exec('ALTER TABLE servers DROP COLUMN latest_version');
      }

      addColumnIfMissing(db, 'server_tools', 'title', 'TEXT');
      addColumnIfMissing(db, 'server_tools', 'output_schema', 'TEXT');
      addColumnIfMissing(db, 'server_tools', 'annotations', 'TEXT');
      addColumnIfMissing(db, 'server_tools', 'tool_hash', "TEXT NOT NULL DEFAULT ''");

      const rows = db
        .prepare(
          "SELECT id, name, description, input_schema FROM server_tools WHERE tool_hash = ''",
        )
        .all() as Array<{ id: number; name: string; description: string; input_schema: string }>;
      const update = db.prepare('UPDATE server_tools SET tool_hash = ? WHERE id = ?');
      for (const row of rows) {
        let inputSchema: unknown = {};
        try {
          inputSchema = JSON.parse(row.input_schema);
        } catch {
          /* keep {} for unparseable legacy rows */
        }
        update.run(toolHash({ name: row.name, description: row.description, inputSchema }), row.id);
      }
    },
  },
  {
    version: 8,
    up: (db: Database.Database) => {
      addColumnIfMissing(db, 'server_secrets', 'backend', 'TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS server_pins (
          server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
          tools TEXT NOT NULL,
          pinned_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          action TEXT NOT NULL,
          server TEXT,
          tool TEXT,
          duration_ms INTEGER,
          is_error INTEGER,
          detail TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_log(server, id);
        CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, id);
        CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      `);

      const rows = db
        .prepare(
          `SELECT t.server_id, t.name, t.description, t.input_schema, t.annotations, t.tool_hash
           FROM server_tools t JOIN servers s ON s.id = t.server_id
           WHERE s.indexed_at IS NOT NULL ORDER BY t.server_id, t.name`,
        )
        .all() as Array<{
        server_id: number;
        name: string;
        description: string | null;
        input_schema: string;
        annotations: string | null;
        tool_hash: string;
      }>;
      const pins = new Map<number, Record<string, unknown>>();
      for (const r of rows) {
        const tools = pins.get(r.server_id) ?? {};
        tools[r.name] = {
          hash: r.tool_hash,
          description: r.description ?? '',
          input_schema: safeJson(r.input_schema) ?? {},
          annotations: safeJson(r.annotations),
        };
        pins.set(r.server_id, tools);
      }
      const insert = db.prepare(
        'INSERT OR IGNORE INTO server_pins (server_id, tools) VALUES (?, ?)',
      );
      for (const [serverId, tools] of pins) insert.run(serverId, JSON.stringify(tools));
    },
  },
  {
    // W3: official MCP Registry mirror (latest version per name) + the
    // registry name an installed server came from.
    version: 9,
    up: (db: Database.Database) => {
      addColumnIfMissing(db, 'servers', 'registry_name', 'TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS registry_servers (
          name TEXT PRIMARY KEY,
          version TEXT NOT NULL,
          title TEXT,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          published_at TEXT,
          updated_at TEXT,
          is_latest INTEGER NOT NULL DEFAULT 1,
          server_json TEXT NOT NULL,
          meta_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS registry_servers_fts USING fts5(
          name, title, description,
          content=registry_servers, content_rowid=rowid,
          tokenize='porter unicode61 remove_diacritics 1'
        );

        CREATE TRIGGER IF NOT EXISTS registry_servers_ai AFTER INSERT ON registry_servers BEGIN
          INSERT INTO registry_servers_fts(rowid, name, title, description)
          VALUES (new.rowid, new.name, coalesce(new.title, ''), new.description);
        END;

        CREATE TRIGGER IF NOT EXISTS registry_servers_ad AFTER DELETE ON registry_servers BEGIN
          INSERT INTO registry_servers_fts(registry_servers_fts, rowid, name, title, description)
          VALUES ('delete', old.rowid, old.name, coalesce(old.title, ''), old.description);
        END;

        CREATE TRIGGER IF NOT EXISTS registry_servers_au AFTER UPDATE ON registry_servers BEGIN
          INSERT INTO registry_servers_fts(registry_servers_fts, rowid, name, title, description)
          VALUES ('delete', old.rowid, old.name, coalesce(old.title, ''), old.description);
          INSERT INTO registry_servers_fts(rowid, name, title, description)
          VALUES (new.rowid, new.name, coalesce(new.title, ''), new.description);
        END;
      `);
    },
  },
  {
    // W1 retrieval: fielded FTS5 index (name / description / args) with porter
    // stemming, written by ToolIndex.save — replaces the trigger-synced
    // name/description table and the hand-written synonym list. Stored vectors
    // were built from another text without query/document formatting, so they
    // are dropped and recomputed on the next index.
    version: 10,
    up: (db: Database.Database) => {
      db.exec(`
        DROP TRIGGER IF EXISTS server_tools_ai;
        DROP TRIGGER IF EXISTS server_tools_ad;
        DROP TRIGGER IF EXISTS server_tools_au;
        DROP TABLE IF EXISTS server_tools_fts;
        ${FTS_SCHEMA}
        UPDATE server_tools SET embedding = NULL, embedding_model = NULL;
      `);
      const rows = db
        .prepare('SELECT id, name, title, description, input_schema FROM server_tools')
        .all() as Array<{
        id: number;
        name: string;
        title: string | null;
        description: string;
        input_schema: string;
      }>;
      const insert = db.prepare(
        'INSERT INTO server_tools_fts (rowid, name, description, args) VALUES (?, ?, ?, ?)',
      );
      for (const row of rows) {
        let inputSchema: Record<string, unknown> = {};
        try {
          inputSchema = JSON.parse(row.input_schema) as Record<string, unknown>;
        } catch {
          /* unparseable legacy schema (kept by migration 7): index without args */
        }
        const doc = buildDocument({ ...row, inputSchema });
        insert.run(row.id, doc.name, doc.description, doc.args);
      }
    },
  },
  {
    // 3.0: the web dashboard's tester presets went with the dashboard.
    version: 11,
    up: (db: Database.Database) => db.exec('DROP TABLE IF EXISTS test_presets;'),
  },
];

function safeJson(raw: string | null): unknown {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
