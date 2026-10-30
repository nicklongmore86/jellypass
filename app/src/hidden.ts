import type { Card, MediaType, Page } from './types.js';

/** At most this many of the member's own changes are remembered; the oldest go first (the server allows 2,000 hides). */
export const HIDDEN_OVERLAY_SIZE = 500;

/**
 * What this member hid or unhid in this page's life, in memory only: never stored, never sent. The server leaves a
 * member's hidden titles out of every discovery list itself, so this exists only for a list read that began before the
 * server had recorded a change (it could still list a title just hidden, or leave out one just unhidden) and for a card
 * whose `hidden` flag was read just before. A key (`movie:<id>`, `tv:<id>`) is added only after the API accepted the
 * change. A read that began after it is the server's own word and ends the key; an older read is corrected by it.
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
  /** The change still newer than the read, or nothing (and the older change is dropped: the server has said its word). */
  const newer = (card: Pick<Card, 'mediaType' | 'tmdbId'>, began: number): boolean | undefined => {
    const at = key(card.mediaType, card.tmdbId);
    const change = changes.get(at);
    if (!change) return undefined;
    if (change.at > began) return change.hidden;
    changes.delete(at);
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
