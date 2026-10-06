// =============================================================================
// agent-discover — Audit log
//
// Append-only record of trust-relevant actions (SQLite `audit_log`; an UPDATE
// trigger rejects edits). Only retention deletes rows: the oldest beyond
// `maxRows` are pruned every PRUNE_EVERY appends. Tool calls record name,
// server, duration and isError — arguments only with AGENT_DISCOVER_AUDIT_ARGS=1,
// and then with secret-looking keys and the server's secret values masked.
// =============================================================================

import type { Db } from '../../storage/database.js';

export type AuditAction =
  | 'install'
  | 'approve'
  | 'deny'
  | 'enable'
  | 'disable'
  | 'uninstall'
  | 'quarantine'
  | 'release'
  | 'flag'
  | 'secret-set'
  | 'secret-delete'
  | 'shutdown'
  | 'call_tool';

export interface AuditEvent {
  action: AuditAction;
  server?: string;
  tool?: string;
  duration_ms?: number;
  is_error?: boolean;
  detail?: Record<string, unknown>;
}

export interface AuditEntry extends AuditEvent {
  id: number;
  ts: string;
}

export interface AuditQuery {
  limit?: number;
  /** Return entries with id < before (paging backwards from newest). */
  before?: number;
  server?: string;
  action?: string;
  tool?: string;
}

const PRUNE_EVERY = 100;
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|auth|cookie|credential|private/i;

/** Mask secret-looking keys and any occurrence of a known secret value. */
export function maskArgs(value: unknown, secrets: string[], key = ''): unknown {
  if (key && SECRET_KEY.test(key)) return '********';
  if (typeof value === 'string') {
    let out = value;
    for (const s of secrets) if (s.length >= 4) out = out.split(s).join('********');
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => maskArgs(v, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        maskArgs(v, secrets, k),
      ]),
    );
  }
  return value;
}

export class AuditLog {
  private appended = 0;

  constructor(
    private readonly db: Db,
    private readonly maxRows: number,
  ) {}

  append(event: AuditEvent): void {
    this.db.run(
      `INSERT INTO audit_log (action, server, tool, duration_ms, is_error, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        event.action,
        event.server ?? null,
        event.tool ?? null,
        event.duration_ms ?? null,
        event.is_error === undefined ? null : event.is_error ? 1 : 0,
        event.detail ? JSON.stringify(event.detail) : null,
      ],
    );
    if (++this.appended % PRUNE_EVERY === 0) this.prune();
  }

  prune(): void {
    if (this.maxRows <= 0) return;
    this.db.run('DELETE FROM audit_log WHERE id <= (SELECT MAX(id) FROM audit_log) - ?', [
      this.maxRows,
    ]);
  }

  list(q: AuditQuery = {}): { entries: AuditEntry[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const col of ['server', 'action', 'tool'] as const) {
      if (q[col]) {
        where.push(`${col} = ?`);
        params.push(q[col]);
      }
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total =
      this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log ${filter}`, params)?.n ??
      0;
    const page = q.before ? [...where, 'id < ?'] : where;
    const rows = this.db.queryAll<{
      id: number;
      ts: string;
      action: AuditAction;
      server: string | null;
      tool: string | null;
      duration_ms: number | null;
      is_error: number | null;
      detail: string | null;
    }>(
      `SELECT * FROM audit_log ${page.length ? `WHERE ${page.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT ?`,
      [...params, ...(q.before ? [q.before] : []), Math.min(Math.max(q.limit ?? 100, 1), 1000)],
    );
    return {
      total,
      entries: rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        action: r.action,
        ...(r.server !== null ? { server: r.server } : {}),
        ...(r.tool !== null ? { tool: r.tool } : {}),
        ...(r.duration_ms !== null ? { duration_ms: r.duration_ms } : {}),
        ...(r.is_error !== null ? { is_error: r.is_error === 1 } : {}),
        ...(r.detail ? { detail: JSON.parse(r.detail) as Record<string, unknown> } : {}),
      })),
    };
  }
}
