import type { DiscoverCard, DiscoverNetwork, DiscoverPage as ListPage, DiscoverSources, DiscoverStudio, Failure, HouseholdState, NetworkList } from './api.js';
import type { Asked } from './asked.js';
import { JELLYFIN_CLASSES, listClasses } from './jellyfin-web.js';
import { drawCard, imageIn, markCard, setNear, skeletonCard, type Drawn, type Unit } from './discover-card.js';
import type { DiscoverData, DiscoverRequest } from './discover-data.js';
import { DISCOVER_TEXT, isHeld, JUSTWATCH_NOTE, listsOf, SOURCE_TEXT, sourceId, TMDB_NOTICE } from './discover-model.js';
import type { HidePreference } from './discover-preference.js';
import { FOCUS_ATTR, type PageContext, type PageView } from './page-host.js';
import type { SessionWatch, Stamp } from './session-watch.js';
import { ERROR_TEXT, kindOf, titleHash } from './title.js';

/**
 * The JellyPass service and studio pages (docs/tv-addon.md, "Service and studio pages"): the household app's network and studio
 * pages as pages of Jellyfin web's at `#/jellypass/service/<id>` and `#/jellypass/studio/<id>`, on the page host, under
 * Jellyfin's real header and Back. A header with the logo, a service's All / Series / Films tabs (Films only for a service the
 * API lists films for), "New only", a grid of cards with Load more (one API page, 20 cards, each press), the JustWatch
 * credit under a service's All and Films, and the TMDB notice at the foot. Only a service or studio the API's sources list has a
 * page: any other address is "Not found", and an address that cannot be one asks nothing.
 *
 * It handles no key (Jellyfin web's focus manager moves between the tabs, the cards and Load more; Back is its history). Back
 * from a title returns to the same card: the page is drawn at once from the kept answers (`DiscoverData`, the pages that were
 * showing, on the tab that was showing) before anything is asked, so the host's focus key finds the card. It shows only the
 * household's own view (what the API answered, through the "Get this" overlay), set with `textContent`; an image is only the
 * API's TMDB URL, set while its card is within about a screen and a half and taken away when it is far off (a 2019 set has about
 * 1 GB and no `loading="lazy"`; where there is no IntersectionObserver every image is set).
 */

/** Marks the page's content (one at most is ever on the page). */
export const SOURCE_ATTRIBUTE = 'data-jellypass-tv-source';
/** A card's image is set while the card is this near the screen (the Discover page's). */
const IMAGE_MARGIN = '25% 0px';
/** The placeholder cards a grid that is still loading shows. */
const SKELETON_CARDS = 14;

type Kind = 'service' | 'studio';

/** What the page asks of the page around it. */
export interface SourceHost {
  /** Opens Jellyfin web's page at `hash` (a title). */
  navigate(hash: string): void;
}

/** One drawing of the page under one session; never changed, so what an earlier one drew is refused whenever it is used. */
interface Render {
  readonly stamp: Stamp;
}

interface Open {
  kind: Kind;
  id: number;
  userId: string;
  render: Render;
  context: PageContext;
  view: HTMLElement;
  /** Bumped by every start, every change of tab and by leaving: an answer that comes for an earlier one is dropped. */
  gen: number;
  /** The frame (tabs, toggle) drawn last and the grid drawn last: a card or control of an earlier one does nothing when pressed. */
  frameNo: number;
  gridNo: number;
  source: DiscoverNetwork | DiscoverStudio | undefined;
  lists: ReadonlyArray<NetworkList>;
  list: NetworkList;
  /** The pages of the list shown, in order, and the number of the next one (the API's `nextPage`). */
  pages: ListPage[];
  nextPage: number | null;
  /** Load more has been chosen and its answer has not come. */
  loading: boolean;
  /** The chip or tab that focus falls back to. */
  fallback: HTMLElement | undefined;
  /** The Try again of the failure on show: only this one answers, once; a retained one (the panel since drawn again) does nothing. */
  retry: HTMLElement | undefined;
  /** The header's title: the service's name, "<studio> movies", or "Not found". */
  title: string;
  heading: HTMLElement | undefined;
  tabs: { [list: string]: HTMLElement };
  hideChip: HTMLElement | undefined;
  panel: HTMLElement | undefined;
  grid: HTMLElement | undefined;
  more: HTMLButtonElement | undefined;
  note: HTMLElement | undefined;
  status: HTMLElement | undefined;
  drawn: Drawn[];
  imageWatch: IntersectionObserver | undefined;
  units: Map<Element, Unit>;
  headUnit: Unit | undefined;
}

