// =============================================================================
// agent-discover — Runtime configuration (environment variables)
//
// Read once per process. Every knob lives here so the daemon, the shim and
// the tests agree on defaults.
// =============================================================================

export type ExposureMode = 'native' | 'proxy';

export interface Config {
  /** Daemon listen port (AGENT_DISCOVER_PORT, default 3424). */
  readonly port: number;
  /** Daemon listen address (AGENT_DISCOVER_HOST, default 127.0.0.1). */
  readonly host: string;
  /** Daemon exits after this long with zero MCP and zero WS clients (AGENT_DISCOVER_IDLE_MS, default 30 min, 0 = never). */
  readonly idleMs: number;
  /** Upstream connections idle longer than this are closed (AGENT_DISCOVER_CONN_IDLE_MS, default 10 min). */
  readonly connIdleMs: number;
  /** native = enabled servers' tools exposed as <server>__<tool>; proxy = meta tools only (AGENT_DISCOVER_MODE). */
  readonly mode: ExposureMode;
  /** Operator opt-in: install_server may run without human consent when the client cannot elicit. */
  readonly allowUnconfirmedInstall: boolean;
  /** Tool descriptions passed to models are cut to this many chars (AGENT_DISCOVER_MAX_TOOL_DESCRIPTION, default 1024, 0 = no cap). */
  readonly maxToolDescription: number;
  /** Same for server descriptions (AGENT_DISCOVER_MAX_SERVER_DESCRIPTION, default 512). */
  readonly maxServerDescription: number;
  /** Record (masked) call arguments in the audit log (AGENT_DISCOVER_AUDIT_ARGS=1). */
  readonly auditArgs: boolean;
  /** Audit log retention in rows (AGENT_DISCOVER_AUDIT_MAX_ROWS, default 50000, 0 = unlimited). */
  readonly auditMaxRows: number;
}

function int(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env.AGENT_DISCOVER_PORT, 3424),
    host: env.AGENT_DISCOVER_HOST || '127.0.0.1',
    idleMs: int(env.AGENT_DISCOVER_IDLE_MS, 30 * 60_000),
    connIdleMs: int(env.AGENT_DISCOVER_CONN_IDLE_MS, 10 * 60_000),
    mode: env.AGENT_DISCOVER_MODE === 'proxy' ? 'proxy' : 'native',
    allowUnconfirmedInstall: env.AGENT_DISCOVER_ALLOW_UNCONFIRMED_INSTALL === '1',
    maxToolDescription: int(env.AGENT_DISCOVER_MAX_TOOL_DESCRIPTION, 1024),
    maxServerDescription: int(env.AGENT_DISCOVER_MAX_SERVER_DESCRIPTION, 512),
    auditArgs: env.AGENT_DISCOVER_AUDIT_ARGS === '1',
    auditMaxRows: int(env.AGENT_DISCOVER_AUDIT_MAX_ROWS, 50_000),
  };
}
