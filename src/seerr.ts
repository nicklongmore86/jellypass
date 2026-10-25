import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { RecentSeerrRequest, SeerrRequest } from './types.js';

interface SeerrRequestList {
  pageInfo?: { results?: number };
  results?: Array<{
    id?: number;
    status?: number;
    type?: string;
    is4k?: boolean;
    createdAt?: string;
    seasonCount?: number;
    media?: { mediaType?: string; tmdbId?: number; status?: number; status4k?: number; jellyfinMediaId?: string; jellyfinMediaId4k?: string };
    requestedBy?: { displayName?: string; username?: string; jellyfinUserId?: string };
  }>;
}

interface SeerrMediaDetails {
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  posterPath?: string;
}

/** Recent requests shown on the admin Dashboard; divides evenly into its 4/3/2-column grid. */
export const RECENT_REQUESTS_LIMIT = 12;
/** Most recent requests fetched and cached per catalog; larger requests are capped to this. */
export const RECENT_REQUESTS_MAX = 20;
const RECENT_REQUESTS_TTL_MS = 60_000;

export interface ImportedSeerrUser {
  id?: number;
  username?: string;
  jellyfinUsername?: string;
  jellyfinUserId?: string;
}

/** A Seerr API call that returned a non-2xx status. */
export class SeerrError extends Error {
  public constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'SeerrError';
  }
}

declare const seerrUserIdBrand: unique symbol;

/**
 * A Seerr user ID: a positive safe integer, checked by {@link seerrUserId}, which is the only way to make one. Seerr
 * runs an API-key call with `X-API-User: <id>` as that user, but a missing or empty `X-API-User` as its owner (user 1),
 * so every call made for a household member needs one.
 */
export type SeerrUserId = number & { readonly [seerrUserIdBrand]: true };

export function isSeerrUserId(value: unknown): value is SeerrUserId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Checks `value` is a Seerr user ID and returns it as one; throws a TypeError otherwise. */
export function seerrUserId(value: unknown): SeerrUserId {
  if (!isSeerrUserId(value)) throw new TypeError('Seerr user ID must be a positive integer');
  return value;
}

/** A Seerr user that Seerr itself reports as linked to a Jellyfin user. `jellyfinUserId` is normalized. */
export interface LinkedSeerrUser {
  id: SeerrUserId;
  jellyfinUserId: string;
}

/** A Jellyfin user ID as Seerr stores it (32 lowercase hex digits, no dashes), or undefined if it is not one. */
export function normalizeJellyfinUserId(value: string): string | undefined {
  const normalized = value.replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : undefined;
}

/**
 * The admin-key Seerr client. Its calls send only `X-Api-Key`, so Seerr runs them as its owner account (user 1): use it
 * for JellyPass's own administrative work, never on behalf of a household member. Calls made for a member go through
 * {@link SeerrMemberClient} (their own data, verified before every call). The household app reads titles from TMDB,
 * never from Seerr (see `src/tmdb.ts`).
 */
