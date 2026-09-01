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
    media?: { mediaType?: string; tmdbId?: number; status?: number; jellyfinMediaId?: string; jellyfinMediaId4k?: string };
    requestedBy?: { displayName?: string; username?: string };
  }>;
}

interface SeerrMediaDetails {
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  posterPath?: string;
}

export interface ImportedSeerrUser {
  id?: number;
  username?: string;
  jellyfinUsername?: string;
  jellyfinUserId?: string;
}

export class SeerrClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  #recentCache: { expiresAt: number; items: RecentSeerrRequest[] } | undefined;

  public constructor(baseUrl: string, apiKey: string) {
    this.#baseUrl = baseUrl;
    this.#apiKey = apiKey;
  }

  public async getRequest(requestId: string): Promise<SeerrRequest> {
    return this.#getJson<SeerrRequest>(`/api/v1/request/${encodeURIComponent(requestId)}`);
  }

  public async importJellyfinUser(jellyfinUserId: string): Promise<{ status: 'imported' | 'already_imported'; user?: ImportedSeerrUser }> {
    const users = await this.#postJson<ImportedSeerrUser[]>('/api/v1/user/import-from-jellyfin', {
      jellyfinUserIds: [jellyfinUserId],
    });
    const user = users.find((entry) => entry.jellyfinUserId?.toLowerCase() === jellyfinUserId.toLowerCase()) ?? users[0];
    return user ? { status: 'imported', user } : { status: 'already_imported' };
  }

  public async getRecentRequests(take = 8, jellyfinItemIds?: ReadonlySet<string>): Promise<RecentSeerrRequest[]> {
    const count = Math.min(Math.max(Math.trunc(take), 1), 20);
    if (this.#recentCache && this.#recentCache.expiresAt > Date.now()) {
      return this.#recentCache.items.slice(0, count);
    }
    const requests: NonNullable<SeerrRequestList['results']> = [];
    const pageSize = 50;
    let skip = 0;
    let total = Number.POSITIVE_INFINITY;
    while (requests.length < count && skip < total) {
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
    requests.splice(count);
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
    this.#recentCache = { expiresAt: Date.now() + 60_000, items };
    return items;
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
      throw new Error(`Seerr GET ${path} returned ${response.status}${detail ? `: ${detail}` : ''}`);
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
