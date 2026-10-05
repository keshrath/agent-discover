/* global process, fetch, AbortSignal */
// GET /api/status ({mode, servers}) for the SessionStart hook and the status line.
export const base = `http://127.0.0.1:${process.env.AGENT_DISCOVER_PORT || '3424'}`;

/** Undefined when the daemon is not running; never starts it. */
export async function readStatus(timeoutMs) {
  try {
    const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const st = await res.json();
    return Array.isArray(st?.servers) ? st : undefined;
  } catch {
    return undefined;
  }
}

/** Servers the user should look at: quarantined (tool drift) or enabled but unhealthy. */
export function attention(servers) {
  return servers.filter((s) => s.quarantined || (s.enabled && s.health_status === 'unhealthy'));
}
