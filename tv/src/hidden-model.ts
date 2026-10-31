import { MAX_HIDDEN_ENTRIES, type Failure, type HiddenEntry } from './api.js';

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
  note: 'Only for you in this household. It does not cancel requests or take anything out of your library.',
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

/** The IDs in one page of GET /hidden, as the server sends them (src/app-api.ts). */
export const HIDDEN_PAGE_SIZE = MAX_HIDDEN_ENTRIES;

/** A read of one page of the Hidden list, from {@link HiddenPager.begin}. */
export interface HiddenRead {
  readonly page: number;
}

/** An unhide sent from the Hidden view, from {@link HiddenPager.unhiding}. */
export interface HiddenUnhide {
  /** The answer: accepted (the server no longer has the title hidden) or not. */
  done(accepted: boolean): void;
}

/**
 * Which page of the member's hidden titles the Hidden view reads next (the household app's, app/src/hidden.ts), and what is new on each page read. The list is
 * paged by place, newest first, 50 a page, so every unhide the server accepts moves each later title up one place (onto
 * an earlier page) and a hide moves them down one. `end` is a place before which every hidden title is already listed;
 * the next page read is the one `end` is on, so a title is never skipped, and a page read again adds only what it had not
 * listed, so none is listed twice (the order of the few a race moves may differ from the server's).
 * - An unhide accepted while no page is out moves `end` back one place.
 * - A page read while unhides were out may have been read before or after each of them: the titles up to as many places
 *   before the page may have moved up past it unread, so `end` goes back that far and that page is read next.
 * - A hide only moves titles later: a page may then be read again, never skipped. (A title hidden after the view was
 *   read is not this view's: it is in the next one.)
 */
export class HiddenPager {
  /** The titles listed and still hidden, in the order read. */
  public readonly entries: HiddenEntry[] = [];
  /** Every title ever listed here, unhidden ones too: a page read again lists none twice. */
  readonly #seen = new Set<string>();
  #end = 0;
  #more = true;
  /** The unhides out now, and each read out now with how many unhides were out while it was. */
  readonly #unhides = new Set<{ counted: boolean }>();
  readonly #reads = new Map<HiddenRead, { start: number; end: number; unhides: Set<{ counted: boolean }> }>();

  /** The page to read next, or null when every hidden title is listed. */
  public next(): number | null {
    return this.#more ? Math.floor(this.#end / HIDDEN_PAGE_SIZE) + 1 : null;
  }

  /** A read of the next page starts (call {@link answered} with its answer, or {@link dropped} when it failed). */
  public begin(): HiddenRead {
    const page = this.next() ?? 1;
    const read: HiddenRead = { page };
    this.#reads.set(read, { start: (page - 1) * HIDDEN_PAGE_SIZE, end: this.#end, unhides: new Set(this.#unhides) });
    return read;
  }

  public dropped(read: HiddenRead): void {
    this.#reads.delete(read);
  }

  /** The read's answer: lists what it had not, and returns how many titles that is. */
  public answered(read: HiddenRead, results: readonly HiddenEntry[], nextPage: number | null): number {
    const out = this.#reads.get(read);
    if (!out) return 0;
    this.#reads.delete(read);
    let added = 0;
    for (const entry of results) {
      const key = `${entry.mediaType}:${entry.tmdbId}`;
      if (this.#seen.has(key)) continue;
      this.#seen.add(key);
      this.entries.push(entry);
      added += 1;
    }
    const after = out.start + results.length;
    const raced = out.unhides.size;
    for (const unhide of out.unhides) unhide.counted = true;
    this.#end = raced === 0 ? after : Math.max(0, Math.min(out.end, after) - raced);
    // Even at the list's end, a title may have moved up into what this page held: it is read again.
    this.#more = nextPage !== null || this.#end < after;
    return added;
  }

  /** An unhide of a title listed here is sent (the view takes it out of {@link entries} itself, once it leaves). */
  public unhiding(): HiddenUnhide {
    const unhide = { counted: false };
    this.#unhides.add(unhide);
    for (const out of this.#reads.values()) out.unhides.add(unhide);
    return {
      done: (accepted) => {
        if (!this.#unhides.delete(unhide)) return;
        if (!accepted) return;
        // A read out now (or answered while this was out) has counted it already.
        if (unhide.counted || [...this.#reads.values()].some((out) => out.unhides.has(unhide))) return;
        this.#end = Math.max(0, this.#end - 1);
      },
    };
  }
}
