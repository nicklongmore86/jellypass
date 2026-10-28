/**
 * The JellyPass loader in the Samsung (Tizen) app (docs/tv-addon.md, "The Samsung app"): the one addition the JellyPass
 * build makes to the Jellyfin web it bundles. That Jellyfin web is the app's own copy, so the household gateway can't
 * add the TV add-on to it; this loader does instead, from the household host the member signed in to. It waits for
 * Jellyfin web's `ApiClient` to name a server, and if that server is an HTTPS household host the build lists, asks it
 * for the add-on's current script name (`/jellypass/tv/manifest.json`, never stored) and adds that script to the page.
 * So a JellyPass release reaches the TV with no resideload.
 *
 * It fails safe: any other server, an answer that isn't a script name, no network, a timeout or any surprise leaves
 * Jellyfin web exactly as it is. It sends no token and no cookie, logs nothing and stores nothing. Built by
 * tv/samsung/build-loader.mjs to ES2017, as the add-on is, for the 2019 set's Chromium 63.
 */

/** The hosts the build trusts (exact names, or one `*` in the first label), written in by tv/samsung/build-loader.mjs. */
declare const __JELLYPASS_TV_HOSTS__: string[];

const MANIFEST_PATH = '/jellypass/tv/manifest.json';
const SCRIPT_PATH = '/jellypass/tv/';
/** The add-on's script, as scripts/build-tv.mjs names it; any other name in the manifest is not loaded. */
const SCRIPT_NAME = /^jellypass-tv\.[0-9a-f]{12}\.js$/;
/** The add-on's own marker: it finds its script by it, and a page that has one is never given another. */
const MARKER = 'data-jellypass-tv';
/** How often Jellyfin web's server is looked at, in milliseconds (no call is made unless it is a listed host). */
const POLL_MS = 1000;
/** How long the manifest may take, in milliseconds; a later answer is ignored. */
const TIMEOUT_MS = 10000;
/** After a failure the same host is asked again after this long, doubling each time up to the most, in milliseconds. */
const FIRST_RETRY_MS = 30000;
const MOST_RETRY_MS = 30 * 60000;

interface Scope {
  ApiClient?: unknown;
  __jellypassTvLoader?: boolean;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  setTimeout: (run: () => void, ms: number) => unknown;
  performance: { now: () => number };
}

/** Whether `hostname` (lower case) is one of `patterns`: an exact name, or a name with one `*` standing for letters, digits and hyphens in its first label. */
export function hostListed(hostname: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const star = pattern.indexOf('*');
    if (star < 0) return hostname === pattern;
    const before = pattern.slice(0, star);
    const after = pattern.slice(star + 1);
    if (hostname.length <= before.length + after.length) return false;
    if (hostname.slice(0, before.length) !== before || hostname.slice(hostname.length - after.length) !== after) return false;
    return /^[a-z0-9-]+$/.test(hostname.slice(before.length, hostname.length - after.length));
  });
}

/**
 * The origin of the server Jellyfin web is connected to, from `ApiClient.serverAddress()`, if it is a listed host over
 * HTTPS on its default port with no credentials in it; otherwise undefined.
 */
export function householdOrigin(client: unknown, patterns: readonly string[]): string | undefined {
  const api = client as { serverAddress?: unknown } | undefined;
  if (!api || typeof api.serverAddress !== 'function') return undefined;
  const address: unknown = api.serverAddress();
  if (typeof address !== 'string' || !address) return undefined;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return undefined;
  return hostListed(url.hostname.toLowerCase(), patterns) ? url.origin : undefined;
}

/** The add-on's current script name from `origin`'s manifest, or undefined on any failure or after {@link TIMEOUT_MS}. */
function manifestScript(scope: Scope, origin: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (name: string | undefined) => {
      if (done) return;
      done = true;
      resolve(name);
    };
    scope.setTimeout(() => finish(undefined), TIMEOUT_MS);
    let request: Promise<Response>;
    try {
      // No credentials, no token, no referrer; a redirect elsewhere is a failure, not followed.
      request = scope.fetch(`${origin}${MANIFEST_PATH}`, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' },
      });
    } catch {
      finish(undefined);
      return;
    }
    request
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: unknown) => {
        const script = body && typeof body === 'object' ? (body as { script?: unknown }).script : undefined;
        finish(typeof script === 'string' && SCRIPT_NAME.test(script) ? script : undefined);
      }, () => finish(undefined));
  });
}

/** Starts the loader in `scope` (the page's window) for `document`. Runs once per page, however often it is started. */
export function startLoader(scope: Scope, document: Document, patterns: readonly string[]): void {
  if (scope.__jellypassTvLoader) return;
  scope.__jellypassTvLoader = true;
  let loaded = false;
  let asking = false;
  let host: string | undefined;
  let retryAt = 0;
  let wait = FIRST_RETRY_MS;
  const check = () => {
    if (document.querySelector(`script[${MARKER}]`)) loaded = true;
    if (loaded || asking) return;
    const origin = householdOrigin(scope.ApiClient, patterns);
    if (!origin) return;
    if (origin !== host) {
      host = origin;
      retryAt = 0;
      wait = FIRST_RETRY_MS;
    }
    if (scope.performance.now() < retryAt) return;
    asking = true;
    void manifestScript(scope, origin).then((name) => {
      asking = false;
      try {
        if (loaded) return;
        // Only for the server Jellyfin web is still connected to: one it left while the manifest was asked is not used.
        if (name && householdOrigin(scope.ApiClient, patterns) === origin && !document.querySelector(`script[${MARKER}]`)) {
          const script = document.createElement('script');
          script.setAttribute('src', `${origin}${SCRIPT_PATH}${name}`);
          script.setAttribute(MARKER, '');
          (document.head || document.documentElement).appendChild(script);
          loaded = true;
          return;
        }
        if (!name) {
          retryAt = scope.performance.now() + wait;
          wait = Math.min(wait * 2, MOST_RETRY_MS);
        }
      } catch {
        // Fails safe: Jellyfin web is left as it is.
      }
    });
  };
  const tick = () => {
    try {
      check();
    } catch {
      // Fails safe: a surprise (an ApiClient that throws, say) is looked at again on the next tick.
    }
    if (!loaded) scope.setTimeout(tick, POLL_MS);
  };
  tick();
}

if (typeof __JELLYPASS_TV_HOSTS__ !== 'undefined') {
  try {
    startLoader(window as unknown as Scope, document, __JELLYPASS_TV_HOSTS__);
  } catch {
    // Never breaks the app: without the loader it is plain Jellyfin.
  }
}
