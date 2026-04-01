// =============================================================================
// agent-discover — Secrets management
//
// Manages server-specific secrets (API keys, tokens, etc.). Values are
// masked in API responses. Secrets override env vars when activating servers.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { SecretEntry } from '../types.js';

interface SecretRow {
  id: number;
  server_id: number;
  key: string;
  value: string;
  masked: number;
  created_at: string;
  updated_at: string;
}

function maskValue(value: string): string {
  if (value.length <= 4) return '****';
  return value.slice(0, 4) + '****';
}

export class SecretsService {
  constructor(private readonly db: Db) {}

  set(serverId: number, key: string, value: string): void {
    this.db.run(
      `INSERT INTO server_secrets (server_id, key, value, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(server_id, key)
       DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      [serverId, key, value],
    );
  }

  get(serverId: number, key: string): string | null {
    const row = this.db.queryOne<SecretRow>(
      'SELECT * FROM server_secrets WHERE server_id = ? AND key = ?',
      [serverId, key],
    );
    return row ? row.value : null;
  }

  list(serverId: number): SecretEntry[] {
    const rows = this.db.queryAll<SecretRow>(
      'SELECT * FROM server_secrets WHERE server_id = ? ORDER BY key',
      [serverId],
    );
    return rows.map((row) => ({
      key: row.key,
      masked_value: maskValue(row.value),
      updated_at: row.updated_at,
    }));
  }

  delete(serverId: number, key: string): void {
    this.db.run('DELETE FROM server_secrets WHERE server_id = ? AND key = ?', [serverId, key]);
  }

  getEnvForServer(serverId: number): Record<string, string> {
    const rows = this.db.queryAll<SecretRow>(
      'SELECT key, value FROM server_secrets WHERE server_id = ?',
      [serverId],
    );
    const env: Record<string, string> = {};
    for (const row of rows) {
      env[row.key] = row.value;
    }
    return env;
  }
}
