/* global process, console */
// Builds the MCP Apps widget into one self-contained HTML file (inline JS + CSS,
// no external requests) so it works under every host's default sandbox CSP.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// zod (pulled in by ext-apps -> client/core) re-exports ~40 locale bundles via
// `z.locales`; widgets only need the default English messages.
const zodEnglishOnly = {
  name: 'zod-english-only',
  setup(b) {
    b.onResolve({ filter: /\/locales\/index\.js$/ }, (a) =>
      /[\\/]zod[\\/]/.test(a.importer)
        ? { path: resolve(a.resolveDir, a.path), namespace: 'zod-locales' }
        : undefined,
    );
    b.onLoad({ filter: /.*/, namespace: 'zod-locales' }, (a) => ({
      contents: `export { default as en } from ${JSON.stringify(a.path.replace(/index\.js$/, 'en.js').replace(/\\/g, '/'))};`,
      resolveDir: dirname(a.path),
    }));
  },
};

export async function bundle(entry) {
  const r = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2022',
    write: false,
    legalComments: 'none',
    plugins: [zodEnglishOnly],
  });
  return r.outputFiles[0].text;
}

export function page(title, css, js) {
  if (/<\/script/i.test(js) || /<\/style/i.test(css))
    throw new Error('unescaped closing tag in inline asset');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<main id="root"></main>
<script>${js}</script>
</body>
</html>
`;
}

export function css() {
  return readFileSync(join(here, 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
}

export async function buildWidget() {
  return page('agent-discover', css(), await bundle(join(here, 'main.js')));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = join(here, '..', '..', 'dist', 'widgets');
  mkdirSync(dir, { recursive: true });
  const html = await buildWidget();
  writeFileSync(join(dir, 'app.html'), html);
  console.error(`widgets: app.html ${(html.length / 1024).toFixed(1)} KB`);
}
