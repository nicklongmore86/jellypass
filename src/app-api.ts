import type { IncomingMessage, ServerResponse } from 'node:http';
import { NEVER_STORE } from './app-assets.js';
import { DispatchQueueFullError, FairDispatcher } from './fair-dispatcher.js';
import {
  GET_THIS_WINDOW_MS,
  MAX_GET_THIS_PER_CLIENT,
  MAX_GET_THIS_PER_HOUSEHOLD,
  MAX_GET_THIS_PER_USER,
  type HouseholdRequests,
  type OwnView,
  type RequestsDto,
} from './household-requests.js';
import { AttemptCounter } from './rate-limit.js';
import {
  normalizeJellyfinUserId,
  SeerrError,
  SeerrUnmappedUserError,
  type SeerrClient,
  type SeerrMemberClient,
} from './seerr.js';
import { MAX_HOUSEHOLDS } from './store.js';
import {
  TMDB_NETWORKS,
  TMDB_STUDIOS,
  TMDB_TIMEOUT_MS,
  TmdbError,
  tmdbSource,
  type TmdbClient,
  type TmdbDiscoverList,
  type TmdbSource,
} from './tmdb.js';

/**
 * The household app API, served under /jellypass/app/v1 on household hosts only (see docs/app-design.md): who the caller
 * is, search, discover and title details, each title with the caller's household state; "Get this" (see
 * {@link HouseholdRequests}), whose answer is the same fixed `202` whatever happens to the title; and the household's own
 * requests with their coarse status.
 *
 * Every answer is built by allowlist shaping: each DTO field is copied from one TMDB or Jellyfin field chosen for it,
 * checked for type, and nothing else is read into a response. Upstream objects are never spread, relayed or stripped.
 * Nothing in an answer depends on what another household holds, has requested or is waiting on: titles come from TMDB,
 * which knows nothing of households, Seerr's media records or anyone's requests; the household state of every title is
 * decided by {@link titleState} from the caller's own Jellyfin view, Seerr's administrator blocklist and the caller's
 * own Seerr permissions; and paging comes only from the titles returned. Each household has its own caches and its own
 * turn at TMDB (see {@link FairDispatcher}), so another household's volume never evicts its answers or uses up its
 * share of TMDB's rate limit.
 */

export const APP_API_PREFIX = '/jellypass/app/v1';
/**
 * The revision of the v1 contract this server speaks, sent in `GET /me`: one more with each release that adds a field or
 * an endpoint to v1, never lowered. v1 only ever gains (see docs/app-design.md, "Native clients (contract)"); anything
 * else is a new path, `/jellypass/app/v2`.
 */
export const APP_API_VERSION = 4;
/** How long a verified Jellyfin token is trusted without asking Jellyfin again (at most 5 minutes). */
export const APP_SESSION_TTL_MS = 5 * 60 * 1000;
/** How long after a sign-out through the household host its tokens are still never kept as verified. */
export const APP_SIGN_OUT_GRACE_MS = 60 * 1000;
/**
 * The most tokens one sign-out is tracked by: one each from `Authorization`, `X-Emby-Authorization`, `X-Emby-Token` and
 * `X-MediaBrowser-Token`, and the first value of each token query parameter (`api_key`, `ApiKey`, `access_token`, in any
 * case).
 */
export const APP_SIGN_OUT_MAX_TOKENS = 7;
/**
 * Sign-outs at Jellyfin at once, per client address, per household and in all. Each keeps its tokens back only while it
 * is at Jellyfin, so these bound what is tracked meanwhile; past any of them a sign-out is refused (503) rather than
 * sent on untracked. A member signs out once, so these are far above what anyone needs.
 */
export const MAX_SIGN_OUTS_IN_FLIGHT_PER_CLIENT = 8;
export const MAX_SIGN_OUTS_IN_FLIGHT_PER_HOUSEHOLD = 32;
export const MAX_SIGN_OUTS_IN_FLIGHT = 512;
/**
 * Sign-outs Jellyfin answered that keep their tokens back for APP_SIGN_OUT_GRACE_MS after, per client address, and per
 * household, in each window of APP_SIGN_OUT_WINDOW_MS. Past these only a token JellyPass has verified (or is verifying)
 * is kept back after; a sign-out Jellyfin did not answer always keeps all of its tokens back.
 */
export const APP_SIGN_OUT_WINDOW_MS = 60 * 1000;
export const MAX_SIGN_OUTS_PER_CLIENT = 10;
export const MAX_SIGN_OUTS_PER_HOUSEHOLD = 30;
/**
 * Token hashes kept back after their sign-outs, all households together. With the limits above a household keeps at
 * most a few hundred, so this is never full on a server of a few households; when it is, the oldest is dropped (see
 * {@link HouseholdApp.signingOut}).
 */
const MAX_SIGN_OUT_TRACKED = 10_000;
/** How long the caller's own Jellyfin library view is reused. */
export const APP_LIBRARY_TTL_MS = 60 * 1000;
/** How long a household reuses a TMDB answer, and how many it keeps (least recently used forgotten first). */
export const APP_TITLE_TTL_MS = 10 * 60 * 1000;
export const MAX_TITLES_PER_HOUSEHOLD = 500;
/** How long a household reuses Seerr's blocklist. */
export const APP_BLOCKLIST_TTL_MS = 60 * 1000;
/** App requests allowed per client address, and per signed-in user, in each window of APP_BUDGET_WINDOW_MS. */
export const APP_BUDGET_WINDOW_MS = 5 * 60 * 1000;
export const MAX_APP_REQUESTS_PER_CLIENT = 300;
export const MAX_APP_REQUESTS_PER_USER = 200;
/** App requests allowed per household, its members together, in each window of APP_BURST_WINDOW_MS. */
export const APP_BURST_WINDOW_MS = 10 * 1000;
export const MAX_APP_REQUESTS_PER_HOUSEHOLD_BURST = 60;
/**
 * TMDB calls, for all households together: at most 20 start a second with at most 10 started at once, so at most 30 in
 * any second, well under TMDB's documented limit of about 40 a second; and at most 10 are ever unanswered at once, each
 * abandoned after {@link TMDB_TIMEOUT_MS}. Each household queues at most 20 calls, each for at most 10 seconds (see
 * {@link FairDispatcher}).
 */
export const TMDB_CALLS_PER_SECOND = 20;
export const TMDB_BURST = 10;
export const TMDB_IN_FLIGHT = 10;
export const TMDB_QUEUE_PER_HOUSEHOLD = 20;
export const TMDB_QUEUE_TIMEOUT_MS = 10 * 1000;
/** How long to wait when TMDB answers 429 without a usable Retry-After. */
const TMDB_DEFAULT_RETRY_AFTER_MS = 1000;
const MAX_TRACKED = 10_000;
/** Verified tokens and library views kept per household, each household's own forgotten first. */
const MAX_SESSIONS_PER_HOUSEHOLD = 100;
const MAX_LIBRARIES_PER_HOUSEHOLD = 50;
/** TMDB returns 20 titles per page; a full page is the only sign another may follow. */
const CATALOGUE_PAGE_SIZE = 20;
const MAX_PAGE = 500;
const MAX_QUERY_LENGTH = 100;
const BLOCKLIST_PAGE = 100;
/** Seerr's newest 5000 blocklist entries are read. */
const MAX_BLOCKLIST_PAGES = 50;
const LIBRARY_PAGE = 1000;
const MAX_LIBRARY_PAGES = 50;
const TMDB_POSTER_BASE = 'https://image.tmdb.org/t/p/w342';
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/w780';
/** Network and studio logos, at one fixed width. */
const TMDB_LOGO_BASE = 'https://image.tmdb.org/t/p/w300';

/** Seerr permission bits (Seerr 3.5.1 `server/lib/permissions.ts`): those that allow an HD request, and managing requests. */
const SEERR_ADMIN = 2;
const SEERR_MANAGE_REQUESTS = 16;
const SEERR_REQUEST = 32;
const SEERR_REQUEST_MOVIE = 262_144;
const SEERR_REQUEST_TV = 524_288;

export type AppEndpoint = 'me' | 'search' | 'discover' | 'movie' | 'tv' | 'season' | 'get' | 'requests' | 'cancel' | 'hide' | 'unhide' | 'hidden' | 'unknown';
export type AppOutcome = 'ok' | 'app_disabled' | 'unauthorized' | 'rate_limited' | 'invalid' | 'not_found' | 'hidden_limit' | 'unavailable';