export class SeerrClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  #recentCache: { expiresAt: number; catalogKey: string; items: RecentSeerrRequest[] } | undefined;
  readonly #titles: TitleParser;

  /** `titleWorker` overrides {@link TITLE_WORKER_LIMITS} (for tests). */
  public constructor(baseUrl: string, apiKey: string, options: { titleWorker?: Partial<TitleWorkerLimits> } = {}) {
    this.#baseUrl = baseUrl;
    this.#apiKey = apiKey;
    this.#titles = new TitleParser({ ...TITLE_WORKER_LIMITS, ...options.titleWorker });
    credentials.set(this, { baseUrl, apiKey });
  }

  /** Stops the title worker (see titleRequests), failing any parse still queued; at shutdown. */
  public close(): Promise<void> {
    return this.#titles.close();
  }

  /**
   * The Seerr user linked to a Jellyfin user, or undefined when Seerr has none (or `jellyfinUserId` is not a Jellyfin
   * user ID). Throws on any other failed lookup. Like every acting-user call, it refuses redirects and its
   * errors carry only the status and the route template.
   */
  public async findUserByJellyfinId(jellyfinUserId: string): Promise<LinkedSeerrUser | undefined> {
    const normalized = normalizeJellyfinUserId(jellyfinUserId);
    if (!normalized) return undefined;
    let user: { id?: unknown; jellyfinUserId?: unknown };
    try {
      user = await this.#guardedGet('/api/v1/user/jellyfin/:jellyfinUserId', `/api/v1/user/jellyfin/${normalized}`) as typeof user;
    } catch (error) {
      if (error instanceof SeerrError && error.status === 404) return undefined;
      throw error;
    }
    // Seerr matches on the normalized ID; anything else in the answer is not the user that was asked for.
    if (!isSeerrUserId(user?.id) || typeof user.jellyfinUserId !== 'string' ||
        normalizeJellyfinUserId(user.jellyfinUserId) !== normalized) {
      return undefined;
    }
    return { id: user.id, jellyfinUserId: normalized };
  }

  /**
   * The Jellyfin user (normalized) that Seerr currently links to a Seerr user, or undefined when that Seerr user no
   * longer exists or has no Jellyfin link. Throws on any other failed lookup; guarded like {@link findUserByJellyfinId}.
   */
  public async jellyfinUserIdOf(user: SeerrUserId): Promise<string | undefined> {
    const record = await this.#userRecord(user);
    return typeof record?.jellyfinUserId === 'string' ? normalizeJellyfinUserId(record.jellyfinUserId) : undefined;
  }

  /**
   * One page of Seerr's blocklist (GET /api/v1/blocklist), newest first. The blocklist is kept by administrators and is
   * the same for every household: each entry names a title and the administrator who blocklisted it, and Seerr joins
   * nothing else to it (no media record, no requests). Guarded like {@link findUserByJellyfinId}.
   */
  public blocklist(take: number, skip: number): Promise<unknown> {
    if (!Number.isSafeInteger(take) || take < 1 || take > 100 || !Number.isSafeInteger(skip) || skip < 0) {
      throw new TypeError('paging is invalid');
    }
    return this.#guardedGet('/api/v1/blocklist', `/api/v1/blocklist?take=${take}&skip=${skip}`);
  }

  /**
   * What Seerr records about a title's HD and 4K requests (GET /api/v1/movie/:id or /api/v1/tv/:id with the admin key),
   * reduced to what household app "Get this" decides from in the background: the media record's ID and Jellyfin items,
   * and each request's ID, status, quality, seasons and requester. Undefined when Seerr (TMDB) does not know the title.
   * The answer carries every household's records on the title, so it is read only by background work, never for an
   * answer, and up to {@link MAX_TITLE_RECORD_BYTES}. Guarded like {@link findUserByJellyfinId}.
   */
  public titleRequests(mediaType: 'movie' | 'tv', tmdbId: number): Promise<SeerrTitleRecord | undefined> {
    if (mediaType !== 'movie' && mediaType !== 'tv') throw new TypeError('media type is invalid');
    return this.#titleRequests(mediaType, tmdbIdentifier(tmdbId));
  }

  async #titleRequests(mediaType: 'movie' | 'tv', id: number): Promise<SeerrTitleRecord | undefined> {
    const route = `/api/v1/${mediaType}/:id`;
    let bytes: Uint8Array;
    try {
      bytes = await guardedSeerrBytes(this.#baseUrl, 'GET', route, `/api/v1/${mediaType}/${id}`,
        { Accept: 'application/json', 'X-Api-Key': this.#apiKey }, undefined, MAX_TITLE_RECORD_BYTES);
    } catch (error) {
      if (error instanceof SeerrError && error.status === 404) return undefined;
      throw error;
    }
    return this.#titles.parse(bytes, route);
  }

  /**
   * One request's status and media record (GET /api/v1/request/:id with the admin key), or undefined when Seerr has
   * no such request (deleted). Only for requests JellyPass's own records name. Guarded like {@link findUserByJellyfinId}.
   */
  public requestState(requestId: string): Promise<{ status: number; mediaId?: number } | undefined> {
    if (typeof requestId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(requestId)) throw new TypeError('request ID is invalid');
    return this.#requestState(requestId);
  }

  async #requestState(requestId: string): Promise<{ status: number; mediaId?: number } | undefined> {
    let answer: unknown;
    try {
      answer = await this.#guardedGet('/api/v1/request/:id', `/api/v1/request/${requestId}`);
    } catch (error) {
      if (error instanceof SeerrError && error.status === 404) return undefined;
      throw error;
    }
    const status = positiveSafeInteger(ownField(answer, 'status'));
    if (status === undefined || String(ownField(answer, 'id')) !== requestId) throw new SeerrError('Seerr GET /api/v1/request/:id returned an unexpected answer', 502);
    return { status, ...optional('mediaId', positiveSafeInteger(ownField(ownField(answer, 'media'), 'id'))) };
  }

  /** Seerr's GET /api/v1/user/:id as the admin, or undefined when that user does not exist (or is not the one asked for). */
  async #userRecord(user: SeerrUserId): Promise<{ jellyfinUserId?: unknown } | undefined> {
    let answer: { id?: unknown; jellyfinUserId?: unknown };
    try {
      answer = await this.#guardedGet('/api/v1/user/:id', `/api/v1/user/${seerrUserId(user)}`) as typeof answer;
    } catch (error) {
      if (error instanceof SeerrError && error.status === 404) return undefined;
      throw error;
    }
    return answer?.id === user ? answer : undefined;
  }

  /** An admin-key GET with the acting-user client's guards: no redirects, capped body, route-only errors. */
  #guardedGet(route: string, path: string): Promise<unknown> {
    return guardedSeerrJson(this.#baseUrl, 'GET', route, path, { Accept: 'application/json', 'X-Api-Key': this.#apiKey });
  }

  public async getRequest(requestId: string): Promise<SeerrRequest> {
    return this.#getJson<SeerrRequest>(`/api/v1/request/${encodeURIComponent(requestId)}`);
  }

  /**
   * The HD Jellyfin item Seerr has linked to a TMDB title, or undefined when Seerr knows the title but has no item for
   * it. Throws on any failed lookup, including a TMDB ID Seerr cannot find.
   */
  public async getJellyfinItemId(mediaType: 'movie' | 'tv', tmdbId: number): Promise<string | undefined> {
    const details = await this.#getJson<{ mediaInfo?: { jellyfinMediaId?: string | null } | null }>(
      `/api/v1/${mediaType}/${encodeURIComponent(String(tmdbId))}`,
    );
    return details.mediaInfo?.jellyfinMediaId || undefined;
  }

  public async importJellyfinUser(jellyfinUserId: string): Promise<{ status: 'imported' | 'already_imported'; user?: ImportedSeerrUser }> {
    const users = await this.#postJson<ImportedSeerrUser[]>('/api/v1/user/import-from-jellyfin', {
      jellyfinUserIds: [jellyfinUserId],
    });
    const user = users.find((entry) => entry.jellyfinUserId?.toLowerCase() === jellyfinUserId.toLowerCase()) ?? users[0];
    return user ? { status: 'imported', user } : { status: 'already_imported' };
  }

  /**
   * Pages through Seerr requests newest first and stops once a whole page was created before
   * `since`, so the backfill does not walk the entire request history on every run.
   */
  public async listRequestsSince(since: Date): Promise<SeerrRequest[]> {
    const requests: SeerrRequest[] = [];
    const pageSize = 50;
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;
    while (skip < total) {
      const list = await this.#getJson<SeerrRequestList>(`/api/v1/request?take=${pageSize}&skip=${skip}&sort=added`);
      const page = list.results ?? [];
      total = list.pageInfo?.results ?? skip + page.length;
      let recent = 0;
      for (const request of page) {
        if (!Number.isInteger(request.id)) continue;
        const createdAt = typeof request.createdAt === 'string' ? Date.parse(request.createdAt) : Number.NaN;
        if (!Number.isFinite(createdAt) || createdAt < since.getTime()) continue;
        recent += 1;
        requests.push(request as SeerrRequest);
      }
      if (!page.length || recent === 0) break;
      skip += page.length;
    }
    return requests;
  }

  public async getRecentRequests(take = RECENT_REQUESTS_LIMIT, jellyfinItemIds?: ReadonlySet<string>): Promise<RecentSeerrRequest[]> {
    const count = Math.min(Math.max(Math.trunc(take), 1), RECENT_REQUESTS_MAX);
    const catalogKey = recentCatalogKey(jellyfinItemIds);
    const cached = this.#recentCache;
    if (cached && cached.expiresAt > Date.now() && cached.catalogKey === catalogKey) {
      return cached.items.slice(0, count);
    }
    // Always fill the cache to the cap so a later, larger request within the TTL is still served in full.
    const requests: NonNullable<SeerrRequestList['results']> = [];
    const pageSize = 50;
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;
    while (requests.length < RECENT_REQUESTS_MAX && skip < total) {
      const list = await this.#getJson<SeerrRequestList>(`/api/v1/request?take=${pageSize}&skip=${skip}&sort=added`);
      const page = list.results ?? [];
      total = list.pageInfo?.results ?? skip + page.length;
      requests.push(...page.filter((request) => {
        const jellyfinItemId = requestJellyfinItemId(request);
        return Number.isInteger(request.id) &&
          Number.isInteger(request.media?.tmdbId) &&
          (request.type === 'movie' || request.type === 'tv') &&
          typeof request.createdAt === 'string' &&
          Boolean(jellyfinItemId) &&
          (!jellyfinItemIds || jellyfinItemIds.has(jellyfinItemId!.toLowerCase()));
      }));
      if (!page.length) break;
      skip += page.length;
    }
    requests.splice(RECENT_REQUESTS_MAX);
    const items = await Promise.all(requests.map(async (request) => {
      const mediaType = request.type as 'movie' | 'tv';
      const tmdbId = request.media?.tmdbId as number;
      let details: SeerrMediaDetails = {};
      try {
        details = await this.#getJson<SeerrMediaDetails>(`/api/v1/${mediaType}/${tmdbId}`);
      } catch {
        // A single unavailable TMDB record should not hide the rest of recent activity.
      }
      const date = details.releaseDate ?? details.firstAirDate;
      const year = date ? Number.parseInt(date.slice(0, 4), 10) : undefined;
      const title = details.title ?? details.name ?? `${mediaType === 'movie' ? 'Movie' : 'Series'} #${tmdbId}`;
      const jellyfinItemId = requestJellyfinItemId(request);
      return {
        id: request.id as number,
        mediaType,
        title,
        ...(year !== undefined && Number.isInteger(year) ? { year } : {}),
        ...(validPosterPath(details.posterPath) ? { posterPath: details.posterPath } : {}),
        ...(jellyfinItemId ? { jellyfinItemId } : {}),
        requestStatus: requestStatus(request.status),
        mediaStatus: mediaStatus(request.media?.status),
        requestedBy: request.requestedBy?.displayName || request.requestedBy?.username || 'Unknown user',
        createdAt: request.createdAt as string,
        ...(mediaType === 'tv' && request.seasonCount ? { seasonCount: request.seasonCount } : {}),
      };
    }));
    this.#recentCache = { expiresAt: Date.now() + RECENT_REQUESTS_TTL_MS, catalogKey, items };
    return items.slice(0, count);
  }

  public async getPoster(posterPath: string): Promise<{ body: Uint8Array; contentType: string }> {
    if (!validPosterPath(posterPath)) throw new Error('posterPath is invalid');
    const response = await fetch(`https://image.tmdb.org/t/p/w342${posterPath}`, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'image/avif,image/webp,image/jpeg' },
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`TMDB poster returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return {
      body: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || 'image/jpeg',
    };
  }

  async #getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', 'X-Api-Key': this.#apiKey },
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new SeerrError(`Seerr GET ${path} returned ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
    }
    return (await response.json()) as T;
  }

  async #postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': this.#apiKey },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Seerr POST ${path} returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return (await response.json()) as T;
  }
}

