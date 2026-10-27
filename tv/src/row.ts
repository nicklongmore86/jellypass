import { trending, type Answer, type Card, type HouseholdState, type MediaType } from './api.js';
import type { Asked } from './asked.js';
import { currentSession, homeSections, JELLYFIN_CLASSES } from './jellyfin-web.js';

/**
 * The JellyPass row on Jellyfin web's Home: what is trending and can be had, from the app API's Trending answer, drawn as
 * one Home section after Home's first, in Jellyfin web's own card markup (see JELLYFIN_CLASSES). Only titles that are
 * Available to get are drawn: one in the caller's library (`in_library`) is in Jellyfin's own rows already, and one
 * Requested belongs to My requests; neither is in the row, so the row has no badge. A title the member asks for while
 * the row is up leaves it at once. If nothing is left the row is not drawn (a second page is never asked for, so the
 * row's one call stays one). It depends only on the caller's own answer. Everything shown is a fixed string or a DTO
 * field set with `textContent`; no HTML is parsed. It runs no navigation of its own: Jellyfin web's focus manager moves
 * between its cards. Choosing a card opens the title view (title.ts). States are read through the "Get this" overlay
 * (asked.ts).
 */

/** The coarse statuses, worded as the household app words them. */
export const STATE_LABELS: Record<HouseholdState, string> = {
  in_library: 'Ready to watch',
  get_this: 'Available to get',
  unavailable: "Can't request",
  requested: 'Requested',
};

export const ROW_TEXT = {
  heading: 'Discover',
} as const;

/** Marks the row (one at most is ever on the page). */
export const ROW_ATTRIBUTE = 'data-jellypass-tv-row';

/**
 * How long an answer is kept, in memory only, before Home being shown again reads it again. Jellyfin web redraws Home's
 * sections each time Home is opened, and a household's devices share one per-address budget, so the row asks at most
 * once a minute however often Home is redrawn, and never while Home just stays on screen.
 */
export const REUSE_MS = 60_000;

interface Kept {
  userId: string;
  at: number;
  answer: Answer;
}

/** A drawn card, with what its status is drawn from. */
interface Drawn {
  card: Card;
  button: HTMLElement;
}

interface Scope {
  ApiClient?: unknown;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

export class HomeRow {
  readonly #document: Document;
  readonly #scope: Scope;
  /** The origin the add-on's script came from: the only one it calls, and only while Jellyfin web is signed in there. */
  readonly #origin: string;
  readonly #asked: Asked;
  readonly #choose: (card: Card) => void;
  readonly #now: () => number;
  #kept: Kept | undefined;
  #loading: { userId: string } | undefined;
  #row: Element | undefined;
  #drawn: Kept | undefined;
  #cards: Drawn[] = [];

  public constructor(document: Document, scope: Scope, origin: string, asked: Asked, choose: (card: Card) => void, now: () => number = Date.now) {
    this.#document = document;
    this.#scope = scope;
    this.#origin = origin;
    this.#asked = asked;
    this.#choose = choose;
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
    const session = currentSession(this.#scope);
    if (!session || session.origin !== this.#origin) {
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
      this.#load(session.userId, session.token);
      return;
    }
    if (this.#row && this.#row.parentNode === home.container && this.#drawn === kept && this.#rows().length === 1) {
      this.#refreshStatuses();
      return;
    }
    const focus = this.#focusedCard();
    this.#removeRows();
    // A failed or empty answer draws nothing (and is not asked again until Home is next shown, after REUSE_MS).
    // Only what can be had: not what is in this member's library (Jellyfin web's rows show it) nor what is Requested.
    const cards = kept.answer.ok ? this.#belongs(kept.answer.cards) : [];
    if (!cards.length) return;
    const row = this.#draw(cards);
    home.container.insertBefore(row, home.first.nextSibling);
    this.#row = row;
    this.#drawn = kept;
    if (focus) this.#restoreFocus(focus);
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

  /** Focuses the drawn card for a title (Back from its title view), if it is still there. */
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
    if (this.#kept && this.#now() - this.#kept.at >= REUSE_MS) this.#kept = undefined;
    this.update();
  }

  #load(userId: string, token: string): void {
    if (this.#loading && this.#loading.userId === userId) return;
    const loading = { userId };
    this.#loading = loading;
    void trending(this.#scope.fetch, this.#origin, token).then((answer) => {
      if (this.#loading !== loading) return;
      this.#loading = undefined;
      // A refused token is nobody's: whatever was shown as requested for it is dropped.
      if (!answer.ok && answer.status === 401) this.#asked.forget();
      this.#kept = { userId, at: this.#now(), answer };
      this.update();
    }).catch(() => undefined);
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
    const document = this.#document;
    const element = (tag: string, className: string, text?: string): HTMLElement => {
      const node = document.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const section = element('div', `${JELLYFIN_CLASSES.section} jellypass-tv-row`);
    section.setAttribute(ROW_ATTRIBUTE, '');
    const headingContainer = element('div', JELLYFIN_CLASSES.headingContainer);
    headingContainer.appendChild(element('h2', JELLYFIN_CLASSES.heading, ROW_TEXT.heading));
    section.appendChild(headingContainer);
    const scroller = element('div', 'jellypass-tv-row-scroller padded-left padded-right');
    const list = element('div', `jellypass-tv-row-list itemsContainer ${JELLYFIN_CLASSES.row}`);
    // Jellyfin web's TV layout draws its cards with a focus ring and a focus zoom: its CSS keys on these two classes.
    const tv = document.documentElement.classList.contains('layout-tv');
    this.#cards = [];
    for (const card of cards) {
      const button = element('button', `${JELLYFIN_CLASSES.card} jellypass-tv-card${tv ? ` ${JELLYFIN_CLASSES.cardTv}` : ''}`) as HTMLButtonElement;
      button.type = 'button';
      button.setAttribute('data-media-type', card.mediaType);
      button.setAttribute('data-tmdb-id', String(card.tmdbId));
      const state = this.#asked.state(card.mediaType, card.tmdbId, card.state);
      button.setAttribute('aria-label', cardLabel(card, state));
      const box = element('div', 'cardBox cardBox-bottompadded');
      const frame = element('div', 'cardScalable');
      frame.appendChild(element('div', 'cardPadder cardPadder-overflowPortrait'));
      const image = element('div', 'cardImageContainer coveredImage cardContent');
      if (card.posterUrl) {
        const poster = document.createElement('img');
        poster.className = 'jellypass-tv-card-image';
        poster.setAttribute('alt', '');
        poster.setAttribute('referrerpolicy', 'no-referrer');
        poster.setAttribute('src', card.posterUrl);
        image.appendChild(poster);
      }
      frame.appendChild(image);
      box.appendChild(frame);
      box.appendChild(element('div', 'cardText cardTextCentered cardText-first jellypass-tv-card-title', card.title));
      if (card.year !== null) box.appendChild(element('div', 'cardText cardText-secondary cardTextCentered jellypass-tv-card-year', String(card.year)));
      button.appendChild(box);
      button.addEventListener('click', () => this.#choose(card));
      this.#cards.push({ card, button });
      list.appendChild(button);
    }
    scroller.appendChild(list);
    section.appendChild(scroller);
    return section;
  }
}

/** A card's accessible name: the title, the year and the status, said once. */
function cardLabel(card: Card, state: HouseholdState): string {
  const label = STATE_LABELS[state];
  return card.year === null ? `${card.title}, ${label}` : `${card.title}, ${card.year}, ${label}`;
}
