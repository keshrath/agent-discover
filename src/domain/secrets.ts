// =============================================================================
// agent-discover — Secrets management
//
// Per-server secrets (API keys, tokens). SQLite keeps only the key names and
// the backend holding each value (see trust/secret-store.ts); values are
// never returned by list(), so REST/WS/MCP output can't leak them. Secrets
// override env vars when a server is launched.
//
// Rows written before 2.0 (backend IS NULL) still carry plaintext: they are
// moved into the backend on startup and the plaintext is wiped
// (secure_delete + WAL truncate so no copy survives in free pages).
//
// Server env values (not secrets) are masked the same way in dashboard
// state; a masked value sent back unchanged keeps the stored original.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { SecretEntry } from '../types.js';
import { secretAccount, type SecretBackend } from './trust/secret-store.js';

export const SECRET_MASK = '********';

/** The server identity secrets are filed under. */
export interface SecretOwner {
  readonly id: number;
  readonly name: string;
}

function maskValue(value: string): string {
  if (value.length <= 4) return '****';
  return value.slice(0, 4) + '****';
}

export function maskEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, maskValue(String(v))]));
}

export function restoreMaskedEnv(
  incoming: Record<string, string>,
  stored: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(incoming).map(([k, v]) => [
      k,
      k in stored && v === maskValue(String(stored[k])) ? stored[k] : v,
    ]),
  );
}

export class SecretsService {
  constructor(
    private readonly db: Db,
    readonly backend: SecretBackend,
  ) {
    this.migratePlaintext();
  }

  private migratePlaintext(): void {
    const legacy = this.db.queryAll<{ id: number; server: string; key: string; value: string }>(
      `SELECT x.id, s.name AS server, x.key, x.value FROM server_secrets x
       JOIN servers s ON s.id = x.server_id WHERE x.backend IS NULL`,
    );
    if (legacy.length === 0) return;
    for (const row of legacy) this.backend.set(secretAccount(row.server, row.key), row.value);
    this.db.raw.pragma('secure_delete = ON');
    this.db.transaction(() => {
      for (const row of legacy) {
        this.db.run("UPDATE server_secrets SET value = '', backend = ? WHERE id = ?", [
          this.backend.name,
          row.id,
        ]);
      }
    });
    this.db.raw.pragma('wal_checkpoint(TRUNCATE)');
    process.stderr.write(
      `[agent-discover] moved ${legacy.length} plaintext secret(s) into the ${this.backend.name} backend\n`,
    );
  }

  /** Store a secret; false when it already had exactly this value. */
  set(server: SecretOwner, key: string, value: string): boolean {
    const account = secretAccount(server.name, key);
    const known = this.list(server).some((s) => s.key === key);
    if (known && this.backend.get(account) === value) return false;
    this.backend.set(account, value);
    this.db.run(
      `INSERT INTO server_secrets (server_id, key, value, backend, updated_at)
       VALUES (?, ?, '', ?, datetime('now'))
       ON CONFLICT(server_id, key)
       DO UPDATE SET backend = excluded.backend, updated_at = datetime('now')`,
      [server.id, key, this.backend.name],
    );
    return true;
  }

  list(server: SecretOwner): SecretEntry[] {
    return this.db
      .queryAll<{
        key: string;
        updated_at: string;
      }>('SELECT key, updated_at FROM server_secrets WHERE server_id = ? ORDER BY key', [server.id])
      .map((row) => ({ key: row.key, masked_value: SECRET_MASK, updated_at: row.updated_at }));
  }

  delete(server: SecretOwner, key: string): void {
    this.backend.delete(secretAccount(server.name, key));
    this.db.run('DELETE FROM server_secrets WHERE server_id = ? AND key = ?', [server.id, key]);
  }

  /** Remove every secret of a server (uninstall). */
  deleteAll(server: SecretOwner): void {
    for (const { key } of this.list(server)) this.delete(server, key);
  }

  getEnvForServer(server: SecretOwner): Record<string, string> {
    const env: Record<string, string> = {};
    for (const { key } of this.list(server)) {
      const value = this.backend.get(secretAccount(server.name, key));
      if (value === null) {
        process.stderr.write(
          `[agent-discover] secret ${key} of "${server.name}" is missing from the ${this.backend.name} backend\n`,
        );
      } else {
        env[key] = value;
      }
    }
    return env;
  }
}
