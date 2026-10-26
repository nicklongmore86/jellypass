#!/usr/bin/env node
// Builds the household app's served files into dist/app from app/static and the compiled client (dist/app-js, from
// tsconfig.app.json). Run by `pnpm build` after tsc.
//
// Every file the page loads except the page itself (index.html) and the service worker (sw.js, which must keep its
// address) is given a name carrying a hash of its content, `app.<hash>.css`, and every reference to it (in the page, in
// other modules' imports, in the manifest) is rewritten to match. A CDN may then keep those files for as long as it
// likes, and a page can only ever load the files its own release names: two releases never share an address. A
// reference is a quoted, exact path (`"app.css"`, `'./api.js'`); CSS may not use `url()` or `@import`, which this does
// not rewrite (the build stops if it finds one), and the TMDB logo is copied byte for byte.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HASH_PLACEHOLDER = '__CONTENT_HASH__';
export const PRECACHE_PLACEHOLDER = '__PRECACHE_PATHS__';
/** The client's `APP_VERSION` is this in the source; the build writes package.json's version in its place. */
export const VERSION_PLACEHOLDER = '__APP_VERSION__';
export const APP_PATH = '/jellypass/app/';
/** The module the page loads; only it and what it imports are built. */
const ENTRY = 'main.js';
/** Files that keep their names: the page (served at the app's address) and the worker (registered by its address). */
const UNHASHED = new Set(['index.html', 'sw.js']);
const FINGERPRINT_LENGTH = 12;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = join(ROOT, 'app', 'static');
const IMPORT = /(\b(?:from|import)\s*)(['"])(\.{1,2}\/[^'"\n]+)\2/g;

/** `app.css` -> `app.<hash>.css`. */
export function fingerprinted(path, hash) {
  const ext = posix.extname(path);
  return `${path.slice(0, path.length - ext.length)}.${hash}${ext}`;
}

/**
 * A hash of every file the service worker precaches (everything under `directory` but the stamped sw.js) and of the
 * unstamped worker template (sw.js with the placeholders, which cannot contain the result): same files and worker, same
 * hash; any change to either, a new one. It names the worker's cache, so a worker-only release gets its own cache.
 */
export function contentHash(directory, template = readFileSync(join(SOURCE_DIR, 'sw.js'), 'utf8')) {
  const hash = createHash('sha256').update(`sw.js\0${Buffer.byteLength(template)}\0${template}`);
  for (const [relative, full] of files(directory).filter(([relative]) => relative !== 'sw.js')) {
    const body = readFileSync(full);
    hash.update(`${relative}\0${body.length}\0`).update(body);
  }
  return hash.digest('hex').slice(0, 16);
}

/** Writes the hash of the built files, and the paths the worker precaches (every file but itself), into the copied worker. */
export function stampWorker(directory) {
  const path = join(directory, 'sw.js');
  const source = readFileSync(path, 'utf8');
  for (const placeholder of [HASH_PLACEHOLDER, PRECACHE_PLACEHOLDER]) {
    if (!source.includes(placeholder)) throw new Error(`sw.js has no ${placeholder} to fill in`);
  }
  const paths = files(directory)
    .map(([relative]) => relative)
    .filter((relative) => relative !== 'sw.js')
    .map((relative) => (relative === 'index.html' ? APP_PATH : `${APP_PATH}${relative}`))
    .sort();
  writeFileSync(path, source
    .replaceAll(HASH_PLACEHOLDER, contentHash(directory, source))
    .replaceAll(PRECACHE_PLACEHOLDER, JSON.stringify(paths)));
}

/** Builds `outDir` (replacing it) from the static files and the compiled modules; returns the logical-to-built path map. */
export function buildApp({
  staticDir = SOURCE_DIR,
  jsDir = join(ROOT, 'dist', 'app-js'),
  outDir = join(ROOT, 'dist', 'app'),
  version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
} = {}) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(staticDir, outDir, { recursive: true });
  for (const [relative, text] of reachableModules(jsDir)) {
    mkdirSync(dirname(join(outDir, 'js', relative)), { recursive: true });
    writeFileSync(join(outDir, 'js', relative), text.replaceAll(VERSION_PLACEHOLDER, version));
  }

  const logical = files(outDir).map(([relative]) => relative).filter((relative) => !UNHASHED.has(relative));
  const sources = new Map(logical.map((relative) => [relative, readFileSync(join(outDir, relative))]));
  for (const [relative, body] of sources) {
    if (relative.endsWith('.css') && /url\(|@import/.test(body.toString('utf8'))) {
      throw new Error(`${relative} uses url() or @import, which the build does not fingerprint`);
    }
  }

  const built = new Map(); // logical path -> built path
  const bodies = new Map(); // logical path -> content as built
  const visiting = new Set();
  const build = (relative) => {
    if (built.has(relative)) return;
    if (visiting.has(relative)) throw new Error(`modules import each other in a cycle at ${relative}`);
    visiting.add(relative);
    let body = sources.get(relative);
    if (isText(relative)) {
      const text = body.toString('utf8');
      for (const dependency of referencesOf(relative, text, logical)) build(dependency);
      body = Buffer.from(rewrite(relative, text, logical, built));
    }
    visiting.delete(relative);
    built.set(relative, fingerprinted(relative, createHash('sha256').update(body).digest('hex').slice(0, FINGERPRINT_LENGTH)));
    bodies.set(relative, body);
  };
  for (const relative of logical) build(relative);

  for (const relative of logical) rmSync(join(outDir, relative));
  for (const relative of logical) {
    const target = join(outDir, built.get(relative));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bodies.get(relative));
  }
  // The page is not fingerprinted but names everything that is, so it is rewritten once all of that is built.
  const pagePath = join(outDir, 'index.html');
  writeFileSync(pagePath, rewrite('index.html', readFileSync(pagePath, 'utf8'), logical, built));
  removeEmptyDirectories(outDir);

  // Nothing may still name a file by its unfingerprinted path, and every module import must reach a file that exists.
  const texts = [['index.html', readFileSync(pagePath, 'utf8')], ...logical.filter(isText).map((relative) => [built.get(relative), bodies.get(relative).toString('utf8')])];
  for (const [name, text] of texts) {
    for (const relative of logical) {
      if (quoted(text, relative)) throw new Error(`${name} still names ${relative} without its fingerprint`);
    }
    if (name.endsWith('.js')) {
      for (const match of text.matchAll(IMPORT)) {
        if (!existsSync(join(outDir, posix.normalize(posix.join(posix.dirname(name), match[3]))))) throw new Error(`${name} imports ${match[3]}, which was not built`);
      }
    }
  }
  stampWorker(outDir);
  return built;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Files whose content names other files. The TMDB logo is deliberately not one: it is copied unmodified. */
const isText = (relative) => /\.(?:js|css|webmanifest)$/.test(relative);

/** Compiled modules reachable from the entry, by path under the compiled directory. */
function reachableModules(jsDir) {
  const found = new Map();
  const visit = (relative) => {
    if (found.has(relative)) return;
    let text;
    try {
      text = readFileSync(join(jsDir, relative), 'utf8');
    } catch {
      throw new Error(`the compiled client is missing ${relative}; run tsc -p tsconfig.app.json (${jsDir})`);
    }
    found.set(relative, text);
    for (const match of text.matchAll(IMPORT)) visit(posix.normalize(posix.join(posix.dirname(relative), match[3])));
  };
  visit(ENTRY);
  return found;
}

/** The logical paths of the files `relative` names: the modules it imports and the assets it quotes by their page-relative path. */
function referencesOf(relative, text, logical) {
  const found = new Set();
  if (relative.endsWith('.js')) {
    for (const match of text.matchAll(IMPORT)) found.add(posix.normalize(posix.join(posix.dirname(relative), match[3])));
  }
  for (const other of logical) if (other !== relative && !other.endsWith('.js') && quoted(text, other)) found.add(other);
  return [...found];
}

function quoted(text, path) {
  return new RegExp(`(['"])${escape(path)}\\1`).test(text);
}

/** `text` of `relative` with the fingerprinted names of everything it references. */
function rewrite(relative, text, logical, built) {
  let result = text;
  if (relative.endsWith('.js')) {
    result = result.replace(IMPORT, (_whole, lead, quote, specifier) => {
      const target = posix.normalize(posix.join(posix.dirname(relative), specifier));
      if (!built.has(target)) throw new Error(`${relative} imports ${specifier}, which is not built`);
      return `${lead}${quote}${specifier.slice(0, specifier.lastIndexOf('/') + 1)}${posix.basename(built.get(target))}${quote}`;
    });
  }
  // The page names scripts too; everything else names only assets that are not modules.
  for (const other of logical.filter((path) => relative === 'index.html' || !path.endsWith('.js'))) {
    if (!quoted(result, other)) continue;
    if (!built.has(other)) throw new Error(`${relative} names ${other} before it is built`);
    result = result.replace(new RegExp(`(['"])${escape(other)}\\1`, 'g'), (_whole, quote) => `${quote}${built.get(other)}${quote}`);
  }
  return result;
}

function files(directory) {
  const found = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const relative = posix.join(prefix, name);
      if (statSync(full).isDirectory()) walk(full, relative);
      else found.push([relative, full]);
    }
  };
  walk(directory, '');
  return found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function removeEmptyDirectories(directory) {
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (!statSync(full).isDirectory()) continue;
    removeEmptyDirectories(full);
    if (!readdirSync(full).length) rmSync(full, { recursive: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) buildApp();