/** An HD request for a title: a whole movie, or the named seasons of a series. */
export type SeerrRequestInput =
  | { mediaType: 'movie'; tmdbId: number }
  | { mediaType: 'tv'; tmdbId: number; seasons: number[] };

/** Largest Seerr response body read by the guarded calls, in bytes; reading stops as soon as a body passes it. */
export const MAX_GUARDED_RESPONSE_BYTES = 4 * 1024 * 1024;
/**
 * Largest Seerr title answer read by {@link SeerrClient.titleRequests}: its size grows with every household's records on
 * the title, so it is far above any real one, and a busy title never makes "Get this" fail.
 */
export const MAX_TITLE_RECORD_BYTES = 64 * 1024 * 1024;

/** What {@link SeerrClient.titleRequests} reads of a title. Jellyfin IDs are normalized. */
export interface SeerrTitleRecord {
  /** The title's names as TMDB has them (title and original title, or a series' name and original name). */
  names: string[];
  /** The year of its release (a series: first air date), if known. */
  year?: number;
  mediaId?: number;
  jellyfinMediaId?: string;
  jellyfinMediaId4k?: string;
  requests: Array<{
    id: string;
    status: number;
    is4k: boolean;
    seasons: number[];
    requesterJellyfinId?: string;
    /** When Seerr made it (ms since the epoch), if it says. */
    createdAt?: number;
  }>;
}

