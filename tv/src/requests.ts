import { cancelRequest, requests as readRequests, title as readTitle, type Failure, type RequestEntry } from './api.js';
import type { Asked } from './asked.js';
import { currentSession, type Session } from './jellyfin-web.js';
import { FOCUS_ATTR, type PageContext, type PageView } from './page-host.js';
import {
  CANCEL_TEXT,
  matchesRequestFilter,
  NO_REQUEST_FILTER,
  REQUEST_FILTER_TEXT,
  REQUEST_KIND_FILTERS,
  REQUEST_LABELS,
  REQUEST_STATUS_FILTERS,
  requestedOnText,
  requestFilterActive,
  requestFilterEmptyText,
  requestPills,
  REQUESTS_TEXT,
  type RequestFilter,
} from './requests-model.js';
import { ERROR_TEXT, kindOf, titleHash, type ErrorKind } from './title.js';
import { TitleCache } from './titles.js';

/**
 * The JellyPass My requests page (docs/tv-addon.md, "My requests"): the household app's My requests as a page of Jellyfin
 * web's at `#/jellypass/requests`, on the page host (page-host.ts), under Jellyfin's real header and Back. It lists the
 * household's requests from `GET /requests` with the coarse statuses (one pill per request, as the app's #87 rule has
 * it), who asked and the day, names them from their titles ten at a time (a title named in the last ten minutes of this
 * sign-in is reused), filters them without a call (status, type, "Asked by me"), and offers **Cancel request** on the
 * entries the server marks cancellable, after a confirmation that a remote can answer. Choosing an entry opens the
 * JellyPass title page; Back returns here with the entry focused (the page host remembers it).
 *
 * It is a route, so Jellyfin web's header, Back, history and focus manager are what apply: this module handles no key.
 * Everything shown is a fixed string or a DTO field set with `textContent`; an image is only the API's TMDB poster URL.
 * Nothing is sent by itself: a cancel is one POST and is never repeated.
 */

/** "My requests" names its titles from TMDB a few at a time, so a long list is never a burst of calls. */
export const REQUESTS_PER_PAGE = 10;
/** How many of those title calls are out at once. */
export const REQUEST_TITLE_CALLS = 4;

/** Marks the page's content (one at most is ever on the page). */
export const REQUESTS_ATTRIBUTE = 'data-jellypass-tv-requests';

interface Scope {
  ApiClient?: unknown;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

/** What the page asks of the page around it. */
export interface RequestsHost {
  /** The overlay changed (a cancel was accepted, or it was forgotten): the rows redraw their statuses. */
  changed(): void;
  /** Opens Jellyfin web's page at `hash` (a title). */
  navigate(hash: string): void;
}

interface Row {
  entry: RequestEntry;
  item: HTMLElement;
  name: HTMLElement;
  meta: HTMLElement;
  kind: string;
  poster: HTMLElement;
  cancel: HTMLElement | undefined;
}

interface Open {
  userId: string;
  context: PageContext;
  /** The page's content, in the host's container. */
  view: HTMLElement;
  /** The part redrawn on each answer. */
  body: HTMLElement;
  /** Bumped by every list read and by leaving, so an answer that comes late for a page since redrawn or left is dropped. */
  load: number;
  /** Until the first thing is drawn: focus then is given through the host, which leaves it alone once the member has moved it. */
  first: boolean;
  /** The list as last read (less what was cancelled since), and how many of it are drawn. */
  entries: RequestEntry[];
  shown: number;
  rows: Row[];
  /** The confirmation of an accepted cancel, kept through the redraws until the page is left. */
  notice: string | undefined;
}

export class RequestsPage {
  readonly #document: Document;
  readonly #scope: Scope;
  readonly #origin: string;
  readonly #asked: Asked;
  readonly #host: RequestsHost;
  readonly #titles: TitleCache;
  /** The member everything below belongs to: another member, or no one, forgets it (all of it in memory only). */
  #owner: string | undefined;
  #filter: RequestFilter = { ...NO_REQUEST_FILTER };
  /** How many requests were drawn when the page was last left, so Back draws them at once (their titles are kept). */
  #drawnCount = 0;
  #open: Open | undefined;
  #loads = 0;
  /** The session last seen by `update` (member and token), and a count bumped whenever it changes: a cancel answers only to its own. */
  #sessionKey: string | undefined;
  #generation = 0;