/** What is remembered of a service's or a studio's page while the member is signed in: the tab, and how many pages of each list showed. */
interface Memory {
  list: NetworkList;
  loaded: { [list: string]: number };
}

export class SourcePage {
  readonly #document: Document;
  readonly #watch: SessionWatch;
  readonly #data: DiscoverData;
  readonly #asked: Asked;
  readonly #host: SourceHost;
  readonly #hide: HidePreference;
  /** The member the memory below belongs to: another member, or no one, forgets it (in memory only). */
  #owner: string | undefined;
  #memory = new Map<string, Memory>();
  #open: Open | undefined;

  public constructor(document: Document, watch: SessionWatch, data: DiscoverData, asked: Asked, host: SourceHost, hide: HidePreference) {
    this.#document = document;
    this.#watch = watch;
    this.#data = data;
    this.#asked = asked;
    this.#host = host;
    this.#hide = hide;
  }

  public get isOpen(): boolean {
    return this.#open !== undefined;
  }

  #member(userId: string | undefined): void {
    if (userId === this.#owner) return;
    this.#owner = userId;
    this.#memory = new Map();
    this.#hide.forMember(userId);
  }

  /** A service's page is about to be opened from a row that shows `list`: it opens on that list, from its first page. */
  public prefer(id: number, list: NetworkList): void {
    this.#member(this.#watch.current()?.userId);
    this.#memory.set(`service:${id}`, { list, loaded: {} });
  }

  /** Called on every page change: signed out or another member signed in, the page (if open) is emptied; a new token draws it again. */
  public update(): void {
    const session = this.#watch.current();
    this.#member(session ? session.userId : undefined);
    const open = this.#open;
    if (!open) return;
    if (!session) {
      this.#end(open);
    } else if (session.userId !== open.userId || !open.view.parentNode) {
      this.#asked.sync(session.userId);
      this.#end(open);
    } else if (!this.#watch.holds(open.render.stamp)) {
      // The same member under a new token (or a new sign-in): what the old session fetched is not shown, the page is drawn afresh.
      this.#asked.sync(session.userId);
      open.render = { stamp: this.#watch.stamp(session) };
      this.#start(open, false);
    }
  }

  /** The "Get this" overlay changed (an accepted request, a cancel, or an expiry): the statuses are drawn again, no call. */
  public overlayChanged(): void {
    const open = this.#open;
    if (!open || !this.#current(open) || !open.grid) return;
    if (this.#hide.held && this.#visibleKeys(open) !== open.drawn.map((one) => this.#cardKey(one.card)).join(' ')) this.#fillGrid(open);
    else for (const one of open.drawn) markCard(one, this.#stateOf(one.card));
  }

  public renderService(context: PageContext): PageView {
    return this.#render('service', context);
  }

  public renderStudio(context: PageContext): PageView {
    return this.#render('studio', context);
  }

  #live(open: Open, render: Render, gen?: number): boolean {
    return this.#open === open && open.render === render && (gen === undefined || open.gen === gen) && this.#watch.holds(render.stamp) !== undefined;
  }

  #current(open: Open): boolean {
    return this.#live(open, open.render);
  }

  #el(tag: string, className: string, text?: string): HTMLElement {
    const node = this.#document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  #tv(): boolean {
    return this.#document.documentElement.classList.contains('layout-tv');
  }

  #button(className: string, text: string, key: string): HTMLButtonElement {
    const button = this.#el('button', `emby-button ${this.#tv() ? 'show-focus ' : ''}${className}`, text) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute(FOCUS_ATTR, key);
    return button;
  }

