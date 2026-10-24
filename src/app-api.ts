import type { IncomingMessage, ServerResponse } from 'node:http';
import { AttemptCounter } from './rate-limit.js';
import {
  normalizeJellyfinUserId,
  SeerrError,
  SeerrUnmappedUserError,
  type SeerrCatalogueClient,
  type SeerrDiscoverList,
  type SeerrMemberClient,
} from './seerr.js';

/**
 * The household app API, served under /jellypass/app/v1 on household hosts only (see docs/app-design.md). Read-only in
 * this version: who the caller is, search, discover and title details, each title with the caller's household state.
 *
 * Every answer is built by allowlist shaping: each DTO field is copied from one Seerr or Jellyfin field chosen for it,
 * checked for type, and nothing else is read into a response. Seerr objects are never spread, relayed or stripped.
 * Nothing in an answer depends on what another household holds, has requested or is waiting on: titles are read as
 * the catalogue user, the household state of every title is decided by {@link titleState} from the caller's own Seerr
 * permissions, their household's own requests and the caller's own Jellyfin view, and paging comes only from the
 * titles returned.
 */

export const APP_API_PREFIX = '/jellypass/app/v1';
/** How long a verified Jellyfin token is trusted without asking Jellyfin again (at most 5 minutes). */
export const APP_SESSION_TTL_MS = 5 * 60 * 1000;
/** How long the caller's own Jellyfin library view is reused. */
export const APP_LIBRARY_TTL_MS = 60 * 1000;
/** App requests allowed per client address, and per signed-in user, in each window of APP_BUDGET_WINDOW_MS. */
export const APP_BUDGET_WINDOW_MS = 5 * 60 * 1000;
export const MAX_APP_REQUESTS_PER_CLIENT = 300;
export const MAX_APP_REQUESTS_PER_USER = 200;
const MAX_TRACKED = 10_000;
const MAX_LIBRARIES = 500;
/** Seerr returns 20 titles per page (TMDB's page size); a full page is the only sign another may follow. */
const CATALOGUE_PAGE_SIZE = 20;
const MAX_PAGE = 500;
const MAX_QUERY_LENGTH = 100;
const OWN_REQUESTS_PAGE = 100;
const MAX_OWN_REQUEST_PAGES = 10;
const LIBRARY_PAGE = 1000;
const MAX_LIBRARY_PAGES = 50;
const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w342';
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/w780';

/** Seerr permission bits (Seerr 3.5.1 `server/lib/permissions.ts`) that allow an HD request. */
const SEERR_ADMIN = 2;
const SEERR_REQUEST = 32;
const SEERR_REQUEST_MOVIE = 262_144;
const SEERR_REQUEST_TV = 524_288;
/** Seerr MediaStatus.BLOCKLISTED: set only by an administrator's blocklist, the same for every household. */
const SEERR_MEDIA_BLOCKLISTED = 6;
/** Seerr MediaRequestStatus values a request is still active in: pending and approved. */
const ACTIVE_REQUEST_STATUSES = new Set([1, 2]);

export type AppEndpoint = 'me' | 'search' | 'discover' | 'movie' | 'tv' | 'season' | 'unknown';
export type AppOutcome = 'ok' | 'unauthorized' | 'rate_limited' | 'invalid' | 'not_found' | 'unavailable';

/**
 * The only error answers, the same for every endpoint and every title. `unauthorized` covers a missing, invalid or
 * disabled token and a caller from another household alike.
 */
const APP_ERRORS: Record<Exclude<AppOutcome, 'ok'>, { status: number; body: { error: string } }> = {
  unauthorized: { status: 401, body: { error: 'unauthorized' } },
  rate_limited: { status: 429, body: { error: 'too_many_requests' } },
  invalid: { status: 400, body: { error: 'invalid_request' } },
  not_found: { status: 404, body: { error: 'not_found' } },
  unavailable: { status: 502, body: { error: 'unavailable' } },
};

