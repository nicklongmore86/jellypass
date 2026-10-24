import { MAX_GUARDED_RESPONSE_BYTES, readCappedBody } from './seerr.js';

/**
 * The household app's title catalogue (search, discover, details), read straight from TMDB's v3 API with JellyPass's
 * own TMDB credential. TMDB knows nothing about JellyPass's households, Seerr's media records or anyone's requests, so
 * nothing another household holds, asked for or waits on can change what these calls return, how large it is or how
 * long it takes. Every call is the same for every caller: a fixed language, no region, no user.
 *
 * Only the endpoints the app uses are exposed, each behind its own method. Responses are TMDB's JSON as-is (`unknown`):
 * callers copy out only the fields they need. Errors carry the status and the route, never TMDB's body, the IDs asked
 * for or the credential. See docs/app-design.md, "Catalogue source".
 */

export const TMDB_API_URL = 'https://api.themoviedb.org';
/** The language every catalogue call asks TMDB for, the same for every caller. */
export const TMDB_LANGUAGE = 'en-US';

/** The discover lists the household app offers, by their app path segment. */
export const TMDB_DISCOVER_LISTS = ['trending', 'popular-movies', 'popular-tv', 'upcoming'] as const;
export type TmdbDiscoverList = typeof TMDB_DISCOVER_LISTS[number];

/**
 * A TMDB API call that failed, by status and route only. A `429` carries how long TMDB asked to wait (its
 * `Retry-After`, in milliseconds), when it said.
 */
export class TmdbError extends Error {
  public constructor(message: string, public readonly status: number, public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'TmdbError';
  }
}

const V3_KEY = /^[0-9a-f]{32}$/i;
const V4_TOKEN = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;

/** Whether `value` looks like a TMDB v3 API key (32 hex digits) or a v4 API read access token (a JWT). */
export function isTmdbCredential(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && (V3_KEY.test(value) || V4_TOKEN.test(value));
}

/** TMDB's credentials, private to this module: never on an instance, so never logged or serialized with it. */
const credentials = new WeakMap<TmdbClient, string>();

/** How long one TMDB call, its body included, may take. */
export const TMDB_TIMEOUT_MS = 15_000;

export interface TmdbCallOptions {
  /** Abandons the call when it aborts. */
  signal?: AbortSignal;
}

export class TmdbClient {
  readonly #baseUrl: string;
  readonly #now: () => number;

  /**
   * `credential` is a TMDB v3 API key or a v4 API read access token; a v4 token is sent as a bearer token, a v3 key as
   * `api_key`. Throws a TypeError if it is neither. `baseUrl` is for tests.
   */
  public constructor(credential: string, options: { baseUrl?: string; now?: () => number } = {}) {
    if (!isTmdbCredential(credential)) throw new TypeError('TMDB credential is invalid');
    this.#baseUrl = (options.baseUrl ?? TMDB_API_URL).replace(/\/+$/, '');
    this.#now = options.now ?? Date.now;
    credentials.set(this, credential);
  }

  /** Checks the credential with TMDB (GET /3/authentication). Throws a {@link TmdbError} if TMDB refuses it or fails. */
  public async validate(): Promise<void> {
    await this.#get('/3/authentication', '/3/authentication', {});
  }

  /** Movies, series and people matching `query` (people are not titles; the app drops them). */
  public search(query: string, page = 1, options: TmdbCallOptions = {}): Promise<unknown> {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new TypeError('search query is invalid');
    return this.#get('/3/search/multi', '/3/search/multi', { query, page: pageNumber(page), include_adult: 'false' }, options);
  }

