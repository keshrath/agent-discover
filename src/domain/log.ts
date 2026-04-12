// =============================================================================
// agent-discover — Call log service
// =============================================================================

const DEFAULT_MAX = 500;
const DEFAULT_RETENTION_DAYS = 30;

export interface LogEntry {
  id: number;
  timestamp: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  response: string;
  latency_ms: number;
  success: boolean;
}

export class LogService {
  private readonly buffer: LogEntry[] = [];
  private readonly max: number;
  private readonly retentionMs: number;
  private seq = 0;
  onEntry?: (entry: LogEntry) => void;

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
    args: Record<string, unknown>,
    response: string,
    latencyMs: number,
    success: boolean,
  ): LogEntry {
    this.pruneExpired();
    const entry: LogEntry = {
      id: ++this.seq,
      timestamp: new Date().toISOString(),
      server,
      tool,
      args,
      response,
      latency_ms: latencyMs,
      success,
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.max) this.buffer.shift();
    if (this.onEntry) this.onEntry(entry);
    return entry;
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.retentionMs;
    while (this.buffer.length > 0 && new Date(this.buffer[0].timestamp).getTime() < cutoff) {
      this.buffer.shift();
    }
  }

  list(limit = 100, offset = 0): LogEntry[] {
    const reversed = [...this.buffer].reverse();
    return reversed.slice(offset, offset + limit);
  }

  count(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer.length = 0;
  }
}
