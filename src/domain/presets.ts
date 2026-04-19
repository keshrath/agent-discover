// =============================================================================
// agent-discover — Preset storage for the Test panel
// =============================================================================

import type { Db } from '../storage/database.js';

export type PresetKind = 'tool' | 'prompt';

export interface PresetEntry {
  id: number;
  server_name: string;
  kind: PresetKind;
  target_name: string;
  preset_name: string;
  payload: unknown;
  created_at: string;
  updated_at: string;
}

interface PresetRow {
  id: number;
  server_name: string;
  kind: string;
  target_name: string;
  preset_name: string;
  payload: string;
  created_at: string;
  updated_at: string;
}

function hydrate(row: PresetRow): PresetEntry {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    server_name: row.server_name,
    kind: row.kind as PresetKind,
    target_name: row.target_name,
    preset_name: row.preset_name,
    payload,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class PresetsService {
  constructor(private readonly db: Db) {}

  list(filter: { server?: string; kind?: PresetKind; target?: string } = {}): PresetEntry[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.server) {
      clauses.push('server_name = ?');
      params.push(filter.server);
    }
    if (filter.kind) {
      clauses.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.target) {
      clauses.push('target_name = ?');
      params.push(filter.target);
    }
    const sql = `SELECT * FROM test_presets${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY server_name, target_name, preset_name`;
    const rows = this.db.queryAll<PresetRow>(sql, params);
    return rows.map(hydrate);
  }

  upsert(input: {
    server: string;
    kind: PresetKind;
    target: string;
    preset: string;
    payload: unknown;
  }): PresetEntry {
    if (!input.server) throw new Error('server is required');
    if (!input.target) throw new Error('target is required');
    if (!input.preset) throw new Error('preset is required');
    if (input.kind !== 'tool' && input.kind !== 'prompt') {
      throw new Error(`kind must be "tool" or "prompt", got "${input.kind}"`);
    }
    const payloadJson = JSON.stringify(input.payload ?? {});
    this.db.run(
      `
      INSERT INTO test_presets (server_name, kind, target_name, preset_name, payload)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(server_name, kind, target_name, preset_name) DO UPDATE SET
        payload = excluded.payload,
        updated_at = datetime('now')
    `,
      [input.server, input.kind, input.target, input.preset, payloadJson],
    );
    const row = this.db.queryOne<PresetRow>(
      `SELECT * FROM test_presets
        WHERE server_name = ? AND kind = ? AND target_name = ? AND preset_name = ?`,
      [input.server, input.kind, input.target, input.preset],
    );
    if (!row) throw new Error('Failed to persist preset');
    return hydrate(row);
  }

  delete(id: number): boolean {
    const result = this.db.run('DELETE FROM test_presets WHERE id = ?', [id]);
    return result.changes > 0;
  }
}
