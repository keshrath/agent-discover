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
  };
}
