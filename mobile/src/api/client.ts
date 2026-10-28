// The household app API client: every call is an absolute URL on the one household address it was made for
// (`https://jelly-<household>.<domain>/jellypass/app/v1/...`), with the token as `Authorization: MediaBrowser
// Token="..."` and nothing else that identifies the caller. See docs/app-design.md, "Native clients (contract)".
//
// - One call per method, never a retry: the PWA retries nothing on its own (every retry is a member's tap), and a
//   household's devices share one per-address budget (docs/app-api/fetch-budget.json). A 429 is handed back, with
//   its Retry-After when there is one, for the screen to offer a retry.
// - No redirects: every call is `redirect: 'manual'` through expo/fetch (transport.ts), so the token is never sent
//   anywhere but the household, and a 3xx (or any answer from elsewhere) is `unexpected` with nothing read.
// - No cookies (`credentials: 'omit'`). No `cache` option: React Native's fetch (whatwg-fetch) adds a `?_=<time>`
//   query to a GET sent with `cache: 'no-store'`, and the API already answers `Cache-Control: no-store`.
// - A call stops at the caller's AbortSignal (the original abort is thrown, never an ApiError) or after `timeoutMs`
//   (an ApiError `network` with `timedOut`).
// - Nothing is logged, and an ApiError holds only its kind and status: never the URL, the token or the answer.
// - Arguments the API would refuse (a TMDB ID out of range, a blank search) are `invalid_request` without a call.

import type { HouseholdAddress } from './address';
import { tokenAuthorization } from './auth';
import {
  decodeMe,
  decodeMovie,
  decodePage,
  decodeRequests,
  decodeSeason,
  decodeSeries,
  decodeSources,
  type DecodeContext,
} from './decode';
import { ApiError, errorForAnswer } from './errors';
import { householdFetch, offHousehold } from './transport';
import { DISCOVER_LISTS, type DiscoverList, type MediaType, type Me, type Movie, type Page, type Requests, type Season, type Series, type Sources } from './types';

export const API_PREFIX = '/jellypass/app/v1';
export const DEFAULT_TIMEOUT_MS = 20_000;
/** The largest answer read; a bigger one is `unexpected` (the API's largest, a full season, is far smaller). */
export const MAX_ANSWER_CHARS = 5 * 1024 * 1024;

const MAX_TMDB_ID = 2_147_483_647;
const MAX_PAGE = 500;
const MAX_SEASON = 999;
const MAX_QUERY_LENGTH = 100;
const MAX_SEASONS_ASKED = 100;

