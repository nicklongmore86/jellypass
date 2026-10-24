#!/usr/bin/env node
// Copies the household app's static files (app/static) next to the compiled client (dist/app/js, from
// tsconfig.app.json), where the server reads them from at startup. Run by `pnpm build` after tsc.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HASH_PLACEHOLDER = '__CONTENT_HASH__';
const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'static');

/**
 * A hash of every file the service worker precaches (everything under `directory` but the stamped sw.js) and of the
 * unstamped worker template (sw.js with the placeholder, which cannot contain the result): same files and worker, same
 * hash; any change to either, a new one. It names the worker's cache, so a worker-only release gets its own cache.
 */
export function contentHash(directory, template = readFileSync(join(SOURCE_DIR, 'sw.js'), 'utf8')) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const relative = posix.join(prefix, name);
      if (statSync(full).isDirectory()) walk(full, relative);
      else if (relative !== 'sw.js') files.push([relative, full]);
    }
  };
  walk(directory, '');
  const hash = createHash('sha256').update(`sw.js\0${Buffer.byteLength(template)}\0${template}`);
  for (const [relative, full] of files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const body = readFileSync(full);
    hash.update(`${relative}\0${body.length}\0`).update(body);
  }
  return hash.digest('hex').slice(0, 16);
}

/** Writes the hash of the built files into the copied service worker. */
export function stampWorker(directory) {
  const path = join(directory, 'sw.js');
  const source = readFileSync(path, 'utf8');
  if (!source.includes(HASH_PLACEHOLDER)) throw new Error(`sw.js has no ${HASH_PLACEHOLDER} to fill in`);
  writeFileSync(path, source.replaceAll(HASH_PLACEHOLDER, contentHash(directory, source)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = join(root, 'dist', 'app');
  mkdirSync(out, { recursive: true });
  for (const entry of ['index.html', 'app.css', 'manifest.webmanifest', 'sw.js', 'tmdb-logo.svg']) {
    rmSync(join(out, entry), { force: true });
  }
  rmSync(join(out, 'icons'), { recursive: true, force: true });
  cpSync(join(root, 'app', 'static'), out, { recursive: true });
  stampWorker(out);
}
