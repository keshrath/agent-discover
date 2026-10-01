// =============================================================================
// agent-discover — Tool hash
//
// sha256 over the security-relevant surface of a tool definition: name,
// description, inputSchema and annotations, serialized as canonical JSON
// (sorted keys) so key order never changes the hash. Trust hooks pin and
// compare these to detect upstream drift.
// =============================================================================

import { createHash } from 'node:crypto';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function toolHash(tool: {
  name: string;
  description?: string | null;
  inputSchema?: unknown;
  annotations?: unknown;
}): string {
  const payload = JSON.stringify(
    canonical({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? {},
      annotations: tool.annotations ?? null,
    }),
  );
  return createHash('sha256').update(payload).digest('hex');
}
