// =============================================================================
// agent-discover — package.json metadata (name + version)
//
// Read once from the package root (one level above both src/ and dist/), so
// MCP serverInfo, REST health, WS state and the upstream client all report
// the published version.
// =============================================================================

import { readFileSync } from 'node:fs';

export interface PackageMeta {
  name: string;
  version: string;
}

let cached: PackageMeta | undefined;

export function readPackageMeta(): PackageMeta {
  if (!cached) {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Partial<PackageMeta>;
    cached = { name: pkg.name ?? 'agent-discover', version: pkg.version ?? '0.0.0' };
  }
  return cached;
}
