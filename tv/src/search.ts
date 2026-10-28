import { MAX_QUERY, search, type Answer, type Card, type MediaType } from './api.js';
import type { Asked } from './asked.js';
import { drawCards, type Drawn } from './cards.js';
import { currentSession, searchPage } from './jellyfin-web.js';

/**
 * The JellyPass row on Jellyfin web's Search page: what the member searched for that can be had, from the app API's
 * Search answer, drawn as one "Discover" section below Jellyfin's own results, in the same cards as the Home row
 * (cards.ts). Only titles that are Available to get are drawn (as on Home: one in the member's library is in Jellyfin's
 * own results, one Requested belongs to My requests, one that can't be requested is no use); if none is left, or there
 * is no query, nothing is drawn.
 *
 * The query is read from Jellyfin web's search field. It is asked for once it has been still for SEARCH_DEBOUNCE_MS
 * (a little longer than Jellyfin web's own 500 ms, so Jellyfin's results are up first), never while it is empty, and
 * never twice for the same words (up to SEARCH_CACHE_SIZE of them are kept) within SEARCH_REUSE_MS. A query that changes while a call is out cancels it (where the
 * browser can) and drops whatever comes back for it; calls are at least SEARCH_MIN_GAP_MS apart, and a `429` stops them
 * for as long as the server asked. The row is only ever drawn from the answer for the words now in the field.
 *
 * It depends only on the caller's own answer, sets everything with `textContent`, and handles no key: Jellyfin web's
 * focus manager moves between its results and our cards. Choosing a card opens the title page (title.ts); Back returns
 * to the Search page, where Jellyfin web puts the query back in the field from its address, and the card is focused
 * again once the row is drawn.
 */

/** Marks the row (one at most is ever on the page). */
export const SEARCH_ROW_ATTRIBUTE = 'data-jellypass-tv-search-row';

/** How long the field must be still before the words are asked for (Jellyfin web's own debounce is 500 ms). */
export const SEARCH_DEBOUNCE_MS = 600;
/** The least time between two calls, however fast the words change (the per-address budget is a call a second, on average). */
export const SEARCH_MIN_GAP_MS = 1_000;
/** How long an answer is kept, in memory, for the same words (coming Back from a title, typing the words again). */
export const SEARCH_REUSE_MS = 60_000;
/** How many answers are kept at once (least recently used goes first): alpha, beta, alpha is two calls, not three. */
export const SEARCH_CACHE_SIZE = 20;
/** How long to wait after a `429` that did not say. */
export const SEARCH_BACKOFF_MS = 30_000;
/** How long after the Search page is shown again, from a title's page, the title's card is given focus whenever the row is drawn. */
export const SEARCH_RETURN_MS = 4_000;

interface Kept {
  userId: string;
  query: string;
  at: number;
  answer: Answer;
}

interface Scope {
  ApiClient?: unknown;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

interface Flight {
  userId: string;
  query: string;
  cancel: (() => void) | undefined;
}

export class SearchRow {
  readonly #document: Document;
  readonly #scope: Scope;
  readonly #origin: string;
  readonly #asked: Asked;
  readonly #choose: (card: Card) => void;
  readonly #now: () => number;
  /** The words and member the field and session hold now (empty: nothing to ask or draw). */
  #wanted: { userId: string; query: string } | undefined;
  /** Answers by member and words, least recently used first; emptied when the member changes or signs out. */
  readonly #cache = new Map<string, Kept>();
  #cacheUser: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #flight: Flight | undefined;
  #lastCall: number | undefined;
  #blockedUntil = 0;
  #row: Element | undefined;
  #drawn: Kept | undefined;
  #cards: Drawn[] = [];
  /** The title whose page was opened from a card, and the words it was found by (see the class comment). */
  #returning: { query: string; mediaType: MediaType; tmdbId: number; shownAt: number | undefined } | undefined;

  public constructor(
    document: Document,
    scope: Scope,
    origin: string,
    asked: Asked,
    choose: (card: Card) => void,
    now: () => number = Date.now,
  ) {
    this.#document = document;
    this.#scope = scope;
    this.#origin = origin;
    this.#asked = asked;
    this.#choose = choose;
    this.#now = now;
  }

