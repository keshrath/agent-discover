// =============================================================================
// agent-discover — Per-launch REST token
//
// The request guard admits any loopback Origin (other local dev servers,
// tools' dashboards). Pages there could still POST state-changing requests
// (e.g. /api/transient spawns a command), so every POST/PUT/PATCH/DELETE on
// /api/* must carry `X-Agent-Discover-Token` = a random value minted at
// daemon start (constant-time compare). GET stays open on loopback.
//
// Who may READ the token (GET /api/token)? Only requests whose Origin is
//   - absent: same-origin GETs from the dashboard (browsers omit Origin
//     there), non-browser local clients (already able to read the DB), and
//     no-cors loads whose response is opaque to the page;
//   - exactly `file://`: agent-desk's Electron renderer;
//   - the daemon's own origin (`http://<Host>`).
// Any other origin, loopback or not, gets 403, so a foreign page can never
// learn the token. /mcp and the stdio shim are unaffected.
// =============================================================================

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const TOKEN_HEADER = 'x-agent-discover-token';

export interface RestToken {
  readonly value: string;
  verify(candidate: string | string[] | undefined): boolean;
}

export function createRestToken(value = randomBytes(32).toString('base64url')): RestToken {
  const expected = Buffer.from(value);
  return {
    value,
    verify(candidate) {
      if (typeof candidate !== 'string') return false;
      const got = Buffer.from(candidate);
      return got.length === expected.length && timingSafeEqual(got, expected);
    },
  };
}

/** See header: absent Origin, `file://`, or the daemon's own origin. */
export function mayReadToken(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return (
    origin === undefined ||
    origin === 'file://' ||
    origin.toLowerCase() === `http://${String(req.headers.host).toLowerCase()}`
  );
}
