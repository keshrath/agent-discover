// =============================================================================
// agent-discover — env masking
// =============================================================================

import { describe, it, expect } from 'vitest';
import { maskEnv, restoreMaskedEnv } from '../src/domain/secrets.js';

describe('env masking', () => {
  it('masks every env value', () => {
    expect(maskEnv({ API_KEY: 'sk-123456', X: 'ab' })).toEqual({ API_KEY: 'sk-1****', X: '****' });
  });

  it('keeps stored values for masked values sent back unchanged', () => {
    const stored = { API_KEY: 'sk-123456', OTHER: 'keep-me' };
    expect(restoreMaskedEnv({ API_KEY: 'sk-1****', OTHER: 'changed', NEW: 'n' }, stored)).toEqual({
      API_KEY: 'sk-123456',
      OTHER: 'changed',
      NEW: 'n',
    });
  });
});
