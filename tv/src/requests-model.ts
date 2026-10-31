import type { CoarseStatus, MediaType, RequestEntry } from './api.js';

/**
 * What My requests shows and how it chooses, as the household app's (app/src/render.ts: the request pills of #87, the
 * filters of #104, the day of #110), with the same words. Nothing here reads anything but the entry it is given: no call,
 * no storage. The words are fixed; only a title's name and the numbers are the household's own.
 */

/** The page's route on the page host, and the address a link opens it at. */
export const REQUESTS_PATH = '/jellypass/requests';
export const REQUESTS_HASH = '#/jellypass/requests';

/** The coarse status of a request, worded as the app words it. */
export const REQUEST_LABELS: Record<CoarseStatus, string> = {
  requested: 'Requested',
  ready: 'Ready to watch',
  failed: "We couldn't get this",
};

export const REQUESTS_TEXT = {
  title: 'My requests',
  empty: 'Nothing requested yet. Choose Get this on a title to ask for it.',
  loading: 'Loading title…',
  loadingList: 'Loading requests…',
  titleMissing: 'Title unavailable',
  byYou: 'Asked for by you',
  byOther: 'Asked for by someone in your household',
  requestedOn: (day: string) => `Requested on ${day}`,
  failedNote: 'Ask your JellyPass admin to try again.',
  loadMore: 'Load more',
  loadingMore: 'Loading…',
  seasons: 'Seasons',
  tryAgain: 'Try again',
  refreshFailed: 'Something went wrong. Try again in a moment.',
  link: 'My requests',
} as const;

/**
 * Cancelling a request: one fixed confirmation sentence, shown whatever became of the cancel (the server settles that in
 * the background), and fixed words for each failure; nothing from a response is ever shown.
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

/** A series request's seasons as text, in order, a run of three or more as a range: "Season 1", "Seasons 1, 3", "Seasons 1–3, 5". */
export function requestSeasonsText(numbers: ReadonlyArray<number>): string {
  const sorted = numbers.filter((number, index) => numbers.indexOf(number) === index).sort((left, right) => left - right);
  if (sorted.length === 0) return '';
  if (sorted.length === 1) return `Season ${sorted[0]}`;
  const parts: string[] = [];
  for (let start = 0; start < sorted.length;) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] as number) + 1) end += 1;
    if (end - start >= 2) parts.push(`${sorted[start]}–${sorted[end]}`);
    else for (let i = start; i <= end; i += 1) parts.push(String(sorted[i]));
    start = end + 1;
  }
  return `Seasons ${parts.join(', ')}`;
}

type Statused = Pick<RequestEntry, 'status' | 'seasons'>;

/**
 * Where a request shows its status, so it is shown once: one pill for the entry (a movie, a series of one season, or
 * seasons that all share one status, listed as text on the details line), or else one pill per season and none for the
 * entry. When the seasons share a status, that status is the pill, even if the request's own overall status differs.
 */
export function requestPills(entry: Statused): { status: CoarseStatus | undefined; seasonsText: string; perSeason: boolean } {
  if (entry.seasons.length === 0) return { status: entry.status, seasonsText: '', perSeason: false };
  const first = (entry.seasons[0] as { status: CoarseStatus }).status;
  if (entry.seasons.every((season) => season.status === first)) {
    return { status: first, seasonsText: requestSeasonsText(entry.seasons.map((season) => season.seasonNumber)), perSeason: false };
  }
  return { status: undefined, seasonsText: '', perSeason: true };
}

/** My requests' filters: status, kind and "Asked by me". They only choose which of the loaded entries are shown. */
export type RequestStatusFilter = 'all' | CoarseStatus;
export type RequestKindFilter = 'all' | MediaType;
export interface RequestFilter {
  status: RequestStatusFilter;
  kind: RequestKindFilter;
  byYou: boolean;
}
export const REQUEST_STATUS_FILTERS: ReadonlyArray<RequestStatusFilter> = ['all', 'requested', 'ready', 'failed'];
export const REQUEST_KIND_FILTERS: ReadonlyArray<RequestKindFilter> = ['all', 'movie', 'tv'];
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
 * The statuses an entry shows (see {@link requestPills}): its one pill, or each season's pill when the seasons differ,
 * plus the entry's own "failed" when the note is under the entry rather than under a season. A series matches a status
 * filter if any status it shows is that status.
 */
export function requestStatuses(entry: Statused): CoarseStatus[] {
  const pills = requestPills(entry);
  if (pills.status) return [pills.status];
  const seen: CoarseStatus[] = [];
  for (const season of entry.seasons) if (seen.indexOf(season.status) < 0) seen.push(season.status);
  if (entry.status === 'failed' && seen.indexOf('failed') < 0) seen.push('failed');
  return seen;
}

/** Whether an entry passes every part of the filter; no part reads anything but the entry (no calls). */
export function matchesRequestFilter(entry: Pick<RequestEntry, 'status' | 'seasons' | 'mediaType' | 'byYou'>, filter: RequestFilter): boolean {
  if (filter.kind !== 'all' && entry.mediaType !== filter.kind) return false;
  if (filter.byYou && !entry.byYou) return false;
  return filter.status === 'all' || requestStatuses(entry).indexOf(filter.status) >= 0;
}

/** What My requests says when a filter leaves nothing, for that combination; `more` when unloaded requests are still to come. */
export function requestFilterEmptyText(filter: RequestFilter, more = false): string {
  const noun = filter.kind === 'movie' ? 'films' : filter.kind === 'tv' ? 'series' : 'requests';
  const status = filter.status === 'requested' ? ' still requested' : filter.status === 'ready' ? ' ready to watch' : filter.status === 'failed' ? " we couldn't get" : '';
  const who = filter.byYou ? `${status ? ',' : ''} asked for by you` : '';
  return [`No ${noun}${status}${who}.`, more ? REQUEST_FILTER_TEXT.more : ''].filter(Boolean).join(' ');
}

/** A request's day as the member's locale writes it, no time: the API sends a UTC day, so it is read and written as one. */
export function requestedOnText(day: string | undefined): string | undefined {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const date = new Date(`${day}T00:00:00Z`);
  if (isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return undefined;
  // Explicit fields rather than `dateStyle`, which Chromium 63 does not know (it would write a numeric date).
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