/**
 * The only error answers, the same for every endpoint and every title. `unauthorized` covers a missing, invalid or
 * disabled token and a caller from another household alike.
 */
const APP_ERRORS: Record<Exclude<AppOutcome, 'ok'>, { status: number; body: { error: string } }> = {
  app_disabled: { status: 403, body: { error: 'app_access_disabled' } },
  unauthorized: { status: 401, body: { error: 'unauthorized' } },
  rate_limited: { status: 429, body: { error: 'too_many_requests' } },
  invalid: { status: 400, body: { error: 'invalid_request' } },
  not_found: { status: 404, body: { error: 'not_found' } },
  /** Only from hiding a new title past MAX_HIDDEN_TITLES_PER_MEMBER: decided by the caller's own hidden titles alone. */
  hidden_limit: { status: 409, body: { error: 'hidden_limit_reached' } },
  unavailable: { status: 502, body: { error: 'unavailable' } },
};

/** The discover lists the app offers, by their path segment, with the media type of lists that hold only one. */
const DISCOVER_LISTS: Record<string, { list: TmdbDiscoverList; mediaType?: MediaType }> = {
  trending: { list: 'trending' },
  'trending-movies': { list: 'trending-movies', mediaType: 'movie' },
  'trending-tv': { list: 'trending-tv', mediaType: 'tv' },
  'popular-movies': { list: 'popular-movies', mediaType: 'movie' },
  'popular-tv': { list: 'popular-tv', mediaType: 'tv' },
  'new-movies': { list: 'new-movies', mediaType: 'movie' },
  upcoming: { list: 'upcoming', mediaType: 'movie' },
  'upcoming-tv': { list: 'upcoming-tv', mediaType: 'tv' },
  'top-movies': { list: 'top-movies', mediaType: 'movie' },
  'top-tv': { list: 'top-tv', mediaType: 'tv' },
};

export type MediaType = 'movie' | 'tv';
/**
 * `requested` comes only from the household's own "Get this" records that are still active (see
 * docs/app-design.md, "Requested and households"), never from Seerr's requests or from membership.
 */
export type HouseholdState = 'unavailable' | 'in_library' | 'requested' | 'get_this';
/** The only answer to "Get this", whatever happens to the title. */
const GET_THIS_ACCEPTED = { status: 'accepted' };
const MAX_GET_THIS_BODY_BYTES = 1024;
const MAX_SEASONS_ASKED = 100;
/** The member's own hidden titles listed per page of GET /hidden. */
export const HIDDEN_PAGE_SIZE = 50;

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
  /** A hash of each Jellyfin token the request carries, so a sign-out with one of them forgets its session. */
  tokenKeys: readonly string[];
  /** The caller per Jellyfin's GET /Users/Me, or undefined if Jellyfin rejects the credentials. Throws if Jellyfin fails. */
  currentUser(): Promise<JellyfinCaller | undefined>;
  /** A Jellyfin GET with the caller's own credentials. Throws unless Jellyfin answers 2xx with JSON. */
  getAsCaller(pathname: string, query: URLSearchParams): Promise<unknown>;
}

export interface HouseholdAppHandler {
  handle(request: IncomingMessage, response: ServerResponse, context: HouseholdAppRequest): Promise<void>;
  /**
   * A sign-out with these tokens (hashes, as `tokenKeys`) is about to be sent to Jellyfin: forgets every verified
   * session, in every household, made with one of them, and keeps none verified until the returned function is called,
   * once Jellyfin's request is over whether or not its client is still there: `answered` when Jellyfin answered it,
   * false when it failed or timed out. After, its tokens are kept back for {@link APP_SIGN_OUT_GRACE_MS} too, in case
   * Jellyfin revokes them a little late. Called with the tokens a sign-out itself carries, never others, and the
   * client address and household it came through. Undefined, having forgotten the sessions all the same, when too many
   * sign-outs are at Jellyfin already (see {@link MAX_SIGN_OUTS_IN_FLIGHT_PER_CLIENT}): it must then not be sent.
   */
  signingOut(tokenKeys: readonly string[], origin: { clientId: string; householdId: string }): ((answered: boolean) => void) | undefined;
}

interface SignOutLimits {
  inFlightPerClient: number;
  inFlightPerHousehold: number;
  inFlight: number;
  perClient: number;
  perHousehold: number;
  tracked: number;
}

export interface HouseholdAppOptions {
  enabled?: (householdId: string) => boolean;
  /** Titles, from TMDB. */
  catalogue: Pick<TmdbClient, 'search' | 'discover' | 'network' | 'networkFilms' | 'studio' | 'movie' | 'tv' | 'season'>;
  /** Seerr's administrator blocklist, read with the admin key. */
  blocklist: Pick<SeerrClient, 'blocklist'>;
  /** The caller's own Seerr user, confirmed before every call (a `SeerrUserMap`). */
  members: { member(jellyfinUserId: string): Pick<SeerrMemberClient, 'ownUser' | 'quota'> | undefined };
  /** "Get this" and the household's own records. Without it, those endpoints answer `404` and nothing is `requested`. */
  requests?: Pick<HouseholdRequests, 'submit' | 'cancel' | 'activeKeys' | 'readyKeys' | 'list'>;
  /**
   * Each member's own "Not interested" titles in each household (GrantStore's hidden titles). Without it, the hidden
   * endpoints answer `404` and nothing is hidden.
   */
  hidden?: HiddenTitles;
  /** A household's name, or undefined once it no longer exists. */
  householdName: (householdId: string) => string | undefined;
  /** How many households there are. */
  householdTotal: () => number;
  /** Counts each answer by endpoint and outcome; never by title. */
  record?: (endpoint: AppEndpoint, outcome: AppOutcome) => void;
  now?: () => number;
  libraryTtlMs?: number;
  titleTtlMs?: number;
  blocklistTtlMs?: number;
  /** TMDB's share of calls (for tests; see {@link TMDB_CALLS_PER_SECOND}). */
  catalogueLimits?: Partial<{
    perSecond: number;
    burst: number;
    inFlight: number;
    queuePerHousehold: number;
    queueTimeoutMs: number;
    callTimeoutMs: number;
  }>;
  /**
   * Sign-out limits (for tests): at Jellyfin at once per client, per household and in all (see
   * {@link MAX_SIGN_OUTS_IN_FLIGHT_PER_CLIENT}), kept back after per client and per household (see
   * {@link MAX_SIGN_OUTS_PER_CLIENT}), and token hashes kept back after in all.
   */
  signOutLimits?: Partial<SignOutLimits>;
  logLevel?: string;
}

/**
 * A member's own hidden titles in a household, kept per household and member (see GrantStore.hideTitle): nothing here
 * reads or changes another member's. `hide` and `unhide` refuse (`not_member`) a caller who is not a member now.
 */
export interface HiddenTitles {
  keys(householdId: string, userId: string): ReadonlySet<string>;
  list(householdId: string, userId: string): Array<{ mediaType: MediaType; tmdbId: number; hiddenAt: string }>;
  hide(input: { householdId: string; userId: string; mediaType: MediaType; tmdbId: number; at: string }): Promise<'hidden' | 'limit' | 'not_member'>;
  unhide(input: { householdId: string; userId: string; mediaType: MediaType; tmdbId: number }): Promise<'unhidden' | 'not_member'>;
}

/** One title's household state, with the caller's own Jellyfin item only when it is `in_library`. */
interface TitleState {
  state: HouseholdState;
  itemId?: string;
}

/**
 * Everything a household state is decided from. None of it depends on another household: the titles the caller's own
 * Jellyfin view holds, Seerr's administrator blocklist (the same for every household) and the caller's own Seerr
 * request permission. No Seerr request is read: Seerr does not record which household a request was for, and the
 * households its requester belongs to now say nothing about which one it was made for (see docs/app-design.md).
 */
interface HouseholdView {
  library: ReadonlyMap<string, string>;
  blocklist: ReadonlySet<string>;
  eligible: Record<MediaType, boolean>;
  /**
   * The titles and seasons this household's own active "Get this" records name (see HouseholdRequests.activeKeys), and
   * those its records say are ready (HouseholdRequests.readyKeys): a ready title the caller's own view does not have
   * (another library, a parental limit) is still `requested` for them, never `get_this`.
   */
  requested: ReadonlySet<string>;
  /**
   * The caller's own hidden titles in this household (see HiddenTitles): left out of discovery lists, and flagged
   * `hidden` on search results and title pages. Never a household state, and never anyone else's.
   */
  hidden: ReadonlySet<string>;
}

