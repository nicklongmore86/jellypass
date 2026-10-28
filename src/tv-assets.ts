import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEVER_STORE } from './app-assets.js';

/**
 * The TV add-on's files (one script and its stylesheet; see docs/tv-addon.md), served on household hosts the add-on is
 * on for, under /jellypass/tv/. They are built into dist/tv by `pnpm build` (scripts/build-tv.mjs) and read once at
 * startup. Both are named for a hash of their content, so they are kept for good; neither carries anything
 * user-specific. A small manifest names the current script, for the Samsung app's loader, which can't read it from
 * Jellyfin web's page (the app bundles its own).
 */

export const TV_PATH = '/jellypass/tv/';
/** `jellypass-tv.<12 hex digits>.js` or `.css`, as scripts/build-tv.mjs names them. */
const TV_FILE = /^jellypass-tv\.[0-9a-f]{12}\.(js|css)$/;
const CONTENT_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};
const IMMUTABLE = 'public, max-age=31536000, immutable';
/**
 * The manifest: `{"script":"jellypass-tv.<hash>.js"}`, the script's name next to it. Never stored, so a loader always
 * learns the current release's name.
 */
export const TV_MANIFEST_PATH = `${TV_PATH}manifest.json`;
/** Marks the tag the gateway adds to Jellyfin web's page, so a page that already has one never gets a second. */
export const TV_SCRIPT_MARKER = 'data-jellypass-tv';

interface TvAsset {
  body: Buffer;
  contentType: string;
  etag: string;
}

export class TvAssets {
  readonly #assets: Map<string, TvAsset>;
  /** The script's absolute path, which the tag added to Jellyfin web's page names. */
  public readonly scriptPath: string;

  public constructor(assets: Map<string, TvAsset>, scriptPath: string) {
    this.#assets = assets;
    this.scriptPath = scriptPath;
  }

  /** Reads dist/tv (or `directory`). Throws unless it holds exactly one script and one stylesheet, and nothing else. */
  public static load(directory = fileURLToPath(new URL('./tv/', import.meta.url))): TvAssets {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (error) {
      throw new Error(`the TV add-on files are missing; run pnpm build (${(error as Error).message})`);
    }
    const assets = new Map<string, TvAsset>();
    const scripts: string[] = [];
    let stylesheets = 0;
    for (const name of names) {
      const match = TV_FILE.exec(name);
      if (!match) throw new Error(`TV add-on file ${name} is not a fingerprinted script or stylesheet`);
      const extension = match[1] as string;
      const body = readFileSync(join(directory, name));
      assets.set(`${TV_PATH}${name}`, {
        body,
        contentType: CONTENT_TYPES[extension] as string,
        etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`,
      });
      if (extension === 'js') scripts.push(`${TV_PATH}${name}`);
      else stylesheets += 1;
    }
    if (scripts.length !== 1 || stylesheets !== 1) {
      throw new Error('the TV add-on files must be one script and one stylesheet; run pnpm build');
    }
    return new TvAssets(assets, scripts[0] as string);
  }

  /** Every path served, for tests. */
  public paths(): string[] {
    return [...this.#assets.keys()];
  }

  /**
   * Answers a GET or HEAD for one of the files, or the manifest, at its exact path and returns true; false for anything
   * else (another method, another spelling, an old fingerprint), which the caller answers itself.
   */
  public serve(request: IncomingMessage, response: ServerResponse, pathname: string): boolean {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    if (pathname === TV_MANIFEST_PATH) {
      const body = Buffer.from(JSON.stringify({ script: this.scriptPath.slice(TV_PATH.length) }));
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        ...NEVER_STORE,
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return true;
    }
    const asset = this.#assets.get(pathname);
    if (!asset) return false;
    const headers = {
      'Content-Type': asset.contentType,
      'Cache-Control': IMMUTABLE,
      ETag: asset.etag,
      'X-Content-Type-Options': 'nosniff',
    };
    if (request.headers['if-none-match']?.split(',').some((tag) => tag.trim() === asset.etag)) {
      response.writeHead(304, headers);
      response.end();
      return true;
    }
    response.writeHead(200, { ...headers, 'Content-Length': asset.body.length });
    response.end(request.method === 'HEAD' ? undefined : asset.body);
    return true;
  }

  /**
   * Jellyfin web's page with the add-on's one `<script>` added just before `</head>`; the page unchanged if it already
   * has the tag (or any tag of the add-on's: it is never added twice); undefined if it has no `</head>` to add it at.
   */
  public inject(page: Buffer): Buffer | undefined {
    const html = page.toString('utf8');
    if (html.includes(TV_SCRIPT_MARKER)) return page;
    const at = html.search(/<\/head\s*>/i);
    if (at < 0) return undefined;
    return Buffer.from(`${html.slice(0, at)}<script defer src="${this.scriptPath}" ${TV_SCRIPT_MARKER}></script>${html.slice(at)}`);
  }
}