  /**
   * One discover list, built the way Seerr 3.5.1 builds its own (`server/routes/discover.ts`): trending is today's
   * trending titles; popular movies and series are TMDB discover by popularity; upcoming is movies by popularity whose
   * primary release is today (UTC) or later.
   */
  public discover(list: TmdbDiscoverList, page = 1, options: TmdbCallOptions = {}): Promise<unknown> {
    const parameters = { page: pageNumber(page) };
    if (list === 'trending') return this.#get('/3/trending/all/day', '/3/trending/all/day', parameters, options);
    if (list === 'popular-movies') {
      return this.#get('/3/discover/movie', '/3/discover/movie', { ...parameters, sort_by: 'popularity.desc', include_adult: 'false' }, options);
    }
    if (list === 'popular-tv') {
      return this.#get('/3/discover/tv', '/3/discover/tv', { ...parameters, sort_by: 'popularity.desc', include_null_first_air_dates: 'false' }, options);
    }
    if (list === 'upcoming') {
      const today = new Date(this.#now()).toISOString().slice(0, 10);
      return this.#get('/3/discover/movie', '/3/discover/movie',
        { ...parameters, sort_by: 'popularity.desc', include_adult: 'false', 'primary_release_date.gte': today }, options);
    }
    throw new TypeError('discover list is invalid');
  }

  public movie(tmdbId: number, options: TmdbCallOptions = {}): Promise<unknown> {
    return this.#get('/3/movie/:id', `/3/movie/${tmdbIdentifier(tmdbId)}`, {}, options);
  }

  public tv(tmdbId: number, options: TmdbCallOptions = {}): Promise<unknown> {
    return this.#get('/3/tv/:id', `/3/tv/${tmdbIdentifier(tmdbId)}`, {}, options);
  }

  public season(tmdbId: number, seasonNumber: number, options: TmdbCallOptions = {}): Promise<unknown> {
    if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0) throw new TypeError('season number is invalid');
    return this.#get('/3/tv/:id/season/:n', `/3/tv/${tmdbIdentifier(tmdbId)}/season/${seasonNumber}`, {}, options);
  }

  /**
   * A guarded TMDB GET. A redirect is never followed (it would carry the credential to wherever it points) and counts as
   * a failure. The body is read up to {@link MAX_GUARDED_RESPONSE_BYTES} bytes and no further. Errors carry only the
   * status and the route template. The call is abandoned after {@link TMDB_TIMEOUT_MS}, or when `options.signal` aborts.
   */
  async #get(
    route: string,
    path: string,
    parameters: Record<string, string | number>,
    options: TmdbCallOptions = {},
  ): Promise<unknown> {
    const credential = credentials.get(this);
    if (!credential) throw new TypeError('TMDB client is invalid');
    const query = new URLSearchParams({ ...stringValues(parameters), language: TMDB_LANGUAGE });
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (V3_KEY.test(credential)) query.set('api_key', credential);
    else headers.Authorization = `Bearer ${credential}`;
    const timeout = AbortSignal.timeout(TMDB_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}?${query}`, { signal, redirect: 'manual', headers });
    } catch {
      // fetch's own error may quote the URL, and with it a v3 key.
      throw new TmdbError(`TMDB GET ${route} failed`, 502);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const retryAfterMs = response.status === 429 ? retryAfter(response.headers.get('retry-after'), this.#now()) : undefined;
      throw new TmdbError(`TMDB GET ${route} returned ${response.status}`, response.status, retryAfterMs);
    }
    const bytes = await readCappedBody(response, MAX_GUARDED_RESPONSE_BYTES).catch(() => {
      throw new TmdbError(`TMDB GET ${route} failed`, 502);
    });
    if (!bytes) throw new TmdbError(`TMDB GET ${route} response is too large`, 502);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new TmdbError(`TMDB GET ${route} returned invalid JSON`, 502);
    }
  }
}

/** A `Retry-After` header (seconds, or an HTTP date) in milliseconds from now, or undefined if it is not one. */
function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  if (/^[0-9]{1,6}$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function stringValues(parameters: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(parameters).map(([name, value]) => [name, String(value)]));
}

function pageNumber(page: number): number {
  if (!Number.isSafeInteger(page) || page < 1 || page > 500) throw new TypeError('page is invalid');
  return page;
}

function tmdbIdentifier(tmdbId: number): number {
  if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) throw new TypeError('TMDB ID is invalid');
  return tmdbId;
}