/**
 * The single place a household state is decided, for every card and title. `in_library` (the caller's own Jellyfin
 * view has it) comes first: playing their own item needs no request permission. Then `unavailable` (blocklisted, or
 * the caller may not request this media type, which includes a caller Seerr has no user for and a caller with a Seerr
 * quota: see getThisEligibility), then `requested` (this
 * household's own active "Get this" record names the title, or one of a series' seasons), and otherwise `get_this`.
 */
export function titleState(view: HouseholdView, mediaType: MediaType, tmdbId: number): TitleState {
  const itemId = view.library.get(titleKey(mediaType, tmdbId));
  if (itemId) return { state: 'in_library', itemId };
  if (!requestable(view, mediaType, tmdbId)) return { state: 'unavailable' };
  if (view.requested.has(titleKey(mediaType, tmdbId))) return { state: 'requested' };
  return { state: 'get_this' };
}

/** Whether the caller could ask for a title: it is not blocklisted and they may request its media type. */
function requestable(view: HouseholdView, mediaType: MediaType, tmdbId: number): boolean {
  return view.eligible[mediaType] && !view.blocklist.has(titleKey(mediaType, tmdbId));
}

/**
 * A season's state: `in_library` when the caller's view has its episodes, otherwise `unavailable` when the series
 * cannot be requested, otherwise `requested` when this household's own active record names the season, otherwise
 * `get_this`.
 */
function seasonState(view: HouseholdView, tmdbId: number, seasonsInLibrary: ReadonlySet<number>, seasonNumber: number): HouseholdState {
  if (seasonsInLibrary.has(seasonNumber)) return 'in_library';
  if (!requestable(view, 'tv', tmdbId)) return 'unavailable';
  return view.requested.has(`${titleKey('tv', tmdbId)}:${seasonNumber}`) ? 'requested' : 'get_this';
}

/**
 * Whether a Seerr user may request each media type in HD (Seerr 3.5.1 `MediaRequest.request`): movies with `ADMIN`,
 * `REQUEST` or `REQUEST_MOVIE`, series with `ADMIN`, `REQUEST` or `REQUEST_TV`. Anything else may request nothing.
 */
export function seerrPermissions(user: unknown): Record<MediaType, boolean> {
  const permissions = field(user, 'permissions');
  if (typeof permissions !== 'number' || !Number.isSafeInteger(permissions) || permissions < 0) return { movie: false, tv: false };
  const has = (bit: number) => (permissions & bit) !== 0;
  const any = has(SEERR_ADMIN) || has(SEERR_REQUEST);
  return { movie: any || has(SEERR_REQUEST_MOVIE), tv: any || has(SEERR_REQUEST_TV) };
}

/**
 * Whether a Seerr user (GET /api/v1/auth/me, read as them) may manage every request (`ADMIN` or `MANAGE_REQUESTS`):
 * Seerr then lets them delete any request, so a cancel never deletes one as them (see HouseholdRequests.cancel). An
 * answer without readable permissions counts as managing.
 */
export function managesSeerrRequests(user: unknown): boolean {
  const permissions = field(user, 'permissions');
  if (typeof permissions !== 'number' || !Number.isSafeInteger(permissions) || permissions < 0) return true;
  return (permissions & (SEERR_ADMIN | SEERR_MANAGE_REQUESTS)) !== 0;
}

/**
 * Whether Seerr gives the caller a request quota (GET /api/v1/user/:id/quota, read as them): a movie or series `limit`
 * above 0, their own or Seerr's default (Seerr reports 0 for a caller who bypasses quotas). "Get this" is not offered to
 * such callers (docs/app-design.md, "Quotas"). Throws on an answer that is not Seerr's quota object.
 */
export function hasSeerrQuota(quota: unknown): boolean {
  const movie = field(quota, 'movie');
  const tv = field(quota, 'tv');
  if (!movie || typeof movie !== 'object' || !tv || typeof tv !== 'object') {
    throw new SeerrError('Seerr GET /api/v1/user/:self/quota returned an unexpected answer', 502);
  }
  return [movie, tv].some((limits) => {
    const limit = field(limits, 'limit');
    return typeof limit === 'number' && limit > 0;
  });
}

/**
 * What a caller may ask "Get this" for, by media type, from their own Seerr user and quota only, never a title: their
 * request permission (see seerrPermissions), and nothing at all when they have a quota (see hasSeerrQuota).
 */
export function getThisEligibility(user: unknown, quota: unknown): Record<MediaType, boolean> {
  if (hasSeerrQuota(quota)) return { movie: false, tv: false };
  return seerrPermissions(user);
}

/**
 * Answers kept for a while, at most `maxEntries` (least recently used forgotten first). Concurrent calls for the same
 * key share one upstream call; a failed call is not kept.
 */
class TtlCache<T> {
  readonly #entries = new Map<string, { expiresAt: number; value: Promise<T> }>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  public constructor(ttlMs: number, maxEntries: number, now: () => number) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
    this.#now = now;
  }

  public get(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.#now();
    const cached = this.#entries.get(key);
    this.#entries.delete(key);
    if (cached && cached.expiresAt > now) {
      this.#entries.set(key, cached);
      return cached.value;
    }
    const value = load();
    const entry = { expiresAt: now + this.#ttlMs, value };
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value as string);
    // A failed read is not kept.
    value.catch(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    });
    return value;
  }
}

/**
 * One household's caches. Each household that exists has its own (see {@link HouseholdApp}'s `#caches`), so one
 * household's calls never decide whether another's are answered from a cache, and so never change how long they take.
 */
interface HouseholdCaches {
  /** Verified tokens of this household's members, by credential hash, with the hashes of the tokens they hold. */
  sessions: Map<string, { expiresAt: number; caller: JellyfinCaller; tokenKeys: readonly string[] }>;
  libraries: TtlCache<Map<string, string>>;
  titles: TtlCache<unknown>;
  blocklist: TtlCache<Set<string>>;
}

class AppAnswer extends Error {
  public constructor(public readonly outcome: Exclude<AppOutcome, 'ok'>) {
    super(outcome);
  }
}

interface Route {
  endpoint: AppEndpoint;
  run: (caller: JellyfinCaller, context: HouseholdAppRequest, url: URL, request: IncomingMessage) => Promise<unknown>;
  /** The status of a successful answer; 200 unless set. */
  status?: number;
}

export class HouseholdApp implements HouseholdAppHandler {
  readonly #catalogue: HouseholdAppOptions['catalogue'];
  readonly #blocklistSource: HouseholdAppOptions['blocklist'];
  readonly #enabled: NonNullable<HouseholdAppOptions['enabled']>;
  readonly #members: HouseholdAppOptions['members'];
  readonly #requests: HouseholdAppOptions['requests'];
  readonly #hidden: HouseholdAppOptions['hidden'];
  readonly #householdName: HouseholdAppOptions['householdName'];
  readonly #householdTotal: HouseholdAppOptions['householdTotal'];
  readonly #record: NonNullable<HouseholdAppOptions['record']>;
  readonly #now: () => number;
  readonly #libraryTtlMs: number;
  readonly #titleTtlMs: number;
  readonly #blocklistTtlMs: number;
  readonly #debug: boolean;
  readonly #byClient: AttemptCounter;
  readonly #byUser: AttemptCounter;
  readonly #byHousehold: AttemptCounter;
  readonly #getThisByUser: AttemptCounter;
  readonly #getThisByClient: AttemptCounter;
  readonly #getThisByHousehold: AttemptCounter;
  readonly #partitions = new Map<string, HouseholdCaches>();
  /** Verifications at Jellyfin now, with the tokens (hashes) each holds: a sign-out with one of them spoils it, so it is not kept. */
  readonly #verifying = new Set<{ tokenKeys: readonly string[]; spoiled: boolean }>();
  /** Sign-outs at Jellyfin, by token hash, with how many carry it: those tokens are never kept as verified meanwhile. */
  readonly #signingOut = new Map<string, number>();
  /** Sign-outs at Jellyfin, by client address and by household, and how many in all. */
  readonly #signOutsInFlightByClient = new Map<string, number>();
  readonly #signOutsInFlightByHousehold = new Map<string, number>();
  #signOutsInFlight = 0;
  /** Tokens signed out lately, by hash, with when they may be kept as verified again (see APP_SIGN_OUT_GRACE_MS). */
  readonly #signedOut = new Map<string, number>();
  readonly #signOutsByClient: AttemptCounter;
  readonly #signOutsByHousehold: AttemptCounter;
  readonly #signOutLimits: SignOutLimits;
  readonly #tmdb: FairDispatcher;

