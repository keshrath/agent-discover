import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM build script without type declarations
import { buildWidget } from '../../src/widgets/build.mjs';

const SRC = join(import.meta.dirname, '..', '..', 'src', 'widgets');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.js') ? [p] : [];
  });
}

describe('widget build', () => {
  it('produces one self-contained HTML document', async () => {
    const html: string = await buildWidget();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import/i);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html.length).toBeLessThan(400 * 1024);
  }, 30_000);

  it('widget sources never build DOM from HTML strings', () => {
    for (const f of sources(SRC)) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write|new Function|eval\(/,
      );
    }
  });
});
