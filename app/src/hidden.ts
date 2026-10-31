import type { Card, HiddenEntry, MediaType, Page } from './types.js';

/** At most this many of the member's own changes are remembered; the oldest go first (the server allows 2,000 hides). */
export const HIDDEN_OVERLAY_SIZE = 500;

/**
 * What this member hid or unhid in this page's life, in memory only: never stored, never sent. The server leaves a
 * member's hidden titles out of every discovery list itself, so this exists only for a list read that began before the
 * server had recorded a change (it could still list a title just hidden, or leave out one just unhidden) and for a card
 * whose `hidden` flag was read just before. A key (`movie:<id>`, `tv:<id>`) is added only after the API accepted the
 * change. A read that began after it is the server's own word; an older read, even one that answers after that, is
 * corrected by it.
 */
export interface HiddenOverlay {
  /** Marks the start of a read: pass the result to the functions below for what that read answered. */
  begin(): number;
  /** The member's accepted hide (`true`) or unhide (`false`). */
  set(mediaType: MediaType, tmdbId: number, hidden: boolean): void;
  forget(): void;
  /** A discovery list: the titles hidden since the read began are left out. */
  list(page: Page, began: number): Page;
  /** Search results, a title page: the `hidden` flag as it is now, with the server's when nothing newer is known. */
  flagged<T extends Card>(card: T, began: number): T;
  flaggedPage(page: Page, began: number): Page;
}

export function createHiddenOverlay(): HiddenOverlay {
  let tick = 0;
  let changes = new Map<string, { hidden: boolean; at: number }>();
  const key = (mediaType: MediaType, tmdbId: number) => `${mediaType}:${tmdbId}`;
  /**
   * The change still newer than the read, or nothing: the server has said its word. The change is kept all the same, for
   * a read that began before it and answers later; a flag the newer read carries is what such a read is corrected to.
   */
  const newer = (card: Pick<Card, 'mediaType' | 'tmdbId' | 'hidden'>, began: number): boolean | undefined => {
    const change = changes.get(key(card.mediaType, card.tmdbId));
    if (!change) return undefined;
    if (change.at > began) return change.hidden;
    if (typeof card.hidden === 'boolean') change.hidden = card.hidden;
    return undefined;
  };
  const overlay: HiddenOverlay = {
    begin: () => tick,
    set(mediaType, tmdbId, hidden) {
      const at = key(mediaType, tmdbId);
      changes.delete(at);
      changes.set(at, { hidden, at: ++tick });
      while (changes.size > HIDDEN_OVERLAY_SIZE) changes.delete(changes.keys().next().value as string);
    },
    forget: () => { changes = new Map(); },
    list: (page, began) => ({ ...page, results: page.results.filter((card) => newer(card, began) !== true) }),
    flagged(card, began) {
      const hidden = newer(card, began);
      return hidden === undefined ? { ...card, hidden: card.hidden === true } : { ...card, hidden };
    },
    flaggedPage: (page, began) => ({ ...page, results: page.results.map((card) => overlay.flagged(card, began)) }),
  };
  return overlay;
}

/** The IDs in one page of GET /hidden, as the server sends them (src/app-api.ts). */
export const HIDDEN_PAGE_SIZE = 50;

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
 * Which page of the member's hidden titles the Hidden view reads next, and what is new on each page read. The list is
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