/** Statuses after which Seerr may no longer accept the acting user (unknown, removed or relinked). */
const USER_REJECTED_STATUSES = new Set([401, 403, 404]);

/** The admin client's connection details, for the acting-user clients made from it; never exported. */
const credentials = new WeakMap<SeerrClient, { baseUrl: string; apiKey: string }>();

/** A Jellyfin user Seerr has no user for, or whose Seerr user could not be confirmed just before a call. */
export class SeerrUnmappedUserError extends Error {
  public constructor() {
    super('Seerr has no confirmed user for this Jellyfin user');
    this.name = 'SeerrUnmappedUserError';
  }
}

/**
 * Where a {@link SeerrMemberClient} gets the Seerr user to try for a Jellyfin user. Its answers are only candidates:
 * the client confirms each with Seerr before every call, so a wrong or stale answer can make a call fail closed but
 * never run as anyone else.
 */
export interface SeerrUserResolver {
  /** The Seerr user believed linked to a normalized Jellyfin user ID, or undefined if none. */
  candidate(jellyfinUserId: string): Promise<SeerrUserId | undefined>;
  /** Stops offering `user` for this Jellyfin user, because Seerr no longer links them. */
  forget(jellyfinUserId: string, user: SeerrUserId): void;
  /** A value that changes whenever this Jellyfin user's mapping is invalidated. */
  version(jellyfinUserId: string): number;
}

