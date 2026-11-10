import { collection as readCollection, getThis, requests as readRequests, type Collection, type CollectionFilm, type Failure, type HouseholdState } from './api.js';
import type { Asked } from './asked.js';
import { COLLECTION_TEXT } from './collection-model.js';
import type { Session } from './jellyfin-web.js';
import { FOCUS_ATTR, type PageContext, type PageView } from './page-host.js';
import { STATE_LABELS } from './row.js';
import { SessionWatch } from './session-watch.js';
import { ERROR_TEXT, TITLE_TEXT, kindOf, rateLimitedText, type ErrorKind } from './title.js';

/**
 * The collection page (docs/tv-addon.md, "Collections"): a film series (TMDB's collection) as a page of Jellyfin web at
 * `#/jellypass/collection/<id>` on the page host, reached only from a film's title page (its "Part of …" button, shown
 * when a server with `apiVersion` 6 names the film's collection). It lists each film with its household state; a film the
 * household can ask for is a toggle (aria-pressed), ticked when it is out already, not when it is not released yet (it is
 * shown, and can be ticked by hand). One button asks: **Get all missing films** while the ticks are the films out and
 * missing, **Get selected (N)** otherwise. It sends one `POST /movie/{tmdbId}/get` per film ticked, one after another in
 * the list's order (Seerr's model: one request per film, each counted against the "Get this" limits), and stops at the
 * first that fails: the page then says which films were asked for and which were not, with the wait the server gave for
 * a `429`. Then the collection is read again. Nothing is ever sent by itself or repeated.
 *
 * It is a route, so Jellyfin web's header, Back, history and focus manager are what apply: this module handles no key.
 * Every answer is checked against the session that sent it (session-watch.ts). Everything shown is a fixed string or a
 * DTO field set with `textContent`. Its classes are the title page's family (`jellypass-tv-title-*`).
 */

/** Marks the page's content (one at most is ever on the page). */
export const COLLECTION_ATTRIBUTE = 'data-jellypass-tv-collection';
const PAGE_TITLE = 'JellyPass';
/** The largest id the API's paths take (a 32-bit signed integer). */
const MAX_ID = 2_147_483_647;

interface Scope {
  ApiClient?: unknown;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

/** What the page asks of the page around it. */
export interface CollectionHost {
  /** The overlay changed (films were asked for, or it was forgotten): rows and pages redraw their statuses. */
  changed(): void;
}

/** What the last press of the button did: the films asked for and not, and the failure that stopped it. */
interface Outcome {
  asked: string[];
  notAsked: string[];
  failure: Failure | undefined;
}

interface Open {
  id: number;
  userId: string;
  context: PageContext;
  view: HTMLElement;
  body: HTMLElement;
  load: number;
  first: boolean;
  /** Films asked for on this page: not offered again while it is open, whatever the overlay says. */
  askedHere: number[];
  /**
   * Films whose request failed (My requests' failed entries, as the title page reads them): shown as such and never
   * offered, since asking again changes nothing until an administrator acts. Kept from the last read that had them.
   */
  failed: number[];
  /** The answer drawn, while it can be drawn again from it alone (not loading, failed or sending). */
  drawn: { found: Collection; outcome: Outcome | undefined; shown: string } | undefined;
  lastFocus: Element | undefined;
}

export class CollectionPage {
  readonly #document: Document;
  readonly #scope: Scope;
  readonly #watch: SessionWatch;
  readonly #origin: string;
  readonly #asked: Asked;
  readonly #host: CollectionHost;
  #open: Open | undefined;
  #loads = 0;

  public constructor(document: Document, scope: Scope, origin: string, asked: Asked, host: CollectionHost) {
    this.#document = document;
    this.#scope = scope;
    this.#watch = new SessionWatch(scope, origin);
    this.#origin = origin;
    this.#asked = asked;
    this.#host = host;
  }

