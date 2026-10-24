import { createHash } from 'node:crypto';
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
 * {@link SeerrUserClient}, from {@link SeerrClient.asUser}.
 */
export class SeerrClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  #recentCache: { expiresAt: number; catalogKey: string; items: RecentSeerrRequest[] } | undefined;

  public constructor(baseUrl: string, apiKey: string) {
    this.#baseUrl = baseUrl;
    this.#apiKey = apiKey;
  }

  /** A client that acts as the given Seerr user. Throws unless `user` is a valid Seerr user ID. */
  public asUser(user: SeerrUserId): SeerrUserClient {
    return new SeerrUserClient(this.#baseUrl, this.#apiKey, user);
  }

  /**
   * The Seerr user linked to a Jellyfin user, or undefined when Seerr has none (or `jellyfinUserId` is not a Jellyfin
   * user ID). Throws on any other failed lookup.
   */
  public async findUserByJellyfinId(jellyfinUserId: string): Promise<LinkedSeerrUser | undefined> {
    const normalized = normalizeJellyfinUserId(jellyfinUserId);
    if (!normalized) return undefined;
    let user: { id?: unknown; jellyfinUserId?: unknown };
    try {
      user = await this.#getJson(`/api/v1/user/jellyfin/${normalized}`);
    } catch (error) {
      if (error instanceof SeerrError && error.status === 404) return undefined;
      throw error;
    }
    // Seerr matches on the normalized ID; anything else in the answer is not the user that was asked for.
    if (!isSeerrUserId(user.id) || typeof user.jellyfinUserId !== 'string' ||
        normalizeJellyfinUserId(user.jellyfinUserId) !== normalized) {
      return undefined;
    }
    return { id: user.id, jellyfinUserId: normalized };
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

/** The discover lists the household app can show. */
export const SEERR_DISCOVER_LISTS = ['trending', 'movies', 'movies/upcoming', 'tv', 'tv/upcoming'] as const;
export type SeerrDiscoverList = typeof SEERR_DISCOVER_LISTS[number];

/** An HD request for a title: a whole movie, or the named seasons of a series. */
export type SeerrRequestInput =
  | { mediaType: 'movie'; tmdbId: number }
  | { mediaType: 'tv'; tmdbId: number; seasons: number[] };

const MAX_USER_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Seerr's API as one Seerr user sees it. Every call sends that user's ID in `X-API-User`, so Seerr applies their
 * permissions, quota and visibility rather than the owner's. The user is fixed when the client is made and must be a
 * valid {@link SeerrUserId}; the constructor throws otherwise, and so does every call if the ID is ever not one.
 *
 * Only the endpoints the household app uses are exposed, each behind its own method; there is no generic pass-through.
 * Responses are Seerr's JSON as-is (`unknown`): they include other users' data, so callers copy out only the fields
 * they need. Errors carry the status and the route, never Seerr's response body.
 */
export class SeerrUserClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #user: SeerrUserId;

  public constructor(baseUrl: string, apiKey: string, user: SeerrUserId) {
    this.#baseUrl = baseUrl;
    this.#apiKey = apiKey;
    this.#user = seerrUserId(user);
  }

  public get userId(): SeerrUserId {
    return this.#user;
  }

  public search(query: string, page = 1): Promise<unknown> {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new TypeError('search query is invalid');
    const parameters = new URLSearchParams({ query, page: String(pageNumber(page)) });
    return this.#getJson('/api/v1/search', `/api/v1/search?${parameters}`);
  }

  public discover(list: SeerrDiscoverList, page = 1): Promise<unknown> {
    if (!SEERR_DISCOVER_LISTS.includes(list)) throw new TypeError('discover list is invalid');
    return this.#getJson(`/api/v1/discover/${list}`, `/api/v1/discover/${list}?page=${pageNumber(page)}`);
  }

  public movie(tmdbId: number): Promise<unknown> {
    return this.#getJson('/api/v1/movie/:id', `/api/v1/movie/${tmdbIdentifier(tmdbId)}`);
  }

  public tv(tmdbId: number): Promise<unknown> {
    return this.#getJson('/api/v1/tv/:id', `/api/v1/tv/${tmdbIdentifier(tmdbId)}`);
  }

  public season(tmdbId: number, seasonNumber: number): Promise<unknown> {
    if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0) throw new TypeError('season number is invalid');
    return this.#getJson('/api/v1/tv/:id/season/:n', `/api/v1/tv/${tmdbIdentifier(tmdbId)}/season/${seasonNumber}`);
  }

  /**
   * Requests a title as this user, in HD. The body names only the title: never `userId` (which would let a manager
   * request for someone else) or a server, profile or folder override.
   */
  public createRequest(input: SeerrRequestInput): Promise<unknown> {
    const tmdbId = tmdbIdentifier(input.tmdbId);
    if (input.mediaType === 'movie') {
      return this.#sendJson('POST', '/api/v1/request', { mediaType: 'movie', mediaId: tmdbId, is4k: false });
    }
    if (input.mediaType !== 'tv') throw new TypeError('media type is invalid');
    const seasons = input.seasons;
    if (!Array.isArray(seasons) || !seasons.length || seasons.length > 100 ||
        !seasons.every((season) => Number.isSafeInteger(season) && season > 0)) {
      throw new TypeError('seasons are invalid');
    }
    return this.#sendJson('POST', '/api/v1/request', { mediaType: 'tv', mediaId: tmdbId, seasons: [...new Set(seasons)], is4k: false });
  }

  /** This user's own requests, newest first. The user ID in the path is always this client's. */
  public ownRequests(take = 20, skip = 0): Promise<unknown> {
    const count = Math.min(Math.max(Math.trunc(take), 1), 100);
    const offset = Math.max(Math.trunc(skip), 0);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(offset)) throw new TypeError('paging is invalid');
    return this.#getJson('/api/v1/user/:self/requests', `/api/v1/user/${this.#header()}/requests?take=${count}&skip=${offset}`);
  }

  public quota(): Promise<unknown> {
    return this.#getJson('/api/v1/user/:self/quota', `/api/v1/user/${this.#header()}/quota`);
  }

  /** This user's own Seerr watchlist. */
  public watchlist(page = 1): Promise<unknown> {
    return this.#getJson('/api/v1/discover/watchlist', `/api/v1/discover/watchlist?page=${pageNumber(page)}`);
  }

  /** The acting user as `X-API-User` sends it; throws rather than return anything Seerr would read as its owner. */
  #header(): string {
    if (!isSeerrUserId(this.#user)) throw new TypeError('Seerr user ID must be a positive integer');
    return String(this.#user);
  }

  #getJson(route: string, path: string): Promise<unknown> {
    return this.#sendJson('GET', route, undefined, path);
  }

  async #sendJson(method: 'GET' | 'POST', route: string, body?: unknown, path = route): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Api-Key': this.#apiKey,
      'X-API-User': this.#header(),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(15_000),
      // A redirect would carry the API key and acting user to wherever it points.
      redirect: 'error',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SeerrError(`Seerr ${method} ${route} returned ${response.status}`, response.status);
    }
    const text = await response.text();
    if (text.length > MAX_USER_RESPONSE_BYTES) throw new SeerrError(`Seerr ${method} ${route} response is too large`, 502);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // JSON.parse's own message quotes the body.
      throw new SeerrError(`Seerr ${method} ${route} returned invalid JSON`, 502);
    }
  }
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