/** A resolver with no cache: every call looks the user up again. */
function lookupResolver(admin: SeerrClient): SeerrUserResolver {
  return {
    candidate: async (jellyfinUserId) => (await admin.findUserByJellyfinId(jellyfinUserId))?.id,
    forget: () => undefined,
    version: () => 0,
  };
}

/**
 * A household member's own data in Seerr (requests, quota, watchlist), acting as their Seerr user. The client holds
 * the member's Jellyfin user, never a Seerr user: immediately before every call it takes a candidate Seerr user from
 * its resolver and has Seerr confirm, with the admin key and GET /api/v1/user/:id, that the candidate is still linked
 * to that Jellyfin user, and only then sends the call with that user in `X-API-User`. Nothing is awaited between the
 * confirmation and the call being sent. A mismatch forgets the candidate and tries once more; a mapping invalidated
 * while a call was being confirmed is confirmed again. Anything else fails closed with {@link SeerrUnmappedUserError}.
 * So a client kept across a relink acts as whoever Seerr links to the member at the time of each call, or nobody.
 *
 * Only the endpoints the household app uses are exposed, each behind its own method; there is no generic pass-through.
 * Responses are Seerr's JSON as-is (`unknown`): callers copy out only the fields they need. Errors carry the status and
 * the route, never Seerr's response body.
 */
export class SeerrMemberClient {
  readonly #admin: SeerrClient;
  readonly #jellyfinUserId: string;
  readonly #resolver: SeerrUserResolver;

  /** Throws a TypeError unless `jellyfinUserId` is a Jellyfin user ID. */
  public constructor(admin: SeerrClient, jellyfinUserId: string, resolver: SeerrUserResolver = lookupResolver(admin)) {
    if (!credentials.has(admin)) throw new TypeError('Seerr admin client is invalid');
    const normalized = typeof jellyfinUserId === 'string' ? normalizeJellyfinUserId(jellyfinUserId) : undefined;
    if (!normalized) throw new TypeError('Jellyfin user ID is invalid');
    this.#admin = admin;
    this.#jellyfinUserId = normalized;
    this.#resolver = resolver;
  }

  /** The member's Jellyfin user ID, normalized. */
  public get jellyfinUserId(): string {
    return this.#jellyfinUserId;
  }

  /**
   * Requests a title as this member, in HD. The body names only the title: never `userId` (which would let a manager
   * request for someone else) or a server, profile or folder override.
   */
  public createRequest(input: SeerrRequestInput): Promise<unknown> {
    return this.#send('POST', '/api/v1/request', () => '/api/v1/request', requestBody(input));
  }

