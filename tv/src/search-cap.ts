/**
 * Smaller searches on a TV (docs/tv-addon.md, "The search cap"). Jellyfin web's Search page (12.3 and 12.4, and 10.11.11:
 * `apps/legacy/features/search/api/*.ts`) asks Jellyfin for up to 800 items (`/Items?…&searchTerm=…&limit=800`) and up to
 * 100 each of people, studios and artists (`/Persons`, `/Studios`, `/Artists`, `limit=100`), and draws every card at once.
 * A broad word ("the": 800 items, 100 people, 45 studios, 1,038 cards) takes a 1.2 GB Samsung TV (Tizen 5.0) to the low
 * memory killer. On a TV, this lowers those limits before the request is sent: at most SEARCH_ITEM_LIMIT items and
 * SEARCH_NAME_LIMIT people, studios or artists. The limit is only ever lowered, never set where there was none and never
 * to 0, so a search that found something still finds something.
 *
 * Jellyfin web makes these calls through `@jellyfin/sdk` and axios, whose browser adapter is XMLHttpRequest, so the hook
 * is `XMLHttpRequest.prototype.open`; `window.fetch` gets the same rewrite in case a later Jellyfin web moves axios to its
 * fetch adapter. A request is a search request only when it is a GET of a path ending `/Items`, `/Persons`, `/Studios` or
 * `/Artists` with a non-empty `searchTerm`: only the Search page sends `searchTerm`. Everything else (the add-on's own
 * calls included) is passed to the browser exactly as it came, with the same arguments. Any surprise in the rewrite sends
 * the original request.
 *
 * Only on a TV, by Jellyfin web's own rule for its TV layout (`scripts/browser.js`: "tv", "viera", "titanos", "netcast" or
 * "web0s" in the user agent), or the Tizen or webOS globals. Not by memory: Chromium 56–63 has no `navigator.deviceMemory`,
 * and every TV is short of memory next to a desktop.
 */

/** The most items one search asks for on a TV (Jellyfin web asks for 800). */
export const SEARCH_ITEM_LIMIT = 100;
/** The most people, studios or artists one search asks for on a TV (Jellyfin web asks for 100 of each). */
export const SEARCH_NAME_LIMIT = 24;

/** The limit for each search endpoint, by the path's last segment (lower case). */
const LIMITS: { [segment: string]: number } = {
  items: SEARCH_ITEM_LIMIT,
  persons: SEARCH_NAME_LIMIT,
  studios: SEARCH_NAME_LIMIT,
  artists: SEARCH_NAME_LIMIT,
};

/**
 * `url` with its `limit` lowered, if it is a search request whose limit is above the cap; otherwise (or if anything
 * about it is unexpected) `undefined`, and the request is sent as it was. Only the one `limit=` pair is changed: the
 * rest of the address is kept as it was written.
 */
export function cappedSearchUrl(url: string, base: string): string | undefined {
  try {
    return capped(url, base);
  } catch {
    // An address that does not parse (or a malformed escape in it) is sent as it is.
    return undefined;
  }
}

function capped(url: string, base: string): string | undefined {
  const hashAt = url.indexOf('#');
  const head = hashAt < 0 ? url : url.slice(0, hashAt);
  const tail = hashAt < 0 ? '' : url.slice(hashAt);
  const queryAt = head.indexOf('?');
  if (queryAt < 0) return undefined;
  const segments = new URL(head, base).pathname.split('/');
  const cap = LIMITS[(segments[segments.length - 1] ?? '').toLowerCase()];
  if (cap === undefined) return undefined;
  const pairs = head.slice(queryAt + 1).split('&');
  let searched = false;
  let limitAt = -1;
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index] ?? '';
    const equals = pair.indexOf('=');
    const name = decodeURIComponent((equals < 0 ? pair : pair.slice(0, equals)).replace(/\+/g, ' ')).toLowerCase();
    const value = equals < 0 ? '' : decodeURIComponent(pair.slice(equals + 1).replace(/\+/g, ' '));
    if (name === 'searchterm' && value.trim() !== '') searched = true;
    if (name === 'limit') {
      // Two limits: which one Jellyfin reads is not ours to guess.
      if (limitAt >= 0) return undefined;
      limitAt = index;
    }
  }
  if (!searched || limitAt < 0) return undefined;
  const pair = pairs[limitAt] ?? '';
  const asked = pair.slice(pair.indexOf('=') + 1);
  if (!/^[0-9]{1,9}$/.test(asked) || Number(asked) <= cap) return undefined;
  pairs[limitAt] = `${pair.slice(0, pair.indexOf('='))}=${cap}`;
  return `${head.slice(0, queryAt + 1)}${pairs.join('&')}${tail}`;
}

