import { hiddenList, setHidden, title as readTitle, type Failure, type HiddenEntry } from './api.js';
import type { Asked } from './asked.js';
import { HIDDEN_HASH, HIDDEN_TEXT, HiddenPager, hiddenFailureText, hiddenOnText } from './hidden-model.js';
import type { Session } from './jellyfin-web.js';
import { FOCUS_ATTR, type PageContext, type PageView } from './page-host.js';
import { REQUESTS_HASH, REQUESTS_TEXT } from './requests-model.js';
import { SessionWatch } from './session-watch.js';
import { ERROR_TEXT, kindOf, titleHash, type ErrorKind } from './title.js';
import type { TitleCache } from './titles.js';

/**
 * The Hidden view of My requests (docs/tv-addon.md, "Hidden titles"): the titles the member marked Not interested, newest
 * first, each with **Unhide**, as a page of Jellyfin web's at `#/jellypass/requests/hidden` on the page host, beside the
 * requests (a separate screen reached by a button, not a filter). The list is `GET /hidden` (50 IDs a page, nothing else),
 * and the titles are named from their own answers ten at a time, four calls at once, the way My requests does; **Load
 * more** names the next ten and reads the list's next page only once the ones already read are all shown. Choosing a
 * title opens its page; Unhide is one `DELETE`, never repeated by itself, and takes the title off the list at once.
 *
 * It is a route, so Jellyfin web's header, Back, history and focus manager are what apply: this module handles no key and
 * adds no document listener. Every answer is checked against the session that sent it (session-watch.ts): after a
 * sign-out or a new sign-in it is ignored whole. Everything shown is a fixed string or a DTO field set with `textContent`.
 */

/** The titles named at a time, and how many of those calls are out at once (My requests' numbers). */
export const HIDDEN_PER_PAGE = 10;
export const HIDDEN_TITLE_CALLS = 4;

/** Marks the page's content (one at most is ever on the page). */
export const HIDDEN_ATTRIBUTE = 'data-jellypass-tv-hidden';
/** Marks the two-button bar (Requests, Hidden) of My requests. */
export const VIEWS_ATTRIBUTE = 'data-jellypass-tv-views';

interface Scope {
  ApiClient?: unknown;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

/** What the page asks of the page around it. */
export interface HiddenHost {
  /** The member unhid a title (accepted): rows and pages that hold lists leave it in, from what they hold. */
  hiddenChanged(): void;
  /** The overlay was forgotten (a refused token). */
  changed(): void;
  navigate(hash: string): void;
}

/**
 * The bar at the top of My requests and its Hidden view: **Requests** and **Hidden**, as buttons a remote can reach, the
 * view shown pressed. Choosing the other opens it (a history entry); choosing the one shown does nothing.
 */
export function viewsBar(document: Document, current: 'requests' | 'hidden', go: (hash: string) => void): HTMLElement {
  const tv = document.documentElement.classList.contains('layout-tv');
  const box = document.createElement('div');
  box.className = 'jellypass-tv-requests-filter-group focuscontainer-x jellypass-tv-views';
  box.setAttribute(VIEWS_ATTRIBUTE, '');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', HIDDEN_TEXT.viewsLabel);
  const button = (view: 'requests' | 'hidden', text: string, hash: string): void => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `emby-button raised ${tv ? 'show-focus ' : ''}jellypass-tv-requests-button jellypass-tv-view`;
    node.textContent = text;
    node.setAttribute(FOCUS_ATTR, `view-${view}`);
    node.setAttribute('aria-pressed', String(view === current));
    node.addEventListener('click', () => {
      if (view !== current) go(hash);
    });
    box.appendChild(node);
  };
  button('requests', HIDDEN_TEXT.requestsView, REQUESTS_HASH);
  button('hidden', HIDDEN_TEXT.hiddenView, HIDDEN_HASH);
  return box;
}

interface Row {
  entry: HiddenEntry;
  item: HTMLElement;
  name: HTMLElement;
  meta: HTMLElement;
  kind: string;
  poster: HTMLElement;
  unhide: HTMLButtonElement;
  message: HTMLElement;
}

interface Open {
  userId: string;
  context: PageContext;
  view: HTMLElement;
  body: HTMLElement;
  /** Bumped by every read of the first page and by leaving, so an answer that comes late for a page since redrawn or left is dropped. */
  load: number;
  first: boolean;
  /** Which page is read next, and the titles listed (see HiddenPager). */
  pager: HiddenPager;
  shown: number;
  rows: Row[];
  /** The parts Load more and the empty note change in place. */
  list: HTMLElement | undefined;
  more: HTMLButtonElement | undefined;
  note: HTMLElement | undefined;
  announce: HTMLElement | undefined;
}

