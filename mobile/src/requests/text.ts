// My requests' fixed words and sizes, word for word as the PWA's requestItem() and REQUESTS_TEXT (app/src/render.ts)
// and requestsScreen() (app/src/main.ts) have them. __tests__/requests-text.test.ts fails if one drifts.
import type { Card, CoarseStatus, MediaType, Request } from '../api/types';
import { REQUEST_LABELS } from '../home/text';
import { GET_THIS_TEXT } from '../title/text';

export const REQUESTS_TEXT = {
  title: 'My requests',
  empty: 'Nothing requested yet. Press Get this on a title to ask for it.',
  loading: 'Loading title…',
  titleMissing: 'Title unavailable',
  byYou: 'Asked for by you',
  byOther: 'Asked for by someone in your household',
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

/**
 * "2024 · Movie" once the title is read; "Movie" until then, or if it cannot be. A series whose seasons share one status
 * says them here too: "2027 · Series · Season 1", "Series · Seasons 1–3".
 */
export function requestMeta(mediaType: MediaType, title: RequestTitle | undefined, seasonsText = ''): string {
  const year = title?.status === 'loaded' && title.title.year ? String(title.title.year) : '';
  return [year, kindText(mediaType), seasonsText].filter(Boolean).join(' · ');
}

export function whoText(request: Pick<Request, 'byYou'>): string {
  return request.byYou ? REQUESTS_TEXT.byYou : REQUESTS_TEXT.byOther;
}

export function requestSeasonName(seasonNumber: number): string {
  return `Season ${seasonNumber}`;
}

/**
 * A series request's seasons as text, in order, a run of three or more as a range: "Season 1", "Seasons 1, 3",
 * "Seasons 1–3, 5".
 */
export function requestSeasonsText(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((left, right) => left - right);
  if (sorted.length === 1) return `Season ${sorted[0]}`;
  const parts: string[] = [];
  for (let start = 0; start < sorted.length; ) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] as number) + 1) end += 1;
    if (end - start >= 2) parts.push(`${sorted[start]}–${sorted[end]}`);
    else parts.push(...sorted.slice(start, end + 1).map(String));
    start = end + 1;
  }
  return `Seasons ${parts.join(', ')}`;
}

/**
 * Where a request shows its status, so it is shown once (the PWA's requestPills()): one pill for the entry (a movie, a
 * series of one season, or seasons that all share one status, listed as text on the meta line), or else one pill per
 * season and none for the entry.
 */
export function requestPills(request: Pick<Request, 'status' | 'seasons'>): { status: CoarseStatus | undefined; seasonsText: string; perSeason: boolean } {
  const shared = new Set(request.seasons.map((season) => season.status));
  if (request.seasons.length === 0) return { status: request.status, seasonsText: '', perSeason: false };
  if (shared.size === 1) return { status: request.seasons[0]?.status, seasonsText: requestSeasonsText(request.seasons.map((season) => season.seasonNumber)), perSeason: false };
  return { status: undefined, seasonsText: '', perSeason: true };
}

/**
 * Whether the admin note goes under the entry's own pill: it failed, or (seasons differing) the entry failed with no
 * failed season to put it under. Otherwise it goes under each failed season.
 */
export function requestNoteHere(request: Pick<Request, 'status' | 'seasons'>): boolean {
  const { status } = requestPills(request);
  return status ? status === 'failed' : request.status === 'failed' && !request.seasons.some((season) => season.status === 'failed');
}

function statusText(status: CoarseStatus): string {
  return REQUEST_LABELS[status] ?? REQUEST_LABELS.requested;
}

/** Whether any part of a request did not work out: it shows the admin note, and nothing to press. */
export function requestFailed(request: Pick<Request, 'status' | 'seasons'>): boolean {
  return request.status === 'failed' || request.seasons.some((season) => season.status === 'failed');
}

/**
 * An entry's accessible name, everything it shows said once, each status once: "Film 7, 2024 · Movie, Requested,
 * Asked for by you" (a series of one season, or of seasons sharing one status, says them on the meta line: "Show, 2027
 * · Series · Season 1, Requested, …"); seasons that differ are said each with its status, and the admin note after
 * what failed.
 */
export function requestName(request: Request, title: RequestTitle | undefined): string {
  const pills = requestPills(request);
  const note = GET_THIS_TEXT.failedNote;
  return [
    requestTitleText(title),
    requestMeta(request.mediaType, title, pills.seasonsText),
    pills.status ? statusText(pills.status) : '',
    whoText(request),
    ...(pills.perSeason
      ? request.seasons.map((season) => [`${requestSeasonName(season.seasonNumber)}: ${statusText(season.status)}`, season.status === 'failed' ? note : ''].filter(Boolean).join(', '))
      : []),
    requestNoteHere(request) ? note : '',
  ]
    .filter(Boolean)
    .join(', ');
}
