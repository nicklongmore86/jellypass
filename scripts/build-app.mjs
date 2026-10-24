#!/usr/bin/env node
// Copies the household app's static files (app/static) next to the compiled client (dist/app/js, from
// tsconfig.app.json), where the server reads them from at startup. Run by `pnpm build` after tsc.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'app');
mkdirSync(out, { recursive: true });
for (const entry of ['index.html', 'app.css', 'manifest.webmanifest', 'sw.js', 'tmdb-logo.svg']) {
  rmSync(join(out, entry), { force: true });
}
rmSync(join(out, 'icons'), { recursive: true, force: true });
cpSync(join(root, 'app', 'static'), out, { recursive: true });