  /**
   * Confirms now, as before every call, the Seerr user that acts for this member, and returns a sender for one request
   * as that user that confirms nothing more: for "Get this", whose last step before its request is a Jellyfin read
   * (docs/app-design.md, "Late requests"). The sender sends nothing (SeerrUnmappedUserError) if this member's mapping
   * was invalidated since (SeerrUserMap.invalidate); otherwise its request leaves at once, like {@link createRequest}.
   * A relink made in Seerr in between that JellyPass is not told of is not seen: the request acts as the user Seerr
   * linked to the member when it was confirmed.
   */
  public async confirmRequester(): Promise<{ createRequest(input: SeerrRequestInput): Promise<unknown> }> {
    const key = this.#jellyfinUserId;
    const { user, version } = await this.#confirm();
    return {
      createRequest: (input) => {
        let body: unknown;
        try {
          body = requestBody(input);
        } catch (error) {
          return Promise.reject(error);
        }
        if (this.#resolver.version(key) !== version) return Promise.reject(new SeerrUnmappedUserError());
        return actingUserJson(this.#admin, user, 'POST', '/api/v1/request', '/api/v1/request', body, () => this.#resolver.forget(key, user));
      },
    };
  }

  /** This member's own requests, newest first. The user ID in the path is always the confirmed acting user's. */
  public ownRequests(take = 20, skip = 0): Promise<unknown> {
    const count = Math.min(Math.max(Math.trunc(take), 1), 100);
    const offset = Math.max(Math.trunc(skip), 0);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(offset)) throw new TypeError('paging is invalid');
    return this.#send('GET', '/api/v1/user/:self/requests', (user) => `/api/v1/user/${user}/requests?take=${count}&skip=${offset}`);
  }

  public quota(): Promise<unknown> {
    return this.#send('GET', '/api/v1/user/:self/quota', (user) => `/api/v1/user/${user}/quota`);
  }

  /** This member's own Seerr user as Seerr reports it to them (GET /api/v1/auth/me), for their own permissions. */
  public ownUser(): Promise<unknown> {
    return this.#send('GET', '/api/v1/auth/me', () => '/api/v1/auth/me');
  }

  /** This member's own Seerr watchlist. */
  public watchlist(page = 1): Promise<unknown> {
    const parameters = `page=${pageNumber(page)}`;
    return this.#send('GET', '/api/v1/discover/watchlist', () => `/api/v1/discover/watchlist?${parameters}`);
  }

  async #send(method: 'GET' | 'POST', route: string, path: (user: string) => string, body?: unknown): Promise<unknown> {
    const key = this.#jellyfinUserId;
    const { user } = await this.#confirm();
    // Sent at once: nothing is awaited between Seerr confirming the link and the call leaving.
    return actingUserJson(this.#admin, user, method, route, path(String(user)), body, () => this.#resolver.forget(key, user));
  }

  /** The Seerr user Seerr confirms is linked to this member now, with the mapping's version when it was confirmed. */
  async #confirm(): Promise<{ user: SeerrUserId; version: number }> {
    const key = this.#jellyfinUserId;
    // A stale candidate is forgotten and replaced once; a second failure means Seerr is changing under us.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const version = this.#resolver.version(key);
      const user = await this.#resolver.candidate(key);
      if (user === undefined || !isSeerrUserId(user)) break;
      if (await this.#admin.jellyfinUserIdOf(user) !== key) {
        this.#resolver.forget(key, user);
        continue;
      }
      if (this.#resolver.version(key) !== version) continue;
      return { user, version };
    }
    throw new SeerrUnmappedUserError();
  }
}

/** The body of an HD request for a title: only the title, never `userId` or a server, profile or folder override. */
function requestBody(input: SeerrRequestInput): unknown {
  const tmdbId = tmdbIdentifier(input.tmdbId);
  if (input.mediaType === 'movie') return { mediaType: 'movie', mediaId: tmdbId, is4k: false };
  if (input.mediaType !== 'tv') throw new TypeError('media type is invalid');
  const seasons = input.seasons;
  if (!Array.isArray(seasons) || !seasons.length || seasons.length > 100 ||
      !seasons.every((season) => Number.isSafeInteger(season) && season > 0)) {
    throw new TypeError('seasons are invalid');
  }
  return { mediaType: 'tv', mediaId: tmdbId, seasons: [...new Set(seasons)], is4k: false };
}

/**
 * A guarded Seerr call acting as `user`, which must be a valid {@link SeerrUserId}: `X-API-User` is built from it and
 * re-checked here, so it is never missing or empty (which Seerr runs as its owner). `onRejected`, if given, runs before a
 * 401, 403 or 404 is thrown.
 */