/** The discover lists the app offers, by their path segment. */
const DISCOVER_LISTS: Record<string, { list: SeerrDiscoverList; mediaType?: MediaType }> = {
  trending: { list: 'trending' },
  'popular-movies': { list: 'movies', mediaType: 'movie' },
  'popular-tv': { list: 'tv', mediaType: 'tv' },
  upcoming: { list: 'movies/upcoming', mediaType: 'movie' },
};

export type MediaType = 'movie' | 'tv';
export type HouseholdState = 'unavailable' | 'in_library' | 'requested' | 'get_this';

/** The caller as Jellyfin's GET /Users/Me reports them. */
export interface JellyfinCaller {
  id: string;
  name: string;
  disabled: boolean;
}

/** What the household gateway hands the app for one request. */
export interface HouseholdAppRequest {
  householdId: string;
  memberIds: readonly string[];
  /** The household host, as `https://<host>`, for Play links. */
  origin: string;
  /** The client address, for the per-client budget. */
  clientId: string;
  /** A hash of the Jellyfin credentials the request carries, or undefined when it carries none. */
  credentialKey: string | undefined;
  /** The caller per Jellyfin's GET /Users/Me, or undefined if Jellyfin rejects the credentials. Throws if Jellyfin fails. */
  currentUser(): Promise<JellyfinCaller | undefined>;
  /** A Jellyfin GET with the caller's own credentials. Throws unless Jellyfin answers 2xx with JSON. */
  getAsCaller(pathname: string, query: URLSearchParams): Promise<unknown>;
}

export interface HouseholdAppHandler {
  handle(request: IncomingMessage, response: ServerResponse, context: HouseholdAppRequest): Promise<void>;
}

export interface HouseholdAppOptions {
  /** Titles, read as the dedicated catalogue user. */
  catalogue: Pick<SeerrCatalogueClient, 'search' | 'discover' | 'movie' | 'tv' | 'season'>;
  /** Each member's own Seerr data, confirmed before every call (a `SeerrUserMap`). */
  members: { member(jellyfinUserId: string): Pick<SeerrMemberClient, 'ownRequests' | 'ownUser'> | undefined };
  householdName: (householdId: string) => string | undefined;
  /** Counts each answer by endpoint and outcome; never by title. */
  record?: (endpoint: AppEndpoint, outcome: AppOutcome) => void;
  now?: () => number;
  libraryTtlMs?: number;
  logLevel?: string;
}

/** One title's household state, with the caller's own Jellyfin item only when it is `in_library`. */
interface TitleState {
  state: HouseholdState;
  itemId?: string;
}

/**
 * Everything a household state is decided from. None of it depends on another household: the caller's own Seerr
 * request permission, the requests of the caller's own household members (each read as that member) and the titles the
 * caller's own Jellyfin view holds.
 */
interface HouseholdView {
  eligible: Record<MediaType, boolean>;
  requested: ReadonlySet<string>;
  library: ReadonlyMap<string, string>;
}

/**
 * The single place a household state is decided, for every card, title and season. `unavailable` (blocklisted, or the
 * caller may not request this media type, which includes a caller Seerr has no user for) is decided before anything
 * else; then `in_library` (the caller's own Jellyfin view has it), `requested` (an active HD request by a member of the
 * caller's household) and otherwise `get_this`.
 */
export function titleState(view: HouseholdView, mediaType: MediaType, tmdbId: number, blocklisted: boolean): TitleState {
  if (blocklisted || !view.eligible[mediaType]) return { state: 'unavailable' };
  const key = titleKey(mediaType, tmdbId);
  const itemId = view.library.get(key);
  if (itemId) return { state: 'in_library', itemId };
  if (view.requested.has(key)) return { state: 'requested' };
  return { state: 'get_this' };
}