/** The parts of a fetch Response the client reads. */
export interface ResponseLike {
  readonly status: number;
  /** The final URL, when the platform reports it: an answer from anywhere but the household is `unexpected`. */
  readonly url?: string;
  /** True when the platform followed a redirect to get this answer (never, with `redirect: 'manual'`). */
  readonly redirected?: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface RequestInitLike {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  credentials: 'omit';
  /** Never follow a redirect: the platform hands back the 3xx itself (transport.ts). */
  redirect: 'manual';
  signal: AbortSignal;
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

export interface ApiClientOptions {
  /** The household this client calls, from parseHouseholdAddress. */
  address: HouseholdAddress;
  /** The member's access token for this address, read for each call; none means `unauthorized` without a call. */
  token: () => string | undefined;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** The clock for Retry-After dates. */
  now?: () => number;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export type NetworkList = 'films' | 'all';

export interface ApiClient {
  readonly address: HouseholdAddress;
  me(options?: CallOptions): Promise<Me>;
  /** `query` is trimmed; blank or longer than 100 characters is `invalid_request`. */
  search(query: string, page?: number, options?: CallOptions): Promise<Page>;
  discover(list: DiscoverList, page?: number, options?: CallOptions): Promise<Page>;
  /** The networks and studios JellyPass lists (no TMDB call). */
  sources(options?: CallOptions): Promise<Sources>;
  /** A network's popular series; with `list`, its films (`films`) or its series and films mixed (`all`). */
  network(id: number, list?: NetworkList, page?: number, options?: CallOptions): Promise<Page>;
  /** A studio's popular movies. */
  studio(id: number, page?: number, options?: CallOptions): Promise<Page>;
  movie(tmdbId: number, options?: CallOptions): Promise<Movie>;
  tv(tmdbId: number, options?: CallOptions): Promise<Series>;
  season(tmdbId: number, seasonNumber: number, options?: CallOptions): Promise<Season>;
  /**
   * "Get this": resolves once the API accepted the call. It always answers the same, so this says nothing about what
   * follows; only `requests()` and the titles' `state` tell, later. A series needs the seasons asked for.
   */
  getThis(mediaType: MediaType, tmdbId: number, seasons?: readonly number[], options?: CallOptions): Promise<void>;
  requests(options?: CallOptions): Promise<Requests>;
  /**
   * Cancels one of the caller's own requests, by its `requests()` ID: resolves once the API accepted the call. It always
   * answers the same, so this says nothing about what follows; only `requests()` tells, later. Needs `apiVersion` 2.
   */
  cancelRequest(id: string, options?: CallOptions): Promise<void>;
}

function isWhole(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Throws `invalid_request` (no call is made) unless every check passed. */
function check(...checks: boolean[]): void {
  if (!checks.every(Boolean)) throw new ApiError('invalid_request');
}

/** `?page=n` for a page after the first, as the PWA sends it. */
function pageQuery(page: number): string {
  check(isWhole(page, 1, MAX_PAGE));
  return page > 1 ? `?page=${page}` : '';
}

/** The caller's abort, as thrown: its reason when that is an AbortError, or a new one. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { address } = options;
  const fetchAnswer: FetchLike = options.fetch ?? householdFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const context: DecodeContext = { origin: address.origin };
  const base = `${address.origin}${API_PREFIX}`;

  /** One call: the answer's body parsed as JSON on a 2xx (or undefined when `read` is false), else the ApiError. */
  async function call(method: 'GET' | 'POST', path: string, body: unknown, read: boolean, callOptions?: CallOptions): Promise<unknown> {
    const token = options.token();
    if (!token) throw new ApiError('unauthorized');
    const external = callOptions?.signal;
    if (external?.aborted) throw abortError(external);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    external?.addEventListener('abort', onAbort);
    /** A failure to get or read an answer: the caller's abort, or `network`. */
    const lost = (): Error => (external?.aborted ? abortError(external) : new ApiError('network', { timedOut }));

    try {
      let response: ResponseLike;
      try {
        response = await fetchAnswer(`${base}${path}`, {
          method,
          headers: {
            Accept: 'application/json',
            Authorization: tokenAuthorization(token),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          credentials: 'omit',
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch {
        throw lost();
      }
      const { status } = response;
      // A redirect (never followed) is `unavailable`, as any status the contract does not list; an answer from anywhere
      // else is `unexpected`. Nothing in either is read.
      if (offHousehold(response, address.origin)) throw new ApiError(status >= 300 && status < 400 ? 'unavailable' : 'unexpected', { status });
      const ok = status >= 200 && status < 300;
      if (ok && !read) return undefined;

      let text: string;
      try {
        text = await response.text();
      } catch {
        if (external?.aborted || timedOut) throw lost();
        if (ok) throw new ApiError('unexpected', { status });
        text = '';
      }
      let parsed: unknown;
      try {
        parsed = text.length <= MAX_ANSWER_CHARS ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      if (!ok) throw errorForAnswer(status, parsed, response.headers.get('Retry-After'), now());
      if (parsed === undefined) throw new ApiError('unexpected', { status });
      return parsed;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }

  async function get<T>(path: string, decode: (value: unknown) => T, callOptions?: CallOptions): Promise<T> {
    const answer = await call('GET', path, undefined, true, callOptions);
    try {
      return decode(answer);
    } catch {
      throw new ApiError('unexpected', { status: 200 });
    }
  }

  const page = (value: unknown) => decodePage(value, context);
  const tmdbId = (id: number) => check(isWhole(id, 1, MAX_TMDB_ID));

  return {
    address,
    me: (callOptions) => get('/me', decodeMe, callOptions),
    search: async (query, pageNumber = 1, callOptions) => {
      const q = query.trim();
      check(q.length >= 1 && q.length <= MAX_QUERY_LENGTH, isWhole(pageNumber, 1, MAX_PAGE));
      return get(`/search?q=${encodeURIComponent(q)}&page=${pageNumber}`, page, callOptions);
    },
    discover: async (list, pageNumber = 1, callOptions) => {
      check(DISCOVER_LISTS.includes(list));
      return get(`/discover/${list}${pageQuery(pageNumber)}`, page, callOptions);
    },
    sources: (callOptions) => get('/discover/sources', decodeSources, callOptions),
    network: async (id, list, pageNumber = 1, callOptions) => {
      check(isWhole(id, 1, Number.MAX_SAFE_INTEGER), list === undefined || list === 'films' || list === 'all');
      return get(`/discover/network/${id}${list ? `/${list}` : ''}${pageQuery(pageNumber)}`, page, callOptions);
    },
    studio: async (id, pageNumber = 1, callOptions) => {
      check(isWhole(id, 1, Number.MAX_SAFE_INTEGER));
      return get(`/discover/studio/${id}${pageQuery(pageNumber)}`, page, callOptions);
    },
    movie: async (id, callOptions) => {
      tmdbId(id);
      return get(`/movie/${id}`, (value) => decodeMovie(value, context), callOptions);
    },
    tv: async (id, callOptions) => {
      tmdbId(id);
      return get(`/tv/${id}`, (value) => decodeSeries(value, context), callOptions);
    },
    season: async (id, seasonNumber, callOptions) => {
      tmdbId(id);
      check(isWhole(seasonNumber, 0, MAX_SEASON));
      return get(`/tv/${id}/season/${seasonNumber}`, decodeSeason, callOptions);
    },
    getThis: async (mediaType, id, seasons = [], callOptions) => {
      tmdbId(id);
      // A movie sends an empty object, a series the seasons asked for; the answer is the same fixed 202 either way.
      if (mediaType === 'tv') {
        check(
          seasons.length >= 1 && seasons.length <= MAX_SEASONS_ASKED,
          seasons.every((season) => isWhole(season, 1, MAX_SEASON)),
          new Set(seasons).size === seasons.length,
        );
      } else check(mediaType === 'movie', seasons.length === 0);
      await call('POST', `/${mediaType}/${id}/get`, mediaType === 'tv' ? { seasons: [...seasons] } : {}, false, callOptions);
    },
    requests: (callOptions) => get('/requests', decodeRequests, callOptions),
    cancelRequest: async (id, callOptions) => {
      check(typeof id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(id));
      await call('POST', `/requests/${id}/cancel`, {}, false, callOptions);
    },
  };
}
