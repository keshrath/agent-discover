// =============================================================================
// agent-discover — Version reader
// =============================================================================

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _version = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  _version = pkg.version ?? '0.0.0';
} catch {
  // Fallback if package.json not found
}

export const version = _version;
