// =============================================================================
// v1.4 → 2.0 database migration: data survives, columns move to their 2.0 homes.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createDb, migrations, runMigrations } from '../src/storage/database.js';
import { ServerStore } from '../src/domain/servers.js';
import { ToolIndex } from '../src/domain/tool-index.js';
import { SecretsService } from '../src/domain/secrets.js';
import { NoopEmbeddingProvider } from '../src/embeddings/index.js';
import { toolHash } from '../src/domain/tool-hash.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seedV14(path: string): void {
  const raw = new Database(path);
  runMigrations(
    raw,
    migrations.filter((m) => m.version <= 6),
  );
  const insert = raw.prepare(
    `INSERT INTO servers (name, description, source, command, args, env, tags, transport, homepage, installed, active, latest_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    'local-a',
    'stdio server',
    'manual',
    'npx',
    '["-y","pkg"]',
    '{"K":"v"}',
    '["t"]',
    'stdio',
    null,
    1,
    1,
    '1.0.0',
  );
  insert.run(
    'remote-b',
    'remote server',
    'smithery',
    null,
    '[]',
    '{}',
    '[]',
    'streamable-http',
    'https://example.com/mcp',
    1,
    0,
    null,
  );
  raw
    .prepare(
      `INSERT INTO server_tools (server_id, name, description, input_schema) VALUES (1, 'do_it', 'Does it', '{"type":"object"}')`,
    )
    .run();
  raw
    .prepare(
      `INSERT INTO server_secrets (server_id, key, value) VALUES (2, 'AUTHORIZATION', 'Bearer x')`,
    )
    .run();
  raw
    .prepare(`INSERT INTO server_metrics (server_id, tool_name, call_count) VALUES (1, 'do_it', 7)`)
    .run();
  raw.close();
}

describe('migration 7 (v1.4 → 2.0)', () => {
  it('preserves servers, tools, secrets and metrics and moves 1.x columns', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ad-mig-'));
    const path = join(dir, 'v14.db');
    seedV14(path);

    const db = createDb({ path });
    const servers = new ServerStore(db);
    const a = servers.get('local-a')!;
    const b = servers.get('remote-b')!;

    expect(a.enabled).toBe(true); // was active
    expect(a.indexed_at).not.toBeNull(); // had tools persisted
    expect(a.args).toEqual(['-y', 'pkg']);
    expect(a.env).toEqual({ K: 'v' });
    expect(b.enabled).toBe(false);
    expect(b.url).toBe('https://example.com/mcp'); // moved out of homepage
    expect(b.homepage).toBeNull();
    expect(b.source).toBe('registry');
    expect(b.indexed_at).toBeNull(); // will be indexed in the background

    const index = new ToolIndex(db, async () => new NoopEmbeddingProvider());
    const tool = index.get('local-a', 'do_it')!;
    expect(tool.tool_hash).toBe(
      toolHash({ name: 'do_it', description: 'Does it', inputSchema: { type: 'object' } }),
    );
    expect(await index.search('do it')).toHaveLength(1); // FTS survived

    expect(new SecretsService(db).getEnvForServer(b.id)).toEqual({ AUTHORIZATION: 'Bearer x' });
    expect(
      db.queryOne<{ call_count: number }>('SELECT call_count FROM server_metrics')!.call_count,
    ).toBe(7);

    const cols = db.queryAll<{ name: string }>('PRAGMA table_info(servers)').map((c) => c.name);
    expect(cols).not.toContain('active');
    expect(cols).not.toContain('installed');
    db.close();

    // Re-opening is a no-op (idempotent runner).
    const again = createDb({ path });
    expect(new ServerStore(again).list()).toHaveLength(2);
    again.close();
  });
});
