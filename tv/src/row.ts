import { trending, type Answer, type Card, type MediaType } from './api.js';
import type { Asked } from './asked.js';
import { drawCards, LINK_ATTRIBUTE, ROW_TEXT, STATE_LABELS, type Drawn } from './cards.js';
import { homeSections, type Session } from './jellyfin-web.js';
import { SessionWatch } from './session-watch.js';

/**
 * The JellyPass row on Jellyfin web's Home: what is trending and can be had, from the app API's Trending answer, drawn as
 * one Home section after Home's first, in Jellyfin web's own card markup (see JELLYFIN_CLASSES). Only titles that are
 * Available to get are drawn: one in the caller's library (`in_library`) is in Jellyfin's own rows already, and one
 * Requested belongs to My requests; neither is in the row, so the row has no badge. A title the member asks for while
 * the row is up leaves it at once. If nothing is left the row is not drawn (a second page is never asked for, so the
 * row's one call stays one). It depends only on the caller's own answer. Everything shown is a fixed string or a DTO
 * field set with `textContent`; no HTML is parsed. It runs no navigation of its own: Jellyfin web's focus manager moves
 * between its cards. Choosing a card opens the title page (title.ts), a page of Jellyfin web's; Back returns to Home and
 * the card is given focus again. States are read through the "Get this" overlay
 * (asked.ts).
 */

export { ROW_TEXT, STATE_LABELS };

/** Marks the row (one at most is ever on the page). */
export const ROW_ATTRIBUTE = 'data-jellypass-tv-row';

/**
 * How long an answer is kept, in memory only, before Home being shown again reads it again. Jellyfin web redraws Home's
 * sections each time Home is opened, and a household's devices share one per-address budget, so the row asks at most
 * once a minute however often Home is redrawn, and never while Home just stays on screen.
 */
export const REUSE_MS = 60_000;

/** How long after Home is shown again, from a title's page, the title's card is given focus whenever the row is drawn. */
export const RETURN_MS = 4_000;

interface Kept {
  userId: string;
  at: number;
  answer: Answer;
}

interface Scope {
  ApiClient?: unknown;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

export class HomeRow {
  readonly #document: Document;
  readonly #scope: Scope;
  readonly #watch: SessionWatch;
  /** The origin the add-on's script came from: the only one it calls, and only while Jellyfin web is signed in there. */
  readonly #origin: string;
  readonly #asked: Asked;
  readonly #choose: (card: Card) => void;
  /** The strip's last card, "My requests": opens the page at `#/jellypass/requests` (main.ts). */
  readonly #openRequests: () => void;
  readonly #now: () => number;
  #kept: Kept | undefined;
  #loading: { userId: string } | undefined;
  #row: Element | undefined;
  #drawn: Kept | undefined;
  #cards: Drawn[] = [];
  /**
   * The title whose page was opened from a card: when Home is shown again, its card is focused each time the row is drawn,
   * for RETURN_MS (Jellyfin web redraws Home's sections, and auto-focuses, after it is shown), until the member moves focus.
   */
  #returning: { mediaType: MediaType; tmdbId: number; shownAt: number | undefined; link?: boolean } | undefined;

  public constructor(document: Document, scope: Scope, origin: string, asked: Asked, choose: (card: Card) => void, openRequests: () => void = () => undefined, now: () => number = Date.now) {
    this.#document = document;
    this.#scope = scope;
    this.#watch = new SessionWatch(scope, origin);
    this.#origin = origin;
    this.#asked = asked;
    this.#choose = choose;
    this.#openRequests = openRequests;
    this.#now = now;
  }

