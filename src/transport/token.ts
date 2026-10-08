// =============================================================================
// agent-discover — Per-launch REST token
//
// Every POST/PUT/PATCH/DELETE on /api/* must carry `X-Agent-Discover-Token`
// = a random value minted at daemon start (constant-time compare). GET stays
// open on loopback. GET /api/token hands it to local non-browser clients (the
// Claude Code pane, scripts; already able to read the DB): the request guard
// refuses every request with an Origin, so a web page never learns it.
// /mcp and the stdio shim are unaffected.
// =============================================================================

import { randomBytes, timingSafeEqual } from 'node:crypto';

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
