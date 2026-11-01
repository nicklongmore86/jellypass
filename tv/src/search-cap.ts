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
 * is `XMLHttpRequest.prototype.open`. `window.fetch` is wrapped too, as a best-effort backup only: it lowers a search
 * address only for `fetch(url)` with a string `url` and no `init` (or an `init` of `undefined` or `null`), since any
 * other `init` is the caller's object and is never read (no property, descriptor or prototype of it). axios's own fetch
 * adapter passes a `Request` (or an `init` object), so it would not reach the cap. A request is a search request only
 * when it is a GET of a path ending `/Items`, `/Persons`, `/Studios` or `/Artists` with a non-empty `searchTerm`: only
 * the Search page sends `searchTerm`. Everything else (the add-on's own calls included) is passed to the browser
 * exactly as it came, with the same receiver and arguments. Any surprise in the rewrite sends the original request.
 *
 * Only on a TV (isTvClient): never a phone, tablet or watch by its user agent, then Jellyfin web's own rule for its TV
 * layout (`scripts/browser.js`: "tv", "viera", "titanos", "netcast" or "web0s" in the user agent), or the Tizen or webOS
 * globals. Not by memory: Chromium 56–63 has no `navigator.deviceMemory`, and every TV is short of memory next to a
 * desktop.
 */

/** The most items one search asks for on a TV (Jellyfin web asks for 800). */
export const SEARCH_ITEM_LIMIT = 100;
/** The most people, studios or artists one search asks for on a TV (Jellyfin web asks for 100 of each). */
export const SEARCH_NAME_LIMIT = 24;

/**
 * The limit for a search endpoint, by the path's last segment (lower case), or `undefined` for any other path. A
 * `switch`, not an object lookup, so `constructor`, `__proto__` or `toString` is no endpoint.
 */
function limitFor(segment: string): number | undefined {
  switch (segment) {
    case 'items':
      return SEARCH_ITEM_LIMIT;
    case 'persons':
    case 'studios':
    case 'artists':
      return SEARCH_NAME_LIMIT;
    default:
      return undefined;
  }
}

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
  const cap = limitFor((segments[segments.length - 1] ?? '').toLowerCase());
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

/**
 * What in a user agent says phone, tablet or watch: Jellyfin web's own `isMobile` terms (`scripts/browser.js`), and
 * the legacy webOS phones and tablet (Palm Pre and Pixi: `webOS/` with a letter O, `Pre/`, `Pixi/`; HP's `hpwOS` and
 * `TouchPad`), whose `PalmSystem` an LG TV also has. Tizen phones and watches say `Mobile`.
 */
const MOBILE_WORDS = ['mobi', 'ipad', 'iphone', 'ipod', 'silk', 'gt-p1000', 'nexus 7', 'kindle fire', 'opera mini', 'webos/', 'hpwos', 'touchpad', 'pre/', 'pixi/'];
/** Jellyfin web's TV words (`scripts/browser.js`, `isTv`; LG TVs say `Web0S`, with a zero). */
const TV_WORDS = ['tv', 'viera', 'titanos', 'netcast', 'web0s'];

/**
 * Whether this is a TV: never a phone, tablet or watch by its user agent (MOBILE_WORDS, or the Oculus browser), and
 * then either Jellyfin web's TV rule for its user agent, or the Tizen or webOS globals (Samsung's and LG's TV apps).
 * A global alone is not enough, since Tizen phones and the legacy webOS phones have them too.
 */
export function isTvClient(scope: Scope): boolean {
  const navigator = scope.navigator;
  const userAgent = navigator ? navigator.userAgent : undefined;
  const agent = typeof userAgent === 'string' ? userAgent.toLowerCase() : '';
  const has = (word: string) => agent.indexOf(word) >= 0;
  if (has('oculusbrowser') || MOBILE_WORDS.some(has)) return false;
  if (TV_WORDS.some(has)) return true;
  return scope.tizen != null || scope.webOS != null || scope.PalmSystem != null;
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
  /** `url` with its limit lowered, if it is a search request's address (a string) to lower; otherwise `undefined`. */
  const capped = (url: unknown): string | undefined => {
    try {
      if (typeof url !== 'string') return undefined;
      const location = scope.location;
      const href = location ? location.href : undefined;
      return cappedSearchUrl(url, typeof href === 'string' ? href : url);
    } catch {
      return undefined;
    }
  };
  const isGet = (method: unknown) => typeof method === 'string' && method.toUpperCase() === 'GET';
  try {
    const Request = scope.XMLHttpRequest;
    const prototype = typeof Request === 'function' ? (Request as { prototype?: { open?: unknown } }).prototype : undefined;
    const open = prototype ? prototype.open : undefined;
    if (prototype && typeof open === 'function') {
      prototype.open = function capOpen(this: unknown, ...args: unknown[]): unknown {
        // The same arguments, as many as were given (an `async` of `undefined` would make the request synchronous).
        if (args.length >= 2 && isGet(args[0])) {
          const lowered = capped(args[1]);
          if (lowered !== undefined) args[1] = lowered;
        }
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
        // Only `fetch(url)` or `fetch(url, undefined | null)`, a GET by definition. Any other init is the caller's, and is
        // passed on without a single read: no property, descriptor or prototype of it is looked at.
        const init = args.length >= 2 ? args[1] : undefined;
        if (args.length >= 1 && (init === undefined || init === null)) {
          const lowered = capped(args[0]);
          if (lowered !== undefined) args[0] = lowered;
        }
        // The receiver as given: native fetch treats `undefined` and `null` as the window (Web IDL, [Global] interfaces),
        // and refuses any other object as it would have without this wrap.
        return (fetch as Open).apply(this, args);
      };
    }
  } catch {
    // fetch is left as it is.
  }
}
