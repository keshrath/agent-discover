// =============================================================================
// agent-discover — Published package version (from package.json)
// =============================================================================

import { readPackageMeta } from './package-meta.js';

export const version = readPackageMeta().version;
