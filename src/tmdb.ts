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
export const TMDB_DISCOVER_LISTS = ['trending', 'popular-movies', 'popular-tv', 'upcoming', 'upcoming-tv'] as const;
export type TmdbDiscoverList = typeof TMDB_DISCOVER_LISTS[number];

/** A TMDB network or production company the app offers a list of, with its name and TMDB logo file. */
export interface TmdbSource {
  id: number;
  name: string;
  logoPath: string;
  /**
   * The TMDB networks the list is drawn from, when more than `id` alone (`id` first); TMDB lists the series of any of
   * them. Fixed here, never taken from a request.
   */
  networkIds?: readonly number[];
}

/**
 * The only networks whose series the app lists (TMDB `discover/tv` with `with_networks`): the major US streamers. IDs,
 * names and logo files checked against TMDB's `GET /3/network/:id` (2026-10-25); Seerr 3.5.1's Networks slider
 * (`src/components/Discover/NetworkSlider`) uses the same IDs for all of them but HBO Max, which it does not list.
 * HBO Max's list also takes in HBO (49), where TMDB files HBO's own series (The Last of Us, House of the Dragon); the
 * app has one HBO Max row, by HBO Max's ID and logo, and no HBO one.
 */
export const TMDB_NETWORKS: readonly TmdbSource[] = Object.freeze([
  { id: 213, name: 'Netflix', logoPath: '/wwemzKWzjKYJFfCeiB57q3r4Bcm.png' },
  { id: 2739, name: 'Disney+', logoPath: '/1edZOYAfoyZyZ3rklNSiUpXX30Q.png' },
  { id: 2552, name: 'Apple TV', logoPath: '/bngHRFi794mnMq34gfVcm9nDxN1.png' },
  { id: 1024, name: 'Prime Video', logoPath: '/w7HfLNm9CWwRmAMU58udl2L7We7.png' },
  { id: 3186, name: 'HBO Max', logoPath: '/nmU0UMDJB3dRRQSTUqawzF2Od1a.png', networkIds: Object.freeze([3186, 49]) },
  { id: 453, name: 'Hulu', logoPath: '/pqUTCleNUiTLAVlelGxUgWn1ELh.png' },
  { id: 4330, name: 'Paramount+', logoPath: '/fi83B1oztoS47xxcemFdPMhIzK.png' },
  { id: 3353, name: 'Peacock', logoPath: '/gIAcGTjKKr0KOHL5s4O36roJ8p7.png' },
].map((source) => Object.freeze(source)));

/**
 * The only production companies whose movies the app lists (TMDB `discover/movie` with `with_companies`): Seerr 3.5.1's
 * Studios slider (`src/components/Discover/StudioSlider`), in its order and with its names. Logo files are TMDB's
 * current ones from `GET /3/company/:id` (2026-10-25).
 */
export const TMDB_STUDIOS: readonly TmdbSource[] = Object.freeze([
  { id: 2, name: 'Disney', logoPath: '/wdrCwmRnLFJhEoH8GSfymY85KHT.png' },
  { id: 127928, name: '20th Century Studios', logoPath: '/h0rjX5vjW5r8yEnUBStFarjcLT4.png' },
  { id: 34, name: 'Sony Pictures', logoPath: '/xAb1o9HrSvKBo9mnXC8fJKDNu00.png' },
  { id: 174, name: 'Warner Bros. Pictures', logoPath: '/zhD3hhtKB5qyv7ZeL4uLpNxgMVU.png' },
  { id: 33, name: 'Universal', logoPath: '/8lvHyhjr8oUKOOy2dKXoALWKdp0.png' },
  { id: 4, name: 'Paramount', logoPath: '/jay6WcMgagAklUt7i9Euwj1pzTF.png' },
  { id: 3, name: 'Pixar', logoPath: '/1TjvGVDMYsj6JBxOAkUHpPEwLf7.png' },
  { id: 521, name: 'DreamWorks', logoPath: '/3BPX5VGBov8SDqTV7wC1L1xShAS.png' },
  { id: 420, name: 'Marvel Studios', logoPath: '/hUzeosd33nzE5MCNsZxCGEKTXaQ.png' },
  { id: 9993, name: 'DC', logoPath: '/2Tc1P3Ac8M479naPp1kYT3izLS5.png' },
  { id: 41077, name: 'A24', logoPath: '/1ZXsGaFPgrgS6ZZGS37AqD5uU12.png' },
].map((source) => Object.freeze(source)));

/** The allowlisted network or studio with this TMDB ID, or undefined. */
export function tmdbSource(kind: 'network' | 'studio', id: number): TmdbSource | undefined {
  return (kind === 'network' ? TMDB_NETWORKS : TMDB_STUDIOS).find((source) => source.id === id);
}

/** Upcoming series first air within this long of now: Seerr 3.5.1's default upper bound, a year and a half. */
const UPCOMING_TV_SPAN_MS = 1000 * 60 * 60 * 24 * (365 * 1.5);

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
   * primary release is today (UTC) or later; upcoming series are series by popularity first airing from today (UTC)
   * to a year and a half from now (Seerr's `discover/tv/upcoming` with its default upper bound).
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
    if (list === 'upcoming-tv') {
      const today = new Date(this.#now());
      const until = new Date(today.getTime() + UPCOMING_TV_SPAN_MS);
      return this.#get('/3/discover/tv', '/3/discover/tv', {
        ...parameters,
        sort_by: 'popularity.desc',
        include_null_first_air_dates: 'false',
        'first_air_date.gte': today.toISOString().slice(0, 10),
        'first_air_date.lte': until.toISOString().slice(0, 10),
      }, options);
    }
    throw new TypeError('discover list is invalid');
  }

  /**
   * Popular series of one allowlisted network ({@link TMDB_NETWORKS}), as Seerr 3.5.1's `discover/tv/network/:id`:
   * TMDB discover by popularity with `with_networks`; a network listed with several {@link TmdbSource.networkIds} asks
   * for the series of any of them (TMDB's `|`, OR). Throws a TypeError for any other network.
   */
  public network(networkId: number, page = 1, options: TmdbCallOptions = {}): Promise<unknown> {
    const source = tmdbSource('network', networkId);
    if (!source) throw new TypeError('network is not allowed');
    return this.#get('/3/discover/tv', '/3/discover/tv', {
      page: pageNumber(page),
      sort_by: 'popularity.desc',
      include_null_first_air_dates: 'false',
      with_networks: (source.networkIds ?? [source.id]).join('|'),
    }, options);
  }

  /**
   * Popular movies of one allowlisted studio ({@link TMDB_STUDIOS}), as Seerr 3.5.1's `discover/movies/studio/:id`:
   * TMDB discover by popularity with `with_companies`. Throws a TypeError for any other company.
   */
  public studio(companyId: number, page = 1, options: TmdbCallOptions = {}): Promise<unknown> {
    if (!tmdbSource('studio', companyId)) throw new TypeError('studio is not allowed');
    return this.#get('/3/discover/movie', '/3/discover/movie', {
      page: pageNumber(page),
      sort_by: 'popularity.desc',
      include_adult: 'false',
      with_companies: companyId,
    }, options);
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
