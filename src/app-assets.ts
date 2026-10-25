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
/**
 * Every file but the page and the service worker is named for a hash of its content (`app.<hash>.css`, see
 * scripts/build-app.mjs), so its bytes never change and it may be kept for good by browsers and CDNs. The page names the
 * files of its own release, so two releases never share an address.
 */
const FINGERPRINTED = /\.[0-9a-f]{12}\.[a-z0-9]+$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';
/**
 * The page and the service worker keep their addresses from release to release, so nothing may keep a copy past the
 * moment it is asked for: `no-store` for browsers and shared caches (Cloudflare never caches `no-store`), and the CDN
 * headers Cloudflare and other CDNs read for their own caching, so a CDN setting that rewrites a browser lifetime
 * cannot make a stale page or worker outlive a release. (A `Cache-Control: no-cache` with an ETag was rewritten to a
 * four-hour `max-age` on a CDN that keeps files by extension.) Every other answer under /jellypass/app (redirects,
 * errors, the API) carries the same three, so no CDN keeps any of them either.
 */
export const NEVER_STORE = {
  'Cache-Control': 'no-store',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
} as const;

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

/** Every powerful browser feature the app has no use for, switched off for the page and anything it embeds. */
export const APP_PERMISSIONS_POLICY = [
  'accelerometer', 'ambient-light-sensor', 'bluetooth', 'camera', 'display-capture', 'geolocation', 'gyroscope', 'hid',
  'idle-detection', 'magnetometer', 'microphone', 'midi', 'payment', 'publickey-credentials-get', 'screen-wake-lock',
  'serial', 'usb', 'xr-spatial-tracking', 'interest-cohort',
]
  .map((feature) => `${feature}=()`)
  .join(', ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': APP_CONTENT_SECURITY_POLICY,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': APP_PERMISSIONS_POLICY,
} as const;

interface AppAsset {
  body: Buffer;
  contentType: string;
  /** Fingerprinted: kept for good, with an ETag. Otherwise never stored, with no validator. */
  fingerprinted: boolean;
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
        assets.set(`${APP_PAGE_PATH}${relative}`, {
          body,
          contentType,
          fingerprinted: FINGERPRINTED.test(name),
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
   * Answers a GET or HEAD for one of the app's files and returns true; false if `pathname` (as requested, not
   * lower-cased) is not one. Only the exact paths are served, so the app has one address and one service worker
   * registration; any other spelling (or an old fingerprint) is just an unknown app path. `/jellypass/app` itself redirects
   * to the page. A fingerprinted file answers a conditional request with a 304; the page and the worker are never stored.
   */
  public serve(request: IncomingMessage, response: ServerResponse, pathname: string): boolean {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    if (pathname === APP_PAGE_PATH.slice(0, -1)) {
      response.writeHead(308, { Location: APP_PAGE_PATH, ...NEVER_STORE, ...SECURITY_HEADERS });
      response.end();
      return true;
    }
    const asset = this.#assets.get(pathname);
    if (!asset) return false;
    const headers = {
      'Content-Type': asset.contentType,
      ...(asset.fingerprinted ? { 'Cache-Control': IMMUTABLE, ETag: asset.etag } : NEVER_STORE),
      ...SECURITY_HEADERS,
    };
    if (asset.fingerprinted && request.headers['if-none-match']?.split(',').some((tag) => tag.trim() === asset.etag)) {
      response.writeHead(304, headers);
      response.end();
      return true;
    }
    response.writeHead(200, { ...headers, 'Content-Length': asset.body.length });
    response.end(request.method === 'HEAD' ? undefined : asset.body);
    return true;
  }
}