  #note(title: string, body: string): HTMLElement {
    const note = this.#el('div', 'jellypass-tv-discover-note padded-left padded-right');
    note.appendChild(this.#el('h2', 'jellypass-tv-discover-note-title', title));
    note.appendChild(this.#el('p', 'jellypass-tv-discover-note-body', body));
    return note;
  }

  #render(kind: Kind, context: PageContext): PageView {
    const view = this.#el('div', 'jellypass-tv-source-page');
    view.setAttribute(SOURCE_ATTRIBUTE, kind);
    context.container.appendChild(view);
    const cleanup = () => this.#leave(context);
    const session = this.#watch.current();
    this.#member(session ? session.userId : undefined);
    if (!session) {
      view.appendChild(this.#note(ERROR_TEXT.unauthorized.title, ERROR_TEXT.unauthorized.body));
      return { title: DISCOVER_TEXT.title, cleanup };
    }
    const id = sourceId(context.params.id ?? '');
    if (id === undefined) {
      // Not a number the API has: nothing is asked.
      view.appendChild(this.#note(ERROR_TEXT.not_found.title, ERROR_TEXT.not_found.body));
      return { title: ERROR_TEXT.not_found.title, cleanup };
    }
    this.#asked.sync(session.userId);
    const open: Open = {
      kind, id, userId: session.userId, render: { stamp: this.#watch.stamp(session) }, context, view, gen: 0, frameNo: 0, gridNo: 0, source: undefined, lists: [], list: 'all', pages: [], nextPage: null,
      loading: false, fallback: undefined, retry: undefined, title: DISCOVER_TEXT.title, heading: undefined, tabs: {}, hideChip: undefined, panel: undefined, grid: undefined, more: undefined, note: undefined, status: undefined,
      drawn: [], imageWatch: undefined, units: new Map(), headUnit: undefined,
    };
    this.#open = open;
    this.#start(open, true);
    return open.fallback ? { title: open.title, cleanup, focus: open.fallback } : { title: open.title, cleanup };
  }

  #leave(context: PageContext): void {
    const open = this.#open;
    if (!open || open.context !== context) return;
    this.#open = undefined;
    this.#release(open);
  }

  #end(open: Open): void {
    if (this.#open !== open) return;
    this.#open = undefined;
    this.#release(open);
    if (open.view.parentNode) open.view.parentNode.removeChild(open.view);
  }

  #release(open: Open): void {
    open.gen = -1;
    this.#teardown(open, 'view');
    if (open.imageWatch) open.imageWatch.disconnect();
    open.imageWatch = undefined;
  }

  /**
   * The ONE way anything the page drew goes (every redraw, tab switch, Hide toggle, sign-in prompt, error state and leaving):
   * it bumps the generations the retained controls check (`gridNo` for cards, `frameNo` for tabs and the toggle), forgets the
   * pointers the one-answer controls check (`more`, `retry`, `note`), lets go of the pictures (unobserve, no `src`) and empties
   * the DOM it covers. `grid` is the cards only (they are drawn again into the same grid); `panel` is everything under the tabs
   * (the grid, Load more, the words, Try again); `view` is the whole page, header and tabs included.
   */
  #teardown(open: Open, scope: 'grid' | 'panel' | 'view'): void {
    open.gridNo += 1;
    open.drawn = [];
    this.#resetUnits(open, scope === 'view');
    if (scope === 'grid') {
      if (open.grid) open.grid.textContent = '';
      return;
    }
    open.grid = undefined;
    open.more = undefined;
    open.note = undefined;
    open.retry = undefined;
    open.loading = false;
    if (scope === 'panel') {
      if (open.panel) {
        open.panel.textContent = '';
        open.panel.removeAttribute('aria-busy');
      }
      return;
    }
    open.frameNo += 1;
    open.tabs = {};
    open.hideChip = undefined;
    open.heading = undefined;
    open.panel = undefined;
    open.status = undefined;
    open.fallback = undefined;
    open.view.textContent = '';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The sources, then the page

  /** The sources say whether the address is a service or studio of the API's (kept, they cost nothing); then the page is drawn. */
  #start(open: Open, sync: boolean, retry = false): void {
    open.gen += 1;
    const gen = open.gen;
    const render = open.render;
    this.#teardown(open, 'view');
    const request: DiscoverRequest = { kind: 'sources' };
    const kept = this.#data.peek(request) as { ok: true; value: DiscoverSources } | Failure | undefined;
    if (kept && kept.ok && !retry) {
      this.#known(open, kept.value, sync);
      return;
    }
    open.view.appendChild(this.#skeletonHead());
    this.#data.get(request, { retry }).then((result) => {
      if (!this.#live(open, render, gen) || 'stale' in result) return;
      if (result.ok) this.#known(open, result.value as DiscoverSources, false);
      else this.#failed(open, result, open.view, () => this.#start(open, false, true), 'retry');
    });
  }