/** A season's state: the series' own when that is `unavailable`, otherwise whether the caller's view has its episodes. */
function seasonState(series: TitleState, seasonsInLibrary: ReadonlySet<number>, seasonNumber: number): HouseholdState {
  if (series.state === 'unavailable') return 'unavailable';
  return seasonsInLibrary.has(seasonNumber) ? 'in_library' : 'get_this';
}

class AppAnswer extends Error {
  public constructor(public readonly outcome: Exclude<AppOutcome, 'ok'>) {
    super(outcome);
  }
}

interface Route {
  endpoint: AppEndpoint;
  run: (caller: JellyfinCaller, context: HouseholdAppRequest, url: URL) => Promise<unknown>;
}

export class HouseholdApp implements HouseholdAppHandler {
  readonly #catalogue: HouseholdAppOptions['catalogue'];
  readonly #members: HouseholdAppOptions['members'];
  readonly #householdName: HouseholdAppOptions['householdName'];
  readonly #record: NonNullable<HouseholdAppOptions['record']>;
  readonly #now: () => number;
  readonly #libraryTtlMs: number;
  readonly #debug: boolean;
  readonly #byClient: AttemptCounter;
  readonly #byUser: AttemptCounter;
  readonly #sessions = new Map<string, { expiresAt: number; caller: JellyfinCaller }>();
  readonly #libraries = new Map<string, { expiresAt: number; library: Promise<Map<string, string>> }>();

  public constructor(options: HouseholdAppOptions) {
    this.#catalogue = options.catalogue;
    this.#members = options.members;
    this.#householdName = options.householdName;
    this.#record = options.record ?? (() => undefined);
    this.#now = options.now ?? Date.now;
    this.#libraryTtlMs = options.libraryTtlMs ?? APP_LIBRARY_TTL_MS;
    this.#debug = options.logLevel === 'debug';
    this.#byClient = new AttemptCounter({ windowMs: APP_BUDGET_WINDOW_MS, maxKeys: MAX_TRACKED, now: this.#now });
    this.#byUser = new AttemptCounter({ windowMs: APP_BUDGET_WINDOW_MS, maxKeys: MAX_TRACKED, now: this.#now });
  }

