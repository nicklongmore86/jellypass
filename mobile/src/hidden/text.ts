// "Not interested"'s fixed words: the title page's button, the long-press sheet, the toast with Undo, the Hidden tab of
// My requests, and each failure's one fixed message (nothing from a response is ever shown). The household web app and
// the TV add-on have no hiding yet, so these are the app's own; they follow docs/app-design.md's labels.
import type { ApiErrorKind } from '../api/errors';
import { kindText } from '../requests/text';
import type { HideTarget } from './store';

/** The first `/me` apiVersion with hiding: below it nothing of this is shown. */
export const HIDE_API_VERSION = 3;

export const HIDE_TEXT = {
  hide: 'Not interested',
  unhide: 'Unhide',
  hiding: 'Hiding…',
  unhiding: 'Unhiding…',
  /** On a card the server or the member hid (Search only: discovery lists leave them out). */
  badge: 'Hidden',
  state: 'Hidden from Discover',
  note: 'Only for you in this household. It does not cancel requests or take anything out of your library.',
  close: 'Close',
  undo: 'Undo',
  dismiss: 'Dismiss',
  undoing: 'Undoing…',
  /** My requests' two views. */
  viewsLabel: 'Show',
  views: { requests: 'Requests', hidden: 'Hidden' },
  empty: "You haven't hidden any titles. Choose Not interested on a title, or press and hold its poster, to keep it out of Discover.",
  limit: "You've hidden 2,000 titles, the most there can be. Unhide some to hide more.",
  rate_limited: 'Too many tries, try again in a few minutes.',
  offline: "You're offline. Check your connection, then try again.",
  unavailable: "We couldn't change that just now. Try again in a moment.",
} as const;

export type HideView = keyof typeof HIDE_TEXT.views;
export const HIDE_VIEWS: readonly HideView[] = ['requests', 'hidden'];

export type HideError = 'limit' | 'rate_limited' | 'offline' | 'unavailable';

/** The fixed message for a hide or unhide that was not accepted (`unauthorized` never gets here: it signs out). */
export function hideError(kind: ApiErrorKind): HideError {
  if (kind === 'hidden_limit_reached') return 'limit';
  if (kind === 'too_many_requests') return 'rate_limited';
  if (kind === 'network') return 'offline';
  return 'unavailable';
}

/** A title named so it cannot be mistaken for another of the same name: "Dune (Movie, 2021)". */
export function hideSubject(target: Pick<HideTarget, 'title' | 'year' | 'mediaType'>): string {
  const facts = [kindText(target.mediaType), target.year ? String(target.year) : ''].filter(Boolean).join(', ');
  return target.title ? `${target.title} (${facts})` : facts;
}

export const hideName = (target: Pick<HideTarget, 'title' | 'year' | 'mediaType'>) => `Hide ${hideSubject(target)} from Discover`;
export const unhideName = (target: Pick<HideTarget, 'title' | 'year' | 'mediaType'>) => `Unhide ${hideSubject(target)}`;
export const undoName = (target: Pick<HideTarget, 'title' | 'year' | 'mediaType'>) => `Undo hiding ${hideSubject(target)}`;
/** Said (and shown in the toast) once a hide is accepted. */
export const hiddenText = (target: Pick<HideTarget, 'title'>) => `Hidden ${target.title || 'this title'} from Discover`;
/** Said once an unhide (or Undo) is accepted. */
export const backText = (target: Pick<HideTarget, 'title'>) => `${target.title || 'This title'} is back in Discover`;

/** "Hidden on 30 Oct 2026", in the device's date format, no time; undefined if the time cannot be read. */
export function hiddenOnText(at: string): string | undefined {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return undefined;
  let text: string;
  try {
    text = date.toLocaleDateString(undefined, { dateStyle: 'medium' });
  } catch {
    text = at.slice(0, 10);
  }
  return `Hidden on ${text}`;
}

/** How long the toast stays before it goes by itself; with a screen reader on it stays until dismissed. */
export const TOAST_MS = 8000;
