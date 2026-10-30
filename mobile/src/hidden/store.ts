// "Not interested": what the member hid and unhid in this session, the long-press sheet and the toast after a hide. The
// server leaves a member's hidden titles out of every discovery list itself (apiVersion 3), so a list read after a hide
// already lacks the title; this covers the lists already on screen, with no call.
//
// - In memory only: never written to the device, never sent. One store per signed-in session (SessionProvider), shared
//   by every tab's stack, so Home's rows and hero, See all, the service and studio pages, Search and the title pages all
//   read it at once. A sign-out, a 401 and any change of household, member or token start it empty (sheet and toast too).
// - A title is marked only once the server has accepted the hide or unhide, in the same session as when it was sent
//   (SessionProvider's setHidden); a failed call marks nothing. The latest mark wins and never ends by itself, so an
//   answer read before the hide (a row kept from earlier, a late answer) never brings the title back, and one read
//   before an unhide never hides it again.
// - A title with no mark shows what the server said (`hidden`). Discovery lists leave out only what is marked hidden
//   here: the server has already left out everything else the member hid, and says `hidden` only in Search and on a
//   title's own page.
import type { Card, MediaType } from '../api/types';
import { titleKey } from '../title/asked';

/** What a hide needs of its title: its key, what to call it, and whether the server says it is hidden. */
export type HideTarget = Pick<Card, 'mediaType' | 'tmdbId' | 'title' | 'year' | 'hidden'>;

export interface HideToast {
  target: HideTarget;
  /** A new number for every hide, so the same title hidden again restarts the toast. */
  id: number;
}

export interface HiddenTitles {
  /** The server accepted hiding (`true`) or unhiding a title: a hide shows the toast, an unhide closes it if it was its. */
  mark(target: HideTarget, hidden: boolean): void;
  isHidden(card: Pick<Card, 'mediaType' | 'tmdbId' | 'hidden'>): boolean;
  /** The card with `hidden` as the member last chose it here. */
  card<T extends Pick<Card, 'mediaType' | 'tmdbId' | 'hidden'>>(card: T): T;
  /** A discovery list's cards without those marked hidden in this session. */
  visible<T extends Pick<Card, 'mediaType' | 'tmdbId' | 'hidden'>>(cards: readonly T[]): T[];
  /** The title the long-press sheet is open for, if any. */
  menu(): HideTarget | undefined;
  openMenu(target: HideTarget): void;
  closeMenu(): void;
  toast(): HideToast | undefined;
  dismissToast(): void;
  /** Drops every mark, the sheet and the toast. */
  forget(): void;
  subscribe(listener: () => void): () => void;
  /** Changes with every change above. */
  version(): number;
}

export const hiddenKey = (mediaType: MediaType, tmdbId: number): string => titleKey(mediaType, tmdbId);

export function createHiddenTitles(): HiddenTitles {
  let marks = new Map<string, boolean>();
  let menu: HideTarget | undefined;
  let toast: HideToast | undefined;
  let toasts = 0;
  let count = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    count += 1;
    for (const listener of [...listeners]) listener();
  };
  const isHidden = (card: Pick<Card, 'mediaType' | 'tmdbId' | 'hidden'>) => marks.get(hiddenKey(card.mediaType, card.tmdbId)) ?? card.hidden;

  return {
    mark(target, hidden) {
      const key = hiddenKey(target.mediaType, target.tmdbId);
      marks.set(key, hidden);
      if (hidden) toast = { target: { ...target, hidden: true }, id: ++toasts };
      else if (toast && hiddenKey(toast.target.mediaType, toast.target.tmdbId) === key) toast = undefined;
      changed();
    },
    isHidden,
    card: (card) => {
      const hidden = isHidden(card);
      return hidden === card.hidden ? card : { ...card, hidden };
    },
    visible: (cards) => cards.filter((card) => marks.get(hiddenKey(card.mediaType, card.tmdbId)) !== true),
    menu: () => menu,
    openMenu(target) {
      menu = target;
      changed();
    },
    closeMenu() {
      if (!menu) return;
      menu = undefined;
      changed();
    },
    toast: () => toast,
    dismissToast() {
      if (!toast) return;
      toast = undefined;
      changed();
    },
    forget() {
      if (marks.size === 0 && !menu && !toast) return;
      marks = new Map();
      menu = undefined;
      toast = undefined;
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    version: () => count,
  };
}
