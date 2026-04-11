// =============================================================================
// agent-discover — Health check service
//
// Monitors the health of registered MCP servers by attempting to connect
// and list tools. Updates health_status and last_health_check in the DB.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { McpProxy } from './proxy.js';
import type { HealthStatus } from '../types.js';

// Matches ACTIVATE_TIMEOUT_MS in proxy.ts — a health probe that isn't already
// active spawns a real child (e.g. `npx -y mcp-remote …`) and does the full
// MCP handshake, which easily exceeds a few seconds on cold start. 5 s was
// always unhealthy for remote-wrapped servers, causing spurious "unhealthy"
// flags and a false Inactive status in the dashboard.
const HEALTH_CHECK_TIMEOUT_MS = 60_000;

export interface HealthCheckResult {
  status: HealthStatus;
  latency_ms: number;
  error?: string;
}

export interface HealthInfo {
  status: string;
  last_check: string | null;
  error_count: number;
}

interface ServerHealthRow {
  id: number;
  name: string;
  command: string | null;
  args: string;
  env: string;
  health_status: string;
  last_health_check: string | null;
  error_count: number;
}

export class HealthService {
  constructor(
    private readonly db: Db,
    private readonly proxy: McpProxy,
  ) {}

  async checkServer(serverId: number): Promise<HealthCheckResult> {
    const row = this.db.queryOne<ServerHealthRow>('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!row) {
      return { status: 'unhealthy', latency_ms: 0, error: 'Server not found' };
    }

    const start = Date.now();
    let result: HealthCheckResult;

    if (this.proxy.isActive(row.name)) {
      // Server is active — try listing tools via proxy
      try {
        this.proxy.getServerTools(row.name);
        const latency = Date.now() - start;
        result = { status: 'healthy', latency_ms: latency };
      } catch (err) {
        const latency = Date.now() - start;
        result = {
          status: 'unhealthy',
          latency_ms: latency,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else if (row.command) {
      // Not active — try a quick activate/deactivate cycle
      try {
        const activatePromise = this.proxy.activate({
          name: row.name,
          command: row.command,
          args: JSON.parse(row.args) as string[],
          env: JSON.parse(row.env) as Record<string, string>,
        });

        const timeoutPromise = new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('Health check timed out')), HEALTH_CHECK_TIMEOUT_MS),
        );

        await Promise.race([activatePromise, timeoutPromise]);
        const latency = Date.now() - start;

        // Deactivate immediately
        try {
          await this.proxy.deactivate(row.name);
        } catch {
          /* ignore */
        }

        result = { status: 'healthy', latency_ms: latency };
      } catch (err) {
        const latency = Date.now() - start;
        // Try to clean up
        try {
          await this.proxy.deactivate(row.name);
        } catch {
          /* ignore */
        }
        result = {
          status: 'unhealthy',
          latency_ms: latency,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else {
      result = { status: 'unhealthy', latency_ms: 0, error: 'No command configured' };
    }

    if (result.status === 'unhealthy') {
      this.db.run(
        `UPDATE servers SET health_status = ?, last_health_check = datetime('now'),
         error_count = error_count + 1, updated_at = datetime('now') WHERE id = ?`,
        [result.status, serverId],
      );
    } else {
      this.db.run(
        `UPDATE servers SET health_status = ?, last_health_check = datetime('now'),
         updated_at = datetime('now') WHERE id = ?`,
        [result.status, serverId],
      );
    }

    return result;
  }

  async checkAll(): Promise<void> {
    const rows = this.db.queryAll<{ id: number }>('SELECT id FROM servers WHERE installed = 1');
    for (const row of rows) {
      try {
        await this.checkServer(row.id);
      } catch {
        /* ignore individual failures */
      }
    }
  }

  getHealth(serverId: number): HealthInfo {
    const row = this.db.queryOne<ServerHealthRow>('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!row) {
      return { status: 'unknown', last_check: null, error_count: 0 };
    }
    return {
      status: row.health_status ?? 'unknown',
      last_check: row.last_health_check ?? null,
      error_count: row.error_count ?? 0,
    };
  }
}