  /** The page host's render for the route: one call, `GET /collection/{id}`. An id that is not one calls nothing. */
  public render(context: PageContext): PageView {
    const cleanup = () => this.#leave(context);
    const session = this.#watch.current();
    if (!session) return { title: PAGE_TITLE, cleanup };
    const view = this.#el('div', 'jellypass-tv-title-page jellypass-tv-title-collection-page');
    view.setAttribute(COLLECTION_ATTRIBUTE, '');
    const body = this.#el('div', 'jellypass-tv-title-body');
    view.appendChild(body);
    context.container.appendChild(view);
    const raw = context.params.id ?? '';
    const id = /^[1-9][0-9]{0,9}$/.test(raw) && Number(raw) <= MAX_ID ? Number(raw) : 0;
    const open: Open = { id, userId: session.userId, context, view, body, load: 0, first: true, askedHere: [], failed: [], drawn: undefined, lastFocus: undefined };
    view.addEventListener('focusin', (event) => {
      open.lastFocus = event.target as Element;
    });
    this.#open = open;
    if (!id) this.#error(open, 'not_found', false);
    else this.#load(open, session, undefined);
    return { title: PAGE_TITLE, cleanup };
  }

  /** Called on every page change: signed out, or another member signed in, the page is emptied and nothing more is read or sent. */
  public update(): void {
    const open = this.#open;
    if (!open) return;
    const session = this.#watch.current();
    if (session && session.userId === open.userId && open.view.parentNode) return;
    this.#asked.sync(session ? session.userId : undefined);
    this.#end(open);
  }

  /** A Requested ran out while the page was open: drawn again from the answer it holds when that changes it (no call). */
  public overlayExpired(): void {
    const open = this.#open;
    const drawn = open ? open.drawn : undefined;
    if (!open || !drawn || this.#shown(drawn.found) === drawn.shown) return;
    const picked = (Array.prototype.slice.call(open.body.querySelectorAll('.jellypass-tv-title-film-pick[aria-pressed="true"]')) as Element[])
      .map((toggle) => Number(toggle.getAttribute('data-tmdb-id')));
    this.#draw(open, drawn.found, drawn.outcome, picked);
  }

  #leave(context: PageContext): void {
    const open = this.#open;
    if (!open || open.context !== context) return;
    this.#open = undefined;
    open.load = -1;
  }

  #end(open: Open): void {
    if (this.#open !== open) return;
    this.#open = undefined;
    open.load = -1;
    if (open.view.parentNode) open.view.parentNode.removeChild(open.view);
  }

  #shown(found: Collection): string {
    return found.films.map((film) => this.#asked.state('movie', film.tmdbId, film.state)).join(' ');
  }

  #el(tag: string, className: string, text?: string): HTMLElement {
    const node = this.#document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  #button(className: string, text: string, focusKey: string): HTMLButtonElement {
    const primary = className.indexOf('jellypass-tv-title-primary') >= 0;
    const tv = this.#document.documentElement.classList.contains('layout-tv');
    const button = this.#el('button', `emby-button raised ${primary ? 'button-submit ' : ''}${tv ? 'show-focus ' : ''}jellypass-tv-title-button ${className}`, text) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute(FOCUS_ATTR, focusKey);
    return button;
  }

