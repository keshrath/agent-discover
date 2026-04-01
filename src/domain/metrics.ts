// =============================================================================
// agent-discover — Metrics service
//
// Tracks per-tool call counts, error counts, and latency for each server.
// Used by the proxy layer to record call metrics automatically.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { MetricEntry } from '../types.js';

interface MetricRow {
  server_id: number;
  tool_name: string;
  call_count: number;
  error_count: number;
  total_latency_ms: number;
  last_called_at: string | null;
}

interface OverviewRow {
  server_name: string;
  total_calls: number;
  total_errors: number;
  total_latency_ms: number;
}

export class MetricsService {
  constructor(private readonly db: Db) {}

  recordCall(serverId: number, toolName: string, latencyMs: number, success: boolean): void {
    const existing = this.db.queryOne<MetricRow>(
      'SELECT * FROM server_metrics WHERE server_id = ? AND tool_name = ?',
      [serverId, toolName],
    );

    if (existing) {
      this.db.run(
        `UPDATE server_metrics
         SET call_count = call_count + 1,
             error_count = error_count + ?,
             total_latency_ms = total_latency_ms + ?,
             last_called_at = datetime('now')
         WHERE server_id = ? AND tool_name = ?`,
        [success ? 0 : 1, latencyMs, serverId, toolName],
      );
    } else {
      this.db.run(
        `INSERT INTO server_metrics (server_id, tool_name, call_count, error_count, total_latency_ms, last_called_at)
         VALUES (?, ?, 1, ?, ?, datetime('now'))`,
        [serverId, toolName, success ? 0 : 1, latencyMs],
      );
    }
  }

  getServerMetrics(serverId: number): MetricEntry[] {
    const rows = this.db.queryAll<MetricRow>(
      'SELECT * FROM server_metrics WHERE server_id = ? ORDER BY tool_name',
      [serverId],
    );
    return rows.map((row) => ({
      tool_name: row.tool_name,
      call_count: row.call_count,
      error_count: row.error_count,
      avg_latency_ms: row.call_count > 0 ? Math.round(row.total_latency_ms / row.call_count) : 0,
      last_called_at: row.last_called_at,
    }));
  }

  getOverview(): Array<{
    server_name: string;
    total_calls: number;
    total_errors: number;
    avg_latency_ms: number;
  }> {
    const rows = this.db.queryAll<OverviewRow>(
      `SELECT s.name AS server_name,
              COALESCE(SUM(m.call_count), 0) AS total_calls,
              COALESCE(SUM(m.error_count), 0) AS total_errors,
              COALESCE(SUM(m.total_latency_ms), 0) AS total_latency_ms
       FROM servers s
       LEFT JOIN server_metrics m ON s.id = m.server_id
       GROUP BY s.id, s.name
       HAVING total_calls > 0
       ORDER BY total_calls DESC`,
    );
    return rows.map((row) => ({
      server_name: row.server_name,
      total_calls: row.total_calls,
      total_errors: row.total_errors,
      avg_latency_ms: row.total_calls > 0 ? Math.round(row.total_latency_ms / row.total_calls) : 0,
    }));
  }
}