  #skeletonHead(): HTMLElement {
    const head = this.#el('div', 'jellypass-tv-source-head padded-left padded-right jellypass-tv-discover-skeleton');
    head.setAttribute('aria-hidden', 'true');
    return head;
  }

  #known(open: Open, sources: DiscoverSources, sync: boolean): void {
    this.#teardown(open, 'view');
    const found: DiscoverNetwork | DiscoverStudio | undefined = (open.kind === 'service' ? sources.networks : sources.studios).filter((one) => one.id === open.id)[0];
    if (!found) {
      open.source = undefined;
      open.view.appendChild(this.#note(ERROR_TEXT.not_found.title, ERROR_TEXT.not_found.body));
      open.title = ERROR_TEXT.not_found.title;
      if (!sync) open.context.setTitle(open.title);
      return;
    }
    open.source = found;
    open.lists = open.kind === 'service' ? listsOf(found as DiscoverNetwork) : ['all'];
    const kept = this.#memory.get(this.#key(open));
    open.list = kept && open.lists.indexOf(kept.list) >= 0 ? kept.list : (open.lists[0] as NetworkList);
    this.#drawFrame(open);
    open.title = open.kind === 'service' ? found.name : SOURCE_TEXT.heading('studio', found.name);
    if (!sync) open.context.setTitle(open.title);
    this.#showList(open, open.list);
    if (!sync && open.fallback) open.context.focus(open.fallback);
  }

  #key(open: Open): string {
    return `${open.kind}:${open.id}`;
  }

  /** The header, the tabs and "New only", the panel the list goes into, and the foot. */
  #drawFrame(open: Open): void {
    const render = open.render;
    open.frameNo += 1;
    const frameNo = open.frameNo;
    const source = open.source as DiscoverNetwork | DiscoverStudio;
    if (open.imageWatch) open.imageWatch.disconnect();
    const Watcher = typeof IntersectionObserver === 'function' ? IntersectionObserver : undefined;
    open.imageWatch = Watcher ? new Watcher((entries) => this.#onImages(open, render, entries), { rootMargin: IMAGE_MARGIN }) : undefined;
    const head = this.#el('div', 'jellypass-tv-source-head padded-left padded-right');
    const tile = this.#el('span', 'jellypass-tv-source-logo');
    const headUnit: Unit = { element: tile, images: [], near: !open.imageWatch };
    open.headUnit = headUnit;
    if (source.logoUrl) tile.appendChild(imageIn(this.#document, headUnit, 'jellypass-tv-source-logo-image', source.logoUrl));
    else tile.textContent = source.name;
    open.units.set(tile, headUnit);
    if (open.imageWatch) open.imageWatch.observe(tile);
    // The logo is decorative: the heading says the name.
    tile.setAttribute('aria-hidden', 'true');
    head.appendChild(tile);
    const heading = this.#el('h1', 'jellypass-tv-source-heading');
    open.heading = heading;
    head.appendChild(heading);
    open.view.appendChild(head);
    const controls = this.#el('div', 'jellypass-tv-discover-chips padded-left padded-right focuscontainer-x');
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', SOURCE_TEXT.listsLabel);
    open.tabs = {};
    if (open.lists.length > 1) {
      for (const list of open.lists) {
        const tab = this.#button('jellypass-tv-discover-chip', SOURCE_TEXT.lists[list], `tab:${list}`);
        tab.setAttribute('aria-pressed', 'false');
        tab.addEventListener('click', () => { if (open.frameNo === frameNo) this.#choose(open, render, list); });
        open.tabs[list] = tab;
        controls.appendChild(tab);
      }
    }
    // Beside the tabs it is set apart from them (as on Discover); alone (a studio, a service with no films) it starts the line.
    const hide = this.#button(`jellypass-tv-discover-chip jellypass-tv-discover-chip-toggle${open.lists.length > 1 ? '' : ' jellypass-tv-source-toggle-alone'}`, DISCOVER_TEXT.hideHeld, 'chip:hide');
    hide.setAttribute('aria-label', DISCOVER_TEXT.hideHeldName);
    hide.setAttribute('aria-pressed', String(this.#hide.held));
    hide.addEventListener('click', () => { if (open.frameNo === frameNo) this.#toggleHide(open, render); });
    open.hideChip = hide;
    controls.appendChild(hide);
    open.view.appendChild(controls);
    const panel = this.#el('div', 'jellypass-tv-source-panel');
    open.panel = panel;
    open.view.appendChild(panel);
    const status = this.#el('div', 'jellypass-tv-source-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    open.status = status;
    open.view.appendChild(status);
    const foot = this.#el('div', 'jellypass-tv-discover-foot padded-left padded-right focusable');
    foot.setAttribute('tabindex', '0');
    foot.setAttribute(FOCUS_ATTR, 'foot');
    foot.appendChild(this.#el('p', 'jellypass-tv-discover-notice', TMDB_NOTICE));
    open.view.appendChild(foot);
    open.fallback = open.lists.length > 1 ? open.tabs[open.list] : hide;
  }

  #onImages(open: Open, render: Render, entries: IntersectionObserverEntry[]): void {
    if (!this.#live(open, render)) return;
    for (const entry of entries) {
      const unit = open.units.get(entry.target);
      if (unit) setNear(unit, entry.isIntersecting);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The list

  #request(open: Open, list: NetworkList, page: number): DiscoverRequest {
    if (open.kind === 'service') return page > 1 ? { kind: 'network', id: open.id, list, page } : { kind: 'network', id: open.id, list };
    return page > 1 ? { kind: 'studio', id: open.id, page } : { kind: 'studio', id: open.id };
  }

  #choose(open: Open, render: Render, list: NetworkList): void {
    if (!this.#live(open, render) || list === open.list) return;
    open.list = list;
    const kept = this.#memory.get(this.#key(open));
    this.#memory.set(this.#key(open), { list, loaded: kept ? kept.loaded : {} });
    this.#showList(open, list);
  }

  #toggleHide(open: Open, render: Render): void {
    if (!this.#live(open, render)) return;
    this.#hide.held = !this.#hide.held;
    (open.hideChip as HTMLElement).setAttribute('aria-pressed', String(this.#hide.held));
    if (open.grid) this.#fillGrid(open);
  }

  /** Draws `list` from the pages that were showing and are kept (no call), and asks for its first page only if that one is gone. */
  #showList(open: Open, list: NetworkList): void {
    open.gen += 1;
    const gen = open.gen;
    open.list = list;
    open.pages = [];
    open.nextPage = null;
    this.#teardown(open, 'panel');
    // The tab is where focus falls back to now (an empty Films page's pagination ends on Films, not on All).
    if (open.lists.length > 1) open.fallback = open.tabs[list];
    for (const key of Object.keys(open.tabs)) (open.tabs[key] as HTMLElement).setAttribute('aria-pressed', String(key === list));
    (open.heading as HTMLElement).textContent = SOURCE_TEXT.heading(open.kind, (open.source as DiscoverStudio).name, list);
    const memory = this.#memory.get(this.#key(open));
    const wanted = memory && memory.loaded[list] ? (memory.loaded[list] as number) : 1;
    for (let page = 1; page <= wanted; page += 1) {
      const kept = this.#data.peek(this.#request(open, list, page)) as { ok: true; value: ListPage } | Failure | undefined;
      if (!kept || !kept.ok) break;
      open.pages.push(kept.value);
      open.nextPage = kept.value.nextPage;
    }
    if (open.pages.length > 0) {
      this.#frame(open);
      this.#fillGrid(open);
      this.#offerMore(open);
      return;
    }
    this.#skeleton(open);
    this.#ask(open, gen, 1, false);
  }

  #skeleton(open: Open): void {
    const panel = open.panel as HTMLElement;
    this.#teardown(open, 'panel');
    const grid = this.#el('div', listClasses(`jellypass-tv-source-grid ${JELLYFIN_CLASSES.grid} jellypass-tv-discover-skeleton padded-left padded-right`, this.#tv()));
    grid.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < SKELETON_CARDS; i += 1) grid.appendChild(skeletonCard(this.#document, 'portrait'));
    panel.appendChild(grid);
    panel.setAttribute('aria-busy', 'true');
  }

  /** The grid's place in the panel, once there is a page to draw. */
  #frame(open: Open): void {
    const panel = open.panel as HTMLElement;
    this.#teardown(open, 'panel');
    open.grid = this.#el('div', listClasses(`jellypass-tv-source-grid ${JELLYFIN_CLASSES.grid} padded-left padded-right`, this.#tv()));
    panel.appendChild(open.grid);
  }

  /** The page `number` of the list shown: kept, in flight or asked for now. */
  #ask(open: Open, gen: number, number: number, retry: boolean): void {
    const render = open.render;
    const list = open.list;
    this.#data.get(this.#request(open, list, number), { retry }).then((result) => {
      if (!this.#live(open, render, gen) || 'stale' in result) return;
      if (result.ok) {
        const first = open.pages.length === 0;
        const hadFocus = !first && open.more !== undefined && this.#document.activeElement === open.more;
        open.pages.push(result.value as ListPage);
        open.nextPage = (result.value as ListPage).nextPage;
        this.#remember(open);
        if (first) {
          this.#frame(open);
          this.#fillGrid(open);
          if (open.fallback) open.context.focus(open.fallback);
        }
        if (!first) this.#append(open, result.value as ListPage);
        open.loading = false;
        this.#offerMore(open);
        if (hadFocus) this.#keepFocus(open);
        if (!first && open.status) open.status.textContent = SOURCE_TEXT.moreLoaded;
        return;
      }
      open.loading = false;
      if (open.pages.length === 0) {
        this.#failed(open, result, open.panel as HTMLElement, () => { this.#skeleton(open); this.#ask(open, gen, 1, true); }, 'retry');
        return;
      }
      // Load more failed: the cards stay, the words say why, and Load more (the same button) asks again.
      this.#loadFailed(open, result);
    });
  }

  /** How many pages of the list showed, so coming back to the page draws them from what is kept. */
  #remember(open: Open): void {
    const kept = this.#memory.get(this.#key(open));
    const loaded: { [list: string]: number } = kept ? kept.loaded : {};
    loaded[open.list] = open.pages.length;
    this.#memory.set(this.#key(open), { list: open.list, loaded });
  }

  #stateOf(card: DiscoverCard): HouseholdState {
    return this.#asked.state(card.mediaType, card.tmdbId, card.state);
  }

  #cardKey(card: DiscoverCard): string {
    return `${card.mediaType}:${card.tmdbId}`;
  }

  /** Every card of the pages shown that "New only" leaves, in order. */
  #visible(open: Open): DiscoverCard[] {
    const cards: DiscoverCard[] = [];
    for (const page of open.pages) {
      for (const card of page.cards) {
        if (this.#hide.held && isHeld({ state: this.#stateOf(card) })) continue;
        cards.push(card);
      }
    }
    return cards;
  }

  #visibleKeys(open: Open): string {
    return this.#visible(open).map((card) => this.#cardKey(card)).join(' ');
  }

  /** The cards' images are forgotten (the cards are being drawn again); the header's logo stays watched. */
  #resetUnits(open: Open, all = false): void {
    const head = all ? undefined : open.headUnit;
    if (all) open.headUnit = undefined;
    // The cards go: their pictures let go of their sources (a card the remote left behind holds nothing).
    open.units.forEach((unit) => {
      if (unit === head) return;
      for (const one of unit.images) one.image.removeAttribute('src');
      unit.images = [];
    });
    open.units.forEach((_unit, element) => { if (open.imageWatch) open.imageWatch.unobserve(element); });
    open.units = new Map();
    if (open.imageWatch) open.imageWatch.disconnect();
    if (head) {
      open.units.set(head.element, head);
      if (open.imageWatch) open.imageWatch.observe(head.element);
    }
  }

  /** The grid drawn again from the pages shown (the choice of "New only", the overlay): no call. */
  #fillGrid(open: Open): void {
    const grid = open.grid as HTMLElement;
    this.#teardown(open, 'grid');
    const cards = this.#visible(open);
    if (cards.length === 0) {
      const held = open.pages.some((page) => page.cards.length > 0);
      grid.appendChild(this.#el('p', 'jellypass-tv-discover-row-note-text', this.#hide.held && held ? DISCOVER_TEXT.nothingLeft : DISCOVER_TEXT.nothing));
      this.#credit(open);
      return;
    }
    for (const card of cards) this.#draw(open, grid, card);
    this.#credit(open);
  }

  /** New cards at the end of the grid (Load more): what is drawn keeps its place, and focus with it. */
  #append(open: Open, page: ListPage): DiscoverCard[] {
    const grid = open.grid as HTMLElement;
    const empty = grid.querySelector('.jellypass-tv-discover-row-note-text');
    if (empty) grid.removeChild(empty);
    const added: DiscoverCard[] = [];
    for (const card of page.cards) {
      if (this.#hide.held && isHeld({ state: this.#stateOf(card) })) continue;
      added.push(card);
    }
    const from = open.drawn.length;
    for (const card of added) this.#draw(open, grid, card);
    if (added.length === 0 && open.drawn.length === 0) this.#fillGrid(open);
    const first = open.drawn[from];
    const more = open.more;
    // Focus was on Load more, which goes (or moves down): the first new card takes it, as the app's does.
    if (first && more && this.#document.activeElement === more) first.button.focus();
    return added;
  }

  /** Focus is never left on something that is gone: Load more drawn again, else the last card, else the tab or toggle. */
  #keepFocus(open: Open): void {
    const now = this.#document.activeElement;
    if (now && now !== this.#document.body && open.view.contains(now)) return;
    const last = open.drawn[open.drawn.length - 1];
    if (open.more) open.more.focus();
    else if (last) last.button.focus();
    // The host ignores a focus request once the member has used the remote: this focus is ours, taken directly.
    else if (open.fallback) open.fallback.focus();
  }

  #draw(open: Open, grid: HTMLElement, card: DiscoverCard): void {
    const render = open.render;
    const gridNo = open.gridNo;
    const unit: Unit = { element: grid, images: [], near: !open.imageWatch };
    const one = drawCard(this.#document, unit, { card, shape: 'portrait', tv: this.#tv(), key: `card:${card.mediaType}:${card.tmdbId}` });
    unit.element = one.button;
    // Kept with or without an observer, so a redraw can let go of the pictures either way.
    open.units.set(one.button, unit);
    if (open.imageWatch) open.imageWatch.observe(one.button);
    one.button.addEventListener('click', () => {
      if (this.#live(open, render) && open.gridNo === gridNo) this.#host.navigate(titleHash(card.mediaType, card.tmdbId));
    });
    markCard(one, this.#stateOf(card));
    open.drawn.push(one);
    grid.appendChild(one.button);
  }

  /** The JustWatch line under a service's All and Films (a service's films are TMDB's where-to-watch data, which is JustWatch's). */
  #credit(open: Open): void {
    const panel = open.panel as HTMLElement;
    const old = panel.querySelector('.jellypass-tv-discover-credit');
    if (old) panel.removeChild(old);
    if (open.kind === 'service' && open.list !== 'series') panel.appendChild(this.#el('p', 'jellypass-tv-discover-credit padded-left padded-right', JUSTWATCH_NOTE));
  }

  /** Load more, after the grid, while the API has a next page. */
  #offerMore(open: Open): void {
    const panel = open.panel as HTMLElement;
    const had = open.more;
    if (had && had.parentNode) had.parentNode.removeChild(had);
    open.more = undefined;
    if (open.nextPage === null) return;
    const render = open.render;
    const gen = open.gen;
    const wrap = this.#el('div', 'jellypass-tv-source-more padded-left padded-right');
    const more = this.#button('raised jellypass-tv-discover-button', SOURCE_TEXT.loadMore, 'more');
    more.addEventListener('click', () => {
      if (!this.#live(open, render, gen) || open.more !== more || open.loading || open.nextPage === null) return;
      open.loading = true;
      more.textContent = SOURCE_TEXT.loading;
      more.setAttribute('aria-disabled', 'true');
      if (open.note && open.note.parentNode) open.note.parentNode.removeChild(open.note);
      open.note = undefined;
      // Choosing Load more is a member's ask: it passes a failure remembered for the last 30 seconds (it never passes a rate limit).
      this.#ask(open, gen, open.nextPage, true);
    });
    wrap.appendChild(more);
    open.more = more;
    const credit = panel.querySelector('.jellypass-tv-discover-credit');
    panel.insertBefore(wrap, credit);
  }

  #loadFailed(open: Open, failure: Failure): void {
    const more = open.more;
    if (more) {
      more.textContent = SOURCE_TEXT.loadMore;
      more.removeAttribute('aria-disabled');
    }
    const kind = ERROR_TEXT[kindOf(failure)];
    if (failure.status === 401) {
      this.#teardown(open, 'panel');
      (open.panel as HTMLElement).appendChild(this.#note(kind.title, kind.body));
      return;
    }
    const note = this.#el('p', 'jellypass-tv-discover-row-note-text padded-left padded-right', `${kind.title}. ${kind.body}`);
    note.setAttribute('role', 'alert');
    open.note = note;
    const panel = open.panel as HTMLElement;
    panel.insertBefore(note, more ? more.parentNode : null);
  }

  /** A failure in `into`: its words, and Try again (never by itself) unless the sign-in is refused. */
  #failed(open: Open, failure: Failure, into: HTMLElement, again: () => void, key: string): void {
    const render = open.render;
    const gen = open.gen;
    this.#teardown(open, into === open.view ? 'view' : 'panel');
    const kind = ERROR_TEXT[kindOf(failure)];
    if (failure.status === 401) {
      into.appendChild(this.#note(kind.title, kind.body));
      return;
    }
    const note = this.#el('div', 'jellypass-tv-discover-row-note padded-left padded-right');
    note.appendChild(this.#el('p', 'jellypass-tv-discover-row-note-text', `${kind.title}. ${kind.body}`));
    const retry = this.#button('raised jellypass-tv-discover-button', DISCOVER_TEXT.retry, key);
    open.retry = retry;
    retry.addEventListener('click', () => {
      if (open.retry !== retry || !this.#live(open, render, gen)) return;
      open.retry = undefined;
      again();
    });
    note.appendChild(retry);
    into.appendChild(note);
    if (open.pages.length === 0 && !open.fallback) open.context.focus(retry);
  }
}