export class HiddenPage {
  readonly #document: Document;
  readonly #scope: Scope;
  readonly #watch: SessionWatch;
  readonly #origin: string;
  readonly #asked: Asked;
  readonly #titles: TitleCache;
  readonly #host: HiddenHost;
  #owner: string | undefined;
  #open: Open | undefined;
  #loads = 0;

  public constructor(document: Document, scope: Scope, origin: string, asked: Asked, titles: TitleCache, host: HiddenHost) {
    this.#document = document;
    this.#scope = scope;
    this.#watch = new SessionWatch(scope, origin);
    this.#origin = origin;
    this.#asked = asked;
    this.#titles = titles;
    this.#host = host;
  }

  public get isOpen(): boolean {
    return this.#open !== undefined;
  }

  /** The member the names belong to; another member (or no one) forgets them. */
  #member(userId: string | undefined): void {
    if (userId === this.#owner) return;
    this.#owner = userId;
    this.#titles.forget();
  }

  /** Called on every page change: signed out, or another member signed in, the page (if open) is emptied and nothing more is read or sent. */
  public update(): void {
    const session = this.#watch.current();
    this.#member(session ? session.userId : undefined);
    const open = this.#open;
    if (!open) return;
    if (!session) {
      this.#end(open);
      return;
    }
    if (session.userId !== open.userId || !open.view.parentNode) {
      this.#asked.sync(session.userId);
      this.#end(open);
    }
  }

  /** The page host's render for the route: draws into the container and reads the list (signed in to this origin only). */
  public render(context: PageContext): PageView {
    const cleanup = () => this.#leave(context);
    const session = this.#watch.current();
    if (!session) return { title: REQUESTS_TEXT.title, cleanup };
    this.#member(session.userId);
    const view = this.#el('div', 'jellypass-tv-requests-page jellypass-tv-hidden-page padded-left padded-right');
    view.setAttribute(HIDDEN_ATTRIBUTE, '');
    const body = this.#el('div', 'jellypass-tv-requests-body');
    view.appendChild(body);
    context.container.appendChild(view);
    const open: Open = { userId: session.userId, context, view, body, load: 0, first: true, pager: new HiddenPager(), shown: 0, rows: [], list: undefined, more: undefined, note: undefined, announce: undefined };
    this.#open = open;
    this.#load(open, session);
    return { title: REQUESTS_TEXT.title, cleanup };
  }

  /** The page is left: what is in flight is dropped. */
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

  /**
   * An answer that no longer belongs to the session that sent it is ignored entirely, failures included. The page is only
   * ended if it is another member's, or read again for the new session if it is the same member's.
   */
  #stale(open: Open): void {
    if (this.#open !== open) return;
    const now = this.#watch.current();
    if (!now || now.userId !== open.userId) this.#end(open);
    else this.#load(open, now);
  }

