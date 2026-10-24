import type { DiscoverList, Me, Movie, Page, Season, Series } from './types.js';

export const API_PREFIX = '/jellypass/app/v1';

/** The only failures the app tells apart, each with a fixed message (see render.ts); upstream text is never shown. */
export type ApiErrorKind = 'unauthorized' | 'rate_limited' | 'not_found' | 'unavailable' | 'offline';

export class ApiError extends Error {
  public constructor(public readonly kind: ApiErrorKind) {
    super(kind);
  }
}

export interface ApiOptions {
  fetch: typeof fetch;
  /** The Jellyfin access token, read for each call. */
  token: () => string | undefined;
}

export interface Api {
  me(signal?: AbortSignal): Promise<Me>;
  search(query: string, page: number, signal?: AbortSignal): Promise<Page>;
  discover(list: DiscoverList, signal?: AbortSignal): Promise<Page>;
  movie(tmdbId: number, signal?: AbortSignal): Promise<Movie>;
  tv(tmdbId: number, signal?: AbortSignal): Promise<Series>;
  season(tmdbId: number, seasonNumber: number, signal?: AbortSignal): Promise<Season>;
}

function kindOf(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  return 'unavailable';
}

export function createApi(options: ApiOptions): Api {
  async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const token = options.token();
    if (!token) throw new ApiError('unauthorized');
    let response: Response;
    try {
      response = await options.fetch(`${API_PREFIX}${path}`, {
        headers: { Accept: 'application/json', Authorization: `MediaBrowser Token="${encodeURIComponent(token).replace(/"/g, '%22')}"` },
        // The API is no-store; the app asks for the same, sends no cookies and keeps nothing.
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError('offline');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiError(kindOf(response.status));
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError('unavailable');
    }
  }

  return {
    me: (signal) => get<Me>('/me', signal),
    search: (query, page, signal) => get<Page>(`/search?q=${encodeURIComponent(query)}&page=${page}`, signal),
    discover: (list, signal) => get<Page>(`/discover/${list}`, signal),
    movie: (tmdbId, signal) => get<Movie>(`/movie/${tmdbId}`, signal),
    tv: (tmdbId, signal) => get<Series>(`/tv/${tmdbId}`, signal),
    season: (tmdbId, seasonNumber, signal) => get<Season>(`/tv/${tmdbId}/season/${seasonNumber}`, signal),
  };
}