async function actingUserJson(
  admin: SeerrClient,
  user: SeerrUserId,
  method: 'GET' | 'POST',
  route: string,
  path: string,
  body?: unknown,
  onRejected?: (status: number) => void,
): Promise<unknown> {
  const connection = credentials.get(admin);
  if (!connection) throw new TypeError('Seerr admin client is invalid');
  if (!isSeerrUserId(user)) throw new TypeError('Seerr user ID must be a positive integer');
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Api-Key': connection.apiKey,
    'X-API-User': String(user),
  };
  try {
    return await guardedSeerrJson(connection.baseUrl, method, route, path, headers, body);
  } catch (error) {
    if (error instanceof SeerrError && USER_REJECTED_STATUSES.has(error.status)) onRejected?.(error.status);
    throw error;
  }
}

/**
 * A Seerr call for the household app. A redirect is never followed (it would carry the API key, and any acting user,
 * to wherever it points) and counts as a failure. The body is read up to {@link MAX_GUARDED_RESPONSE_BYTES} bytes
 * and no further. Errors carry only the status and the route template, never Seerr's body or the IDs in the path.
 */
async function guardedSeerrJson(
  baseUrl: string,
  method: 'GET' | 'POST',
  route: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  limit = MAX_GUARDED_RESPONSE_BYTES,
): Promise<unknown> {
  const bytes = await guardedSeerrBytes(baseUrl, method, route, path, headers, body, limit);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    // JSON.parse's own message quotes the body.
    throw new SeerrError(`Seerr ${method} ${route} returned invalid JSON`, 502);
  }
}

/** {@link guardedSeerrJson}'s call, up to reading the body's bytes. */
async function guardedSeerrBytes(
  baseUrl: string,
  method: 'GET' | 'POST',
  route: string,
  path: string,
  headers: Record<string, string>,
  body: unknown,
  limit: number,
): Promise<Uint8Array> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    signal: AbortSignal.timeout(15_000),
    redirect: 'manual',
    headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    // Includes an unfollowed redirect, which Node's fetch hands back as the 3xx itself.
    throw new SeerrError(`Seerr ${method} ${route} returned ${response.status}`, response.status);
  }
  const bytes = await readCappedBody(response, limit);
  if (!bytes) throw new SeerrError(`Seerr ${method} ${route} response is too large`, 502);
  return bytes;
}

/** Bounds on the worker Seerr title answers are parsed in (see SeerrClient.titleRequests). */
export interface TitleWorkerLimits {
  /** Most answers queued or being parsed at once; more are refused (`503`) until one is done. */
  maxJobs: number;
  /** Most bytes queued or being parsed at once, all answers together; an answer past it is refused (`503`). */
  maxQueuedBytes: number;
  /** Longest one answer may take to parse; past it the worker is stopped (failing every queued answer) and restarted when next needed. */
  timeoutMs: number;
}

export const TITLE_WORKER_LIMITS: TitleWorkerLimits = { maxJobs: 32, maxQueuedBytes: 4 * MAX_TITLE_RECORD_BYTES, timeoutMs: 15_000 };

interface TitleWorkerState {
  worker: Worker;
  jobs: Map<number, TitleJob>;
  timer?: NodeJS.Timeout;
}

interface TitleJob {
  resolve: (record: SeerrTitleRecord) => void;
  reject: (error: Error) => void;
  route: string;
  bytes: number;
}

/**
 * The worker title answers are parsed in (see parseTitleAnswer), so the event loop never waits on the size of other
 * households' records: started when first needed, kept while it works and stopped by {@link close}. Bounded by
 * {@link TitleWorkerLimits}: queued answers and bytes are capped, and a parse that takes too long stops the worker.
 * Exported for tests; each SeerrClient has its own.
 */
export class TitleParser {
  readonly #limits: TitleWorkerLimits;
  #current: TitleWorkerState | undefined;
  #nextJob = 1;
  #queuedBytes = 0;
  #closed = false;

  public constructor(limits: TitleWorkerLimits) {
    this.#limits = limits;
  }

