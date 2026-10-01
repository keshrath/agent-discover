/* global console, process */
// Builds dist/widgets/harness.html: the widget mounted in an AppBridge host with mock data.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWidget } from '../../../src/widgets/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildHarness() {
  const widget = await buildWidget();
  const js = (
    await build({
      entryPoints: [join(here, 'host.js')],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      write: false,
      minify: true,
    })
  ).outputFiles[0].text;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>agent-discover widget harness</title>
<style>
:root{color-scheme:light;--page:#eef0f3;--panel:#ffffff;--ink:#57606a}
:root[data-theme=dark]{color-scheme:dark;--page:#0e1013;--panel:#16191d;--ink:#a3acb6}
body{margin:0;padding:20px;background:var(--page);font:12px system-ui,sans-serif;color:var(--ink)}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(560px,1fr));gap:20px;align-items:start}
.panel{background:var(--panel);border-radius:14px;padding:14px 16px;box-shadow:0 1px 3px rgb(0 0 0/.08)}
h2{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin:0 0 10px}
iframe{width:100%;border:0;height:120px;display:block;background:transparent}
</style></head>
<body><div id="grid"></div>
<script>window.WIDGET_HTML=${JSON.stringify(widget).replace(/</g, '\\u003c')};</script>
<script type="module">${js}</script>
</body></html>`;
  const out = join(here, '..', '..', '..', 'dist', 'widgets', 'harness.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  console.error(await buildHarness());