  public async handle(request: IncomingMessage, response: ServerResponse, context: HouseholdAppRequest): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = this.#route(request.method, url.pathname);
    const endpoint = route?.endpoint ?? 'unknown';
    const answer = (outcome: AppOutcome, body?: unknown) => {
      this.#record(endpoint, outcome);
      if (outcome === 'ok') writeAppJson(response, 200, body);
      else writeAppJson(response, APP_ERRORS[outcome].status, APP_ERRORS[outcome].body);
    };
    // Counted for every call, signed in or not, before Jellyfin is asked anything.
    if (this.#byClient.increment(context.clientId) > MAX_APP_REQUESTS_PER_CLIENT) return answer('rate_limited');
    let caller: JellyfinCaller | undefined;
    try {
      caller = await this.#caller(context);
    } catch (error) {
      this.#logFailure(endpoint, error);
      return answer('unavailable');
    }
    if (!caller) return answer('unauthorized');
    if (this.#byUser.increment(normalizedUserId(caller.id)) > MAX_APP_REQUESTS_PER_USER) return answer('rate_limited');
    if (!route) return answer('not_found');
    let body: unknown;
    try {
      body = await route.run(caller, context, url);
    } catch (error) {
      if (error instanceof AppAnswer) return answer(error.outcome);
      this.#logFailure(endpoint, error);
      return answer('unavailable');
    }
    return answer('ok', body);
  }

  #route(method: string | undefined, pathname: string): Route | undefined {
    if (method !== 'GET' || !pathname.startsWith(`${APP_API_PREFIX}/`)) return undefined;
    const path = pathname.slice(APP_API_PREFIX.length);
    if (path === '/me') return { endpoint: 'me', run: (caller, context) => this.#me(caller, context) };
    if (path === '/search') return { endpoint: 'search', run: (caller, context, url) => this.#search(caller, context, url) };
    const discover = /^\/discover\/([a-z-]+)$/.exec(path);
    if (discover) {
      const list = Object.hasOwn(DISCOVER_LISTS, discover[1] as string) ? DISCOVER_LISTS[discover[1] as string] : undefined;
      return list ? { endpoint: 'discover', run: (caller, context, url) => this.#discover(caller, context, url, list) } : undefined;
    }
    const movie = /^\/movie\/([^/]+)$/.exec(path);
    if (movie) return { endpoint: 'movie', run: (caller, context) => this.#movie(caller, context, movie[1] as string) };
    const tv = /^\/tv\/([^/]+)$/.exec(path);
    if (tv) return { endpoint: 'tv', run: (caller, context) => this.#tv(caller, context, tv[1] as string) };
    const season = /^\/tv\/([^/]+)\/season\/([^/]+)$/.exec(path);
    if (season) {
      return { endpoint: 'season', run: (caller, context) => this.#season(caller, context, season[1] as string, season[2] as string) };
    }
    return undefined;
  }

  /**
   * The caller, if their token is valid, their Jellyfin user enabled and a member of this host's household; otherwise
   * undefined, whichever of these failed. A verified token is trusted for {@link APP_SESSION_TTL_MS}; membership is
   * checked against the store on every call.
   */
  async #caller(context: HouseholdAppRequest): Promise<JellyfinCaller | undefined> {
    const key = context.credentialKey;
    if (!key) return undefined;
    const now = this.#now();
    let caller = this.#sessions.get(key);
    if (caller && caller.expiresAt <= now) {
      this.#sessions.delete(key);
      caller = undefined;
    }
    if (!caller) {
      const verified = await context.currentUser();
      if (!verified) return undefined;
      caller = { expiresAt: now + APP_SESSION_TTL_MS, caller: verified };
      this.#sessions.set(key, caller);
      while (this.#sessions.size > MAX_TRACKED) this.#sessions.delete(this.#sessions.keys().next().value as string);
    }
    if (caller.caller.disabled) return undefined;
    const id = normalizedUserId(caller.caller.id);
    if (!context.memberIds.some((member) => normalizedUserId(member) === id)) return undefined;
    return caller.caller;
  }

  async #me(caller: JellyfinCaller, context: HouseholdAppRequest): Promise<MeDto> {
    return { name: caller.name, household: this.#householdName(context.householdId) ?? '' };
  }

  async #search(caller: JellyfinCaller, context: HouseholdAppRequest, url: URL): Promise<PageDto> {
    const query = url.searchParams.get('q')?.trim() ?? '';
    if (!query || query.length > MAX_QUERY_LENGTH) throw new AppAnswer('invalid');
    const page = pageParameter(url);
    const [answer, view] = await Promise.all([this.#catalogue.search(query, page), this.#view(caller, context)]);
    return pageOf(answer, page, undefined, view, context.origin);
  }

  async #discover(
    caller: JellyfinCaller,
    context: HouseholdAppRequest,
    url: URL,
    list: { list: SeerrDiscoverList; mediaType?: MediaType },
  ): Promise<PageDto> {
    const page = pageParameter(url);
    const [answer, view] = await Promise.all([this.#catalogue.discover(list.list, page), this.#view(caller, context)]);
    return pageOf(answer, page, list.mediaType, view, context.origin);
  }

  async #movie(caller: JellyfinCaller, context: HouseholdAppRequest, input: string): Promise<MovieDto> {
    const tmdbId = tmdbParameter(input);
    const [answer, view] = await Promise.all([catalogueTitle(this.#catalogue.movie(tmdbId)), this.#view(caller, context)]);
    const state = titleState(view, 'movie', tmdbId, isBlocklisted(answer));
    return {
      mediaType: 'movie',
      tmdbId,
      ...titleFields(answer, 'movie'),
      genres: genreNames(field(answer, 'genres')),
      runtime: positiveInteger(field(answer, 'runtime')),
      ...stateFields(state, context.origin),
    };
  }

  async #tv(caller: JellyfinCaller, context: HouseholdAppRequest, input: string): Promise<TvDto> {
    const tmdbId = tmdbParameter(input);
    const [answer, view] = await Promise.all([catalogueTitle(this.#catalogue.tv(tmdbId)), this.#view(caller, context)]);
    const state = titleState(view, 'tv', tmdbId, isBlocklisted(answer));
    const inLibrary = await this.#seasonsInLibrary(caller, context, state);
    const runTimes = field(answer, 'episodeRunTime');
    return {
      mediaType: 'tv',
      tmdbId,
      ...titleFields(answer, 'tv'),
      genres: genreNames(field(answer, 'genres')),
      runtime: Array.isArray(runTimes) ? positiveInteger(runTimes[0]) : null,
      seasons: seasonList(field(answer, 'seasons')).map((season) => ({
        ...season,
        state: seasonState(state, inLibrary, season.seasonNumber),
      })),
      ...stateFields(state, context.origin),
    };
  }

  async #season(caller: JellyfinCaller, context: HouseholdAppRequest, input: string, seasonInput: string): Promise<SeasonDto> {
    const tmdbId = tmdbParameter(input);
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(seasonInput)) throw new AppAnswer('invalid');
    const seasonNumber = Number(seasonInput);
    const [series, answer, view] = await Promise.all([
      catalogueTitle(this.#catalogue.tv(tmdbId)),
      catalogueTitle(this.#catalogue.season(tmdbId, seasonNumber)),
      this.#view(caller, context),
    ]);
    const state = titleState(view, 'tv', tmdbId, isBlocklisted(series));
    const inLibrary = await this.#seasonsInLibrary(caller, context, state);
    const episodes = field(answer, 'episodes');
    return {
      tmdbId,
      seasonNumber,
      name: text(field(answer, 'name'), 200),
      overview: text(field(answer, 'overview'), 4000),
      episodes: (Array.isArray(episodes) ? episodes : []).flatMap((episode) => {
        const episodeNumber = nonNegativeInteger(field(episode, 'episodeNumber'));
        return episodeNumber === null ? [] : [{
          episodeNumber,
          name: text(field(episode, 'name'), 200),
          overview: text(field(episode, 'overview'), 4000),
        }];
      }).slice(0, 500),
      state: seasonState(state, inLibrary, seasonNumber),
    };
  }

  /** Everything the household states of this answer are decided from (see {@link HouseholdView}), read in parallel. */
  async #view(caller: JellyfinCaller, context: HouseholdAppRequest): Promise<HouseholdView> {
    const [eligible, requested, library] = await Promise.all([
      this.#eligibility(caller),
      this.#householdRequests(context.memberIds),
      this.#library(caller, context),
    ]);
    return { eligible, requested, library };
  }

  /**
   * Whether the caller may request each media type in HD, from their own Seerr user read as them. A caller Seerr has no
   * confirmed user for may request nothing.
   */
  async #eligibility(caller: JellyfinCaller): Promise<Record<MediaType, boolean>> {
    const none = { movie: false, tv: false };
    const member = this.#members.member(caller.id);
    if (!member) return none;
    let user: unknown;
    try {
      user = await member.ownUser();
    } catch (error) {
      if (error instanceof SeerrUnmappedUserError) return none;
      throw error;
    }
    const permissions = field(user, 'permissions');
    if (typeof permissions !== 'number' || !Number.isSafeInteger(permissions) || permissions < 0) return none;
    const has = (bit: number) => (permissions & bit) !== 0;
    const any = has(SEERR_ADMIN) || has(SEERR_REQUEST);
    return { movie: any || has(SEERR_REQUEST_MOVIE), tv: any || has(SEERR_REQUEST_TV) };
  }

  /**
   * The titles members of this household have an active HD request for, each member's own requests read as that member.
   * A member Seerr has no confirmed user for has none.
   */
  async #householdRequests(memberIds: readonly string[]): Promise<Set<string>> {
    const members = [...new Set(memberIds.flatMap((id) => normalizeJellyfinUserId(id) ?? []))];
    const keys = await Promise.all(members.map(async (id) => {
      const member = this.#members.member(id);
      if (!member) return [];
      try {
        return await activeRequests(member);
      } catch (error) {
        if (error instanceof SeerrUnmappedUserError) return [];
        throw error;
      }
    }));
    return new Set(keys.flat());
  }

  /**
   * The movies and series the caller's own Jellyfin view holds, by TMDB ID, read with the caller's own credentials (so
   * Jellyfin applies their blocked tags, library access and parental limits) and reused for a short while.
   */
  #library(caller: JellyfinCaller, context: HouseholdAppRequest): Promise<Map<string, string>> {
    const key = normalizedUserId(caller.id);
    const now = this.#now();
    const cached = this.#libraries.get(key);
    if (cached && cached.expiresAt > now) return cached.library;
    const library = readLibrary(caller, context);
    this.#libraries.delete(key);
    this.#libraries.set(key, { expiresAt: now + this.#libraryTtlMs, library });
    while (this.#libraries.size > MAX_LIBRARIES) this.#libraries.delete(this.#libraries.keys().next().value as string);
    // A failed read is not kept.
    library.catch(() => {
      if (this.#libraries.get(key)?.library === library) this.#libraries.delete(key);
    });
    return library;
  }

  /** The season numbers of a series the caller's own Jellyfin view has episodes of; none unless it is `in_library`. */
  async #seasonsInLibrary(caller: JellyfinCaller, context: HouseholdAppRequest, state: TitleState): Promise<Set<number>> {
    if (state.state !== 'in_library' || !state.itemId) return new Set();
    const answer = await context.getAsCaller(`/Shows/${state.itemId}/Episodes`, new URLSearchParams({
      userId: caller.id,
      isMissing: 'false',
      enableImages: 'false',
      enableUserData: 'false',
    }));
    const items = field(answer, 'Items');
    const seasons = new Set<number>();
    for (const item of Array.isArray(items) ? items : []) {
      const season = nonNegativeInteger(field(item, 'ParentIndexNumber'));
      if (season !== null) seasons.add(season);
    }
    return seasons;
  }

  #logFailure(endpoint: AppEndpoint, error: unknown): void {
    // Seerr and Jellyfin errors name the route and status only.
    console.error(JSON.stringify({
      level: 'error',
      message: 'household app request failed',
      endpoint,
      detail: error instanceof Error ? error.message : String(error),
    }));
    if (this.#debug && error instanceof Error && error.stack) console.debug(error.stack);
  }
}

export interface MeDto {
  name: string;
  household: string;
}

export interface PlayDto {
  itemId: string;
  url: string;
}

export interface CardDto {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  rating: number | null;
  state: HouseholdState;
  play: PlayDto | null;
}

export interface PageDto {
  page: number;
  nextPage: number | null;
  results: CardDto[];
}

export interface SeasonSummaryDto {
  seasonNumber: number;
  name: string;
  episodeCount: number | null;
  state: HouseholdState;
}

export interface MovieDto extends Omit<CardDto, 'mediaType'> {
  mediaType: 'movie';
  genres: string[];
  runtime: number | null;
}

export interface TvDto extends Omit<CardDto, 'mediaType'> {
  mediaType: 'tv';
  genres: string[];
  runtime: number | null;
  seasons: SeasonSummaryDto[];
}

export interface SeasonDto {
  tmdbId: number;
  seasonNumber: number;
  name: string;
  overview: string;
  episodes: Array<{ episodeNumber: number; name: string; overview: string }>;
  state: HouseholdState;
}

/**
 * A page of cards from a Seerr search or discover answer. Only movies and series are kept (people and collections are
 * not titles). `nextPage` comes only from the answer's own results: Seerr's totals and paging are never read.
 */
function pageOf(answer: unknown, page: number, mediaType: MediaType | undefined, view: HouseholdView, origin: string): PageDto {
  const results = field(answer, 'results');
  const entries = Array.isArray(results) ? results : [];
  const cards = entries.flatMap((entry) => {
    const card = cardOf(entry, mediaType, view, origin);
    return card ? [card] : [];
  });
  return { page, nextPage: entries.length >= CATALOGUE_PAGE_SIZE && page < MAX_PAGE ? page + 1 : null, results: cards };
}

function cardOf(entry: unknown, listType: MediaType | undefined, view: HouseholdView, origin: string): CardDto | undefined {
  const declared = field(entry, 'mediaType');
  const mediaType = declared === 'movie' || declared === 'tv' ? declared : declared === undefined ? listType : undefined;
  const tmdbId = positiveInteger(field(entry, 'id'));
  if (!mediaType || tmdbId === null) return undefined;
  const state = titleState(view, mediaType, tmdbId, isBlocklisted(entry));
  return { mediaType, tmdbId, ...titleFields(entry, mediaType), ...stateFields(state, origin) };
}

/** The title fields every card and title shares, each copied from the one TMDB field chosen for it. */
function titleFields(source: unknown, mediaType: MediaType): Pick<CardDto, 'title' | 'year' | 'overview' | 'posterUrl' | 'backdropUrl' | 'rating'> {
  const date = field(source, mediaType === 'movie' ? 'releaseDate' : 'firstAirDate');
  const year = typeof date === 'string' && /^[0-9]{4}-/.test(date) ? Number(date.slice(0, 4)) : null;
  const rating = field(source, 'voteAverage');
  return {
    title: text(field(source, mediaType === 'movie' ? 'title' : 'name'), 300),
    year,
    overview: text(field(source, 'overview'), 4000),
    posterUrl: imageUrl(TMDB_POSTER_BASE, field(source, 'posterPath')),
    backdropUrl: imageUrl(TMDB_BACKDROP_BASE, field(source, 'backdropPath')),
    rating: typeof rating === 'number' && Number.isFinite(rating) && rating > 0 && rating <= 10 ? Math.round(rating * 10) / 10 : null,
  };
}

function stateFields(state: TitleState, origin: string): Pick<CardDto, 'state' | 'play'> {
  return {
    state: state.state,
    play: state.state === 'in_library' && state.itemId
      ? { itemId: state.itemId, url: `${origin}/web/#/details?id=${state.itemId}` }
      : null,
  };
}

/** Whether an administrator blocklisted the title: Seerr's `mediaInfo.status`, the only field read from `mediaInfo`. */
function isBlocklisted(source: unknown): boolean {
  return field(field(source, 'mediaInfo'), 'status') === SEERR_MEDIA_BLOCKLISTED;
}

function seasonList(value: unknown): Array<Omit<SeasonSummaryDto, 'state'>> {
  return (Array.isArray(value) ? value : []).flatMap((season) => {
    const seasonNumber = nonNegativeInteger(field(season, 'seasonNumber'));
    return seasonNumber === null ? [] : [{
      seasonNumber,
      name: text(field(season, 'name'), 200),
      episodeCount: nonNegativeInteger(field(season, 'episodeCount')),
    }];
  }).slice(0, 200);
}

function genreNames(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).flatMap((genre) => {
    const name = field(genre, 'name');
    return typeof name === 'string' && name ? [name.slice(0, 100)] : [];
  }).slice(0, 20);
}

/** A TMDB image as a fixed TMDB base URL plus an allowlisted file path, or null. */
function imageUrl(base: string, value: unknown): string | null {
  return typeof value === 'string' && /^\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/.test(value) ? `${base}${value}` : null;
}

/** The active HD requests of one member, as `mediaType:tmdbId` keys, paged through their own request list. */
async function activeRequests(member: Pick<SeerrMemberClient, 'ownRequests'>): Promise<string[]> {
  const keys: string[] = [];
  for (let page = 0; page < MAX_OWN_REQUEST_PAGES; page += 1) {
    const results = field(await member.ownRequests(OWN_REQUESTS_PAGE, page * OWN_REQUESTS_PAGE), 'results');
    const requests = Array.isArray(results) ? results : [];
    for (const request of requests) {
      const status = field(request, 'status');
      const type = field(request, 'type');
      const tmdbId = positiveInteger(field(field(request, 'media'), 'tmdbId'));
      if (typeof status !== 'number' || !ACTIVE_REQUEST_STATUSES.has(status) || field(request, 'is4k') === true) continue;
      if ((type !== 'movie' && type !== 'tv') || tmdbId === null) continue;
      keys.push(titleKey(type, tmdbId));
    }
    if (requests.length < OWN_REQUESTS_PAGE) break;
  }
  return keys;
}

/** The caller's own Jellyfin movies and series with a TMDB ID, as `mediaType:tmdbId` → item ID (the lowest when several). */
async function readLibrary(caller: JellyfinCaller, context: HouseholdAppRequest): Promise<Map<string, string>> {
  const library = new Map<string, string>();
  for (let page = 0; page < MAX_LIBRARY_PAGES; page += 1) {
    const answer = await context.getAsCaller('/Items', new URLSearchParams({
      userId: caller.id,
      recursive: 'true',
      includeItemTypes: 'Movie,Series',
      hasTmdbId: 'true',
      fields: 'ProviderIds',
      enableImages: 'false',
      enableUserData: 'false',
      enableTotalRecordCount: 'false',
      sortBy: 'SortName',
      sortOrder: 'Ascending',
      startIndex: String(page * LIBRARY_PAGE),
      limit: String(LIBRARY_PAGE),
    }));
    const items = field(answer, 'Items');
    const entries = Array.isArray(items) ? items : [];
    for (const item of entries) {
      const type = field(item, 'Type');
      const mediaType = type === 'Movie' ? 'movie' : type === 'Series' ? 'tv' : undefined;
      const id = field(item, 'Id');
      const itemId = typeof id === 'string' ? normalizeJellyfinUserId(id) : undefined;
      const tmdbId = providerTmdbId(field(item, 'ProviderIds'));
      if (!mediaType || !itemId || tmdbId === null) continue;
      const key = titleKey(mediaType, tmdbId);
      const known = library.get(key);
      if (!known || itemId < known) library.set(key, itemId);
    }
    if (entries.length < LIBRARY_PAGE) break;
  }
  return library;
}

function providerTmdbId(providerIds: unknown): number | null {
  if (!providerIds || typeof providerIds !== 'object' || Array.isArray(providerIds)) return null;
  for (const [name, value] of Object.entries(providerIds)) {
    if (name.toLowerCase() === 'tmdb' && typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value)) {
      return positiveInteger(Number(value));
    }
  }
  return null;
}

/** A catalogue answer, with a title Seerr does not know reported as `not_found`. */
async function catalogueTitle(answer: Promise<unknown>): Promise<unknown> {
  try {
    return await answer;
  } catch (error) {
    if (error instanceof SeerrError && error.status === 404) throw new AppAnswer('not_found');
    throw error;
  }
}

function pageParameter(url: URL): number {
  const value = url.searchParams.get('page');
  if (value === null) return 1;
  if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > MAX_PAGE) throw new AppAnswer('invalid');
  return Number(value);
}

function tmdbParameter(value: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 2_147_483_647) throw new AppAnswer('invalid');
  return Number(value);
}

function titleKey(mediaType: MediaType, tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

function normalizedUserId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

/** One own property of a JSON object, or undefined; never anything inherited. */
function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, name)) return undefined;
  return (value as Record<string, unknown>)[name];
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function writeAppJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': encoded.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(encoded);
}
