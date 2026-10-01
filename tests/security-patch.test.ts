// =============================================================================
// agent-discover — env masking + markdown sanitising
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { runInNewContext } from 'vm';
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

describe('renderMarkdown', () => {
  const window: { AD?: { renderMarkdown(text: string): string } } = {};
  runInNewContext(readFileSync(new URL('../src/ui/markdown.js', import.meta.url), 'utf8'), {
    window,
  });
  const render = (text: string) => window.AD!.renderMarkdown(text);

  it('keeps http(s) links', () => {
    expect(render('[docs](https://example.com/a)')).toContain('href="https://example.com/a"');
  });

  it('drops javascript: links', () => {
    const html = render('[x](javascript:alert(1))');
    expect(html).not.toContain('href');
    expect(html).not.toContain('javascript:');
  });

  it('cannot break out of the href attribute', () => {
    const html = render('[x](https://e.com/"onmouseover="alert(1))');
    expect(html).not.toContain('"onmouseover="');
  });
});
