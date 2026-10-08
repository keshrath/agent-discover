// =============================================================================
// agent-discover — Call log service
//
// What GET /api/logs serves. It keeps no call arguments and no successful
// output (tool payloads can carry anything); `response` is the error text of
// a failed call, the message of an elicitation, or a notification's payload.
// =============================================================================

const DEFAULT_MAX = 500;
const DEFAULT_RETENTION_DAYS = 30;

export type LogKind =
  | 'call'
  | 'ping'
  | 'resource-read'
  | 'prompt-get'
  | 'notification'
  | 'progress'
  | 'elicitation'
  | 'sampling';

export interface LogEntry {
  id: number;
  timestamp: string;
  server: string;
  tool: string;
  response: string;
  latency_ms: number;
  success: boolean;
  kind: LogKind;
}

export class LogService {
  private readonly buffer: LogEntry[] = [];
  private readonly max: number;
  private readonly retentionMs: number;
  private seq = 0;

  constructor(max = DEFAULT_MAX, retentionDays?: number) {
    this.max = max;
    const days =
      retentionDays ??
      parseInt(process.env.AGENT_DISCOVER_LOG_RETENTION_DAYS ?? String(DEFAULT_RETENTION_DAYS), 10);
    this.retentionMs = (days > 0 ? days : DEFAULT_RETENTION_DAYS) * 86_400_000;
  }

  push(
    server: string,
    tool: string,
    response: string,
    latencyMs: number,
    success: boolean,
    kind: LogKind = 'call',
  ): LogEntry {
    this.pruneExpired();
    const entry: LogEntry = {
      id: ++this.seq,
      timestamp: new Date().toISOString(),
      server,
      tool,
      response,
      latency_ms: latencyMs,
      success,
      kind,
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.max) this.buffer.shift();
    return entry;
  }

  pushNotification(server: string, method: string, payload: Record<string, unknown>): LogEntry {
    return this.push(server, method, JSON.stringify(payload), 0, true, 'notification');
  }

  pushProgress(
    server: string,
    token: string | number,
    progress: number,
    total: number | undefined,
    message: string | undefined,
  ): LogEntry {
    return this.push(
      server,
      'progress',
      JSON.stringify({ token, progress, total, message }),
      0,
      true,
      'progress',
    );
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.retentionMs;
    while (this.buffer.length > 0 && new Date(this.buffer[0].timestamp).getTime() < cutoff) {
      this.buffer.shift();
    }
  }

  list(limit = 100, offset = 0, kind?: LogKind): LogEntry[] {
    const filtered = kind ? this.buffer.filter((e) => e.kind === kind) : this.buffer;
    const reversed = [...filtered].reverse();
    return reversed.slice(offset, offset + limit);
  }

  count(kind?: LogKind): number {
    if (!kind) return this.buffer.length;
    return this.buffer.reduce((n, e) => n + (e.kind === kind ? 1 : 0), 0);
  }
}