  #el(tag: string, className: string, text?: string): HTMLElement {
    const node = this.#document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  #button(className: string, text: string, focusKey: string): HTMLButtonElement {
    const tv = this.#document.documentElement.classList.contains('layout-tv');
    const button = this.#el('button', `emby-button raised ${tv ? 'show-focus ' : ''}jellypass-tv-requests-button ${className}`, text) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute(FOCUS_ATTR, focusKey);
    return button;
  }

  #fill(open: Open, parts: HTMLElement[]): void {
    while (open.body.firstChild) open.body.removeChild(open.body.firstChild);
    for (const part of parts) open.body.appendChild(part);
  }

  #heading(): HTMLElement {
    return this.#el('h1', 'sectionTitle jellypass-tv-requests-heading', REQUESTS_TEXT.title);
  }

  #views(): HTMLElement {
    return viewsBar(this.#document, 'hidden', (hash) => this.#host.navigate(hash));
  }

  #place(open: Open, element: HTMLElement | null): void {
    if (this.#open !== open) return;
    if (open.first) {
      open.first = false;
      open.context.focus(element);
    } else if (element) element.focus();
  }

  /** A refused token is nobody's: what was shown as requested for it, and the names, are dropped. */
  #forget(): void {
    this.#titles.forget();
    this.#asked.forget();
    this.#host.changed();
  }

  /** Reads the first page of the list (one call) and draws it. */
  #load(open: Open, session: Session): void {
    const load = ++this.#loads;
    open.load = load;
    this.#fill(open, [this.#heading(), this.#views(), this.#el('p', 'jellypass-tv-requests-loading', REQUESTS_TEXT.loadingList)]);
    const stamp = this.#watch.stamp(session);
    const pager = new HiddenPager();
    open.pager = pager;
    this.#read(open, session, (answer) => {
      if (open.load !== load || this.#open !== open) return;
      const now = this.#watch.holds(stamp);
      if (!now || now.userId !== open.userId) {
        this.#stale(open);
        return;
      }
      if (!answer.ok) {
        if (answer.status === 401) this.#forget();
        this.#failed(open, answer);
        return;
      }
      this.#asked.sync(now.userId);
      this.#draw(open);
    });
  }

  /**
   * Reads pages of the list (one call each) until one lists a title not yet listed or the list ends (a page read again
   * after an unhide may add nothing), then calls `done` with the last answer.
   */
  #read(open: Open, session: Session, done: (answer: { ok: true } | Failure) => void): void {
    const pager = open.pager;
    const stamp = this.#watch.stamp(session);
    const read = pager.begin();
    void hiddenList(this.#scope.fetch, this.#origin, session.token, read.page).then((answer) => {
      if (!answer.ok || this.#open !== open || open.pager !== pager || !this.#watch.holds(stamp)) {
        pager.dropped(read);
        done(answer.ok ? { ok: true } : answer);
        return;
      }
      if (pager.answered(read, answer.entries, answer.nextPage) === 0 && pager.next() !== null) this.#read(open, session, done);
      else done(answer);
    }).catch(() => undefined);
  }

  /** A list that could not be read: the fixed error state with a retry that only reads (none for a refused token). */
  #failed(open: Open, failure: Failure): void {
    const kind: ErrorKind = kindOf(failure);
    const box = this.#el('div', 'jellypass-tv-requests-state');
    box.appendChild(this.#el('p', 'jellypass-tv-requests-error', ERROR_TEXT[kind].title));
    box.appendChild(this.#el('p', 'jellypass-tv-requests-note', ERROR_TEXT[kind].body));
    let retry: HTMLButtonElement | null = null;
    if (kind !== 'unauthorized') {
      retry = this.#button('jellypass-tv-requests-retry jellypass-tv-requests-secondary', REQUESTS_TEXT.tryAgain, 'retry');
      retry.addEventListener('click', () => {
        const session = this.#watch.current();
        if (this.#open !== open) return;
        if (!session || session.userId !== open.userId) {
          this.#end(open);
          return;
        }
        this.#load(open, session);
      });
      box.appendChild(retry);
    }
    this.#fill(open, [this.#heading(), this.#views(), box]);
    this.#place(open, retry);
  }

  #draw(open: Open): void {
    open.rows = [];
    open.shown = 0;
    const views = this.#views();
    const note = this.#el('p', 'jellypass-tv-requests-note', HIDDEN_TEXT.empty);
    note.hidden = true;
    const list = this.#el('ul', 'jellypass-tv-requests-list');
    const announce = this.#el('p', 'jellypass-tv-requests-announce');
    announce.setAttribute('role', 'status');
    const more = this.#button('jellypass-tv-requests-more jellypass-tv-requests-secondary', REQUESTS_TEXT.loadMore, 'more');
    more.addEventListener('click', () => {
      if (more.disabled || this.#open !== open) return;
      more.disabled = true;
      more.textContent = REQUESTS_TEXT.loadingMore;
      this.#showMore(open, true);
    });
    open.list = list;
    open.more = more;
    open.note = note;
    open.announce = announce;
    this.#fill(open, [this.#heading(), views, announce, note, list, more]);
    this.#showMore(open, false);
    const first = open.rows[0];
    this.#place(open, first ? first.item.querySelector('.jellypass-tv-request-open') as HTMLElement : views.querySelector('button'));
  }

  /** What Load more and the empty note show now. */
  #sync(open: Open): void {
    const more = open.more;
    const note = open.note;
    if (more) {
      more.hidden = open.shown >= open.pager.entries.length && open.pager.next() === null;
      more.disabled = false;
      more.textContent = REQUESTS_TEXT.loadMore;
    }
    if (note) note.hidden = open.rows.length > 0 || open.pager.next() !== null || open.pager.entries.length > 0;
  }

  /**
   * The next ten are named. Once every entry read is shown, the next page of the list is read first (one call), and only
   * then are its first ten named. `focus` moves focus to the first new entry.
   */
  #showMore(open: Open, focus: boolean): void {
    if (open.shown >= open.pager.entries.length && open.pager.next() !== null) {
      this.#nextPage(open, focus);
      return;
    }
    const list = open.list as HTMLElement;
    const batch = open.pager.entries.slice(open.shown, open.shown + HIDDEN_PER_PAGE);
    open.shown += batch.length;
    const built = batch.map((entry) => this.#row(open, entry));
    for (const row of built) {
      list.appendChild(row.item);
      open.rows.push(row);
    }
    this.#sync(open);
    this.#name(open, built);
    const next = built[0];
    if (focus) {
      if (next) (next.item.querySelector('.jellypass-tv-request-open') as HTMLElement).focus();
      else if (open.more) open.more.focus();
    }
  }

  #nextPage(open: Open, focus: boolean): void {
    const session = this.#watch.current();
    if (!session || session.userId !== open.userId) {
      this.#end(open);
      return;
    }
    const load = open.load;
    const stamp = this.#watch.stamp(session);
    this.#read(open, session, (answer) => {
      if (this.#open !== open || open.load !== load) return;
      const now = this.#watch.holds(stamp);
      if (!now || now.userId !== open.userId) {
        this.#stale(open);
        return;
      }
      if (!answer.ok) {
        if (answer.status === 401) {
          this.#forget();
          this.#failed(open, answer);
          return;
        }
        // The page stays as it is: the failure is said in fixed words and Load more is offered again.
        const more = open.more;
        if (more) {
          more.disabled = false;
          more.textContent = REQUESTS_TEXT.loadMore;
          more.focus();
        }
        if (open.announce) open.announce.textContent = ERROR_TEXT[kindOf(answer)].body;
        return;
      }
      this.#showMore(open, focus);
    });
  }

  /** One entry: the title to open, and its Unhide. */
  #row(open: Open, entry: HiddenEntry): Row {
    const kind = entry.mediaType === 'tv' ? 'Series' : 'Movie';
    const item = this.#el('li', 'jellypass-tv-request jellypass-tv-hidden-entry');
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
    const on = hiddenOnText(entry.hiddenAt);
    if (on !== undefined) text.appendChild(this.#el('span', 'jellypass-tv-request-on', on));
    choose.appendChild(text);
    choose.addEventListener('click', () => this.#choose(open, entry));
    item.appendChild(choose);
    const unhide = this.#button('jellypass-tv-hidden-unhide jellypass-tv-requests-secondary', HIDDEN_TEXT.unhide, `unhide-${entry.mediaType}-${entry.tmdbId}`);
    const message = this.#el('p', 'jellypass-tv-requests-cancel-message jellypass-tv-hidden-message');
    message.setAttribute('role', 'status');
    const row: Row = { entry, item, name, meta, kind, poster, unhide, message };
    unhide.addEventListener('click', () => this.#unhide(open, row));
    const box = this.#el('div', 'jellypass-tv-requests-cancel');
    box.appendChild(unhide);
    box.appendChild(message);
    item.appendChild(box);
    return row;
  }

  #choose(open: Open, entry: HiddenEntry): void {
    const session = this.#watch.current();
    if (this.#open !== open || !session || session.userId !== open.userId) return;
    this.#host.navigate(titleHash(entry.mediaType, entry.tmdbId));
  }

  /** Unhide: one call, disabled while it is out; an accepted one takes the entry off the list at once, a failure says its fixed words. */
  #unhide(open: Open, row: Row): void {
    if (row.unhide.disabled || this.#open !== open) return;
    const session = this.#watch.current();
    if (!session || session.userId !== open.userId) {
      this.#end(open);
      return;
    }
    row.unhide.disabled = true;
    row.unhide.textContent = HIDDEN_TEXT.sending;
    row.unhide.setAttribute('aria-busy', 'true');
    row.message.className = 'jellypass-tv-requests-cancel-message jellypass-tv-hidden-message';
    row.message.textContent = '';
    const { mediaType, tmdbId } = row.entry;
    const stamp = this.#watch.stamp(session);
    const load = open.load;
    this.#asked.sync(session.userId);
    const epoch = this.#asked.epoch();
    const unhide = open.pager.unhiding();
    void setHidden(this.#scope.fetch, this.#origin, session.token, mediaType, tmdbId, false).then((answer) => {
      const now = this.#watch.holds(stamp);
      unhide.done(answer.ok);
      if (!now) {
        if (open.load === load) this.#stale(open);
        return;
      }
      // After another call was refused while this was out (the overlay was forgotten), nothing is written or said: the
      // button is only offered again as it was.
      if (this.#asked.epoch() !== epoch) {
        if (this.#open !== open || open.load !== load) return;
        row.unhide.disabled = false;
        row.unhide.removeAttribute('aria-busy');
        row.unhide.textContent = HIDDEN_TEXT.unhide;
        return;
      }
      if (answer.ok) {
        this.#asked.sync(now.userId);
        this.#asked.hide(now.userId, mediaType, tmdbId, false);
        this.#host.hiddenChanged();
        if (this.#open !== open) return;
        if (now.userId !== open.userId) {
          this.#end(open);
          return;
        }
        this.#removed(open, row);
        return;
      }
      if (this.#open !== open) return;
      if (answer.status === 401) {
        this.#forget();
        this.#failed(open, answer);
        return;
      }
      row.unhide.disabled = false;
      row.unhide.removeAttribute('aria-busy');
      row.unhide.textContent = HIDDEN_TEXT.unhide;
      row.message.className = 'jellypass-tv-requests-cancel-message jellypass-tv-hidden-message jellypass-tv-requests-error-text';
      row.message.textContent = hiddenFailureText(answer);
      row.unhide.focus();
    }).catch(() => undefined);
  }

  /** The entry left the list: focus goes to the next entry's Unhide, else the one before, else Load more, else the bar. */
  #removed(open: Open, row: Row): void {
    const at = open.rows.indexOf(row);
    const neighbour = open.rows[at + 1] || open.rows[at - 1];
    if (at >= 0) open.rows.splice(at, 1);
    const index = open.pager.entries.indexOf(row.entry);
    if (index >= 0) open.pager.entries.splice(index, 1);
    if (open.shown > 0) open.shown -= 1;
    if (row.item.parentNode) row.item.parentNode.removeChild(row.item);
    if (open.announce) open.announce.textContent = HIDDEN_TEXT.unhidden;
    this.#sync(open);
    const bar = open.body.querySelector('.jellypass-tv-view');
    const target = (neighbour ? neighbour.unhide : undefined) ?? (open.more && !open.more.hidden ? open.more : undefined) ?? (bar as HTMLElement | null);
    if (target) (target as HTMLElement).focus();
  }

  /** Names `rows` from their titles, a few calls at a time; a title named in the last ten minutes of this sign-in is not read again. */
  #name(open: Open, rows: Row[]): void {
    let next = 0;
    const load = open.load;
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
        const session = this.#watch.current();
        if (!session || session.userId !== open.userId) return;
        const stamp = this.#watch.stamp(session);
        void readTitle(this.#scope.fetch, this.#origin, session.token, mediaType, tmdbId).then((answer) => {
          if (this.#open !== open) return;
          const now = this.#watch.holds(stamp);
          if (!now || now.userId !== open.userId) {
            if (open.load === load) this.#stale(open);
            return;
          }
          if (answer.ok) {
            const details = { title: answer.title.title, year: answer.title.year, posterUrl: answer.title.posterUrl };
            this.#titles.set(mediaType, tmdbId, details);
            this.#named(row, details);
          } else if (answer.status === 401) {
            this.#forget();
            this.#failed(open, answer);
            return;
          } else {
            // Unhide still works: only the name could not be read.
            this.#named(row, undefined);
          }
          worker();
        }).catch(() => undefined);
        return;
      }
    };
    for (let i = 0; i < HIDDEN_TITLE_CALLS; i += 1) worker();
  }

  #named(row: Row, details: { title: string; year: number | null; posterUrl: string | null } | undefined): void {
    row.name.textContent = details && details.title ? details.title : REQUESTS_TEXT.titleMissing;
    if (details) row.meta.textContent = [details.year === null ? '' : String(details.year), row.kind].filter(Boolean).join(' · ');
    if (details && details.title) row.unhide.setAttribute('aria-label', HIDDEN_TEXT.unhideLabel(details.title));
    if (details && details.posterUrl && !row.poster.firstChild) {
      const image = this.#document.createElement('img');
      image.setAttribute('alt', '');
      image.setAttribute('referrerpolicy', 'no-referrer');
      image.setAttribute('src', details.posterUrl);
      row.poster.appendChild(image);
    }
  }
}
