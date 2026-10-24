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

export class SeerrClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  #recentCache: { expiresAt: number; catalogKey: string; items: RecentSeerrRequest[] } | undefined;

  public constructor(baseUrl: string, apiKey: string) {
    this.#baseUrl = baseUrl;
    this.#apiKey = apiKey;
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
