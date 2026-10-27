import { failedSeasons, getThis, title as readTitle, type Failure, type HouseholdState, type MediaType, type SeasonSummary, type Title } from './api.js';
import type { Asked } from './asked.js';
import { currentSession, detailsHash, type Session } from './jellyfin-web.js';
import { FOCUS_ATTR, type PageContext, type PageView } from './page-host.js';
import { STATE_LABELS } from './row.js';

/**
 * The JellyPass title page (docs/tv-addon.md, "The title page"): the household app's title page as a page of Jellyfin web
 * at `#/jellypass/title/<movie|tv>/<tmdbId>`, on the page host (page-host.ts), laid out as Jellyfin web's own item
 * details page is (poster, name, year and runtime and rating, buttons, overview, genres), with the title's backdrop
 * across the whole screen whatever Jellyfin's Backdrops setting says. It shows the title's household state in the app's
 * coarse words and one action: **Play** (Jellyfin web's own details page for the item, on this host, with Jellyfin's own
 * player) when it is in the library, or **Get this** (with a season picker for a series) when the household can ask
 * for it. "Get this" is the app's identical-outcome flow: one fixed confirmation for every accepted call, fixed words for
 * each failure, never retried by itself. Everything shown is a fixed string or a DTO field set with `textContent`.
 *
 * It is a route, so Jellyfin web's header, its Back button, its history and its focus manager are what apply: this
 * module handles no key. Back returns to where the member came from (Home's card is given focus again by the row).
 */

/** Every fixed string the page shows; the "Get this" words are the household app's (app/src/render.ts, GET_THIS_TEXT). */
export const TITLE_TEXT = {
  loading: 'Loading…',
  play: 'Play',
  getThis: 'Get this',
  sending: 'Sending…',
  seasons: 'Seasons',
  genres: 'Genres',
  chooseSeasons: 'Choose the seasons you want',
  chooseBelow: 'Choose the seasons you want below.',
  selectAll: 'Select all',
  clearAll: 'Clear all',
  confirmation: "Thanks — we'll get this for your household.",
  failed: "We couldn't get this",
  failedNote: 'Ask your JellyPass admin to try again.',
  rate_limited: 'Too many tries, try again in a few minutes.',
  offline: "You're offline. Check your connection, then try again.",
  unavailable: "We couldn't send that just now. Try again in a moment.",
  refreshFailed: 'Something went wrong. Try again in a moment.',
  tryAgain: 'Try again',
} as const;

/** What a title says besides its status when it has no button. The TV has no My requests yet, so it points to the app. */
export const STATE_NOTES = {
  unavailable: "This title can't be requested.",
  requested: 'Check My requests in the JellyPass app to follow it.',
} as const;

type ErrorKind = 'unauthorized' | 'rate_limited' | 'unavailable' | 'not_found' | 'offline';

/** The page's fixed error states, the household app's words (app/src/render.ts, ERROR_TEXT). */
export const ERROR_TEXT: Record<ErrorKind, { title: string; body: string }> = {
  unauthorized: { title: 'Sign in to continue', body: 'Your Jellyfin sign-in is missing or has expired.' },
  rate_limited: { title: 'Too many requests', body: 'Wait a minute, then try again.' },
  unavailable: { title: "Can't load this right now", body: 'Something went wrong. Try again in a moment.' },
  not_found: { title: 'Not found', body: "We couldn't find that title." },
  offline: { title: "You're offline", body: 'Check your connection, then try again.' },
};

/** The page's route on the page host, and the address a card opens it at. */
export const TITLE_PATH = '/jellypass/title/:mediaType/:tmdbId';
export function titleHash(mediaType: MediaType, tmdbId: number): string {
  return `#/jellypass/title/${mediaType}/${tmdbId}`;
}

/** Marks the page's content (one at most is ever on the page). */
export const VIEW_ATTRIBUTE = 'data-jellypass-tv-title';
/** The header's title until the title is known. */
const PAGE_TITLE = 'JellyPass';

