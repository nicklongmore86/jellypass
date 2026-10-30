import type { Failure } from './api.js';

/**
 * What hiding a title ("Not interested") says on the TV, with the household app's words (app/src/render.ts, HIDE_TEXT).
 * Everything is fixed; only a title's name and the numbers are the household's own, and nothing from a response is shown.
 */

/** The Hidden view of My requests: its route on the page host, and the address a button opens it at. */
export const HIDDEN_PATH = '/jellypass/requests/hidden';
export const HIDDEN_HASH = '#/jellypass/requests/hidden';

export const HIDDEN_TEXT = {
  hide: 'Not interested',
  unhide: 'Unhide',
  sending: 'Sending…',
  note: 'Only for you in this household. This does not cancel requests or remove downloads.',
  tag: 'Hidden from Discover',
  hidden: 'Hidden from Discover. Choose Unhide to undo.',
  unhidden: 'Unhidden.',
  limit: "You've hidden as many titles as you can (2,000). Unhide some to hide more.",
  rate_limited: 'Too many tries, try again in a few minutes.',
  offline: "You're offline. Check your connection, then try again.",
  unavailable: "We couldn't change that just now. Try again in a moment.",
  /** My requests' two views. */
  viewsLabel: 'My requests views',
  requestsView: 'Requests',
  hiddenView: 'Hidden',
  empty: 'Nothing hidden. Titles you mark Not interested are listed here, so you can bring them back.',
  hiddenOn: (day: string) => `Hidden on ${day}`,
  hideLabel: (title: string) => `Not interested: ${title}`,
  unhideLabel: (title: string) => `Unhide ${title}`,
} as const;

/** The words for a hide or unhide that failed: the limit (`409`), a rate limit, no network, or anything else. */
export function hiddenFailureText(failure: Failure): string {
  if (failure.status === 409) return HIDDEN_TEXT.limit;
  if (failure.status === 429) return HIDDEN_TEXT.rate_limited;
  if (failure.status === 0) return HIDDEN_TEXT.offline;
  return HIDDEN_TEXT.unavailable;
}

/** The day a title was hidden, as the member's locale writes it (explicit fields: Chromium 63 has no `dateStyle`); nothing for a time it can't read. */
export function hiddenOnText(at: string | undefined): string | undefined {
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(at)) return undefined;
  const date = new Date(at);
  if (isNaN(date.getTime())) return undefined;
  return HIDDEN_TEXT.hiddenOn(date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }));
}
