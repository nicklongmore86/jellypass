import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The household app's own files (the page, its styles and script modules, manifest, service worker, icons and TMDB's
 * logo), served on household hosts under /jellypass/app/. They are built into dist/app by `pnpm build` and read once at
 * startup; there is nothing user-specific in any of them (the page fetches everything from the API after load), so
 * they are the same for every caller and need no credentials.
 */

export const APP_PAGE_PATH = '/jellypass/app/';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
/** Files that change with a release are revalidated on each use (a cheap 304); icons and the logo are kept a week. */
const REVALIDATE = 'no-cache';
const KEEP = 'public, max-age=604800';

/**
 * Strict CSP for every app file: only the app's own origin, plus TMDB's image host for posters and backdrops. No inline
 * script or style, no framing, no forms, no plugins.
 */
export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https://image.tmdb.org",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': APP_CONTENT_SECURITY_POLICY,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
} as const;

interface AppAsset {
  body: Buffer;
  contentType: string;
  cacheControl: string;
  etag: string;
}

export class AppAssets {
  readonly #assets: Map<string, AppAsset>;

  public constructor(assets: Map<string, AppAsset>) {
    this.#assets = assets;
  }

  /** Reads every file under `directory` (default: dist/app next to this module). Throws if there is none. */
  public static load(directory = fileURLToPath(new URL('./app/', import.meta.url))): AppAssets {
    const assets = new Map<string, AppAsset>();
    const walk = (dir: string, prefix: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const relative = posix.join(prefix, name);
        if (statSync(full).isDirectory()) {
          walk(full, relative);
          continue;
        }
        const contentType = CONTENT_TYPES[extname(name).toLowerCase()];
        if (!contentType) throw new Error(`household app file ${relative} has no known content type`);
        const body = readFileSync(full);
        const keep = /\.(png|svg)$/i.test(name);
        assets.set(`${APP_PAGE_PATH}${relative}`.toLowerCase(), {
          body,
          contentType,
          cacheControl: keep ? KEEP : REVALIDATE,
          etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`,
        });
      }
    };
    try {
      walk(directory, '');
    } catch (error) {
      throw new Error(`the household app files are missing; run pnpm build (${(error as Error).message})`);
    }
    const page = assets.get(`${APP_PAGE_PATH}index.html`);
    if (!page) throw new Error('the household app files are missing index.html; run pnpm build');
    assets.set(APP_PAGE_PATH, page);
    return new AppAssets(assets);
  }

  /** Every path served, for tests. */
  public paths(): string[] {
    return [...this.#assets.keys()];
  }

  /**
   * Answers a GET or HEAD for one of the app's files and returns true; false if `pathname` (already lower-cased) is not
   * one. `/jellypass/app` itself redirects to the page. A conditional request gets a 304.
   */
  public serve(request: IncomingMessage, response: ServerResponse, pathname: string): boolean {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    if (pathname === APP_PAGE_PATH.slice(0, -1)) {
      response.writeHead(308, { Location: APP_PAGE_PATH, 'Cache-Control': REVALIDATE, ...SECURITY_HEADERS });
      response.end();
      return true;
    }
    const asset = this.#assets.get(pathname);
    if (!asset) return false;
    const headers = {
      'Content-Type': asset.contentType,
      'Cache-Control': asset.cacheControl,
      ETag: asset.etag,
      ...SECURITY_HEADERS,
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
}