function kindOf(failure: Failure): ErrorKind {
  if (failure.status === 0) return 'offline';
  if (failure.status === 401) return 'unauthorized';
  if (failure.status === 404) return 'not_found';
  if (failure.status === 429) return 'rate_limited';
  return 'unavailable';
}

function runtimeText(minutes: number | null): string {
  if (!minutes) return '';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} h${rest ? ` ${rest} min` : ''}` : `${rest} min`;
}

interface Scope {
  ApiClient?: unknown;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

/** What the page asks of the page around it. */
export interface TitleHost {
  /** The overlay changed (a "Get this" was accepted, or it was forgotten): the Home row redraws its statuses. */
  changed(): void;
  /** Opens Jellyfin web's own page at `hash` (Play). */
  navigate(hash: string): void;
}

/** The title a route names. */
export interface Chosen {
  mediaType: MediaType;
  tmdbId: number;
}

interface Open {
  chosen: Chosen;
  userId: string;
  context: PageContext;
  /** The page's content, in the host's container. */
  view: HTMLElement;
  /** The part redrawn on each answer (the backdrop included). */
  body: HTMLElement;
  /** Bumped by every load and by leaving, so an answer that comes late for a page since redrawn or left is dropped. */
  load: number;
  /** Until the first thing is drawn: focus then is given through the host, which leaves it alone once the member has moved it. */
  first: boolean;
  /** Seasons (0 for a movie) asked for on this page: not offered again while it is open, whatever the overlay says. */
  askedHere: number[];
  /** The last element on the page that had focus, given back when it is drawn again in place. */
  lastFocus: Element | undefined;
  /** The answer the page is drawn from, while it can be drawn again from it alone (not loading, failed or sending). */
  drawn: Drawn | undefined;
}

interface Drawn {
  found: Title;
  failed: number[];
  confirmed: boolean;
  /** Drawn with the note and retry of an accepted "Get this" whose page could not be read again. */
  refreshFailed: boolean;
  /** The statuses drawn (the title's, then each season's), to tell whether the overlay now shows otherwise. */
  shown: string;
}

/** What survives the page being drawn again in place: where focus was, and the seasons ticked. */
interface Kept {
  focus: Element | undefined;
  picked: number[];
  refreshFailed: boolean;
}

/** The classes that name a button (or the message) on the page, for finding its new self after a redraw. */
const FOCUS_CLASSES = ['jellypass-tv-title-play', 'jellypass-tv-title-get', 'jellypass-tv-title-select-all', 'jellypass-tv-title-retry', 'jellypass-tv-title-message'];

export class TitlePage {
  readonly #document: Document;
  readonly #scope: Scope;
  readonly #origin: string;
  readonly #asked: Asked;
  readonly #host: TitleHost;
  #open: Open | undefined;
  #loads = 0;

  public constructor(document: Document, scope: Scope, origin: string, asked: Asked, host: TitleHost) {
    this.#document = document;
    this.#scope = scope;
    this.#origin = origin;
    this.#asked = asked;
    this.#host = host;
  }

  public get isOpen(): boolean {
    return this.#open !== undefined;
  }

  /**
   * The page host's render for the route: draws into the container and reads the title (signed in to this origin only):
   * two calls, the app's title page's. A title that is not a number, or no sign-in, calls nothing.
   */
  public render(context: PageContext): PageView {
    const cleanup = () => this.#leave(context);
    const session = this.#session();
    if (!session) return { title: PAGE_TITLE, cleanup };
    const view = this.#el('div', 'jellypass-tv-title-page');
    view.setAttribute(VIEW_ATTRIBUTE, '');
    const body = this.#el('div', 'jellypass-tv-title-body');
    view.appendChild(body);
    context.container.appendChild(view);
    const chosen = chosenOf(context.params);
    const open: Open = { chosen: chosen ?? { mediaType: 'movie', tmdbId: 0 }, userId: session.userId, context, view, body, load: 0, first: true, askedHere: [], lastFocus: undefined, drawn: undefined };
    view.addEventListener('focusin', (event) => {
      open.lastFocus = event.target as Element;
    });
    this.#open = open;
    if (!chosen) this.#error(open, 'not_found', false);
    else this.#load(open, session, false);
    return { title: PAGE_TITLE, cleanup };
  }

  /** The page is left: what is in flight is dropped. */
  #leave(context: PageContext): void {
    const open = this.#open;
    if (!open || open.context !== context) return;
    this.#open = undefined;
    open.load = -1;
  }

  /** Called on every page change: signed out, or another member signed in, the page is emptied and nothing more is read or sent. */
  public update(): void {
    const open = this.#open;
    if (!open) return;
    const session = this.#session();
    if (session && session.userId === open.userId && open.view.parentNode) return;
    // Signed out or another member: what was asked for here is forgotten with the page, wherever Jellyfin web goes next.
    this.#asked.sync(session ? session.userId : undefined);
    this.#end(open);
  }

  #end(open: Open): void {
    if (this.#open !== open) return;
    this.#open = undefined;
    open.load = -1;
    if (open.view.parentNode) open.view.parentNode.removeChild(open.view);
  }

  /**
   * A Requested ran out while the page was left open (asked.ts): if that changes what it shows, it is drawn again from
   * the answer it holds, with no call, keeping focus and the seasons ticked. Not while loading, failed or sending.
   */
  public overlayExpired(): void {
    const open = this.#open;
    const drawn = open ? open.drawn : undefined;
    if (!open || !drawn || this.#shown(drawn.found) === drawn.shown) return;
    const picked = Array.prototype.slice.call(open.body.querySelectorAll('.jellypass-tv-title-season-pick[aria-pressed="true"]')) as Element[];
    const focus = open.lastFocus && open.body.contains(open.lastFocus) ? open.lastFocus : undefined;
    this.#draw(open, drawn.found, drawn.failed, drawn.confirmed, { focus, picked: picked.map((toggle) => Number(toggle.getAttribute('data-season'))), refreshFailed: drawn.refreshFailed });
  }

  /** The statuses the overlay gives a title and its seasons now, as `Drawn.shown`. */
  #shown(found: Title): string {
    const states = [this.#asked.state(found.mediaType, found.tmdbId, found.state)];
    for (const season of found.seasons) states.push(this.#asked.state(found.mediaType, found.tmdbId, season.state, season.seasonNumber));
    return states.join(' ');
  }

  #session(): Session | undefined {
    const session = currentSession(this.#scope);
    return session && session.origin === this.#origin ? session : undefined;
  }

  #el(tag: string, className: string, text?: string): HTMLElement {
    const node = this.#document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** A button in Jellyfin web's own look (`emby-button raised`, `button-submit` for the primary one), with its focus ring on a TV. */
  #button(className: string, text: string, focusKey: string): HTMLButtonElement {
    const primary = className.indexOf('jellypass-tv-title-primary') >= 0;
    const tv = this.#document.documentElement.classList.contains('layout-tv');
    const button = this.#el('button', `emby-button raised ${primary ? 'button-submit ' : ''}${tv ? 'show-focus ' : ''}jellypass-tv-title-button ${className}`, text) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute(FOCUS_ATTR, focusKey);
    return button;
  }

  /** The page's body replaced by `parts`. */
  #fill(open: Open, parts: HTMLElement[]): void {
    const body = open.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    for (const part of parts) body.appendChild(part);
  }

  /** A state with nothing but words (loading, an error): padded as Jellyfin's pages are. */
  #state(...parts: HTMLElement[]): HTMLElement {
    const box = this.#el('div', 'jellypass-tv-title-state padded-left padded-right');
    for (const part of parts) box.appendChild(part);
    return box;
  }

  /**
   * Reads the title and the household's requests (for a failed request's note) together, then draws it. After an
   * accepted "Get this" (`confirmed`), the confirmation stays whatever the read does, and `before` (what the page was
   * drawn from when it was sent) is what a Requested running out draws it again from if the read fails.
   */
  #load(open: Open, session: Session, confirmed: boolean, before?: Drawn): void {
    const load = ++this.#loads;
    open.load = load;
    if (!confirmed) open.drawn = undefined;
    const { mediaType, tmdbId } = open.chosen;
    if (!confirmed) this.#fill(open, [this.#state(this.#el('p', 'jellypass-tv-title-loading', TITLE_TEXT.loading))]);
    const fetcher = this.#scope.fetch;
    void Promise.all([
      readTitle(fetcher, this.#origin, session.token, mediaType, tmdbId),
      failedSeasons(fetcher, this.#origin, session.token, mediaType, tmdbId),
    ]).then(([answer, failed]) => {
      if (open.load !== load || this.#open !== open) return;
      const now = this.#session();
      if (!now || now.userId !== open.userId) {
        this.#end(open);
        return;
      }
      // A refused token is nobody's: whatever was shown as requested for it is dropped, whichever of the two reads was
      // refused. A failed requests read is otherwise only a note left out, as in the app.
      const refused = (!answer.ok && answer.status === 401) || (!failed.ok && failed.status === 401);
      if (refused) this.#forget();
      if (!answer.ok || refused) {
        if (confirmed) this.#refreshFailed(open, refused, before);
        else this.#error(open, refused ? 'unauthorized' : kindOf(answer as Failure), true);
        return;
      }
      this.#asked.sync(now.userId);
      open.context.setTitle(answer.title.title);
      this.#draw(open, answer.title, failed.ok ? failed.failed : [], confirmed);
    }).catch(() => undefined);
  }

  #forget(): void {
    this.#asked.forget();
    this.#host.changed();
  }

  /** A fixed error state, with a retry that only reads the page again (never sends anything). */
  #error(open: Open, kind: ErrorKind, canRetry: boolean): void {
    open.drawn = undefined;
    const text = ERROR_TEXT[kind];
    const parts = [this.#el('p', 'jellypass-tv-title-error', text.title), this.#el('p', 'jellypass-tv-title-note', text.body)];
    let retry: HTMLButtonElement | undefined;
    if (kind !== 'unauthorized' && canRetry) {
      retry = this.#button('jellypass-tv-title-retry', TITLE_TEXT.tryAgain, 'retry');
      retry.addEventListener('click', () => this.#reload(open));
      const actions = this.#el('div', 'jellypass-tv-title-actions');
      actions.appendChild(retry);
      parts.push(actions);
    }
    this.#fill(open, [this.#state(...parts)]);
    this.#place(open, retry ?? null);
  }

  /**
   * After an accepted "Get this" whose page could not be read again: the confirmation stays, with a retry that only
   * reads. A Requested running out still draws it again, from the answer it was drawn from before (`before`, with what it
   * shows now), keeping the confirmation and the retry; not after a refused token, whose overlay is gone.
   */
  #refreshFailed(open: Open, refused: boolean, before: Drawn | undefined): void {
    open.drawn = before && !refused ? { found: before.found, failed: before.failed, confirmed: true, refreshFailed: true, shown: before.shown } : undefined;
    const message = open.body.querySelector('.jellypass-tv-title-message');
    const box = message ? message.parentNode : null;
    if (!box || open.body.querySelector('.jellypass-tv-title-refresh')) return;
    this.#refreshNote(open, box, refused);
  }

  #refreshNote(open: Open, box: Node, refused: boolean): void {
    box.appendChild(this.#el('p', 'jellypass-tv-title-note jellypass-tv-title-refresh', refused ? ERROR_TEXT.unauthorized.body : TITLE_TEXT.refreshFailed));
    if (refused) return;
    const retry = this.#button('jellypass-tv-title-retry', TITLE_TEXT.tryAgain, 'retry');
    retry.addEventListener('click', () => this.#reload(open));
    box.appendChild(retry);
  }

  #reload(open: Open): void {
    const session = this.#session();
    if (this.#open !== open) return;
    if (!session || session.userId !== open.userId) {
      this.#end(open);
      return;
    }
    this.#load(open, session, false);
  }

  /** Focus after a change the member made: given straight to the element. */
  #focus(open: Open, element: Element | null): void {
    if (element && this.#open === open) (element as HTMLElement).focus();
  }

  /**
   * Focus for what a read draws: the first time through the page host, so what had focus when the page was last left
   * (Back from Play) gets it again, and nothing is taken from a member who has already moved focus on this page. After
   * that, a change the member made (Try again) is their focus to give back, straight.
   */
  #place(open: Open, element: HTMLElement | null): void {
    if (this.#open !== open) return;
    if (open.first) {
      open.first = false;
      open.context.focus(element);
    } else if (element) element.focus();
  }

  /** Draws the page from an answer; `kept` when it is drawn again in place (overlayExpired). */
  #draw(open: Open, found: Title, failed: number[], confirmed: boolean, kept?: Kept): void {
    const asked = this.#asked;
    const state: HouseholdState = asked.state(found.mediaType, found.tmdbId, found.state);
    const seasons: SeasonSummary[] = found.seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      name: season.name,
      episodeCount: season.episodeCount,
      state: asked.state(found.mediaType, found.tmdbId, season.state, season.seasonNumber),
    }));
    const askedHere = open.askedHere;
    const isFailed = (season: number, seasonState: HouseholdState) => seasonState === 'get_this' && failed.indexOf(season) >= 0;
    const failedMovie = found.mediaType === 'movie' && isFailed(0, state);
    const failedAny = failedMovie || seasons.some((season) => isFailed(season.seasonNumber, season.state));
    // What "Get this" can ask for here: the movie, or the series' seasons the household can ask for (specials aside).
    const movieChoice = found.mediaType === 'movie' && state === 'get_this' && !failedMovie && askedHere.indexOf(0) < 0;
    const seasonChoices = found.mediaType === 'tv'
      ? seasons.filter((season) => season.state === 'get_this' && season.seasonNumber >= 1 && askedHere.indexOf(season.seasonNumber) < 0 && !isFailed(season.seasonNumber, season.state))
      : [];
    // After an accepted "Get this" whose page could not be read again, nothing here sends until Try again reads it.
    const refreshFailed = kept !== undefined && kept.refreshFailed;
    const canGet = !refreshFailed && (movieChoice || seasonChoices.length > 0);

    const parts: HTMLElement[] = [];
    // Always drawn, whatever Jellyfin web's own Backdrops setting says (it is read nowhere here).
    const backdrop = this.#el('div', 'jellypass-tv-title-backdrop');
    if (found.backdropUrl) backdrop.appendChild(this.#image(found.backdropUrl));
    parts.push(backdrop);

    // As Jellyfin web's item details page: the poster on the left, then name, facts, buttons and overview.
    const main = this.#el('div', 'jellypass-tv-title-main padded-left padded-right');
    const poster = this.#el('span', 'jellypass-tv-title-poster');
    if (found.posterUrl) poster.appendChild(this.#image(found.posterUrl));
    main.appendChild(poster);
    const text = this.#el('div', 'jellypass-tv-title-text');
    const names = this.#el('div', 'nameContainer');
    names.appendChild(this.#el('h1', 'itemName jellypass-tv-title-name', found.title));
    text.appendChild(names);
    const facts = this.#el('div', 'itemMiscInfo itemMiscInfo-primary jellypass-tv-title-facts');
    const fact = (words: string) => facts.appendChild(this.#el('div', 'mediaInfoItem jellypass-tv-title-fact', words));
    if (found.year !== null) fact(String(found.year));
    const seasonCount = seasons.filter((season) => season.seasonNumber >= 1).length;
    const length = seasonCount > 0 ? `${seasonCount} ${seasonCount === 1 ? 'season' : 'seasons'}` : found.mediaType === 'movie' ? runtimeText(found.runtime) : '';
    if (length) fact(length);
    if (found.rating !== null) fact(`★ ${found.rating.toFixed(1)} TMDB`);
    facts.appendChild(failedMovie
      ? this.#el('div', 'mediaInfoItem jellypass-tv-title-status jellypass-tv-title-status-failed', TITLE_TEXT.failed)
      : this.#el('div', `mediaInfoItem jellypass-tv-title-status jellypass-tv-title-status-${state}`, STATE_LABELS[state]));
    text.appendChild(facts);

    const actions = this.#el('div', 'mainDetailButtons focuscontainer-x jellypass-tv-title-actions');
    const play = state === 'in_library' && found.playItemId ? this.#button('jellypass-tv-title-play jellypass-tv-title-primary', TITLE_TEXT.play, 'play') : undefined;
    if (play) {
      const itemId = found.playItemId as string;
      play.setAttribute('aria-label', `${TITLE_TEXT.play} ${found.title}`);
      play.addEventListener('click', () => {
        if (this.#open !== open) return;
        this.#host.navigate(detailsHash(itemId));
      });
      actions.appendChild(play);
    }
    const message = this.#el('p', 'jellypass-tv-title-message', confirmed ? TITLE_TEXT.confirmation : undefined);
    message.setAttribute('role', 'status');
    message.setAttribute('tabindex', '-1');
    message.setAttribute(FOCUS_ATTR, 'message');
    // A series partly in the library keeps Play as its primary; Get this steps back beside it, as in the app.
    const get = canGet ? this.#button(play ? 'jellypass-tv-title-get jellypass-tv-title-secondary' : 'jellypass-tv-title-get jellypass-tv-title-primary', TITLE_TEXT.getThis, 'get') : undefined;
    const picking = found.mediaType === 'tv';
    const hint = get && picking ? this.#el('p', 'jellypass-tv-title-hint', TITLE_TEXT.chooseBelow) : undefined;
    if (get) {
      get.setAttribute('aria-label', `${TITLE_TEXT.getThis}: ${found.title}`);
      actions.appendChild(get);
    }
    const actionBox = this.#el('div', 'jellypass-tv-title-action');
    if (actions.firstChild) actionBox.appendChild(actions);
    if (hint) actionBox.appendChild(hint);
    actionBox.appendChild(message);
    if (refreshFailed) this.#refreshNote(open, actionBox, false);
    text.appendChild(actionBox);
    if (state === 'unavailable' || state === 'requested') text.appendChild(this.#el('p', 'jellypass-tv-title-note', STATE_NOTES[state]));
    if (failedAny) text.appendChild(this.#el('p', 'jellypass-tv-title-note', TITLE_TEXT.failedNote));
    if (found.overview) text.appendChild(this.#el('p', 'overview jellypass-tv-title-overview', found.overview));
    if (found.genres.length) {
      const group = this.#el('div', 'itemDetailsGroup jellypass-tv-title-details');
      const row = this.#el('div', 'detailsGroupItem');
      row.appendChild(this.#el('div', 'label', TITLE_TEXT.genres));
      row.appendChild(this.#el('div', 'jellypass-tv-title-genres', found.genres.join(', ')));
      group.appendChild(row);
      text.appendChild(group);
    }
    main.appendChild(text);
    parts.push(main);

    // The seasons: each a card with its status; the ones the household can ask for are toggles (aria-pressed).
    const toggles: HTMLButtonElement[] = [];
    let selectAll: HTMLButtonElement | undefined;
    if (found.mediaType === 'tv') {
      const section = this.#el('div', 'jellypass-tv-title-seasons padded-left padded-right');
      section.appendChild(this.#el('h2', 'sectionTitle jellypass-tv-title-seasons-heading', TITLE_TEXT.seasons));
      if (get) {
        section.appendChild(this.#el('p', 'jellypass-tv-title-note', TITLE_TEXT.chooseSeasons));
        if (seasonChoices.length > 1) {
          selectAll = this.#button('jellypass-tv-title-select-all jellypass-tv-title-secondary', TITLE_TEXT.selectAll, 'select-all');
          section.appendChild(selectAll);
        }
      }
      const list = this.#el('div', 'jellypass-tv-title-season-list');
      for (const season of seasons) {
        const name = season.name || `Season ${season.seasonNumber}`;
        const pickable = get !== undefined && seasonChoices.indexOf(season) >= 0;
        const item = pickable ? this.#el('button', 'jellypass-tv-title-season jellypass-tv-title-season-pick') : this.#el('div', 'jellypass-tv-title-season');
        if (pickable) {
          (item as HTMLButtonElement).type = 'button';
          item.setAttribute('aria-pressed', kept && kept.picked.indexOf(season.seasonNumber) >= 0 ? 'true' : 'false');
          item.setAttribute('data-season', String(season.seasonNumber));
          item.setAttribute(FOCUS_ATTR, `season-${season.seasonNumber}`);
          item.appendChild(this.#el('span', 'jellypass-tv-title-check'));
          toggles.push(item as HTMLButtonElement);
        }
        item.appendChild(this.#el('span', 'jellypass-tv-title-season-name', name));
        if (season.episodeCount !== null) {
          item.appendChild(this.#el('span', 'jellypass-tv-title-season-count', `${season.episodeCount} ${season.episodeCount === 1 ? 'episode' : 'episodes'}`));
        }
        item.appendChild(isFailed(season.seasonNumber, season.state)
          ? this.#el('span', 'jellypass-tv-title-status jellypass-tv-title-status-failed', TITLE_TEXT.failed)
          : this.#el('span', `jellypass-tv-title-status jellypass-tv-title-status-${season.state}`, STATE_LABELS[season.state]));
        list.appendChild(item);
      }
      section.appendChild(list);
      parts.push(section);
    }

    if (get) this.#wireGetThis(open, found, { get, hint, message, toggles, selectAll, picking });
    this.#fill(open, parts);
    open.drawn = { found, failed, confirmed, refreshFailed, shown: [state].concat(seasons.map((season) => season.state)).join(' ') };
    const again = kept && kept.focus ? this.#same(open, kept.focus) : null;
    if (again) this.#focus(open, again);
    else if (confirmed) this.#focus(open, message);
    else this.#place(open, play ?? (get && !get.disabled ? get : toggles[0]) ?? null);
  }

  /** On a page just drawn again, the element standing for `before` (the same season, or the same button), if any. */
  #same(open: Open, before: Element): Element | null {
    const season = before.getAttribute('data-season');
    if (season !== null) return open.body.querySelector(`[data-season="${Number(season)}"]`);
    for (const name of FOCUS_CLASSES) if (before.classList.contains(name)) return open.body.querySelector(`.${name}`);
    return null;
  }

  #image(url: string): HTMLImageElement {
    const image = this.#document.createElement('img');
    image.setAttribute('alt', '');
    image.setAttribute('referrerpolicy', 'no-referrer');
    image.setAttribute('src', url);
    return image;
  }

  /**
   * "Get this": the button is disabled while its one call is out (and, for a series, until a season is chosen). An
   * accepted call shows the one fixed confirmation at once, marks the title (and seasons) requested in the overlay, and
   * reads the page again; a failure shows its fixed words and offers the button again. Nothing is ever sent by itself.
   */
  #wireGetThis(open: Open, found: Title, parts: { get: HTMLButtonElement; hint: HTMLElement | undefined; message: HTMLElement; toggles: HTMLButtonElement[]; selectAll: HTMLButtonElement | undefined; picking: boolean }): void {
    const { get, hint, message, toggles, selectAll, picking } = parts;
    const chosen = (): number[] => toggles.filter((toggle) => toggle.getAttribute('aria-pressed') === 'true').map((toggle) => Number(toggle.getAttribute('data-season')));
    const refresh = () => {
      const count = chosen().length;
      get.disabled = picking && count === 0;
      if (hint) hint.hidden = count > 0;
      if (selectAll) selectAll.textContent = count === toggles.length ? TITLE_TEXT.clearAll : TITLE_TEXT.selectAll;
    };
    for (const toggle of toggles) {
      toggle.addEventListener('click', () => {
        if (toggle.disabled) return;
        toggle.setAttribute('aria-pressed', toggle.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
        refresh();
      });
    }
    // Select all only moves the checkmarks; "Get this" is still the one thing that asks.
    if (selectAll) {
      selectAll.addEventListener('click', () => {
        const next = chosen().length === toggles.length ? 'false' : 'true';
        for (const toggle of toggles) toggle.setAttribute('aria-pressed', next);
        refresh();
      });
    }
    refresh();
    get.addEventListener('click', () => {
      if (get.disabled || this.#open !== open) return;
      const session = this.#session();
      if (!session || session.userId !== open.userId) {
        this.#end(open);
        return;
      }
      const seasons = picking ? chosen() : [];
      // Not drawn again while the call is out: its answer decides what the page shows next.
      const drawn = open.drawn;
      open.drawn = undefined;
      get.disabled = true;
      for (const toggle of toggles) toggle.disabled = true;
      if (selectAll) selectAll.disabled = true;
      get.textContent = TITLE_TEXT.sending;
      get.setAttribute('aria-busy', 'true');
      message.className = 'jellypass-tv-title-message';
      message.textContent = '';
      const { mediaType, tmdbId } = found;
      void getThis(this.#scope.fetch, this.#origin, session.token, mediaType, tmdbId, seasons).then((answer) => {
        if (answer.ok) {
          // Shown as requested while the server records it, only for the member who asked (not if the sign-in changed).
          const now = this.#session();
          if (now && now.userId === session.userId) {
            this.#asked.sync(now.userId);
            this.#asked.add(now.userId, mediaType, tmdbId, seasons);
          }
          this.#host.changed();
          if (this.#open !== open) return;
          for (const season of seasons.length ? seasons : [0]) open.askedHere.push(season);
          // The confirmation at once, whatever the read that follows does; nothing left here can send again.
          message.textContent = TITLE_TEXT.confirmation;
          for (const node of [get, hint, selectAll]) if (node && node.parentNode) node.parentNode.removeChild(node);
          for (const toggle of toggles) toggle.setAttribute('aria-pressed', 'false');
          this.#focus(open, message);
          if (now && now.userId === open.userId) this.#load(open, now, true, drawn);
          else this.#end(open);
          return;
        }
        if (this.#open !== open) return;
        if (answer.status === 401) {
          this.#forget();
          this.#error(open, 'unauthorized', true);
          return;
        }
        open.drawn = drawn;
        const kind = kindOf(answer);
        message.className = 'jellypass-tv-title-message jellypass-tv-title-error';
        message.textContent = kind === 'rate_limited' ? TITLE_TEXT.rate_limited : kind === 'offline' ? TITLE_TEXT.offline : TITLE_TEXT.unavailable;
        get.textContent = TITLE_TEXT.getThis;
        get.removeAttribute('aria-busy');
        for (const toggle of toggles) toggle.disabled = false;
        if (selectAll) selectAll.disabled = false;
        refresh();
        this.#focus(open, get.disabled ? toggles[0] ?? null : get);
      }).catch(() => undefined);
    });
  }
}

/** The title a route's params name: `movie` or `tv`, and a TMDB id as the API has them (digits, no leading zero). */
function chosenOf(params: { [name: string]: string }): Chosen | undefined {
  const mediaType = params.mediaType;
  const id = params.tmdbId;
  if ((mediaType !== 'movie' && mediaType !== 'tv') || !id || !/^[1-9][0-9]{0,9}$/.test(id)) return undefined;
  return { mediaType, tmdbId: Number(id) };
}