/** Jellyfin web's TV rule (`scripts/browser.js`, `isTv`), with the Tizen and webOS globals. */
export function isTvClient(scope: Scope): boolean {
  if (scope.tizen != null || scope.webOS != null || scope.PalmSystem != null) return true;
  const agent = scope.navigator && typeof scope.navigator.userAgent === 'string' ? scope.navigator.userAgent.toLowerCase() : '';
  if (agent.indexOf('oculusbrowser') >= 0) return false;
  return ['tv', 'viera', 'titanos', 'netcast', 'web0s'].some((word) => agent.indexOf(word) >= 0);
}

export interface Scope {
  tizen?: unknown;
  webOS?: unknown;
  PalmSystem?: unknown;
  navigator?: { userAgent?: unknown };
  location?: { href?: unknown };
  XMLHttpRequest?: unknown;
  fetch?: unknown;
}

type Open = (this: unknown, ...args: unknown[]) => unknown;

/**
 * On a TV, wraps `XMLHttpRequest.prototype.open` and `window.fetch` so that search requests ask for less. Each wrap is
 * on its own: one that cannot be made (a missing or read-only `open`) leaves that one alone. Never throws.
 */
export function installSearchCap(scope: Scope): void {
  try {
    if (!isTvClient(scope)) return;
  } catch {
    return;
  }
  /** The address to send instead of `url`, or `url` itself. */
  const rewrite = (method: unknown, url: unknown): unknown => {
    try {
      if (typeof url !== 'string' || (method !== undefined && (typeof method !== 'string' || method.toUpperCase() !== 'GET'))) return url;
      const base = scope.location && typeof scope.location.href === 'string' ? scope.location.href : undefined;
      const capped = cappedSearchUrl(url, base ?? url);
      return capped === undefined ? url : capped;
    } catch {
      return url;
    }
  };
  try {
    const Request = scope.XMLHttpRequest;
    const prototype = typeof Request === 'function' ? (Request as { prototype?: { open?: unknown } }).prototype : undefined;
    const open = prototype ? prototype.open : undefined;
    if (prototype && typeof open === 'function') {
      prototype.open = function capOpen(this: unknown, ...args: unknown[]): unknown {
        // The same arguments, as many as were given (an `async` of `undefined` would make the request synchronous).
        if (args.length >= 2) args[1] = rewrite(args[0], args[1]);
        return (open as Open).apply(this, args);
      };
    }
  } catch {
    // XMLHttpRequest is left as it is.
  }
  try {
    const fetch = scope.fetch;
    if (typeof fetch === 'function') {
      scope.fetch = function capFetch(this: unknown, ...args: unknown[]): unknown {
        if (args.length >= 1) {
          const init = args[1] as { method?: unknown } | null | undefined;
          let method: unknown;
          try {
            method = init && typeof init === 'object' ? init.method : undefined;
          } catch {
            method = 'unknown';
          }
          args[0] = rewrite(method, args[0]);
        }
        return (fetch as Open).apply(this === undefined || this === null ? scope : this, args);
      };
    }
  } catch {
    // fetch is left as it is.
  }
}
