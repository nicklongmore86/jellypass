// My requests' fixed words and sizes, word for word as the PWA's requestItem() and REQUESTS_TEXT (app/src/render.ts)
// and requestsScreen() (app/src/main.ts) have them. __tests__/requests-text.test.ts fails if one drifts.
import type { Card, CoarseStatus, MediaType, Request } from '../api/types';
import type { ApiErrorKind } from '../api/errors';
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

/**
 * Cancelling a request, word for word as the PWA's CANCEL_TEXT (app/src/render.ts). The confirmation is one fixed
 * sentence whatever became of the cancel; each failure has its own fixed words.
 */
export const CANCEL_TEXT = {
  button: 'Cancel request',
  heading: 'Cancel this request?',
  body: "This withdraws your household's request. If it has already been approved, it may still be added to the server, but it won't be added for your household.",
  confirm: 'Cancel request',
  keep: 'Keep request',
  sending: 'Cancelling…',
  confirmation: 'Request cancelled',
  rate_limited: 'Too many tries, try again in a few minutes.',
  offline: "You're offline. Check your connection, then try again.",
  unavailable: "We couldn't cancel that just now. Try again in a moment.",
} as const;

export type CancelError = 'rate_limited' | 'offline' | 'unavailable';

/** The fixed message for a Cancel that was not accepted (`unauthorized` never gets here: it signs the member out). */
export function cancelError(kind: ApiErrorKind): CancelError {
  if (kind === 'too_many_requests') return 'rate_limited';
  if (kind === 'network') return 'offline';
  return 'unavailable';
}

/** The accessible name of an entry's Cancel button: it names its request. */
export function cancelName(title: RequestTitle | undefined): string {
  return title?.status === 'loaded' && title.title.title ? `${CANCEL_TEXT.button}: ${title.title.title}` : CANCEL_TEXT.button;
}

/** The day a request was made as the member's locale writes it, no time (the API sends a UTC day, read and written as one); undefined if there is none. */
export function requestedOnText(day: string | null | undefined): string | undefined {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return undefined;
  let text: string;
  try {
    text = date.toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
  } catch {
    text = day;
  }
  return `Requested on ${text}`;
}

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
 * season and none for the entry. When the seasons share a status, that status is the pill, even if the request's own
 * overall status differs.
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
    requestedOnText(request.requestedOn) ?? '',
    ...(pills.perSeason
      ? request.seasons.map((season) => [`${requestSeasonName(season.seasonNumber)}: ${statusText(season.status)}`, season.status === 'failed' ? note : ''].filter(Boolean).join(', '))
      : []),
    requestNoteHere(request) ? note : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** My requests' filters, the PWA's (app/src/render.ts): status, kind and "Asked by me". They only choose which entries show. */
export type RequestStatusFilter = 'all' | CoarseStatus;
export type RequestKindFilter = 'all' | 'movie' | 'tv';
export interface RequestFilter {
  status: RequestStatusFilter;
  kind: RequestKindFilter;
  byYou: boolean;
}
export const REQUEST_STATUS_FILTERS: readonly RequestStatusFilter[] = ['all', 'requested', 'ready', 'failed'];
export const REQUEST_KIND_FILTERS: readonly RequestKindFilter[] = ['all', 'movie', 'tv'];
export const NO_REQUEST_FILTER: Readonly<RequestFilter> = { status: 'all', kind: 'all', byYou: false };

export const REQUEST_FILTER_TEXT = {
  statusLabel: 'Status',
  kindLabel: 'Type',
  whoLabel: 'Who',
  status: { all: 'All', requested: 'Requested', ready: 'Ready to watch', failed: "Couldn't get this" },
  kind: { all: 'All', movie: 'Films', tv: 'Series' },
  byYou: 'Asked by me',
  showAll: 'Show all requests',
  more: 'More may match — Load more to look further.',
} as const;

export function requestFilterActive(filter: RequestFilter): boolean {
  return filter.status !== 'all' || filter.kind !== 'all' || filter.byYou;
}

/**
 * The statuses an entry shows (see {@link requestPills}): its one chip, or each season's chip when the seasons differ,
 * plus the entry's own "failed" when the admin note is under the entry rather than under a season. A series matches a
 * status filter if any status it shows is that status, so a series with Season 1 ready and Season 2 requested is in
 * both Ready to watch and Requested.
 */
export function requestStatuses(request: Pick<Request, 'status' | 'seasons'>): CoarseStatus[] {
  const pills = requestPills(request);
  if (pills.status) return [pills.status];
  const seen = new Set<CoarseStatus>(request.seasons.map((season) => season.status));
  if (request.status === 'failed') seen.add('failed');
  return [...seen];
}

/** Whether an entry passes every part of the filter; nothing but the entry is read (no calls). */
export function matchesRequestFilter(request: Pick<Request, 'status' | 'seasons' | 'mediaType' | 'byYou'>, filter: RequestFilter): boolean {
  if (filter.kind !== 'all' && request.mediaType !== filter.kind) return false;
  if (filter.byYou && !request.byYou) return false;
  return filter.status === 'all' || requestStatuses(request).includes(filter.status);
}

/** What My requests says when a filter leaves nothing, for that combination; `more` when unnamed requests are still to load. */
export function requestFilterEmptyText(filter: RequestFilter, more = false): string {
  const noun = filter.kind === 'movie' ? 'films' : filter.kind === 'tv' ? 'series' : 'requests';
  const status = filter.status === 'requested' ? ' still requested' : filter.status === 'ready' ? ' ready to watch' : filter.status === 'failed' ? " we couldn't get" : '';
  const who = filter.byYou ? `${status ? ',' : ''} asked for by you` : '';
  return [`No ${noun}${status}${who}.`, more ? REQUEST_FILTER_TEXT.more : ''].filter(Boolean).join(' ');
}
