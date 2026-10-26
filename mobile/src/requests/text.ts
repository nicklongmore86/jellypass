// My requests' fixed words and sizes, word for word as the PWA's requestItem() and REQUESTS_TEXT (app/src/render.ts)
// and requestsScreen() (app/src/main.ts) have them. __tests__/requests-text.test.ts fails if one drifts.
import type { Card, MediaType, Request } from '../api/types';
import { REQUEST_LABELS } from '../home/text';
import { GET_THIS_TEXT } from '../title/text';

export const REQUESTS_TEXT = {
  title: 'My requests',
  empty: 'Nothing requested yet. Press Get this on a title to ask for it.',
  loading: 'Loading title…',
  titleMissing: 'Title unavailable',
  byYou: 'Asked for by you',
  byOther: 'Asked for by someone in your household',
  seasons: 'Seasons',
} as const;

/** The requests shown at first and added by each Load more, each named with one title call, a few calls at a time. */
export const REQUESTS_PER_PAGE = 10;
export const REQUEST_TITLE_CALLS = 4;

/** What a request's entry knows of its title: still asking, the title's own answer, or nothing (it could not be read). */
export type RequestTitle = { status: 'loading' } | { status: 'loaded'; title: Pick<Card, 'title' | 'year' | 'posterUrl'> } | { status: 'missing' };

export function kindText(mediaType: MediaType): string {
  return mediaType === 'tv' ? 'Series' : 'Movie';
}

export function requestTitleText(title: RequestTitle | undefined): string {
  if (title?.status === 'loaded') return title.title.title || REQUESTS_TEXT.titleMissing;
  return title?.status === 'missing' ? REQUESTS_TEXT.titleMissing : REQUESTS_TEXT.loading;
}

/** "2024 · Movie" once the title is read; "Movie" until then, or if it cannot be. */
export function requestMeta(mediaType: MediaType, title: RequestTitle | undefined): string {
  const year = title?.status === 'loaded' && title.title.year ? String(title.title.year) : '';
  return [year, kindText(mediaType)].filter(Boolean).join(' · ');
}

export function whoText(request: Pick<Request, 'byYou'>): string {
  return request.byYou ? REQUESTS_TEXT.byYou : REQUESTS_TEXT.byOther;
}

export function requestSeasonName(seasonNumber: number): string {
  return `Season ${seasonNumber}`;
}

/** Whether any part of a request did not work out: it shows the admin note, and nothing to press. */
export function requestFailed(request: Pick<Request, 'status' | 'seasons'>): boolean {
  return request.status === 'failed' || request.seasons.some((season) => season.status === 'failed');
}

/**
 * An entry's accessible name, everything it shows said once: "Film 7, 2024 · Movie, Requested, Asked for by you", then
 * each season and its status, then the admin note where something failed.
 */
export function requestName(request: Request, title: RequestTitle | undefined): string {
  return [
    requestTitleText(title),
    requestMeta(request.mediaType, title),
    REQUEST_LABELS[request.status] ?? REQUEST_LABELS.requested,
    whoText(request),
    ...request.seasons.map((season) => `${requestSeasonName(season.seasonNumber)}: ${REQUEST_LABELS[season.status] ?? REQUEST_LABELS.requested}`),
    requestFailed(request) ? GET_THIS_TEXT.failedNote : '',
  ]
    .filter(Boolean)
    .join(', ');
}