  /**
   * Called whenever the page changes. With Home laid out and shown, and Jellyfin web signed in to this origin, the row
   * is put back if Jellyfin web redrew Home without it, drawn from the answer kept for this member, or asked for if
   * there is none (then drawn when it comes). Signed out, or signed in elsewhere, there is no row.
   */
  public update(): void {
    const home = homeSections(this.#document);
    if (!home) return;
    const session = this.#watch.current();
    if (!session) {
      this.#kept = undefined;
      this.#asked.sync(undefined);
      this.#removeRows();
      return;
    }
    this.#asked.sync(session.userId);
    const kept = this.#kept && this.#kept.userId === session.userId ? this.#kept : undefined;
    if (!kept) {
      // Another member's row goes at once; this member's stays until the new answer replaces it.
      if (!this.#drawn || this.#drawn.userId !== session.userId) this.#removeRows();
      this.#load(session);
      return;
    }
    if (this.#row && this.#row.parentNode === home.container && this.#drawn === kept && this.#rows().length === 1) {
      this.#refreshStatuses();
      this.#applyReturn();
      return;
    }
    const focus = this.#focusedCard();
    this.#removeRows();
    // A failed or empty answer is not asked again until Home is next shown, after REUSE_MS. Only what can be had is
    // drawn: not what is in this member's library (Jellyfin web's rows show it) nor what is Requested. With nothing to
    // draw, the row is only the "My requests" card, so the page stays reachable from Home (decided from this answer: no call).
    const cards = kept.answer.ok ? this.#belongs(kept.answer.cards) : [];
    const row = this.#draw(cards);
    home.container.insertBefore(row, home.first.nextSibling);
    this.#row = row;
    this.#drawn = kept;
    if (focus) this.#restoreFocus(focus);
    this.#applyReturn();
  }

  /**
   * Back from a title's page: once Home is shown again and the row is on it, focus goes to the card the member came from
   * (the first card if its title has left the row), after Jellyfin web's own auto-focus has been and gone, and again if
   * the row is drawn again under it, until the member moves focus themselves or RETURN_MS has passed.
   */
  #applyReturn(): void {
    const back = this.#returning;
    if (!back || back.shownAt === undefined) return;
    if (this.#now() - back.shownAt > RETURN_MS) {
      this.#returning = undefined;
      return;
    }
    // Back from My requests returns to its link; from a title, to the title's card.
    const link = back.link ? this.#row?.querySelector(`[${LINK_ATTRIBUTE}]`) as HTMLElement | null | undefined : undefined;
    const wanted = link ?? (this.#cards.find((drawn) => drawn.card.mediaType === back.mediaType && drawn.card.tmdbId === back.tmdbId) ?? this.#cards[0])?.button;
    if (wanted && this.#document.activeElement !== wanted) wanted.focus();
  }

  /** A key or pointer press by the member: once Home is back, focus is theirs, not the card's to be given. */
  public userInput(): void {
    if (this.#returning && this.#returning.shownAt !== undefined) this.#returning = undefined;
  }

  /** Which drawn card has focus, if the row has it: its place in the row and its title. */
  #focusedCard(): { index: number; mediaType: MediaType; tmdbId: number } | undefined {
    const active = this.#document.activeElement;
    if (!active || !this.#row || !this.#row.contains(active)) return undefined;
    const index = this.#cards.findIndex((drawn) => drawn.button === active || drawn.button.contains(active));
    if (index < 0) return undefined;
    const { mediaType, tmdbId } = this.#cards[index]!.card;
    return { index, mediaType, tmdbId };
  }

  /** The row was drawn again while it had focus: focus goes to the same title, else the card now in its place, never to the page. */
  #restoreFocus(focus: { index: number; mediaType: MediaType; tmdbId: number }): void {
    const same = this.#cards.find((drawn) => drawn.card.mediaType === focus.mediaType && drawn.card.tmdbId === focus.tmdbId);
    (same ?? this.#cards[Math.min(focus.index, this.#cards.length - 1)])?.button.focus();
  }

  /** Focuses the drawn card for a title (Back from its title page), if it is still there. */
  public focusCard(mediaType: MediaType, tmdbId: number): void {
    for (const drawn of this.#cards) {
      if (drawn.card.mediaType === mediaType && drawn.card.tmdbId === tmdbId && this.#row && this.#row.contains(drawn.button)) {
        drawn.button.focus();
        return;
      }
    }
    // The title left the row (it was just asked for): focus goes to the row's first card, if any.
    this.#cards[0]?.button.focus();
  }

  /** A Requested ran out (asked.ts): the row is drawn again from the answer it holds, the title back in it (no call). */
  public overlayExpired(): void {
    this.update();
  }

  /**
   * The overlay now shows a title otherwise (asked for, or its Requested ran out): if the cards that belong in the row
   * are no longer the ones drawn, the row is drawn again from its answer (no call). Otherwise nothing moves, so focus stays.
   */
  #refreshStatuses(): void {
    const kept = this.#drawn;
    if (!kept || !kept.answer.ok) return;
    const key = (cards: Card[]): string => cards.map((card) => `${card.mediaType}:${card.tmdbId}`).join(',');
    if (key(this.#belongs(kept.answer.cards)) === key(this.#cards.map((drawn) => drawn.card))) return;
    this.#drawn = undefined;
    this.update();
  }

  /** The cards of an answer that belong in the row: only those Available to get, as the overlay has them. */
  #belongs(cards: Card[]): Card[] {
    return cards.filter((card) => this.#asked.state(card.mediaType, card.tmdbId, card.state) === 'get_this');
  }

  /** Home is being shown again: an answer older than REUSE_MS is read again (the row stays until the new one comes). */
  public homeShown(): void {
    if (this.#returning) this.#returning.shownAt = this.#now();
    if (this.#kept && this.#now() - this.#kept.at >= REUSE_MS) this.#kept = undefined;
    this.update();
  }

  #load(session: Session): void {
    const { userId } = session;
    if (this.#loading && this.#loading.userId === userId) return;
    const loading = { userId };
    this.#loading = loading;
    const stamp = this.#watch.stamp(session);
    void trending(this.#scope.fetch, this.#origin, session.token).then((answer) => {
      if (this.#loading !== loading) return;
      this.#loading = undefined;
      // An answer to another sign-in's call (signed out, or in again with a new token) is dropped whole, a refused token
      // included; `update` reads again for the session that is there now.
      if (!this.#watch.holds(stamp)) {
        this.update();
        return;
      }
      // A refused token is nobody's: whatever was shown as requested for it is dropped.
      if (!answer.ok && answer.status === 401) this.#asked.forget();
      this.#kept = { userId, at: this.#now(), answer };
      this.update();
    }).catch(() => undefined);
  }

  /** A card chosen: its page is opened, if Jellyfin web is still signed in to this origin, and Back will return to the card. */
  #open(card: Card): void {
    if (!this.#watch.current()) return;
    this.#returning = { mediaType: card.mediaType, tmdbId: card.tmdbId, shownAt: undefined };
    this.#choose(card);
  }

  /** The "My requests" card chosen: its page is opened, if Jellyfin web is still signed in to this origin, and Back will return to the card. */
  #requests(): void {
    if (!this.#watch.current()) return;
    this.#returning = { mediaType: 'movie', tmdbId: 0, shownAt: undefined, link: true };
    this.#openRequests();
  }

  #rows(): Element[] {
    return Array.prototype.slice.call(this.#document.querySelectorAll(`[${ROW_ATTRIBUTE}]`)) as Element[];
  }

  #removeRows(): void {
    for (const row of this.#rows()) row.parentNode?.removeChild(row);
    this.#row = undefined;
    this.#drawn = undefined;
    this.#cards = [];
  }

  #draw(cards: Card[]): Element {
    const { section, drawn } = drawCards(this.#document, cards, {
      attribute: ROW_ATTRIBUTE,
      state: (card) => this.#asked.state(card.mediaType, card.tmdbId, card.state),
      choose: (card) => this.#open(card),
      link: { label: ROW_TEXT.requests, open: () => this.#requests() },
    });
    this.#cards = drawn;
    return section;
  }
}