  /**
   * Called whenever the page changes or the field is typed in. With Jellyfin web's Search page shown and signed in to
   * this origin, the words in the field are followed: a change cancels what was out for the old words and takes their
   * row away at once, and the new words are asked for when they have been still. Anywhere else nothing is drawn or asked.
   */
  public update(): void {
    const found = searchPage(this.#document);
    if (!found) {
      this.#stop();
      return;
    }
    const session = currentSession(this.#scope);
    if (!session || session.origin !== this.#origin) {
      this.#cache.clear();
      this.#cacheUser = undefined;
      this.#returning = undefined;
      this.#asked.sync(undefined);
      this.#stop();
      return;
    }
    this.#asked.sync(session.userId);
    if (this.#cacheUser !== session.userId) this.#cache.clear();
    this.#cacheUser = session.userId;
    const query = found.input.value.trim();
    const wanted = this.#wanted;
    if (!wanted || wanted.userId !== session.userId || wanted.query !== query) {
      this.#cancel();
      this.#removeRow();
      this.#wanted = { userId: session.userId, query };
    }
    if (!query || query.length > MAX_QUERY) return;
    const kept = this.#recall(session.userId, query);
    if (!kept) {
      if (this.#timer === undefined && !this.#flight) this.#schedule(session.userId, query);
      return;
    }
    this.#show(found.page, kept);
  }

  /** The Search page is shown again (Jellyfin web's `viewshow`): the return from a title's page starts its window. */
  public shown(): void {
    if (this.#returning) this.#returning.shownAt = this.#now();
  }

  /** A key or pointer press by the member: once the page is back, focus is theirs, not the card's to be given. */
  public userInput(): void {
    if (this.#returning && this.#returning.shownAt !== undefined) this.#returning = undefined;
  }

  /** A title's "Get this" was accepted or a Requested ran out (asked.ts): the cards that belong are drawn again (no call). */
  public overlayChanged(): void {
    this.update();
  }

  #schedule(userId: string, query: string): void {
    const now = this.#now();
    let delay = SEARCH_DEBOUNCE_MS;
    if (this.#lastCall !== undefined) delay = Math.max(delay, this.#lastCall + SEARCH_MIN_GAP_MS - now);
    delay = Math.max(delay, this.#blockedUntil - now);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#ask(userId, query);
    }, delay);
  }

  #ask(userId: string, query: string): void {
    const found = searchPage(this.#document);
    const session = currentSession(this.#scope);
    // Whatever changed while the words were still (the page left, the field typed in, another member) is `update`'s to see.
    if (!found || !session || session.origin !== this.#origin || session.userId !== userId || found.input.value.trim() !== query) {
      this.update();
      return;
    }
    if (this.#now() < this.#blockedUntil) {
      this.#schedule(userId, query);
      return;
    }
    // Chromium 63 has no AbortController: there the stale answer is dropped when it comes (below), not cancelled.
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    const flight: Flight = { userId, query, cancel: controller ? () => controller.abort() : undefined };
    this.#flight = flight;
    this.#lastCall = this.#now();
    void search(this.#scope.fetch, this.#origin, session.token, query, controller?.signal).then((answer) => {
      const current = this.#flight === flight;
      if (current) this.#flight = undefined;
      // What the server said about the caller holds whether or not the words have moved on; only the content is stale.
      if (!answer.ok && answer.status === 401) this.#asked.forget();
      if (!answer.ok && answer.status === 429) this.#blockedUntil = Math.max(this.#blockedUntil, this.#now() + (answer.retryAfterMs ?? SEARCH_BACKOFF_MS));
      if (!current) return;
      // A failure is kept like an answer: the same words are not asked again at once.
      this.#remember({ userId, query, at: this.#now(), answer });
      this.update();
    }).catch(() => undefined);
  }

  #recall(userId: string, query: string): Kept | undefined {
    const id = cacheKey(userId, query);
    const kept = this.#cache.get(id);
    if (!kept) return undefined;
    if (this.#now() - kept.at >= SEARCH_REUSE_MS) {
      this.#cache.delete(id);
      return undefined;
    }
    this.#cache.delete(id);
    this.#cache.set(id, kept);
    return kept;
  }

  #remember(kept: Kept): void {
    const id = cacheKey(kept.userId, kept.query);
    this.#cache.delete(id);
    this.#cache.set(id, kept);
    while (this.#cache.size > SEARCH_CACHE_SIZE) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      this.#cache.delete(oldest.value);
    }
  }

  /** Draws the row for `kept` after Jellyfin web's results, or leaves it be if it is already there as it should be. */
  #show(page: Element, kept: Kept): void {
    const cards = kept.answer.ok ? this.#belongs(kept.answer.cards) : [];
    if (this.#row && this.#drawn === kept && this.#row.parentNode === page && key(cards) === key(this.#cards.map((drawn) => drawn.card))) {
      // Jellyfin web adds its results as the page's last child: the row is put back below them.
      if (page.lastElementChild !== this.#row) page.appendChild(this.#row);
      this.#applyReturn();
      return;
    }
    const focus = this.#focusedCard();
    this.#removeRow();
    if (!cards.length) return;
    const { section, drawn } = drawCards(this.#document, cards, {
      attribute: SEARCH_ROW_ATTRIBUTE,
      state: (card) => this.#asked.state(card.mediaType, card.tmdbId, card.state),
      choose: (card) => this.#open(card, kept.query),
    });
    page.appendChild(section);
    this.#row = section;
    this.#drawn = kept;
    this.#cards = drawn;
    if (focus) {
      const same = drawn.find((one) => one.card.mediaType === focus.mediaType && one.card.tmdbId === focus.tmdbId);
      (same ?? drawn[Math.min(focus.index, drawn.length - 1)])?.button.focus();
    }
    this.#applyReturn();
  }

  /** The cards of an answer that belong in the row: only those Available to get, as the overlay has them. */
  #belongs(cards: Card[]): Card[] {
    return cards.filter((card) => this.#asked.state(card.mediaType, card.tmdbId, card.state) === 'get_this');
  }

  /**
   * Back from a title's page: once the Search page is shown again with the same words and the row is on it, focus goes
   * to the card the member came from (the first card if its title has left the row), after Jellyfin web's own
   * auto-focus of the field has been and gone, and again if the row is drawn again, until the member moves focus
   * themselves or SEARCH_RETURN_MS has passed.
   */
  #applyReturn(): void {
    const back = this.#returning;
    if (!back || back.shownAt === undefined) return;
    if (this.#now() - back.shownAt > SEARCH_RETURN_MS) {
      this.#returning = undefined;
      return;
    }
    if (!this.#drawn || this.#drawn.query !== back.query) return;
    const wanted = this.#cards.find((drawn) => drawn.card.mediaType === back.mediaType && drawn.card.tmdbId === back.tmdbId) ?? this.#cards[0];
    if (wanted && this.#document.activeElement !== wanted.button) wanted.button.focus();
  }

  #focusedCard(): { index: number; mediaType: MediaType; tmdbId: number } | undefined {
    const active = this.#document.activeElement;
    if (!active || !this.#row || !this.#row.contains(active)) return undefined;
    const index = this.#cards.findIndex((drawn) => drawn.button === active || drawn.button.contains(active));
    if (index < 0) return undefined;
    const { mediaType, tmdbId } = this.#cards[index]!.card;
    return { index, mediaType, tmdbId };
  }

  /** A card chosen: its page is opened, if Jellyfin web is still signed in to this origin, and Back will return to the card. */
  #open(card: Card, query: string): void {
    const session = currentSession(this.#scope);
    if (!session || session.origin !== this.#origin) return;
    this.#returning = { query, mediaType: card.mediaType, tmdbId: card.tmdbId, shownAt: undefined };
    this.#choose(card);
  }

  /** The Search page is gone (or not as expected, or no one is signed in here): no row, no timer, nothing in flight. */
  #stop(): void {
    this.#cancel();
    this.#removeRow();
    this.#wanted = undefined;
  }

  #cancel(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const flight = this.#flight;
    this.#flight = undefined;
    try {
      if (flight && flight.cancel) flight.cancel();
    } catch {
      // A cancel that fails leaves the answer to be dropped when it comes.
    }
  }

  #removeRow(): void {
    const rows = Array.prototype.slice.call(this.#document.querySelectorAll(`[${SEARCH_ROW_ATTRIBUTE}]`)) as Element[];
    for (const row of rows) row.parentNode?.removeChild(row);
    this.#row = undefined;
    this.#drawn = undefined;
    this.#cards = [];
  }
}

function cacheKey(userId: string, query: string): string {
  return `${userId}\u0000${query}`;
}

function key(cards: Card[]): string {
  return cards.map((card) => `${card.mediaType}:${card.tmdbId}`).join(',');
}