  public constructor(document: Document, scope: Scope, origin: string, asked: Asked, host: RequestsHost, now: () => number, wall: () => number) {
    this.#document = document;
    this.#scope = scope;
    this.#origin = origin;
    this.#asked = asked;
    this.#host = host;
    this.#titles = new TitleCache(now, wall);
  }

  public get isOpen(): boolean {
    return this.#open !== undefined;
  }

  /** The member this page's memory (filters, names, how much was shown) is kept for; another member's starts afresh. */
  #member(userId: string | undefined): void {
    if (userId === this.#owner) return;
    this.#owner = userId;
    this.#filter = { ...NO_REQUEST_FILTER };
    this.#drawnCount = 0;
    this.#titles.forget();
  }

  /**
   * Called on every page change: signed out, or another member signed in, the filters and the names are forgotten, the
   * page (if open) is emptied, and nothing more is read or sent.
   */
  public update(): void {
    const session = this.#session();
    const key = session ? `${session.userId}\n${session.token}` : undefined;
    if (key !== this.#sessionKey) {
      // Any sign-out, new sign-in or token change ends the cancels still in flight: they belong to the session that sent them.
      this.#sessionKey = key;
      this.#generation += 1;
    }
    // Whether or not the page is open, another member (or no one) forgets the filters, the names and how much was shown.
    this.#member(session ? session.userId : undefined);
    const open = this.#open;
    if (!session) {
      if (open) this.#end(open);
      return;
    }
    if (!open) return;
    if (session.userId !== open.userId || !open.view.parentNode) {
      this.#asked.sync(session.userId);
      this.#end(open);
    }
  }

  #session(): Session | undefined {
    const session = currentSession(this.#scope);
    return session && session.origin === this.#origin ? session : undefined;
  }

  /** The page host's render for the route: draws into the container and reads the list (signed in to this origin only). */
  public render(context: PageContext): PageView {
    const cleanup = () => this.#leave(context);
    const session = this.#session();
    if (!session) return { title: REQUESTS_TEXT.title, cleanup };
    this.#member(session.userId);
    const view = this.#el('div', 'jellypass-tv-requests-page padded-left padded-right');
    view.setAttribute(REQUESTS_ATTRIBUTE, '');
    const body = this.#el('div', 'jellypass-tv-requests-body');
    view.appendChild(body);
    context.container.appendChild(view);
    const open: Open = { userId: session.userId, context, view, body, load: 0, first: true, entries: [], shown: 0, rows: [], notice: undefined };
    this.#open = open;
    this.#load(open, session);
    return { title: REQUESTS_TEXT.title, cleanup };
  }

  /** The page is left: what is in flight is dropped, and how much was drawn is remembered for Back. */
  #leave(context: PageContext): void {
    const open = this.#open;
    if (!open || open.context !== context) return;
    this.#drawnCount = open.shown;
    this.#open = undefined;
    open.load = -1;
  }

  #end(open: Open): void {
    if (this.#open !== open) return;
    this.#open = undefined;
    open.load = -1;
    if (open.view.parentNode) open.view.parentNode.removeChild(open.view);
  }