  public constructor(options: HouseholdAppOptions) {
    this.#catalogue = options.catalogue;
    this.#blocklistSource = options.blocklist;
    this.#members = options.members;
    this.#enabled = options.enabled ?? (() => false);
    this.#requests = options.requests;
    this.#hidden = options.hidden;
    this.#householdName = options.householdName;
    this.#householdTotal = options.householdTotal;
    this.#record = options.record ?? (() => undefined);
    this.#now = options.now ?? Date.now;
    this.#libraryTtlMs = options.libraryTtlMs ?? APP_LIBRARY_TTL_MS;
    this.#titleTtlMs = options.titleTtlMs ?? APP_TITLE_TTL_MS;
    this.#blocklistTtlMs = options.blocklistTtlMs ?? APP_BLOCKLIST_TTL_MS;
    this.#debug = options.logLevel === 'debug';
    this.#byClient = new AttemptCounter({ windowMs: APP_BUDGET_WINDOW_MS, maxKeys: MAX_TRACKED, now: this.#now });
    this.#byUser = new AttemptCounter({ windowMs: APP_BUDGET_WINDOW_MS, maxKeys: MAX_TRACKED, now: this.#now });
    this.#byHousehold = new AttemptCounter({ windowMs: APP_BURST_WINDOW_MS, maxKeys: MAX_TRACKED, now: this.#now });
    this.#getThisByUser = new AttemptCounter({ windowMs: GET_THIS_WINDOW_MS, maxKeys: MAX_TRACKED, now: this.#now });
    this.#getThisByClient = new AttemptCounter({ windowMs: GET_THIS_WINDOW_MS, maxKeys: MAX_TRACKED, now: this.#now });
    this.#getThisByHousehold = new AttemptCounter({ windowMs: GET_THIS_WINDOW_MS, maxKeys: MAX_TRACKED, now: this.#now });
    this.#signOutsByClient = new AttemptCounter({ windowMs: APP_SIGN_OUT_WINDOW_MS, maxKeys: MAX_TRACKED, now: this.#now });
    this.#signOutsByHousehold = new AttemptCounter({ windowMs: APP_SIGN_OUT_WINDOW_MS, maxKeys: MAX_TRACKED, now: this.#now });
    this.#signOutLimits = {
      inFlightPerClient: options.signOutLimits?.inFlightPerClient ?? MAX_SIGN_OUTS_IN_FLIGHT_PER_CLIENT,
      inFlightPerHousehold: options.signOutLimits?.inFlightPerHousehold ?? MAX_SIGN_OUTS_IN_FLIGHT_PER_HOUSEHOLD,
      inFlight: options.signOutLimits?.inFlight ?? MAX_SIGN_OUTS_IN_FLIGHT,
      perClient: options.signOutLimits?.perClient ?? MAX_SIGN_OUTS_PER_CLIENT,
      perHousehold: options.signOutLimits?.perHousehold ?? MAX_SIGN_OUTS_PER_HOUSEHOLD,
      tracked: options.signOutLimits?.tracked ?? MAX_SIGN_OUT_TRACKED,
    };
    const limits = options.catalogueLimits ?? {};
    const queuePerHousehold = limits.queuePerHousehold ?? TMDB_QUEUE_PER_HOUSEHOLD;
    this.#tmdb = new FairDispatcher({
      ratePerSecond: limits.perSecond ?? TMDB_CALLS_PER_SECOND,
      burst: limits.burst ?? TMDB_BURST,
      maxInFlight: limits.inFlight ?? TMDB_IN_FLIGHT,
      maxQueuedPerLane: queuePerHousehold,
      maxQueued: queuePerHousehold * MAX_HOUSEHOLDS,
      queueTimeoutMs: limits.queueTimeoutMs ?? TMDB_QUEUE_TIMEOUT_MS,
      callTimeoutMs: limits.callTimeoutMs ?? TMDB_TIMEOUT_MS,
      retryAfter: (error) => error instanceof TmdbError && error.status === 429
        ? error.retryAfterMs ?? TMDB_DEFAULT_RETRY_AFTER_MS
        : undefined,
    });
  }

  /**
   * The household's caches, created the first time a household that exists is served. A household's caches are never
   * dropped for another's: they go only once the household is deleted (when the next household's are created). The
   * store refuses more than {@link MAX_HOUSEHOLDS} households while the app is enabled, so there is room for every one;
   * should a state file hold more, nothing is cached for any household (the same for all, whoever was served first).
   */
  #caches(householdId: string): HouseholdCaches | undefined {
    if (this.#householdTotal() > MAX_HOUSEHOLDS) {
      this.#partitions.clear();
      return undefined;
    }
    const existing = this.#partitions.get(householdId);
    if (existing) return existing;
    if (this.#householdName(householdId) === undefined) return undefined;
    for (const id of this.#partitions.keys()) {
      if (this.#householdName(id) === undefined) this.#partitions.delete(id);
    }
    const caches: HouseholdCaches = {
      sessions: new Map(),
      libraries: new TtlCache(this.#libraryTtlMs, MAX_LIBRARIES_PER_HOUSEHOLD, this.#now),
      titles: new TtlCache(this.#titleTtlMs, MAX_TITLES_PER_HOUSEHOLD, this.#now),
      blocklist: new TtlCache(this.#blocklistTtlMs, 1, this.#now),
    };
    this.#partitions.set(householdId, caches);
    return caches;
  }

  /**
   * At most {@link APP_SIGN_OUT_MAX_TOKENS} tokens are taken from `tokenKeys`. Every sign-out at Jellyfin keeps all of
   * its tokens back until it is over; there are only so many at once, as each holds a request to Jellyfin, and past the
   * limits on those one is refused rather than sent on untracked. After, a sign-out Jellyfin did not answer keeps all of
   * its tokens back for the grace; one it answered keeps back those JellyPass had verified or was verifying, and the
   * rest too only within the client's and the household's limits. Nothing here ever keeps back a token the sign-out
   * does not carry.
   */
  public signingOut(tokenKeys: readonly string[], origin: { clientId: string; householdId: string }): ((answered: boolean) => void) | undefined {
    const keys = [...new Set(tokenKeys)].slice(0, APP_SIGN_OUT_MAX_TOKENS);
    if (!keys.length) return () => {};
    const verified = this.#forget(keys);
    const limits = this.#signOutLimits;
    const byClient = this.#signOutsInFlightByClient;
    const byHousehold = this.#signOutsInFlightByHousehold;
    if ((byClient.get(origin.clientId) ?? 0) >= limits.inFlightPerClient
      || (byHousehold.get(origin.householdId) ?? 0) >= limits.inFlightPerHousehold
      || this.#signOutsInFlight >= limits.inFlight) return undefined;
    adjust(byClient, origin.clientId, 1);
    adjust(byHousehold, origin.householdId, 1);
    this.#signOutsInFlight += 1;
    for (const key of keys) adjust(this.#signingOut, key, 1);
    const withinLimits = this.#signOutsByClient.increment(origin.clientId) <= limits.perClient
      && this.#signOutsByHousehold.increment(origin.householdId) <= limits.perHousehold;
    let done = false;
    return (answered) => {
      if (done) return;
      done = true;
      for (const key of this.#forget(keys)) verified.add(key);
      adjust(byClient, origin.clientId, -1);
      adjust(byHousehold, origin.householdId, -1);
      this.#signOutsInFlight -= 1;
      for (const key of keys) adjust(this.#signingOut, key, -1);
      this.#keepBack(!answered || withinLimits ? keys : keys.filter((key) => verified.has(key)));
    };
  }

  /**
   * Keeps these tokens (hashes) back for {@link APP_SIGN_OUT_GRACE_MS}, dropping signed-out tokens to make room, those
   * whose grace is over first and then the oldest: a dropped token may be kept as verified again a little early, should
   * Jellyfin revoke it late.
   */
  #keepBack(tokenKeys: readonly string[]): void {
    const now = this.#now();
    const until = now + APP_SIGN_OUT_GRACE_MS;
    for (const key of tokenKeys) {
      this.#signedOut.delete(key);
      this.#signedOut.set(key, until);
    }
    for (const [key, keptUntil] of this.#signedOut) {
      if (keptUntil > now && this.#signedOut.size <= this.#signOutLimits.tracked) break;
      this.#signedOut.delete(key);
    }
  }

  /**
   * Forgets every verified session, in every household, made with one of these tokens (hashes), and spoils any
   * verification of one. Returns those of them that were verified or being verified.
   */
  #forget(tokenKeys: readonly string[]): Set<string> {
    const forgotten = new Set(tokenKeys);
    const found = new Set<string>();
    const holds = (held: readonly string[]) => {
      let holding = false;
      for (const tokenKey of held) {
        if (!forgotten.has(tokenKey)) continue;
        found.add(tokenKey);
        holding = true;
      }
      return holding;
    };
    for (const { sessions } of this.#partitions.values()) {
      for (const [key, session] of sessions) {
        if (holds(session.tokenKeys)) sessions.delete(key);
      }
    }
    for (const verification of this.#verifying) {
      if (holds(verification.tokenKeys)) verification.spoiled = true;
    }
    return found;
  }

  /** Whether a token just verified with these hashes may be kept: not while, or just after, it is signed out. */
  #mayKeep(tokenKeys: readonly string[]): boolean {
    const now = this.#now();
    return tokenKeys.every((key) => {
      if (this.#signingOut.has(key)) return false;
      const until = this.#signedOut.get(key);
      if (until === undefined) return true;
      if (now < until) return false;
      this.#signedOut.delete(key);
      return true;
    });
  }

  public async handle(request: IncomingMessage, response: ServerResponse, context: HouseholdAppRequest): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = this.#route(request.method, url.pathname);
    const endpoint = route?.endpoint ?? 'unknown';
    const answer = (outcome: AppOutcome, body?: unknown) => {
      this.#record(endpoint, outcome);
      if (outcome === 'ok') writeAppJson(response, route?.status ?? 200, body);
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
    if (!this.#enabled(context.householdId)) return answer('app_disabled');
    if (this.#byUser.increment(normalizedUserId(caller.id)) > MAX_APP_REQUESTS_PER_USER) return answer('rate_limited');
    // Counted only for the household's own members, so no one else can use up its burst.
    if (this.#byHousehold.increment(context.householdId) > MAX_APP_REQUESTS_PER_HOUSEHOLD_BURST) return answer('rate_limited');
    if (!route) return answer('not_found');
    let body: unknown;
    try {
      body = await route.run(caller, context, url, request);
    } catch (error) {
      if (error instanceof AppAnswer) return answer(error.outcome);
      this.#logFailure(endpoint, error);
      return answer('unavailable');
    }
    return answer('ok', body);
  }

  #route(method: string | undefined, pathname: string): Route | undefined {
    if (!pathname.startsWith(`${APP_API_PREFIX}/`)) return undefined;
    const path = pathname.slice(APP_API_PREFIX.length);
    const hidden = /^\/hidden\/(movie|tv)\/([^/]+)$/.exec(path);
    if (hidden && this.#hidden && (method === 'POST' || method === 'DELETE')) {
      const mediaType = hidden[1] as MediaType;
      const input = hidden[2] as string;
      return method === 'POST'
        ? { endpoint: 'hide', run: (caller, context, _url, request) => this.#hide(caller, context, request, mediaType, input) }
        : { endpoint: 'unhide', run: (caller, context, _url, request) => this.#unhide(caller, context, request, mediaType, input) };
    }
    if (method === 'POST') {
      const cancel = /^\/requests\/([^/]+)\/cancel$/.exec(path);
      if (cancel && this.#requests) {
        return { endpoint: 'cancel', status: 202, run: (caller, context, _url, request) => this.#cancel(caller, context, request, cancel[1] as string) };
      }
      const get = /^\/(movie|tv)\/([^/]+)\/get$/.exec(path);
      if (!get || !this.#requests) return undefined;
      const mediaType = get[1] as MediaType;
      return {
        endpoint: 'get',
        status: 202,
        run: (caller, context, _url, request) => this.#getThis(caller, context, request, mediaType, get[2] as string),
      };
    }
    if (method !== 'GET') return undefined;
    if (path === '/hidden') return this.#hidden ? { endpoint: 'hidden', run: (caller, context, url) => this.#hiddenList(caller, context, url) } : undefined;
    if (path === '/requests') return this.#requests ? { endpoint: 'requests', run: (caller, context) => this.#list(caller, context) } : undefined;
    if (path === '/me') return { endpoint: 'me', run: (caller, context) => this.#me(caller, context) };
    if (path === '/search') return { endpoint: 'search', run: (caller, context, url) => this.#search(caller, context, url) };
    if (path === '/discover/sources') return { endpoint: 'discover', run: async () => sourcesDto() };
    const source = /^\/discover\/(network|studio)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (source) {
      const kind = source[1] as 'network' | 'studio';
      // Only a listed network's own lists follow an ID; any other second segment is an unknown path, as before 2.7.0.
      if (source[3] !== undefined && (kind !== 'network' || !networkHasList(source[2] as string, source[3]))) return undefined;
      return {
        endpoint: 'discover',
        run: (caller, context, url) => this.#source(caller, context, url, kind, source[2] as string, source[3]),
      };
    }
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
   * undefined, whichever of these failed. A member's verified token is trusted for {@link APP_SESSION_TTL_MS}, in the
   * household's own cache (anyone else's is checked with Jellyfin on every call, so it can never crowd a member's out);
   * membership is checked against the store on every call. A sign-out through the household host forgets it at once,
   * and it is not kept again until a while after that sign-out is over (see {@link signingOut}), though each call is
   * still answered as Jellyfin answers it; a token Jellyfin refuses is never kept.
   */
  async #caller(context: HouseholdAppRequest): Promise<JellyfinCaller | undefined> {
    const key = context.credentialKey;
    if (!key) return undefined;
    const now = this.#now();
    const sessions = this.#caches(context.householdId)?.sessions;
    let caller = sessions?.get(key);
    if (caller && caller.expiresAt <= now) {
      sessions?.delete(key);
      caller = undefined;
    }
    if (!caller) {
      const verification = { tokenKeys: context.tokenKeys, spoiled: false };
      this.#verifying.add(verification);
      let verified: JellyfinCaller | undefined;
      try {
        verified = await context.currentUser();
      } finally {
        this.#verifying.delete(verification);
      }
      if (!verified) return undefined;
      caller = { expiresAt: now + APP_SESSION_TTL_MS, caller: verified, tokenKeys: context.tokenKeys };
      if (sessions && !verification.spoiled && this.#mayKeep(context.tokenKeys) && !verified.disabled && isMember(context, verified)) {
        sessions.set(key, caller);
        while (sessions.size > MAX_SESSIONS_PER_HOUSEHOLD) sessions.delete(sessions.keys().next().value as string);
      }
    }
    if (caller.caller.disabled || !isMember(context, caller.caller)) return undefined;
    return caller.caller;
  }

  async #me(caller: JellyfinCaller, context: HouseholdAppRequest): Promise<MeDto> {
    return { name: caller.name, household: this.#householdName(context.householdId) ?? '', apiVersion: APP_API_VERSION };
  }

  async #search(caller: JellyfinCaller, context: HouseholdAppRequest, url: URL): Promise<PageDto> {
    const query = url.searchParams.get('q')?.trim() ?? '';
    if (!query || query.length > MAX_QUERY_LENGTH) throw new AppAnswer('invalid');
    const page = pageParameter(url);
    const [answer, view] = await Promise.all([
      this.#title(context, `search\n${query}\n${page}`, (signal) => this.#catalogue.search(query, page, { signal })),
      this.#view(caller, context),
    ]);
    // Search finds hidden titles too, flagged, so the member can unhide them.
    return pageOf(answer, page, undefined, view, context.origin, false);
  }

  async #discover(
    caller: JellyfinCaller,
    context: HouseholdAppRequest,
    url: URL,
    list: { list: TmdbDiscoverList; mediaType?: MediaType },
  ): Promise<PageDto> {
    const page = pageParameter(url);
    const [answer, view] = await Promise.all([
      this.#title(context, `discover\n${list.list}\n${page}`, (signal) => this.#catalogue.discover(list.list, page, { signal })),
      this.#view(caller, context),
    ]);
    return pageOf(answer, page, list.mediaType, view, context.origin, true);
  }

  /**
   * A network's popular series, its films (`/films`: the movies its service streams in {@link TMDB_WATCH_REGION}), both
   * mixed (`/all`, see {@link mixedPage}) or a studio's popular movies, only for an allowlisted ID ({@link TMDB_NETWORKS},
   * {@link TMDB_STUDIOS}). Any other ID is `invalid` before TMDB, the cache or the caller's view is asked anything; a
   * list is only routed here after a listed network's ID that has it (see {@link networkHasList}).
   */
  async #source(
    caller: JellyfinCaller,
    context: HouseholdAppRequest,
    url: URL,
    kind: 'network' | 'studio',
    input: string,
    list: string | undefined,
  ): Promise<PageDto> {
    const id = sourceParameter(kind, input);
    const page = pageParameter(url);
    const series = () => this.#title(context, `network\n${id}\n${page}`, (signal) => this.#catalogue.network(id, page, { signal }));
    // A network's films are cached under keys of their own, never its series'.
    const films = () => this.#title(context, `network-films\n${id}\n${page}`, (signal) => this.#catalogue.networkFilms(id, page, { signal }));
    if (kind === 'studio') {
      const [answer, view] = await Promise.all([
        this.#title(context, `studio\n${id}\n${page}`, (signal) => this.#catalogue.studio(id, page, { signal })),
        this.#view(caller, context),
      ]);
      return pageOf(answer, page, 'movie', view, context.origin, true);
    }
    if (list === 'all') {
      const [seriesAnswer, filmsAnswer, view] = await Promise.all([series(), films(), this.#view(caller, context)]);
      return mixedPage(pageOf(filmsAnswer, page, 'movie', view, context.origin, true), pageOf(seriesAnswer, page, 'tv', view, context.origin, true));
    }
    const [answer, view] = await Promise.all([list === 'films' ? films() : series(), this.#view(caller, context)]);
    return pageOf(answer, page, list === 'films' ? 'movie' : 'tv', view, context.origin, true);
  }

  async #movie(caller: JellyfinCaller, context: HouseholdAppRequest, input: string): Promise<MovieDto> {
    const tmdbId = tmdbParameter(input);
    const [answer, view] = await Promise.all([
      this.#title(context, `movie\n${tmdbId}`, (signal) => this.#catalogue.movie(tmdbId, { signal })),
      this.#view(caller, context),
    ]);
    const state = titleState(view, 'movie', tmdbId);
    return {
      mediaType: 'movie',
      tmdbId,
      ...titleFields(answer, 'movie'),
      genres: genreNames(field(answer, 'genres')),
      runtime: positiveInteger(field(answer, 'runtime')),
      ...stateFields(state, context.origin),
      hidden: view.hidden.has(titleKey('movie', tmdbId)),
    };
  }

  async #tv(caller: JellyfinCaller, context: HouseholdAppRequest, input: string): Promise<TvDto> {
    const tmdbId = tmdbParameter(input);
    const [answer, view] = await Promise.all([
      this.#title(context, `tv\n${tmdbId}`, (signal) => this.#catalogue.tv(tmdbId, { signal })),
      this.#view(caller, context),
    ]);
    const state = titleState(view, 'tv', tmdbId);
    const inLibrary = await this.#seasonsInLibrary(caller, context, state);
    const runTimes = field(answer, 'episode_run_time');
    return {
      mediaType: 'tv',
      tmdbId,
      ...titleFields(answer, 'tv'),
      genres: genreNames(field(answer, 'genres')),
      runtime: Array.isArray(runTimes) ? positiveInteger(runTimes[0]) : null,
      seasons: seasonList(field(answer, 'seasons')).map((season) => ({
        ...season,
        state: seasonState(view, tmdbId, inLibrary, season.seasonNumber),
      })),
      ...stateFields(state, context.origin),
      hidden: view.hidden.has(titleKey('tv', tmdbId)),
    };
  }

  async #season(caller: JellyfinCaller, context: HouseholdAppRequest, input: string, seasonInput: string): Promise<SeasonDto> {
    const tmdbId = tmdbParameter(input);
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(seasonInput)) throw new AppAnswer('invalid');
    const seasonNumber = Number(seasonInput);
    const [answer, view] = await Promise.all([
      this.#title(context, `season\n${tmdbId}\n${seasonNumber}`, (signal) => this.#catalogue.season(tmdbId, seasonNumber, { signal })),
      this.#view(caller, context),
    ]);
    const state = titleState(view, 'tv', tmdbId);
    const inLibrary = await this.#seasonsInLibrary(caller, context, state);
    const episodes = field(answer, 'episodes');
    return {
      tmdbId,
      seasonNumber,
      name: text(field(answer, 'name'), 200),
      overview: text(field(answer, 'overview'), 4000),
      episodes: (Array.isArray(episodes) ? episodes : []).flatMap((episode) => {
        const episodeNumber = nonNegativeInteger(field(episode, 'episode_number'));
        return episodeNumber === null ? [] : [{
          episodeNumber,
          name: text(field(episode, 'name'), 200),
          overview: text(field(episode, 'overview'), 4000),
        }];
      }).slice(0, 500),
      state: seasonState(view, tmdbId, inLibrary, seasonNumber),
    };
  }

  /**
   * "Get this" (see {@link HouseholdRequests}). Only the call decides what happens before the answer: its input and the
   * caller's own submission budgets (per user, per client address and per household, counted for every valid call and
   * never given back). Then the same `202` always follows, before anything is read about the caller's eligibility or
   * the title: both are decided in the background, and nothing the caller can call waits on them.
   */
  async #getThis(caller: JellyfinCaller, context: HouseholdAppRequest, request: IncomingMessage, mediaType: MediaType, input: string): Promise<unknown> {
    const requests = this.#requests as NonNullable<HouseholdAppOptions['requests']>;
    const tmdbId = tmdbParameter(input);
    const seasons = getThisSeasons(mediaType, await readBody(request));
    const callerId = normalizedUserId(caller.id);
    // Each counted only if the previous one admitted the call, so a call refused for the caller's own volume is never
    // counted against the household's or the address's.
    if (this.#getThisByUser.increment(callerId) > MAX_GET_THIS_PER_USER
      || this.#getThisByClient.increment(context.clientId) > MAX_GET_THIS_PER_CLIENT
      || this.#getThisByHousehold.increment(context.householdId) > MAX_GET_THIS_PER_HOUSEHOLD) {
      throw new AppAnswer('rate_limited');
    }
    await requests.submit({
      householdId: context.householdId,
      callerId,
      mediaType,
      tmdbId,
      seasons,
      ownView: () => this.#ownView(caller, context, mediaType, tmdbId),
    });
    return GET_THIS_ACCEPTED;
  }

  /**
   * Cancelling one of the caller's requests (see HouseholdRequests.cancel). As for "Get this", only the call decides
   * what happens before the answer: the entry ID's form (22 base64url characters, never looked up), an empty body (or
   * `{}`) and the caller's submission budgets, which cancels share with "Get this". Then the same `202` always follows,
   * before anything about the entry is read: whether the household lists it, whether it can still be cancelled and what
   * becomes of its Seerr request are decided in the background.
   */
  async #cancel(caller: JellyfinCaller, context: HouseholdAppRequest, request: IncomingMessage, id: string): Promise<unknown> {
    const requests = this.#requests as NonNullable<HouseholdAppOptions['requests']>;
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) throw new AppAnswer('invalid');
    getThisSeasons('movie', await readBody(request));
    const callerId = normalizedUserId(caller.id);
    if (this.#getThisByUser.increment(callerId) > MAX_GET_THIS_PER_USER
      || this.#getThisByClient.increment(context.clientId) > MAX_GET_THIS_PER_CLIENT
      || this.#getThisByHousehold.increment(context.householdId) > MAX_GET_THIS_PER_HOUSEHOLD) {
      throw new AppAnswer('rate_limited');
    }
    await requests.cancel({
      householdId: context.householdId,
      callerId,
      id,
      ownView: (mediaType, tmdbId) => this.#ownView(caller, context, mediaType, tmdbId),
    });
    return GET_THIS_ACCEPTED;
  }

  /**
   * Hides a title for the caller in this household ("Not interested"): it leaves their discovery lists, and only theirs
   * (see HiddenTitles). Only the call decides the answer: its form (a media type and a TMDB ID, an empty body or `{}`),
   * the caller's membership now, and, for a title they have not hidden yet, their own count against
   * MAX_HIDDEN_TITLES_PER_MEMBER (`409 hidden_limit_reached`). TMDB is never asked: a well-formed ID is hidden whether or
   * not TMDB knows it. The same answer whether or not it was hidden already, once it is written.
   */
  async #hide(caller: JellyfinCaller, context: HouseholdAppRequest, request: IncomingMessage, mediaType: MediaType, input: string): Promise<HiddenDto> {
    const hidden = this.#hidden as HiddenTitles;
    const tmdbId = tmdbParameter(input);
    getThisSeasons('movie', await readBody(request));
    const result = await hidden.hide({
      householdId: context.householdId,
      userId: normalizedUserId(caller.id),
      mediaType,
      tmdbId,
      at: new Date(this.#now()).toISOString(),
    });
    if (result === 'not_member') throw new AppAnswer('unauthorized');
    if (result === 'limit') throw new AppAnswer('hidden_limit');
    return { hidden: true };
  }

  /** Unhides a title for the caller in this household: the same answer whether or not it was hidden, once it is written. */
  async #unhide(caller: JellyfinCaller, context: HouseholdAppRequest, request: IncomingMessage, mediaType: MediaType, input: string): Promise<HiddenDto> {
    const hidden = this.#hidden as HiddenTitles;
    const tmdbId = tmdbParameter(input);
    getThisSeasons('movie', await readBody(request));
    const result = await hidden.unhide({ householdId: context.householdId, userId: normalizedUserId(caller.id), mediaType, tmdbId });
    if (result === 'not_member') throw new AppAnswer('unauthorized');
    return { hidden: false };
  }

  /**
   * The caller's own hidden titles in this household, newest first, {@link HIDDEN_PAGE_SIZE} a page: IDs, media types and
   * when each was hidden, nothing else (a client names them as it names My requests' titles). Neither TMDB nor Jellyfin
   * is asked anything. A page past the last is empty.
   */
  async #hiddenList(caller: JellyfinCaller, context: HouseholdAppRequest, url: URL): Promise<HiddenPageDto> {
    const page = pageParameter(url);
    const all = (this.#hidden as HiddenTitles).list(context.householdId, normalizedUserId(caller.id));
    const start = (page - 1) * HIDDEN_PAGE_SIZE;
    return {
      page,
      nextPage: all.length > start + HIDDEN_PAGE_SIZE && page < MAX_PAGE ? page + 1 : null,
      results: all.slice(start, start + HIDDEN_PAGE_SIZE).map((entry) => ({ mediaType: entry.mediaType, tmdbId: entry.tmdbId, hiddenAt: entry.hiddenAt })),
    };
  }

  /**
   * The household's own titles with their coarse status (see HouseholdRequests.list), `ready` only for what the
   * caller's own Jellyfin view has: the same view the title pages decide `in_library` from (the caller's library,
   * reused as for them, and a series' seasons with episodes).
   */
  async #list(caller: JellyfinCaller, context: HouseholdAppRequest): Promise<RequestsDto> {
    const library = await this.#library(caller, context);
    return (this.#requests as NonNullable<HouseholdAppOptions['requests']>).list(context.householdId, normalizedUserId(caller.id), async (mediaType, tmdbId) => {
      const itemId = library.get(titleKey(mediaType, tmdbId));
      if (!itemId) return { visible: false, seasons: new Set() };
      return { visible: true, seasons: mediaType === 'tv' ? await this.#seasonsInLibrary(caller, context, { state: 'in_library', itemId }) : new Set() };
    });
  }

  /** What the caller's own Jellyfin view holds of a title, read now with their own credentials (never from a cache). */
  async #ownView(caller: JellyfinCaller, context: HouseholdAppRequest, mediaType: MediaType, tmdbId: number): Promise<OwnView> {
    const itemId = (await readLibrary(caller, context)).get(titleKey(mediaType, tmdbId));
    if (!itemId) return { visible: false, seasons: new Set() };
    return { visible: true, seasons: mediaType === 'tv' ? await this.#seasonsInLibrary(caller, context, { state: 'in_library', itemId }) : new Set() };
  }

  /**
   * A TMDB answer, reused by this household for {@link APP_TITLE_TTL_MS}. The key is the request's own parameters; the
   * household only picks the cache. The call waits for the household's turn (see {@link FairDispatcher}). A title TMDB
   * does not know is `not_found`; a household with too many calls already waiting for TMDB is `rate_limited`.
   */
  async #title(context: HouseholdAppRequest, key: string, load: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    const call = () => this.#tmdb.run(context.householdId, load);
    try {
      const titles = this.#caches(context.householdId)?.titles;
      return await (titles ? titles.get(key, call) : call());
    } catch (error) {
      if (error instanceof TmdbError && error.status === 404) throw new AppAnswer('not_found');
      if (error instanceof DispatchQueueFullError) throw new AppAnswer('rate_limited');
      throw error;
    }
  }

  /** Everything the household states of this answer are decided from (see {@link HouseholdView}), read in parallel. */
  async #view(caller: JellyfinCaller, context: HouseholdAppRequest): Promise<HouseholdView> {
    const blocklist = () => readBlocklist(this.#blocklistSource);
    const cached = this.#caches(context.householdId)?.blocklist;
    const [library, blocked, eligible] = await Promise.all([
      this.#library(caller, context),
      cached ? cached.get('blocklist', blocklist) : blocklist(),
      this.#eligibility(caller),
    ]);
    const requested = this.#requests
      ? new Set([...this.#requests.activeKeys(context.householdId), ...this.#requests.readyKeys(context.householdId)])
      : new Set<string>();
    const hidden = this.#hidden ? this.#hidden.keys(context.householdId, normalizedUserId(caller.id)) : new Set<string>();
    return { library, blocklist: blocked, eligible, requested, hidden };
  }

  /**
   * Whether the caller may ask "Get this" for each media type, from their own Seerr user and quota read as them (see
   * getThisEligibility). A caller Seerr has no confirmed user for may ask for nothing.
   */
  async #eligibility(caller: JellyfinCaller): Promise<Record<MediaType, boolean>> {
    const none = { movie: false, tv: false };
    const member = this.#members.member(caller.id);
    if (!member) return none;
    let user: unknown;
    let quota: unknown;
    try {
      [user, quota] = await Promise.all([member.ownUser(), member.quota()]);
    } catch (error) {
      if (error instanceof SeerrUnmappedUserError) return none;
      throw error;
    }
    return getThisEligibility(user, quota);
  }

  /**
   * The movies and series the caller's own Jellyfin view holds, by TMDB ID, read with the caller's own credentials (so
   * Jellyfin applies their blocked tags, library access and parental limits) and reused for a short while, in the
   * household's own cache.
   */
  #library(caller: JellyfinCaller, context: HouseholdAppRequest): Promise<Map<string, string>> {
    const load = () => readLibrary(caller, context);
    const libraries = this.#caches(context.householdId)?.libraries;
    return libraries ? libraries.get(normalizedUserId(caller.id), load) : load();
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
    // TMDB, Seerr and Jellyfin errors name the route and status only.
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
  /** {@link APP_API_VERSION}. */
  apiVersion: number;
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
  /**
   * The caller hid this title (see HiddenTitles). Always false in discovery lists, which leave hidden titles out; true
   * only in search results and on title pages. Since apiVersion 3.
   */
  hidden: boolean;
}

export interface PageDto {
  page: number;
  nextPage: number | null;
  results: CardDto[];
}

/** The answer to hiding (`true`) or unhiding (`false`) a title. */
export interface HiddenDto {
  hidden: boolean;
}

/** A page of the caller's own hidden titles (GET /hidden). */
export interface HiddenPageDto {
  page: number;
  nextPage: number | null;
  results: Array<{ mediaType: MediaType; tmdbId: number; hiddenAt: string }>;
}

/** A network or studio the app lists, from JellyPass's own allowlist: no TMDB call, the same for everyone. */
export interface SourceDto {
  id: number;
  name: string;
  logoUrl: string | null;
}

/** A network, and whether it has a films list (`GET /discover/network/:id/films`). */
export interface NetworkDto extends SourceDto {
  hasFilms: boolean;
}

export interface SourcesDto {
  networks: NetworkDto[];
  studios: SourceDto[];
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

/** Adds `by` to the count under `key`, dropping it at zero. */
function adjust(counts: Map<string, number>, key: string, by: number): void {
  const count = (counts.get(key) ?? 0) + by;
  if (count > 0) counts.set(key, count);
  else counts.delete(key);
}

/**
 * One page of a network's films and series together: the same page of each, alternating film, series, film, … from
 * each one's own popularity order (TMDB's popularity is not comparable across movies and series), the longer one's rest
 * at the end. Nothing is dropped as a duplicate (a movie and a series are never the same title). There is a next page
 * while either list has one.
 */
function mixedPage(films: PageDto, series: PageDto): PageDto {
  const results: CardDto[] = [];
  for (let index = 0; index < Math.max(films.results.length, series.results.length); index += 1) {
    const film = films.results[index];
    const show = series.results[index];
    if (film) results.push(film);
    if (show) results.push(show);
  }
  return { page: films.page, nextPage: films.nextPage ?? series.nextPage, results };
}

/**
 * A page of cards from a TMDB search or discover answer. Only movies and series are kept (people and collections are
 * not titles). `nextPage` comes only from the answer's own results: TMDB's totals and paging are never read.
 * `leaveOutHidden` (discovery lists) leaves out the caller's own hidden titles, so a page may be shorter, or empty, with
 * a next page all the same: `nextPage` is decided from TMDB's entries before anything is left out, and no other page is
 * read to make up for them.
 */
function pageOf(answer: unknown, page: number, mediaType: MediaType | undefined, view: HouseholdView, origin: string, leaveOutHidden: boolean): PageDto {
  const results = field(answer, 'results');
  const entries = Array.isArray(results) ? results : [];
  const cards = entries.flatMap((entry) => {
    const card = cardOf(entry, mediaType, view, origin);
    return card && !(leaveOutHidden && card.hidden) ? [card] : [];
  });
  return { page, nextPage: entries.length >= CATALOGUE_PAGE_SIZE && page < MAX_PAGE ? page + 1 : null, results: cards };
}

function cardOf(entry: unknown, listType: MediaType | undefined, view: HouseholdView, origin: string): CardDto | undefined {
  const declared = field(entry, 'media_type');
  const mediaType = declared === 'movie' || declared === 'tv' ? declared : declared === undefined ? listType : undefined;
  const tmdbId = positiveInteger(field(entry, 'id'));
  if (!mediaType || tmdbId === null) return undefined;
  const state = titleState(view, mediaType, tmdbId);
  return { mediaType, tmdbId, ...titleFields(entry, mediaType), ...stateFields(state, origin), hidden: view.hidden.has(titleKey(mediaType, tmdbId)) };
}

/** The title fields every card and title shares, each copied from the one TMDB field chosen for it. */
function titleFields(source: unknown, mediaType: MediaType): Pick<CardDto, 'title' | 'year' | 'overview' | 'posterUrl' | 'backdropUrl' | 'rating'> {
  const date = field(source, mediaType === 'movie' ? 'release_date' : 'first_air_date');
  const year = typeof date === 'string' && /^[0-9]{4}-/.test(date) ? Number(date.slice(0, 4)) : null;
  const rating = field(source, 'vote_average');
  return {
    title: text(field(source, mediaType === 'movie' ? 'title' : 'name'), 300),
    year,
    overview: text(field(source, 'overview'), 4000),
    posterUrl: imageUrl(TMDB_POSTER_BASE, field(source, 'poster_path')),
    backdropUrl: imageUrl(TMDB_BACKDROP_BASE, field(source, 'backdrop_path')),
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

function seasonList(value: unknown): Array<Omit<SeasonSummaryDto, 'state'>> {
  return (Array.isArray(value) ? value : []).flatMap((season) => {
    const seasonNumber = nonNegativeInteger(field(season, 'season_number'));
    return seasonNumber === null ? [] : [{
      seasonNumber,
      name: text(field(season, 'name'), 200),
      episodeCount: nonNegativeInteger(field(season, 'episode_count')),
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

/**
 * The titles on Seerr's blocklist, as `mediaType:tmdbId` keys, paged through with the admin key. Only each entry's
 * `mediaType` and `tmdbId` are read. The blocklist is kept by administrators and is the same for every household.
 */
export async function readBlocklist(seerr: Pick<SeerrClient, 'blocklist'>): Promise<Set<string>> {
  const keys = new Set<string>();
  for (let page = 0; page < MAX_BLOCKLIST_PAGES; page += 1) {
    const results = field(await seerr.blocklist(BLOCKLIST_PAGE, page * BLOCKLIST_PAGE), 'results');
    const entries = Array.isArray(results) ? results : [];
    for (const entry of entries) {
      const type = field(entry, 'mediaType');
      const tmdbId = positiveInteger(field(entry, 'tmdbId'));
      if ((type === 'movie' || type === 'tv') && tmdbId !== null) keys.add(titleKey(type, tmdbId));
    }
    if (entries.length < BLOCKLIST_PAGE) break;
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

function pageParameter(url: URL): number {
  const value = url.searchParams.get('page');
  if (value === null) return 1;
  if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > MAX_PAGE) throw new AppAnswer('invalid');
  return Number(value);
}

/** An allowlisted network or studio ID, or `invalid` (any other number, or anything that is not one). */
function sourceParameter(kind: 'network' | 'studio', value: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(value) || !tmdbSource(kind, Number(value))) throw new AppAnswer('invalid');
  return Number(value);
}

/**
 * Whether `list` (`films` or `all`) is one of the network `input`'s lists: only a listed network with films has them.
 * Any other second segment after a network's ID, as after a studio's, is an unknown path (`not_found`).
 */
function networkHasList(input: string, list: string): boolean {
  return (list === 'films' || list === 'all')
    && /^[1-9][0-9]{0,9}$/.test(input)
    && Boolean(tmdbSource('network', Number(input))?.movieProviderIds?.length);
}

function sourceDto(source: TmdbSource): SourceDto {
  return { id: source.id, name: source.name, logoUrl: imageUrl(TMDB_LOGO_BASE, source.logoPath) };
}

/** The allowlisted networks and studios, in the order Home shows them. */
function sourcesDto(): SourcesDto {
  return {
    networks: TMDB_NETWORKS.map((network) => ({ ...sourceDto(network), hasFilms: Boolean(network.movieProviderIds?.length) })),
    studios: TMDB_STUDIOS.map(sourceDto),
  };
}

function tmdbParameter(value: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 2_147_483_647) throw new AppAnswer('invalid');
  return Number(value);
}

/**
 * The seasons a "Get this" body asks for: none for a movie (an empty body or `{}`), and for a series `{"seasons":
 * [n, ...]}` with 1 to 100 distinct season numbers from 1 to 999 (specials cannot be requested), sorted. Anything else
 * is `invalid`.
 */
function getThisSeasons(mediaType: MediaType, body: Buffer): number[] {
  let value: unknown;
  try {
    value = body.length === 0 ? {} : JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new AppAnswer('invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppAnswer('invalid');
  const keys = Object.keys(value);
  if (mediaType === 'movie') {
    if (keys.length > 0) throw new AppAnswer('invalid');
    return [];
  }
  const seasons = field(value, 'seasons');
  if (keys.length !== 1 || !Array.isArray(seasons) || seasons.length < 1 || seasons.length > MAX_SEASONS_ASKED
    || !seasons.every((season) => typeof season === 'number' && Number.isSafeInteger(season) && season >= 1 && season <= 999)
    || new Set(seasons).size !== seasons.length) {
    throw new AppAnswer('invalid');
  }
  return [...(seasons as number[])].sort((left, right) => left - right);
}

/** A request body of at most MAX_GET_THIS_BODY_BYTES bytes; a larger one is `invalid`. */
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_GET_THIS_BODY_BYTES) throw new AppAnswer('invalid');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function titleKey(mediaType: MediaType, tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

function normalizedUserId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

function isMember(context: HouseholdAppRequest, caller: JellyfinCaller): boolean {
  const id = normalizedUserId(caller.id);
  return context.memberIds.some((member) => normalizedUserId(member) === id);
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
    ...NEVER_STORE,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(encoded);
}
