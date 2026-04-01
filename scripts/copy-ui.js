import { cpSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
cpSync(join(root, 'src', 'ui'), join(root, 'dist', 'ui'), { recursive: true });
copyFileSync(
  join(root, 'node_modules', 'morphdom', 'dist', 'morphdom-umd.min.js'),
  join(root, 'dist', 'ui', 'morphdom.min.js'),
);
