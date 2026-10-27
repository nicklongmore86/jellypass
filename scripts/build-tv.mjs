#!/usr/bin/env node
// Builds the TV add-on (docs/tv-addon.md) into dist/tv: tv/src/main.ts and what it imports, bundled by esbuild into one
// classic script (an IIFE, no modules) downlevelled to ES2017 for the TVs' Chromium 63, and tv/static/tv.css copied as
// it is. Run by `pnpm build`. This is the only bundled code in the repository; everything else keeps the no-bundler
// rule (docs/app-design.md, "Source and build").
//
// Both files are named for a hash of their content, `jellypass-tv.<hash>.js` and `.css`, so a CDN may keep them for
// good and a page only ever loads the files of its own release. The script names its stylesheet, so the stylesheet is
// hashed first and its name built into the script before the script is hashed.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

/** What the script is downlevelled to: ES2017 (async/await, no object spread, no optional catch binding, no `?.`). */
export const TV_TARGET = 'es2017';
const FINGERPRINT_LENGTH = 12;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const hashOf = (body) => createHash('sha256').update(body).digest('hex').slice(0, FINGERPRINT_LENGTH);

/** Builds `outDir` (replacing it); returns the built names, `{ script, stylesheet }`. */
export async function buildTv({
  entry = join(ROOT, 'tv', 'src', 'main.ts'),
  stylesheet = join(ROOT, 'tv', 'static', 'tv.css'),
  outDir = join(ROOT, 'dist', 'tv'),
} = {}) {
  const css = readFileSync(stylesheet);
  if (/url\(|@import/.test(css.toString('utf8'))) throw new Error('tv.css uses url() or @import, which the build does not fingerprint');
  const stylesheetName = `jellypass-tv.${hashOf(css)}.css`;
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    target: TV_TARGET,
    platform: 'browser',
    charset: 'utf8',
    legalComments: 'none',
    minifySyntax: true,
    write: false,
    logLevel: 'silent',
    define: { __JELLYPASS_TV_CSS__: JSON.stringify(stylesheetName) },
  });
  const script = Buffer.from(result.outputFiles[0].contents);
  const scriptName = `jellypass-tv.${hashOf(script)}.js`;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, stylesheetName), css);
  writeFileSync(join(outDir, scriptName), script);
  return { script: scriptName, stylesheet: stylesheetName };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await buildTv();
