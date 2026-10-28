import type { IncomingMessage, ServerResponse } from 'node:http';
import { NEVER_STORE } from './app-assets.js';

/**
 * Cross-origin access for the JellyPass build of Jellyfin's Samsung (Tizen) app (docs/tv-addon.md, "The Samsung app"):
 * on a household host the TV add-on is on for, the app API (`/jellypass/app/v1/...`) and the add-on's files
 * (`/jellypass/tv/...`) answer the app's origin, and only it.
 *
 * The app is a packaged web app, loaded from `file:///www/index.html` (measured with the inspector on both households'
 * sets). Chromium (M63 on Tizen 5.0, M69 on 5.5) sends a `file:` page's origin as `file://` when the runtime grants it
 * file access, as Tizen's does for a packaged app, and as `null` when it does not, so those two exact values are the
 * app's origin. No web page has either: a site's origin is always `https://<host>`. An opaque page (a sandboxed frame)
 * also sends `null`, and gains nothing a token it already holds doesn't give it: the API reads only the
 * `Authorization` header, sets and reads no cookie, and credentials are never allowed.
 */
export const TIZEN_APP_ORIGINS: ReadonlySet<string> = new Set(['file://', 'null']);

/** The two families of paths that answer the app, with the methods and request headers each allows. */
const FAMILIES = {
  /** The app API: reads and "Get this" (a JSON `POST`), with the token in `Authorization`. */
  api: { prefix: '/jellypass/app/v1/', methods: ['GET', 'POST'], headers: ['authorization', 'content-type'] },
  /** The add-on's files and its manifest: plain reads. */
  tv: { prefix: '/jellypass/tv/', methods: ['GET', 'HEAD'], headers: [] as string[] },
} as const;
type Family = keyof typeof FAMILIES;

/** One of the add-on's fingerprinted files (see tv-assets.ts). */
const FINGERPRINTED = /^\/jellypass\/tv\/jellypass-tv\.[0-9a-f]{12}\.(?:js|css)$/;
/** How long a browser may keep a preflight's answer, in seconds (Chromium caps it at 600). */
const PREFLIGHT_MAX_AGE = '600';

/**
 * Which family `pathname` (the request's path as sent, before its query) is in, or undefined. The caller has already
 * decided the request is the app's (`api`) or the add-on's (`tv`) on the route Jellyfin would take, and only asks this
 * for a household host the add-on is on for.
 */
export function corsFamily(pathname: string): Family | undefined {
  if (pathname.startsWith(FAMILIES.api.prefix)) return 'api';
  if (pathname.startsWith(FAMILIES.tv.prefix)) return 'tv';
  return undefined;
}

/**
 * Applies the rules to one request in `family`: a preflight from the app's origin for a method and headers the family
 * allows is answered `204` here (returns true, before any token is looked at); any other request from that origin gets
 * `Access-Control-Allow-Origin` with it on whatever answer follows (returns false). Anything else, from another origin or
 * with no `Origin`, or a preflight asking for more, is left exactly as it was (returns false, no header set).
 */
export function applyTvCors(request: IncomingMessage, response: ServerResponse, family: Family): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !TIZEN_APP_ORIGINS.has(origin)) return false;
  const rules = FAMILIES[family];
  if (request.method === 'OPTIONS') {
    const method = request.headers['access-control-request-method'];
    if (typeof method !== 'string' || !(rules.methods as readonly string[]).includes(method)) return false;
    const asked = (request.headers['access-control-request-headers'] ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    if (!asked.every((name) => (rules.headers as readonly string[]).includes(name))) return false;
    response.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': rules.methods.join(', '),
      ...(rules.headers.length ? { 'Access-Control-Allow-Headers': rules.headers.map(headerName).join(', ') } : {}),
      'Access-Control-Max-Age': PREFLIGHT_MAX_AGE,
      Vary: 'Origin',
      ...NEVER_STORE,
      'Content-Length': 0,
    });
    response.end();
    return true;
  }
  response.setHeader('Access-Control-Allow-Origin', origin);
  // The add-on's fingerprinted files are the same for everyone and kept by the CDN for good, so they don't vary: a copy
  // with or without the header is right for anyone (a <script> or <link> reads them without CORS). Everything else in
  // these families is never stored.
  const pathname = (request.url ?? '').split('?', 1)[0] as string;
  if (!(family === 'tv' && FINGERPRINTED.test(pathname))) response.setHeader('Vary', 'Origin');
  return false;
}

const headerName = (name: string) => name.replace(/(^|-)([a-z])/g, (_match, dash: string, letter: string) => `${dash}${letter.toUpperCase()}`);
