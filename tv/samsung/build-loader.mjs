#!/usr/bin/env node
// Builds the JellyPass loader for the Samsung (Tizen) app (docs/tv-addon.md, "The Samsung app") and adds it to a built
// Jellyfin web: tv/samsung/loader.ts bundled by esbuild into one classic script (an IIFE) downlevelled to ES2017 for
// the 2019 set's Chromium 63, as the add-on is (scripts/build-tv.mjs), with the trusted hosts written in. Run by
// tv/samsung/build-wgt.sh as
//
//   node tv/samsung/build-loader.mjs --hosts 'jelly-*.example.org' --www <jellyfin-tizen>/www
//
// which writes www/jellypass-loader.js and adds one <script> for it to www/index.html, before </head>. With --check
// instead of --www it only checks the hosts.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { TV_TARGET } from '../../scripts/build-tv.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LOADER_NAME = 'jellypass-loader.js';
const MARKER = 'data-jellypass-loader';
/** A host name in lower case with at least two labels; one `*` is allowed, in the first label only. */
const HOST_PATTERN = /^(?:[a-z0-9-]*\*[a-z0-9-]*|[a-z0-9-]+)(?:\.[a-z0-9-]+)+$/;

/** The hosts option (`a.example.org,jelly-*.example.org`) as a list, or an error naming what is wrong with it. */
export function parseHosts(input) {
  const hosts = String(input ?? '').split(',').map((host) => host.trim()).filter(Boolean);
  if (!hosts.length) throw new Error('--hosts is required: the household hosts the loader may load from, separated by commas');
  for (const host of hosts) {
    if (!HOST_PATTERN.test(host) || host.split('*').length > 2) {
      throw new Error(`--hosts: ${JSON.stringify(host)} is not a lower-case host name (one * allowed, in the first label)`);
    }
  }
  return hosts;
}

/** The loader's script for `hosts` (already parsed), as a string. */
export async function buildLoader({ hosts, entry = join(HERE, 'loader.ts') }) {
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
    define: { __JELLYPASS_TV_HOSTS__: JSON.stringify(hosts) },
  });
  return result.outputFiles[0].text;
}

/**
 * Jellyfin web's built page with one `<script defer src="jellypass-loader.js">` added just before `</head>`. Throws if
 * the page has no `</head>` or already has the loader, so a build never quietly ships without it or with two.
 */
export function injectLoader(html) {
  if (html.includes(MARKER)) throw new Error('index.html already has the JellyPass loader');
  const at = html.search(/<\/head\s*>/i);
  if (at < 0) throw new Error('index.html has no </head> to add the JellyPass loader before');
  return `${html.slice(0, at)}<script defer src="${LOADER_NAME}" ${MARKER}></script>${html.slice(at)}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { hosts: { type: 'string' }, www: { type: 'string' }, check: { type: 'boolean' } } });
  const hosts = parseHosts(values.hosts);
  // --check: only checks the hosts, before a build starts its slow steps.
  if (values.check) process.exit(0);
  if (!values.www) throw new Error('--www is required: the jellyfin-tizen www directory');
  const index = join(values.www, 'index.html');
  const page = injectLoader(readFileSync(index, 'utf8'));
  writeFileSync(join(values.www, LOADER_NAME), await buildLoader({ hosts }));
  writeFileSync(index, page);
  console.log(`Added ${LOADER_NAME} for ${hosts.join(', ')} to ${index}`);
}
