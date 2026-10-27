import { trending, type Answer, type Card, type HouseholdState } from './api.js';
import { currentSession, homeSections, JELLYFIN_CLASSES } from './jellyfin-web.js';

/**
 * The JellyPass row on Jellyfin web's Home: the household's view of Trending, as the app API answers it, drawn as one
 * Home section after Home's first. Everything shown is a fixed string or a DTO field set with `textContent`; no HTML is
 * parsed. It runs no navigation of its own: Jellyfin web's focus manager moves between its cards (see JELLYFIN_CLASSES).
 */

/** The coarse statuses, worded as the household app words them. */
export const STATE_LABELS: Record<HouseholdState, string> = {
  in_library: 'Ready to watch',
  get_this: 'Available to get',
  unavailable: "Can't request",
  requested: 'Requested',
};

export const ROW_TEXT = {
  heading: 'JellyPass: Trending',
  /** Shown when a card is chosen, until title pages and "Get this" come to the TV. */
  placeholder: 'Coming soon to the TV. To get a title now, use the JellyPass app on your phone.',
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

interface Scope {
  ApiClient?: unknown;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

export class HomeRow {
  readonly #document: Document;
  readonly #scope: Scope;
  /** The origin the add-on's script came from: the only one it calls, and only while Jellyfin web is signed in there. */
  readonly #origin: string;
  readonly #now: () => number;
  #kept: Kept | undefined;
  #loading: { userId: string } | undefined;
  #row: Element | undefined;
  #drawn: Kept | undefined;

  public constructor(document: Document, scope: Scope, origin: string, now: () => number = Date.now) {
    this.#document = document;
    this.#scope = scope;
    this.#origin = origin;
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
      this.#removeRows();
      return;
    }
    const kept = this.#kept && this.#kept.userId === session.userId ? this.#kept : undefined;
    if (!kept) {
      // Another member's row goes at once; this member's stays until the new answer replaces it.
      if (!this.#drawn || this.#drawn.userId !== session.userId) this.#removeRows();
      this.#load(session.userId, session.token);
      return;
    }
    if (this.#row && this.#row.parentNode === home.container && this.#drawn === kept && this.#rows().length === 1) return;
    this.#removeRows();
    // A failed or empty answer draws nothing (and is not asked again until Home is next shown, after REUSE_MS).
    if (!kept.answer.ok || !kept.answer.cards.length) return;
    const row = this.#draw(kept.answer.cards);
    home.container.insertBefore(row, home.first.nextSibling);
    this.#row = row;
    this.#drawn = kept;
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
    const scroller = element('div', 'jellypass-tv-scroller padded-left padded-right');
    const list = element('div', `jellypass-tv-list ${JELLYFIN_CLASSES.row}`);
    const note = element('p', 'jellypass-tv-note padded-left');
    note.setAttribute('role', 'status');
    for (const card of cards) {
      const button = element('button', 'jellypass-tv-card') as HTMLButtonElement;
      button.type = 'button';
      button.setAttribute('data-media-type', card.mediaType);
      button.setAttribute('data-tmdb-id', String(card.tmdbId));
      const label = STATE_LABELS[card.state];
      button.setAttribute('aria-label', card.year === null ? `${card.title}, ${label}` : `${card.title}, ${card.year}, ${label}`);
      const poster = element('span', 'jellypass-tv-poster');
      if (card.posterUrl) {
        const image = document.createElement('img');
        image.setAttribute('alt', '');
        image.setAttribute('referrerpolicy', 'no-referrer');
        image.setAttribute('src', card.posterUrl);
        poster.appendChild(image);
      }
      button.appendChild(poster);
      button.appendChild(element('span', `jellypass-tv-status jellypass-tv-status-${card.state}`, label));
      button.appendChild(element('span', 'jellypass-tv-title', card.title));
      if (card.year !== null) button.appendChild(element('span', 'jellypass-tv-year', String(card.year)));
      // Title pages and "Get this" come in later releases: choosing a card only says so.
      button.addEventListener('click', () => {
        note.textContent = ROW_TEXT.placeholder;
      });
      list.appendChild(button);
    }
    scroller.appendChild(list);
    section.appendChild(scroller);
    section.appendChild(note);
    return section;
  }
}