  #image(url: string): HTMLImageElement {
    const image = this.#document.createElement('img');
    image.setAttribute('alt', '');
    image.setAttribute('referrerpolicy', 'no-referrer');
    image.setAttribute('src', url);
    return image;
  }

  #fill(open: Open, parts: HTMLElement[]): void {
    const body = open.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    for (const part of parts) body.appendChild(part);
  }

  #place(open: Open, element: HTMLElement | null): void {
    if (this.#open !== open) return;
    if (open.first) {
      open.first = false;
      open.context.focus(element);
    } else if (element) element.focus();
  }

  /**
   * Reads the collection, then draws it. After the button was pressed (`outcome`), what it did stays shown whatever the
   * read does: a failed read draws the page again from the answer it was drawn from (`before`), the overlay showing the
   * films asked for as requested.
   */
  #load(open: Open, session: Session, outcome: Outcome | undefined, before?: Collection): void {
    const load = ++this.#loads;
    open.load = load;
    open.drawn = undefined;
    if (!outcome) {
      const box = this.#el('div', 'jellypass-tv-title-state padded-left padded-right');
      box.appendChild(this.#el('p', 'jellypass-tv-title-loading', TITLE_TEXT.loading));
      this.#fill(open, [box]);
    }
    const stamp = this.#watch.stamp(session);
    void Promise.all([
      readCollection(this.#scope.fetch, this.#origin, session.token, open.id),
      readRequests(this.#scope.fetch, this.#origin, session.token),
    ]).then(([answer, listed]) => {
      if (open.load !== load || this.#open !== open) return;
      const now = this.#watch.holds(stamp);
      if (!now || now.userId !== open.userId) {
        // Signed in again as the same member (a new token): read again for that session; anyone else, the page ends.
        const current = this.#watch.current();
        if (current && current.userId === open.userId) this.#load(open, current, outcome, before);
        else this.#end(open);
        return;
      }
      // A refused requests read is a refused sign-in too; any other failure of it only leaves the failed marks as they were.
      if (answer.ok && !listed.ok && listed.status === 401) answer = { ok: false, status: 401 };
      if (listed.ok) open.failed = listed.entries.filter((entry) => entry.mediaType === 'movie' && entry.status === 'failed').map((entry) => entry.tmdbId);
      if (!answer.ok) {
        if (answer.status === 401) {
          this.#asked.forget();
          this.#host.changed();
          this.#error(open, 'unauthorized', true);
        } else if (outcome && before) this.#draw(open, before, outcome, []);
        else this.#error(open, kindOf(answer), true);
        return;
      }
      this.#asked.sync(now.userId);
      if (answer.collection.name) open.context.setTitle(answer.collection.name);
      this.#draw(open, answer.collection, outcome, undefined);
    }).catch(() => undefined);
  }

  #error(open: Open, kind: ErrorKind, canRetry: boolean): void {
    open.drawn = undefined;
    const text = ERROR_TEXT[kind];
    const box = this.#el('div', 'jellypass-tv-title-state padded-left padded-right');
    box.appendChild(this.#el('p', 'jellypass-tv-title-error', text.title));
    box.appendChild(this.#el('p', 'jellypass-tv-title-note', kind === 'not_found' ? COLLECTION_TEXT.noFilms : text.body));
    let retry: HTMLButtonElement | undefined;
    if (kind !== 'unauthorized' && canRetry) {
      retry = this.#button('jellypass-tv-title-retry', TITLE_TEXT.tryAgain, 'retry');
      retry.addEventListener('click', () => {
        const session = this.#watch.current();
        if (this.#open !== open) return;
        if (!session || session.userId !== open.userId) this.#end(open);
        else this.#load(open, session, undefined);
      });
      const actions = this.#el('div', 'jellypass-tv-title-actions');
      actions.appendChild(retry);
      box.appendChild(actions);
    }
    this.#fill(open, [box]);
    this.#place(open, retry ?? null);
  }

  /**
   * Draws the page from an answer. `picked`: the films ticked when it is drawn again in place (undefined: the defaults,
   * every film out and missing). `outcome`: what the last press did, shown under the button, which then has focus.
   */
  #draw(open: Open, found: Collection, outcome: Outcome | undefined, picked: number[] | undefined): void {
    const asked = this.#asked;
    const films = found.films.map((film) => ({ film, state: asked.state('movie', film.tmdbId, film.state) as HouseholdState }));
    const failedFilm = (entry: { film: CollectionFilm; state: HouseholdState }) => entry.state === 'get_this' && open.failed.indexOf(entry.film.tmdbId) >= 0;
    const hiddenFilm = (film: CollectionFilm) => film.hidden !== undefined && asked.hiddenNow('movie', film.tmdbId, film.hidden);
    const pickable = (entry: { film: CollectionFilm; state: HouseholdState }) =>
      entry.state === 'get_this' && open.askedHere.indexOf(entry.film.tmdbId) < 0 && !failedFilm(entry);
    // Not a film the member hid ("Not interested", as Discover leaves it out): it can still be ticked by hand.
    const defaults = films.filter((entry) => pickable(entry) && entry.film.released && !hiddenFilm(entry.film)).map((entry) => entry.film.tmdbId);
    const ticked = picked ?? defaults;

    const parts: HTMLElement[] = [];
    const backdrop = this.#el('div', 'jellypass-tv-title-backdrop');
    if (found.backdropUrl) backdrop.appendChild(this.#image(found.backdropUrl));
    parts.push(backdrop);
    const main = this.#el('div', 'jellypass-tv-title-main padded-left padded-right');
    const text = this.#el('div', 'jellypass-tv-title-text');
    const names = this.#el('div', 'nameContainer');
    names.appendChild(this.#el('h1', 'itemName jellypass-tv-title-name', found.name));
    text.appendChild(names);
    if (found.overview) text.appendChild(this.#el('p', 'overview jellypass-tv-title-overview', found.overview));

    const actionBox = this.#el('div', 'jellypass-tv-title-action');
    const actions = this.#el('div', 'mainDetailButtons focuscontainer-x jellypass-tv-title-actions');
    const anyPickable = films.some(pickable);
    const get = anyPickable ? this.#button('jellypass-tv-title-collection-get jellypass-tv-title-primary', COLLECTION_TEXT.getAll, 'collection-get') : undefined;
    if (get) actions.appendChild(get);
    if (actions.firstChild) actionBox.appendChild(actions);
    const message = this.#el('div', 'jellypass-tv-title-message');
    message.setAttribute('role', 'status');
    message.setAttribute('tabindex', '-1');
    message.setAttribute(FOCUS_ATTR, 'message');
    if (outcome) this.#outcome(message, outcome);
    actionBox.appendChild(message);
    text.appendChild(actionBox);
    main.appendChild(text);
    parts.push(main);

    const section = this.#el('div', 'jellypass-tv-title-seasons jellypass-tv-title-collection-films padded-left padded-right');
    section.appendChild(this.#el('h2', 'sectionTitle jellypass-tv-title-seasons-heading', COLLECTION_TEXT.films));
    if (anyPickable) section.appendChild(this.#el('p', 'jellypass-tv-title-note', COLLECTION_TEXT.chooseFilms));
    const toggles: HTMLButtonElement[] = [];
    const list = this.#el('div', 'jellypass-tv-title-season-list jellypass-tv-title-film-list');
    for (const entry of films) {
      const { film, state } = entry;
      const canPick = get !== undefined && pickable(entry);
      // Drawn as the title page's season cards are (their look, focus ring and check), with the film's own classes too.
      const item = canPick
        ? this.#el('button', 'jellypass-tv-title-season jellypass-tv-title-season-pick jellypass-tv-title-film jellypass-tv-title-film-pick')
        : this.#el('div', 'jellypass-tv-title-season jellypass-tv-title-film');
      if (canPick) {
        (item as HTMLButtonElement).type = 'button';
        item.setAttribute('aria-pressed', ticked.indexOf(film.tmdbId) >= 0 ? 'true' : 'false');
        item.setAttribute('aria-label', COLLECTION_TEXT.pick(film.title));
        item.setAttribute('data-tmdb-id', String(film.tmdbId));
        item.setAttribute(FOCUS_ATTR, `film-${film.tmdbId}`);
        item.appendChild(this.#el('span', 'jellypass-tv-title-check'));
        toggles.push(item as HTMLButtonElement);
      }
      const poster = this.#el('span', 'jellypass-tv-title-film-poster');
      if (film.posterUrl) poster.appendChild(this.#image(film.posterUrl));
      item.appendChild(poster);
      item.appendChild(this.#el('span', 'jellypass-tv-title-film-name', film.title));
      if (film.year !== null) item.appendChild(this.#el('span', 'jellypass-tv-title-film-year', String(film.year)));
      if (!film.released) item.appendChild(this.#el('span', 'jellypass-tv-title-film-note', film.releaseDate ? COLLECTION_TEXT.comingOn(film.releaseDate) : COLLECTION_TEXT.notReleased));
      if (hiddenFilm(film)) item.appendChild(this.#el('span', 'jellypass-tv-title-film-note jellypass-tv-title-film-hidden', COLLECTION_TEXT.hidden));
      item.appendChild(failedFilm(entry)
        ? this.#el('span', 'jellypass-tv-title-status jellypass-tv-title-status-failed', TITLE_TEXT.failed)
        : this.#el('span', `jellypass-tv-title-status jellypass-tv-title-status-${state}`, STATE_LABELS[state]));
      list.appendChild(item);
    }
    if (!films.length) list.appendChild(this.#el('p', 'jellypass-tv-title-note', COLLECTION_TEXT.noFilms));
    section.appendChild(list);
    parts.push(section);

    if (get) this.#wire(open, found, films.map((entry) => entry.film), { get, message, toggles, defaults });
    this.#fill(open, parts);
    open.drawn = { found, outcome, shown: films.map((entry) => entry.state).join(' ') };
    if (outcome) {
      if (this.#open === open) message.focus();
      open.first = false;
    } else this.#place(open, get && !get.disabled ? get : toggles[0] ?? null);
  }

  /** What a press did: the confirmation or the failure's words, then the films asked for and those not. */
  #outcome(message: HTMLElement, outcome: Outcome): void {
    const failure = outcome.failure;
    message.className = failure ? 'jellypass-tv-title-message jellypass-tv-title-error' : 'jellypass-tv-title-message';
    let words: string = TITLE_TEXT.confirmation;
    if (failure) {
      const kind = kindOf(failure);
      words = kind === 'rate_limited' ? rateLimitedText(failure, TITLE_TEXT.rate_limited) : kind === 'offline' ? TITLE_TEXT.offline : TITLE_TEXT.unavailable;
    }
    message.appendChild(this.#el('p', 'jellypass-tv-title-collection-result', words));
    if (outcome.asked.length) message.appendChild(this.#el('p', 'jellypass-tv-title-collection-asked', COLLECTION_TEXT.asked(outcome.asked)));
    if (outcome.notAsked.length) message.appendChild(this.#el('p', 'jellypass-tv-title-collection-not-asked', COLLECTION_TEXT.notAsked(outcome.notAsked)));
  }

  /** The toggles and the one button: its label follows the ticks; a press asks for the films ticked, one call each, in order. */
  #wire(open: Open, found: Collection, films: CollectionFilm[], parts: { get: HTMLButtonElement; message: HTMLElement; toggles: HTMLButtonElement[]; defaults: number[] }): void {
    const { get, message, toggles, defaults } = parts;
    const chosen = (): number[] => toggles.filter((toggle) => toggle.getAttribute('aria-pressed') === 'true').map((toggle) => Number(toggle.getAttribute('data-tmdb-id')));
    const refresh = () => {
      const picked = chosen();
      const all = picked.length > 0 && picked.length === defaults.length && defaults.every((id) => picked.indexOf(id) >= 0);
      get.textContent = all ? COLLECTION_TEXT.getAll : COLLECTION_TEXT.getSelected(picked.length);
      get.disabled = picked.length === 0;
    };
    for (const toggle of toggles) {
      toggle.addEventListener('click', () => {
        if (toggle.disabled) return;
        toggle.setAttribute('aria-pressed', toggle.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
        refresh();
      });
    }
    refresh();
    get.addEventListener('click', () => {
      if (get.disabled || this.#open !== open) return;
      const session = this.#watch.current();
      if (!session || session.userId !== open.userId) {
        this.#end(open);
        return;
      }
      const picked = chosen();
      const wanted = films.filter((film) => picked.indexOf(film.tmdbId) >= 0);
      if (!wanted.length) return;
      open.drawn = undefined;
      get.disabled = true;
      get.textContent = TITLE_TEXT.sending;
      get.setAttribute('aria-busy', 'true');
      for (const toggle of toggles) toggle.disabled = true;
      while (message.firstChild) message.removeChild(message.firstChild);
      message.className = 'jellypass-tv-title-message';
      void this.#send(open, session, wanted).then((result) => {
        if (!result || this.#open !== open) return;
        if (result.failure && result.failure.status === 401) {
          this.#asked.forget();
          this.#host.changed();
          this.#error(open, 'unauthorized', true);
          return;
        }
        const now = this.#watch.current();
        if (!now || now.userId !== open.userId) {
          this.#end(open);
          return;
        }
        // What was done stays shown, and the collection is read again for the states.
        this.#load(open, now, result, found);
      }).catch(() => undefined);
    });
  }

  /**
   * One `POST /movie/{tmdbId}/get` per film, one after another, stopping at the first failure. An accepted film is shown
   * as requested at once (the overlay) and not offered again on this page. Undefined when the session changed meanwhile:
   * nothing more is sent, written or said.
   */
  async #send(open: Open, session: Session, films: CollectionFilm[]): Promise<Outcome | undefined> {
    const stamp = this.#watch.stamp(session);
    const outcome: Outcome = { asked: [], notAsked: [], failure: undefined };
    let index = 0;
    for (; index < films.length; index += 1) {
      const film = films[index] as CollectionFilm;
      const answer = await getThis(this.#scope.fetch, this.#origin, session.token, 'movie', film.tmdbId, []);
      const now = this.#watch.holds(stamp);
      if (!now || now.userId !== open.userId || this.#open !== open) {
        if (outcome.asked.length) this.#host.changed();
        if (this.#open === open) this.#end(open);
        return undefined;
      }
      if (!answer.ok) {
        outcome.failure = answer;
        break;
      }
      this.#asked.sync(now.userId);
      this.#asked.add(now.userId, 'movie', film.tmdbId, []);
      open.askedHere.push(film.tmdbId);
      outcome.asked.push(film.title);
    }
    for (; index < films.length; index += 1) outcome.notAsked.push((films[index] as CollectionFilm).title);
    if (outcome.asked.length) this.#host.changed();
    return outcome;
  }
}