  #el(tag: string, className: string, text?: string): HTMLElement {
    const node = this.#document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** A button in Jellyfin web's own look (`emby-button raised`), with its focus ring on a TV. */
  #button(className: string, text: string, focusKey: string): HTMLButtonElement {
    const tv = this.#document.documentElement.classList.contains('layout-tv');
    const button = this.#el('button', `emby-button raised ${tv ? 'show-focus ' : ''}jellypass-tv-requests-button ${className}`, text) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute(FOCUS_ATTR, focusKey);
    return button;
  }

  #fill(open: Open, parts: HTMLElement[]): void {
    const body = open.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    for (const part of parts) body.appendChild(part);
  }

  #heading(): HTMLElement {
    return this.#el('h1', 'sectionTitle jellypass-tv-requests-heading', REQUESTS_TEXT.title);
  }

  /** Focus for what a read draws: through the page host the first time (Back's remembered element wins), then straight. */
  #place(open: Open, element: HTMLElement | null): void {
    if (this.#open !== open) return;
    if (open.first) {
      open.first = false;
      open.context.focus(element);
    } else if (element) element.focus();
  }

  #forget(): void {
    this.#titles.forget();
    this.#asked.forget();
    this.#host.changed();
  }

  /**
   * Reads the household's requests (one call) and draws them: `notice` is the confirmation of a cancel just accepted,
   * which stays whatever this read does.
   */
  #load(open: Open, session: Session, notice?: string): void {
    const load = ++this.#loads;
    open.load = load;
    if (notice === undefined) this.#fill(open, [this.#heading(), this.#el('p', 'jellypass-tv-requests-loading', REQUESTS_TEXT.loadingList)]);
    void readRequests(this.#scope.fetch, this.#origin, session.token).then((answer) => {
      if (open.load !== load || this.#open !== open) return;
      const now = this.#session();
      if (!now || now.userId !== open.userId) {
        this.#end(open);
        return;
      }
      if (!answer.ok) {
        // A refused token is nobody's: what was shown as requested for it, and the names, are dropped.
        if (answer.status === 401) this.#forget();
        this.#failed(open, answer, notice);
        return;
      }
      this.#asked.sync(now.userId);
      open.entries = answer.entries;
      this.#draw(open, notice);
    }).catch(() => undefined);
  }

  /**
   * A list that could not be read: the app's fixed error state with a retry that only reads. After an accepted cancel
   * the confirmation stays, with the one fixed refresh note and the retry (none for a refused token).
   */
  #failed(open: Open, failure: Failure, notice: string | undefined): void {
    const kind: ErrorKind = kindOf(failure);
    const parts: HTMLElement[] = [this.#heading()];
    const box = this.#el('div', 'jellypass-tv-requests-state');
    let focus: HTMLElement | null = null;
    if (notice !== undefined) {
      const message = this.#el('p', 'jellypass-tv-requests-message', notice);
      message.setAttribute('role', 'status');
      message.setAttribute('tabindex', '-1');
      box.appendChild(message);
      box.appendChild(this.#el('p', 'jellypass-tv-requests-note', kind === 'unauthorized' ? ERROR_TEXT.unauthorized.body : REQUESTS_TEXT.refreshFailed));
      focus = message;
    } else {
      box.appendChild(this.#el('p', 'jellypass-tv-requests-error', ERROR_TEXT[kind].title));
      box.appendChild(this.#el('p', 'jellypass-tv-requests-note', ERROR_TEXT[kind].body));
    }
    if (kind !== 'unauthorized') {
      const retry = this.#button('jellypass-tv-requests-retry jellypass-tv-requests-secondary', REQUESTS_TEXT.tryAgain, 'retry');
      retry.addEventListener('click', () => this.#reload(open, notice));
      box.appendChild(retry);
      if (notice === undefined) focus = retry;
    }
    parts.push(box);
    this.#fill(open, parts);
    this.#place(open, focus);
  }

  #reload(open: Open, notice: string | undefined): void {
    const session = this.#session();
    if (this.#open !== open) return;
    if (!session || session.userId !== open.userId) {
      this.#end(open);
      return;
    }
    this.#load(open, session, notice);
  }

  /** Draws the list: the filters, the first entries (as many as were drawn before, at least ten), and Load more. */
  #draw(open: Open, notice: string | undefined): void {
    open.notice = notice;
    open.rows = [];
    open.shown = 0;
    const heading = this.#heading();
    const parts: HTMLElement[] = [heading];
    let message: HTMLElement | undefined;
    if (notice !== undefined) {
      message = this.#el('p', 'jellypass-tv-requests-message', notice);
      message.setAttribute('role', 'status');
      message.setAttribute('tabindex', '-1');
      parts.push(message);
    }
    if (open.entries.length === 0) {
      parts.push(this.#el('p', 'jellypass-tv-requests-note', REQUESTS_TEXT.empty));
      this.#fill(open, parts);
      this.#place(open, message ?? null);
      return;
    }
    const list = this.#el('ul', 'jellypass-tv-requests-list');
    const hint = this.#el('p', 'jellypass-tv-requests-note jellypass-tv-requests-hint', REQUEST_FILTER_TEXT.more);
    hint.hidden = true;
    const none = this.#el('div', 'jellypass-tv-requests-none');
    none.hidden = true;
    const noneText = this.#el('p', 'jellypass-tv-requests-note');
    const showAll = this.#button('jellypass-tv-requests-show-all jellypass-tv-requests-secondary', REQUEST_FILTER_TEXT.showAll, 'show-all');
    none.appendChild(noneText);
    none.appendChild(showAll);
    const count = this.#el('p', 'jellypass-tv-requests-announce');
    count.setAttribute('role', 'status');
    const more = this.#button('jellypass-tv-requests-more jellypass-tv-requests-secondary', REQUESTS_TEXT.loadMore, 'more');

    const chips: HTMLButtonElement[] = [];
    const bar = this.#el('div', 'jellypass-tv-requests-filters');
    const group = (label: string, built: HTMLButtonElement[]): void => {
      const box = this.#el('div', 'jellypass-tv-requests-filter-group focuscontainer-x');
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', label);
      box.appendChild(this.#el('span', 'jellypass-tv-requests-filter-label', label));
      for (const chip of built) box.appendChild(chip);
      bar.appendChild(box);
    };
    const chip = (kind: 'status' | 'kind' | 'byYou', value: string, label: string): HTMLButtonElement => {
      const button = this.#button('jellypass-tv-requests-chip', label, `chip-${kind}-${value}`);
      button.setAttribute('data-filter-group', kind);
      button.setAttribute('data-filter', value);
      button.addEventListener('click', () => {
        if (this.#open !== open) return;
        if (kind === 'byYou') this.#filter = { ...this.#filter, byYou: !this.#filter.byYou };
        else if (kind === 'status') this.#filter = { ...this.#filter, status: value as RequestFilter['status'] };
        else this.#filter = { ...this.#filter, kind: value as RequestFilter['kind'] };
        apply();
        count.textContent = `${open.rows.filter((row) => !row.item.hidden).length} shown.`;
      });
      chips.push(button);
      return button;
    };
    group(REQUEST_FILTER_TEXT.statusLabel, REQUEST_STATUS_FILTERS.map((value) => chip('status', value, REQUEST_FILTER_TEXT.status[value])));
    group(REQUEST_FILTER_TEXT.kindLabel, REQUEST_KIND_FILTERS.map((value) => chip('kind', value, REQUEST_FILTER_TEXT.kind[value])));
    group(REQUEST_FILTER_TEXT.whoLabel, [chip('byYou', 'byYou', REQUEST_FILTER_TEXT.byYou)]);

    // The filters only hide or show entries already on the page: choosing one reads nothing, so no call is made and the
    // titles named so far stay named. Load more names the next ten of the list, which the filter then applies to.
    const apply = (): void => {
      let any = false;
      for (const row of open.rows) {
        const visible = matchesRequestFilter(row.entry, this.#filter);
        row.item.hidden = !visible;
        if (visible) any = true;
      }
      const unloaded = open.shown < open.entries.length;
      none.hidden = any;
      hint.hidden = !any || !requestFilterActive(this.#filter) || !unloaded;
      noneText.textContent = requestFilterEmptyText(this.#filter, unloaded);
      showAll.hidden = !requestFilterActive(this.#filter);
      for (const button of chips) {
        const kind = button.getAttribute('data-filter-group');
        const value = button.getAttribute('data-filter');
        const pressed = kind === 'byYou' ? this.#filter.byYou : kind === 'status' ? this.#filter.status === value : this.#filter.kind === value;
        button.setAttribute('aria-pressed', String(pressed));
      }
    };
    showAll.addEventListener('click', () => {
      if (this.#open !== open) return;
      this.#filter = { ...NO_REQUEST_FILTER };
      apply();
      count.textContent = 'All shown.';
      if (chips[0]) chips[0].focus();
    });

    const showMore = (size: number): Row[] => {
      const batch = open.entries.slice(open.shown, open.shown + size);
      open.shown += batch.length;
      this.#drawnCount = open.shown;
      const built = batch.map((entry) => this.#row(open, entry));
      for (const row of built) {
        list.appendChild(row.item);
        open.rows.push(row);
      }
      more.hidden = open.shown >= open.entries.length;
      more.disabled = false;
      more.textContent = REQUESTS_TEXT.loadMore;
      apply();
      this.#name(open, built);
      return built;
    };
    more.addEventListener('click', () => {
      if (more.disabled || this.#open !== open) return;
      more.disabled = true;
      more.textContent = REQUESTS_TEXT.loadingMore;
      const built = showMore(REQUESTS_PER_PAGE);
      const next = built.filter((row) => !row.item.hidden)[0];
      if (next) (next.item.querySelector('.jellypass-tv-request-open') as HTMLElement).focus();
      else more.focus();
    });

    parts.push(bar, count, list, hint, none, more);
    this.#fill(open, parts);
    // Back draws the entries that were showing at once (their titles are kept), not just the first ten.
    const first = showMore(Math.max(REQUESTS_PER_PAGE, this.#drawnCount));
    const firstOpen = first.filter((row) => !row.item.hidden)[0];
    this.#place(open, message ?? (firstOpen ? (firstOpen.item.querySelector('.jellypass-tv-request-open') as HTMLElement) : chips[0] ?? null));
  }

  /** One entry: what is open to choose (the title), then its Cancel, if the server says the caller may. */
  #row(open: Open, entry: RequestEntry): Row {
    const pills = requestPills(entry);
    const kind = [entry.mediaType === 'tv' ? 'Series' : 'Movie', pills.seasonsText].filter(Boolean).join(' · ');
    const item = this.#el('li', 'jellypass-tv-request');
    const choose = this.#el('button', `jellypass-tv-request-open${this.#document.documentElement.classList.contains('layout-tv') ? ' show-focus' : ''}`) as HTMLButtonElement;
    choose.type = 'button';
    choose.setAttribute(FOCUS_ATTR, `entry-${entry.mediaType}-${entry.tmdbId}`);
    const poster = this.#el('span', 'jellypass-tv-request-poster');
    choose.appendChild(poster);
    const text = this.#el('span', 'jellypass-tv-request-text');
    const name = this.#el('span', 'jellypass-tv-request-name', REQUESTS_TEXT.loading);
    const meta = this.#el('span', 'jellypass-tv-request-meta', kind);
    text.appendChild(name);
    text.appendChild(meta);
    if (pills.status) text.appendChild(this.#pill(pills.status));
    text.appendChild(this.#el('span', 'jellypass-tv-request-who', entry.byYou ? REQUESTS_TEXT.byYou : REQUESTS_TEXT.byOther));
    const day = requestedOnText(entry.requestedOn);
    if (day !== undefined) text.appendChild(this.#el('span', 'jellypass-tv-request-on', REQUESTS_TEXT.requestedOn(day)));
    if (pills.perSeason) {
      const seasons = this.#el('span', 'jellypass-tv-request-seasons');
      for (const season of entry.seasons) {
        const line = this.#el('span', 'jellypass-tv-request-season');
        line.appendChild(this.#el('span', 'jellypass-tv-request-season-name', `Season ${season.seasonNumber}`));
        line.appendChild(this.#pill(season.status));
        if (season.status === 'failed') line.appendChild(this.#el('span', 'jellypass-tv-request-note', REQUESTS_TEXT.failedNote));
        seasons.appendChild(line);
      }
      text.appendChild(seasons);
    }
    // The note sits under the entry's pill, or under each failed season's; a failed entry with no failed season among
    // differing ones (never sent) still says so once.
    const noteHere = pills.status ? pills.status === 'failed' : entry.status === 'failed' && !entry.seasons.some((season) => season.status === 'failed');
    if (noteHere) text.appendChild(this.#el('span', 'jellypass-tv-request-note', REQUESTS_TEXT.failedNote));
    choose.appendChild(text);
    choose.addEventListener('click', () => this.#choose(open, entry));
    item.appendChild(choose);
    const row: Row = { entry, item, name, meta, kind, poster, cancel: undefined };
    if (entry.cancellable) {
      row.cancel = this.#cancelControl(open, row);
      item.appendChild(row.cancel);
    }
    return row;
  }

  #pill(status: keyof typeof REQUEST_LABELS): HTMLElement {
    return this.#el('span', `jellypass-tv-request-pill jellypass-tv-request-pill-${status}`, REQUEST_LABELS[status]);
  }

  /** An entry chosen: the title page is opened, if Jellyfin web is still signed in to this origin as the same member. */
  #choose(open: Open, entry: RequestEntry): void {
    const session = this.#session();
    if (this.#open !== open || !session || session.userId !== open.userId) return;
    this.#host.navigate(titleHash(entry.mediaType, entry.tmdbId));
  }

  /**
   * Names `rows` from their titles, a few calls at a time; a title named in the last ten minutes of this sign-in is not
   * read again. The status is always the list's. A title that can't be read leaves the entry with its status and a fixed
   * "Title unavailable"; a refused token ends the sign-in's memory.
   */
  #name(open: Open, rows: Row[]): void {
    let next = 0;
    const worker = (): void => {
      while (next < rows.length) {
        const row = rows[next];
        next += 1;
        if (!row || this.#open !== open) return;
        const { mediaType, tmdbId } = row.entry;
        const kept = this.#titles.get(mediaType, tmdbId);
        if (kept) {
          this.#named(row, kept);
          continue;
        }
        const session = this.#session();
        if (!session || session.userId !== open.userId) return;
        void readTitle(this.#scope.fetch, this.#origin, session.token, mediaType, tmdbId).then((answer) => {
          if (this.#open !== open) return;
          const now = this.#session();
          if (!now || now.userId !== open.userId) {
            this.#end(open);
            return;
          }
          if (answer.ok) {
            const details = { title: answer.title.title, year: answer.title.year, posterUrl: answer.title.posterUrl };
            this.#titles.set(mediaType, tmdbId, details);
            this.#named(row, details);
          } else if (answer.status === 401) {
            this.#forget();
            this.#failed(open, answer, undefined);
            return;
          } else {
            this.#named(row, undefined);
          }
          worker();
        }).catch(() => undefined);
        return;
      }
    };
    for (let i = 0; i < REQUEST_TITLE_CALLS; i += 1) worker();
  }

  #named(row: Row, details: { title: string; year: number | null; posterUrl: string | null } | undefined): void {
    row.name.textContent = details && details.title ? details.title : REQUESTS_TEXT.titleMissing;
    // "2024 · Movie", or "2027 · Series · Season 1" with the seasons the entry put there.
    if (details) row.meta.textContent = [details.year === null ? '' : String(details.year), row.kind].filter(Boolean).join(' · ');
    if (details && details.title && row.cancel) {
      const button = row.cancel.querySelector('.jellypass-tv-requests-cancel-open');
      if (button) button.setAttribute('aria-label', `${CANCEL_TEXT.button}: ${details.title}`);
    }
    if (details && details.posterUrl && !row.poster.firstChild) {
      const image = this.#document.createElement('img');
      image.setAttribute('alt', '');
      image.setAttribute('referrerpolicy', 'no-referrer');
      image.setAttribute('src', details.posterUrl);
      row.poster.appendChild(image);
    }
  }

  /**
   * "Cancel request" and its confirmation, in the page under the entry (so a remote answers it): the button opens a group
   * that says what cancelling does, with **Keep request** focused (the safe answer) and **Cancel request**. The call is
   * sent once (both buttons are disabled while it is out); a failure says its fixed words and offers the button again.
   */
  #cancelControl(open: Open, row: Row): HTMLElement {
    const openButton = this.#button('jellypass-tv-requests-cancel-open jellypass-tv-requests-secondary', CANCEL_TEXT.button, `cancel-${row.entry.mediaType}-${row.entry.tmdbId}`);
    openButton.setAttribute('aria-label', CANCEL_TEXT.button);
    openButton.setAttribute('aria-expanded', 'false');
    const heading = this.#el('p', 'jellypass-tv-requests-cancel-heading', CANCEL_TEXT.heading);
    const body = this.#el('p', 'jellypass-tv-requests-note', CANCEL_TEXT.body);
    const confirm = this.#button('jellypass-tv-requests-cancel-confirm', CANCEL_TEXT.confirm, `cancel-confirm-${row.entry.mediaType}-${row.entry.tmdbId}`);
    const keep = this.#button('jellypass-tv-requests-cancel-keep jellypass-tv-requests-secondary', CANCEL_TEXT.keep, `cancel-keep-${row.entry.mediaType}-${row.entry.tmdbId}`);
    const message = this.#el('p', 'jellypass-tv-requests-cancel-message');
    message.setAttribute('role', 'status');
    const actions = this.#el('div', 'jellypass-tv-requests-cancel-actions focuscontainer-x');
    actions.appendChild(keep);
    actions.appendChild(confirm);
    const panel = this.#el('div', 'jellypass-tv-requests-cancel-panel');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', CANCEL_TEXT.heading);
    panel.hidden = true;
    panel.appendChild(heading);
    panel.appendChild(body);
    panel.appendChild(actions);
    panel.appendChild(message);
    const close = (): void => {
      panel.hidden = true;
      openButton.hidden = false;
      openButton.setAttribute('aria-expanded', 'false');
      message.textContent = '';
      openButton.focus();
    };
    openButton.addEventListener('click', () => {
      openButton.hidden = true;
      openButton.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
      keep.focus();
    });
    keep.addEventListener('click', () => {
      if (!keep.disabled) close();
    });
    confirm.addEventListener('click', () => {
      if (confirm.disabled || this.#open !== open) return;
      const session = this.#session();
      if (!session || session.userId !== open.userId) {
        this.#end(open);
        return;
      }
      confirm.disabled = true;
      keep.disabled = true;
      confirm.textContent = CANCEL_TEXT.sending;
      confirm.setAttribute('aria-busy', 'true');
      message.className = 'jellypass-tv-requests-cancel-message';
      message.textContent = '';
      const { mediaType, tmdbId, id } = row.entry;
      const generation = this.#generation;
      void cancelRequest(this.#scope.fetch, this.#origin, session.token, id).then((answer) => {
        if (answer.ok) {
          // Shown as available to get while the server withdraws it, only in the session that cancelled: a sign-out or a
          // new sign-in since (even as the same member, with a new token) drops the answer before it touches anything.
          const now = this.#session();
          const same = now !== undefined && now.userId === session.userId && now.token === session.token && this.#generation === generation;
          if (!same) {
            if (this.#open === open) this.#end(open);
            return;
          }
          this.#asked.sync(now.userId);
          this.#asked.withdraw(now.userId, mediaType, tmdbId);
          this.#host.changed();
          if (this.#open !== open) return;
          if (now.userId === open.userId) this.#cancelled(open, row, now);
          else this.#end(open);
          return;
        }
        if (this.#open !== open) return;
        if (answer.status === 401) {
          this.#forget();
          this.#failed(open, answer, undefined);
          return;
        }
        const kind = kindOf(answer);
        message.className = 'jellypass-tv-requests-cancel-message jellypass-tv-requests-error-text';
        message.textContent = kind === 'rate_limited' ? CANCEL_TEXT.rate_limited : kind === 'offline' ? CANCEL_TEXT.offline : CANCEL_TEXT.unavailable;
        confirm.textContent = CANCEL_TEXT.confirm;
        confirm.removeAttribute('aria-busy');
        confirm.disabled = false;
        keep.disabled = false;
        confirm.focus();
      }).catch(() => undefined);
    });
    const box = this.#el('div', 'jellypass-tv-requests-cancel');
    box.appendChild(openButton);
    box.appendChild(panel);
    return box;
  }

  /**
   * A cancel was accepted: the entry leaves the list at once, the one fixed confirmation is shown whatever follows, and
   * the list is read again (the server's word: the title is Get this again). If that read fails the confirmation stays,
   * with the fixed refresh note and a retry that only reads.
   */
  #cancelled(open: Open, row: Row, session: Session): void {
    const index = open.entries.indexOf(row.entry);
    if (index >= 0) open.entries.splice(index, 1);
    if (open.shown > 0) open.shown -= 1;
    this.#drawnCount = open.shown;
    if (row.item.parentNode) row.item.parentNode.removeChild(row.item);
    const at = open.rows.indexOf(row);
    if (at >= 0) open.rows.splice(at, 1);
    const confirmation = this.#el('p', 'jellypass-tv-requests-message', CANCEL_TEXT.confirmation);
    confirmation.setAttribute('role', 'status');
    confirmation.setAttribute('tabindex', '-1');
    const old = open.body.querySelector('.jellypass-tv-requests-message');
    const heading = open.body.querySelector('.jellypass-tv-requests-heading');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (heading && heading.parentNode) heading.parentNode.insertBefore(confirmation, heading.nextSibling);
    confirmation.focus();
    this.#load(open, session, CANCEL_TEXT.confirmation);
  }
}
