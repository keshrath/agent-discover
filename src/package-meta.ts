// =============================================================================
// agent-discover — package.json metadata (name + version)
//
// Thin wrapper around agent-common's readPackageMeta, locked to agent-discover's
// own package.json so MCP initialize, WebSocket payloads, REST health, and the
// MCP child client all read the authoritative version.
// =============================================================================

import { readPackageMeta as readKitPackageMeta, type PackageMeta } from 'agent-common';

export function readPackageMeta(): PackageMeta {
  return readKitPackageMeta({
    importMetaUrl: import.meta.url,
    fallbackName: 'agent-discover',
    fallbackVersion: '0.0.0',
  });
}