  public parse(bytes: Uint8Array, route: string): Promise<SeerrTitleRecord> {
    if (this.#closed) return Promise.reject(new SeerrError(`Seerr GET ${route} could not be read`, 503));
    const busy = this.#current?.jobs.size ?? 0;
    if (busy >= this.#limits.maxJobs || this.#queuedBytes + bytes.byteLength > this.#limits.maxQueuedBytes) {
      return Promise.reject(new SeerrError(`Seerr GET ${route} could not be read now`, 503));
    }
    const current = this.#current ??= this.#start();
    const id = this.#nextJob++;
    return new Promise((resolve, reject) => {
      current.jobs.set(id, { resolve, reject, route, bytes: bytes.byteLength });
      this.#queuedBytes += bytes.byteLength;
      current.worker.ref();
      this.#arm(current);
      // Handed over, not copied: nothing reads the bytes here afterwards.
      const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
      current.worker.postMessage({ id, bytes: whole }, [whole.buffer as ArrayBuffer]);
    });
  }

  public async close(): Promise<void> {
    this.#closed = true;
    const current = this.#current;
    if (!current) return;
    this.#fail(current, 'could not be read');
    await current.worker.terminate();
  }

  #start(): TitleWorkerState {
    const worker = new Worker(new URL('./seerr-title-worker.js', import.meta.url));
    const state: TitleWorkerState = { worker, jobs: new Map() };
    worker.on('message', ({ id, record }: { id: number; record?: SeerrTitleRecord }) => {
      const job = state.jobs.get(id);
      state.jobs.delete(id);
      if (job) this.#queuedBytes -= job.bytes;
      this.#arm(state);
      if (state.jobs.size === 0) worker.unref();
      if (!job) return;
      if (record) job.resolve(record);
      else job.reject(new SeerrError(`Seerr GET ${job.route} returned invalid JSON`, 502));
    });
    worker.on('error', () => this.#fail(state, 'could not be read'));
    worker.on('exit', () => this.#fail(state, 'could not be read'));
    worker.unref();
    return state;
  }

  /** (Re)starts the timeout of the oldest job still in the worker; none when idle. */
  #arm(state: TitleWorkerState): void {
    clearTimeout(state.timer);
    delete state.timer;
    if (state.jobs.size === 0) return;
    state.timer = setTimeout(() => {
      this.#fail(state, 'took too long to read');
      void state.worker.terminate();
    }, this.#limits.timeoutMs);
    state.timer.unref();
  }

  /** Fails every job of `state` and forgets its worker, so the next parse starts another. */
  #fail(state: TitleWorkerState, reason: string): void {
    clearTimeout(state.timer);
    if (this.#current === state) this.#current = undefined;
    for (const job of state.jobs.values()) {
      this.#queuedBytes -= job.bytes;
      job.reject(new SeerrError(`Seerr GET ${job.route} ${reason}`, 502));
    }
    state.jobs.clear();
  }
}

/** The response body if it is at most `limit` bytes, or undefined (with the rest of the body left unread) if not. */
export async function readCappedBody(response: Response, limit: number): Promise<Uint8Array | undefined> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** One own property of a JSON object, or undefined; never anything inherited. */
function ownField(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, name)) return undefined;
  return (value as Record<string, unknown>)[name];
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>;
}

function pageNumber(page: number): number {
  if (!Number.isSafeInteger(page) || page < 1 || page > 500) throw new TypeError('page is invalid');
  return page;
}

function tmdbIdentifier(tmdbId: number): number {
  if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) throw new TypeError('TMDB ID is invalid');
  return tmdbId;
}

function validPosterPath(value: string | undefined): value is string {
  return typeof value === 'string' && /^\/[a-zA-Z0-9._/-]{1,180}$/.test(value);
}

function requestJellyfinItemId(request: NonNullable<SeerrRequestList['results']>[number]): string | undefined {
  return request.is4k
    ? request.media?.jellyfinMediaId4k ?? request.media?.jellyfinMediaId
    : request.media?.jellyfinMediaId;
}

function requestStatus(value: number | undefined): RecentSeerrRequest['requestStatus'] {
  return ({ 1: 'pending', 2: 'approved', 3: 'declined', 4: 'failed', 5: 'completed' } as const)[value ?? 0] ?? 'unknown';
}

function mediaStatus(value: number | undefined): RecentSeerrRequest['mediaStatus'] {
  return ({ 1: 'unknown', 2: 'pending', 3: 'processing', 4: 'partially_available', 5: 'available', 6: 'deleted' } as const)[value ?? 0] ?? 'unknown';
}

function recentCatalogKey(jellyfinItemIds: ReadonlySet<string> | undefined): string {
  if (!jellyfinItemIds) return '*';
  return createHash('sha256').update([...jellyfinItemIds].sort().join('\n')).digest('hex');
}
