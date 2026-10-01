// =============================================================================
// agent-discover — Tool pins (rug-pull defense)
//
// The first index after a user-consented install pins every tool's hash plus
// the definition it covers (description, inputSchema, annotations), so a
// later drift can be shown as a readable diff. Any re-index whose tool set
// differs from the pins (changed, added or removed tool) quarantines the
// server until the user re-approves the current set.
// =============================================================================

import { createHash } from 'node:crypto';
import type { Db } from '../../storage/database.js';
import type { IndexedTool } from '../../types.js';

interface PinnedTool {
  hash: string;
  description: string;
  input_schema: Record<string, unknown>;
  annotations: Record<string, unknown> | null;
}

export interface ToolChange {
  tool: string;
  description?: { before: string; after: string };
  input_schema?: { added: string[]; removed: string[]; changed: string[] };
  annotations?: { before: unknown; after: unknown };
}

export interface Drift {
  changed: ToolChange[];
  added: string[];
  removed: string[];
}

export function isDrifted(drift: Drift): boolean {
  return drift.changed.length + drift.added.length + drift.removed.length > 0;
}

/** Order-independent digest of a tool hash set (what an approval refers to). */
export function hashSetDigest(hashes: string[]): string {
  return createHash('sha256')
    .update([...hashes].sort().join('\n'))
    .digest('hex');
}

function props(schema: Record<string, unknown>): Record<string, unknown> {
  const p = schema.properties;
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
}

function schemaChange(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b = props(before);
  const a = props(after);
  const added = Object.keys(a).filter((k) => !(k in b));
  const removed = Object.keys(b).filter((k) => !(k in a));
  const changed = Object.keys(a).filter(
    (k) => k in b && JSON.stringify(a[k]) !== JSON.stringify(b[k]),
  );
  // Non-property changes (required, additionalProperties, ...) count as a change of "(schema)".
  const { properties: _pb, ...restB } = before;
  const { properties: _pa, ...restA } = after;
  void _pb;
  void _pa;
  if (JSON.stringify(restA) !== JSON.stringify(restB)) changed.push('(schema)');
  return { added, removed, changed };
}

function describeChange(tool: string, pin: PinnedTool, now: IndexedTool): ToolChange {
  const change: ToolChange = { tool };
  if (pin.description !== now.description) {
    change.description = { before: pin.description, after: now.description };
  }
  const schema = schemaChange(pin.input_schema, now.input_schema);
  if (schema.added.length + schema.removed.length + schema.changed.length > 0) {
    change.input_schema = schema;
  }
  if (JSON.stringify(pin.annotations) !== JSON.stringify(now.annotations)) {
    change.annotations = { before: pin.annotations, after: now.annotations };
  }
  return change;
}

export class PinStore {
  constructor(private readonly db: Db) {}

  private load(serverId: number): Record<string, PinnedTool> | null {
    const row = this.db.queryOne<{ tools: string }>(
      'SELECT tools FROM server_pins WHERE server_id = ?',
      [serverId],
    );
    return row ? (JSON.parse(row.tools) as Record<string, PinnedTool>) : null;
  }

  isPinned(serverId: number): boolean {
    return this.load(serverId) !== null;
  }

  /** Pin exactly `tools` (first index, or an approval). */
  pin(serverId: number, tools: IndexedTool[]): void {
    const map: Record<string, PinnedTool> = {};
    for (const t of tools) {
      map[t.name] = {
        hash: t.tool_hash,
        description: t.description,
        input_schema: t.input_schema,
        annotations: t.annotations,
      };
    }
    this.db.run(
      `INSERT INTO server_pins (server_id, tools, pinned_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(server_id) DO UPDATE SET tools = excluded.tools, pinned_at = excluded.pinned_at`,
      [serverId, JSON.stringify(map)],
    );
  }

  /** Difference between the pinned set and `current`; empty when unpinned. */
  drift(serverId: number, current: IndexedTool[]): Drift {
    const pins = this.load(serverId);
    const drift: Drift = { changed: [], added: [], removed: [] };
    if (!pins) return drift;
    const seen = new Set<string>();
    for (const t of current) {
      seen.add(t.name);
      const pin = pins[t.name];
      if (!pin) drift.added.push(t.name);
      else if (pin.hash !== t.tool_hash) drift.changed.push(describeChange(t.name, pin, t));
    }
    drift.removed = Object.keys(pins).filter((name) => !seen.has(name));
    return drift;
  }
}
