import type { DiscoverCard, DiscoverList, DiscoverNetwork, DiscoverSources, Failure, HouseholdState, NetworkList } from './api.js';
import type { Asked } from './asked.js';
import { drawCard, imageIn, markCard, setNear, skeletonCard, type Drawn, type Unit } from './discover-card.js';
import type { DiscoverData, DiscoverRequest } from './discover-data.js';
import {
  DISCOVER_FILTERS,
  DISCOVER_LAYOUT,
  DISCOVER_TEXT,
  heroCards,
  isHeld,
  JUSTWATCH_NOTE,
  listHash,
  networkListFor,
  networksFor,
  rowCards,
  serviceHash,
  STATE_LABELS,
  studioHash,
  TMDB_NOTICE,
  type DiscoverFilter,
} from './discover-model.js';
import type { HidePreference } from './discover-preference.js';
import { JELLYFIN_CLASSES, listClasses } from './jellyfin-web.js';
import { FOCUS_ATTR, type PageContext, type PageView } from './page-host.js';
import type { SessionWatch, Stamp } from './session-watch.js';
import { ERROR_TEXT, kindOf, titleHash } from './title.js';

/**
 * The JellyPass Discover page (docs/tv-addon.md, "The Discover page"): the household app's Home as a page of Jellyfin web's
 * at `#/jellypass/discover`, on the page host (page-host.ts), under Jellyfin's real header and Back. A hero of up to five
 * slides (Previous / View / Next and dots, no auto-advance, no swipe), the All / Movies / TV chips and "New only",
 * the rows of `DISCOVER_LAYOUT`, and a foot with the studios, the JustWatch line and the TMDB notice. Choosing a card opens
 * the JellyPass title page; Back returns here with the same card focused and no Discover call (the answers are kept by
 * `DiscoverData`, and a returning page draws them before it asks for anything).
 *
 * Rows ask as they come near the screen (an IntersectionObserver, Chromium 51+), and a row's images are set only while it is
 * within about a screen and a half, and taken away again when it is far off, because a 2019 set has about 1 GB and no
 * `loading="lazy"`. Where there is no IntersectionObserver every row asks at once and every image is set.
 *
 * It is a route, so Jellyfin web's header, Back, history and focus manager are what apply: this module handles no key. It
 * shows only the household's own view (what the API answered, through the "Get this" overlay), set with `textContent`; an
 * image is only the API's TMDB URL. A late answer, from a session since ended, is dropped by `DiscoverData`.
 */

/** Marks the page's content (one at most is ever on the page). */
export const DISCOVER_ATTRIBUTE = 'data-jellypass-tv-discover';
/** A row asks when it is this near the screen (the study measured 5 calls on opening, 10 more on the way down, with it). */
export const DATA_MARGIN = '700px 0px';
/** A row's images are set while it is this near (a screen's height is 100%: about a screen and a half in all, up and down). */
export const IMAGE_MARGIN = '25% 0px';
/** The placeholder cards a row that is still loading shows. */
const SKELETON_CARDS = 7;

/** What the page asks of the page around it. */
export interface DiscoverHost {
  /** Opens Jellyfin web's page at `hash` (a title, a service or a studio). */
  navigate(hash: string): void;
  /** A service's page is about to be opened from a row that shows `list`: it opens on that list. */
  openService(id: number, list: NetworkList): void;
}

/**
 * One drawing of the page under one session. It is never changed: a new token (or sign-in) makes a new one, so what an earlier one
 * drew (a card, a chip, a button) keeps pointing at the earlier one and is refused, however long the element is kept.
 */
interface Render {
  readonly stamp: Stamp;
}

/** What a callback drawn into the body remembers: the page, the drawing, and which painting of the body it came from. */
interface Scope {
  readonly open: Open;
  readonly render: Render;
  readonly paint: number;
}

interface RowView {
  scope: Scope;
  id: string;
  heading: string;
  variant: 'poster' | 'backdrop';
  request: DiscoverRequest;
  eager: boolean;
  /** The first row: its cards are the hero's. */
  feeds: boolean;
  section: HTMLElement;
  /** What the row shows under its heading: placeholders, then its cards, or why there are none. */
  body: HTMLElement;
  unit: Unit;
  asked: boolean;
  answered: DiscoverCard[] | undefined;
  drawn: Drawn[];
  /** Bumped each time the row's cards are drawn: a card of an earlier drawing does nothing. */
  fill: number;
  /** The Try again of the failure on show: only this one answers, once; a retained one does nothing. */
  retry: HTMLElement | undefined;
}

interface Hero {
  slides: DiscoverCard[];
  unit: Unit;
  title: HTMLElement;
  facts: HTMLElement;
  overview: HTMLElement;
  dots: HTMLElement;
  view: HTMLElement;
  image: HTMLImageElement;
}

interface Open {
  userId: string;
  /** The Try again of a failed sources call on show (see RowView.retry). */
  retry: HTMLElement | undefined;
  /** The drawing under the session the page is shown for (member, token and sign-in generation): every callback checks it still holds. */
  render: Render;
  context: PageContext;
  view: HTMLElement;
  heroSlot: HTMLElement;
  chipBox: HTMLElement;
  chips: { [key: string]: HTMLElement };
  body: HTMLElement;
  /** Bumped by every drawing of the body and by leaving: an answer that comes for an earlier one is dropped. */
  paint: number;
  rows: RowView[];
  units: Unit[];
  hero: Hero | undefined;
  /** Where the services' rows, and the foot, go in the body once the sources are known. */
  networks: HTMLElement | undefined;
  /** The studios' tiles, above the foot. */
  studios: HTMLElement | undefined;
  foot: HTMLElement | undefined;
  dataWatch: IntersectionObserver | undefined;
  imageWatch: IntersectionObserver | undefined;
  /** The rows by their section, for the observer's callbacks. */
  byElement: Array<{ element: Element; row?: RowView; unit?: Unit }>;
}

export class DiscoverPage {
  readonly #document: Document;
  readonly #watch: SessionWatch;
  readonly #data: DiscoverData;
  readonly #asked: Asked;
  readonly #host: DiscoverHost;
  /** The member everything below belongs to: another member, or no one, forgets it (in memory only). */
  #owner: string | undefined;
  readonly #hide: HidePreference;
  #filter: DiscoverFilter = 'all';
  #slide = 0;
  #open: Open | undefined;

  public constructor(document: Document, watch: SessionWatch, data: DiscoverData, asked: Asked, host: DiscoverHost, hide: HidePreference) {
    this.#document = document;
    this.#hide = hide;
    this.#watch = watch;
    this.#data = data;
    this.#asked = asked;
    this.#host = host;
  }

  public get isOpen(): boolean {
    return this.#open !== undefined;
  }

  #member(userId: string | undefined): void {
    if (userId === this.#owner) return;
    this.#owner = userId;
    this.#filter = 'all';
    this.#hide.forMember(userId);
    this.#slide = 0;
  }

  /** Called on every page change: signed out, or another member signed in, the page (if open) is emptied and nothing more is asked. */
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
    } else if (!this.#watch.holds(open.render.stamp)) {
      // The same member under a new token (or a new sign-in): what the old session fetched is not shown, the page is drawn afresh.
      this.#asked.sync(session.userId);
      open.render = { stamp: this.#watch.stamp(session) };
      this.#drawChips(open);
      this.#paint(open);
    }
  }

  /**
   * Whether `open` is still the page shown, under the very session it was drawn for. Every callback that can arrive later than the
   * thing that started it (an observer, a click, an answer) asks this first and does nothing if not: sign-out, another member or a
   * new token are seen here at once, before `update` has had its turn to end the page.
   */
  #live(open: Open, render: Render, paint?: number): boolean {
    return this.#open === open && open.render === render && (paint === undefined || open.paint === paint) && this.#watch.holds(render.stamp) !== undefined;
  }

  /** For a callback that asks at the moment it runs, not for something drawn earlier (the overlay, an observer of the current painting). */
  #current(open: Open): boolean {
    return this.#live(open, open.render);
  }

  /** The "Get this" overlay changed (an accepted request, a cancel, or an expiry): the statuses are drawn again, no call. */
  public overlayChanged(): void {
    const open = this.#open;
    if (!open || !this.#current(open)) return;
    for (const row of open.rows) {
      if (!row.answered) continue;
      if (this.#hide.held && this.#visibleKeys(row) !== row.drawn.map((one) => this.#cardKey(one.card)).join(' ')) this.#fill(row);
      else for (const one of row.drawn) this.#mark(one);
    }
    this.#refreshHero(open);
  }

  /** The chips, new for each drawing: one kept from an earlier drawing (an earlier token) does nothing. */
  #drawChips(open: Open): void {
    const render = open.render;
    open.chipBox.textContent = '';
    open.chips = {};
    for (const filter of DISCOVER_FILTERS) {
      const chip = this.#chip(DISCOVER_TEXT.filters[filter], `chip:${filter}`, this.#filter === filter);
      chip.addEventListener('click', () => this.#choose(open, render, filter));
      open.chips[filter] = chip;
      open.chipBox.appendChild(chip);
    }
    const hide = this.#chip(DISCOVER_TEXT.hideHeld, 'chip:hide', this.#hide.held);
    hide.className += ' jellypass-tv-discover-chip-toggle';
    hide.setAttribute('aria-label', DISCOVER_TEXT.hideHeldName);
    hide.addEventListener('click', () => this.#toggleHide(open, render));
    open.chips.hide = hide;
    open.chipBox.appendChild(hide);
  }

  /** The page host's render for the route. */
  public render(context: PageContext): PageView {
    const cleanup = () => this.#leave(context);
    const session = this.#watch.current();
    const view = this.#el('div', 'jellypass-tv-discover-page');
    view.setAttribute(DISCOVER_ATTRIBUTE, '');
    context.container.appendChild(view);
    if (!session) {
      this.#member(undefined);
      view.appendChild(this.#note(ERROR_TEXT.unauthorized.title, ERROR_TEXT.unauthorized.body));
      return { title: DISCOVER_TEXT.title, cleanup };
    }
    this.#member(session.userId);
    this.#asked.sync(session.userId);
    const heroSlot = this.#el('div', 'jellypass-tv-discover-hero-slot');
    const chips = this.#el('div', 'jellypass-tv-discover-chips padded-left padded-right focuscontainer-x');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', DISCOVER_TEXT.chips);
    const body = this.#el('div', 'jellypass-tv-discover-body');
    view.appendChild(heroSlot);
    view.appendChild(chips);
    view.appendChild(body);
    const open: Open = { retry: undefined, userId: session.userId, render: { stamp: this.#watch.stamp(session) }, context, view, heroSlot, chipBox: chips, chips: {}, body, paint: 0, rows: [], units: [], hero: undefined, networks: undefined, studios: undefined, foot: undefined, dataWatch: undefined, imageWatch: undefined, byElement: [] };
    this.#drawChips(open);
    this.#open = open;
    this.#paint(open);
    return { title: DISCOVER_TEXT.title, cleanup, focus: open.hero ? open.hero.view : (open.chips[this.#filter] as HTMLElement) };
  }

  /** The page is left: what is in flight is dropped (by the paint number), and the observers stop. */
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
    open.paint = -1;
    this.#teardown(open, 'body');
    if (open.dataWatch) open.dataWatch.disconnect();
    if (open.imageWatch) open.imageWatch.disconnect();
    open.dataWatch = undefined;
    open.imageWatch = undefined;
  }

  /**
   * The ONE way anything the page drew goes (a redraw for another chip, the leaving of the page, a service row's or the whole
   * list's sign-in prompt, an error state, a row or the hero drawn again): it bumps what the retained controls check (a row's
   * `fill`; the hero and a row are also forgotten by identity, `open.hero` and `open.rows`), forgets the Try again pointers,
   * and lets go of the pictures (unobserve, no `src`) before the DOM is emptied. `row` is one row's body; `hero` is the hero;
   * `networks` is the services' rows; `body` is everything (the hero too).
   */
  #teardown(open: Open, scope: 'row' | 'hero' | 'networks' | 'body', row?: RowView): void {
    if (scope === 'row' && row) {
      row.retry = undefined;
      row.fill += 1;
      row.drawn = [];
      this.#clearImages(row.unit);
      row.unit.images = [];
      row.body.textContent = '';
      row.body.removeAttribute('aria-busy');
      return;
    }
    if (scope === 'hero') {
      if (open.hero) this.#dropUnit(open, open.hero.unit);
      open.hero = undefined;
      open.heroSlot.textContent = '';
      return;
    }
    if (scope === 'networks') {
      const slot = open.networks;
      if (!slot) return;
      const gone = open.rows.filter((one) => slot.contains(one.section));
      for (const one of gone) {
        this.#teardown(open, 'row', one);
        if (open.dataWatch) open.dataWatch.unobserve(one.section);
        this.#dropUnit(open, one.unit);
      }
      open.rows = open.rows.filter((one) => gone.indexOf(one) < 0);
      open.byElement = open.byElement.filter((one) => !one.row || gone.indexOf(one.row) < 0);
      open.retry = undefined;
      slot.textContent = '';
      slot.removeAttribute('aria-busy');
      return;
    }
    for (const one of open.rows) this.#teardown(open, 'row', one);
    for (const unit of open.units) this.#clearImages(unit);
    this.#teardown(open, 'hero');
    open.body.textContent = '';
    open.rows = [];
    open.units = [];
    open.byElement = [];
    open.retry = undefined;
    open.networks = undefined;
    open.studios = undefined;
    open.foot = undefined;
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

  #note(title: string, body: string): HTMLElement {
    const note = this.#el('div', 'jellypass-tv-discover-note padded-left padded-right');
    note.appendChild(this.#el('h2', 'jellypass-tv-discover-note-title', title));
    note.appendChild(this.#el('p', 'jellypass-tv-discover-note-body', body));
    return note;
  }

  /** A button in Jellyfin web's own look (`emby-button`), with its focus ring on a TV; `key` is what Back returns focus to. */
  #button(className: string, text: string, key: string): HTMLButtonElement {
    const button = this.#el('button', `emby-button ${this.#tv() ? 'show-focus ' : ''}${className}`, text) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute(FOCUS_ATTR, key);
    return button;
  }

  #chip(text: string, key: string, pressed: boolean): HTMLButtonElement {
    const chip = this.#button('jellypass-tv-discover-chip', text, key);
    chip.setAttribute('aria-pressed', String(pressed));
    return chip;
  }

  #choose(open: Open, render: Render, filter: DiscoverFilter): void {
    if (!this.#live(open, render) || filter === this.#filter) return;
    this.#filter = filter;
    this.#slide = 0;
    for (const one of DISCOVER_FILTERS) (open.chips[one] as HTMLElement).setAttribute('aria-pressed', String(one === filter));
    this.#paint(open);
  }

  #toggleHide(open: Open, render: Render): void {
    if (!this.#live(open, render)) return;
    this.#hide.held = !this.#hide.held;
    open.chips.hide?.setAttribute('aria-pressed', String(this.#hide.held));
    for (const row of open.rows) if (row.answered) this.#fill(row);
    this.#refreshHero(open);
  }

  /** A card's state as the member sees it: the household's own, with what they just asked for on this TV. */
  #stateOf(card: DiscoverCard): HouseholdState {
    return this.#asked.state(card.mediaType, card.tmdbId, card.state);
  }

  #cardKey(card: DiscoverCard): string {
    return `${card.mediaType}:${card.tmdbId}`;
  }

  /** The cards a row shows now, as keys: what "New only" leaves, at most the row's 14. */
  #visible(row: RowView): DiscoverCard[] {
    const states = (row.answered as DiscoverCard[]).map((card) => ({ card, state: this.#stateOf(card) }));
    return rowCards(states, this.#hide.held).map((one) => one.card);
  }

  #visibleKeys(row: RowView): string {
    return this.#visible(row).map((card) => this.#cardKey(card)).join(' ');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The body

  /** Draws the page's body for the chip from what is kept, and asks for the rest (eager rows now, the others near the screen). */
  #paint(open: Open): void {
    if (this.#open !== open) return;
    open.paint += 1;
    const paint = open.paint;
    if (open.dataWatch) open.dataWatch.disconnect();
    if (open.imageWatch) open.imageWatch.disconnect();
    const Watcher = typeof IntersectionObserver === 'function' ? IntersectionObserver : undefined;
    open.dataWatch = Watcher ? new Watcher((entries) => this.#onData(open, paint, entries), { rootMargin: DATA_MARGIN }) : undefined;
    open.imageWatch = Watcher ? new Watcher((entries) => this.#onImages(open, paint, entries), { rootMargin: IMAGE_MARGIN }) : undefined;
    this.#teardown(open, 'body');
    const layout = DISCOVER_LAYOUT[this.#filter];
    let feeds = true;
    for (const part of layout) {
      if (part.part === 'row') {
        const row = this.#addRow(open, part.variant, { kind: 'list', list: part.list }, part.list, part.heading, part.eager, feeds);
        feeds = false;
        open.body.appendChild(row.section);
      } else if (part.part === 'networks') {
        open.networks = this.#el('div', 'jellypass-tv-discover-networks');
        open.body.appendChild(open.networks);
      }
    }
    open.studios = this.#el('div', 'jellypass-tv-discover-studios padded-left padded-right');
    open.body.appendChild(open.studios);
    open.foot = this.#el('div', 'jellypass-tv-discover-foot padded-left padded-right focusable');
    open.foot.setAttribute('tabindex', '0');
    open.foot.setAttribute(FOCUS_ATTR, 'foot');
    open.body.appendChild(open.foot);
    open.foot.appendChild(this.#el('p', 'jellypass-tv-discover-notice', TMDB_NOTICE));
    if (open.rows[0] && !open.rows[0].answered) {
      // Keeps the hero's room while the first row is on its way, so the page does not jump when it arrives.
      open.heroSlot.className = 'jellypass-tv-discover-hero-slot jellypass-tv-discover-hero-slot-waiting';
    }
    for (const row of open.rows) this.#start(open, paint, row);
    this.#sources(open, paint, false);
  }

  #unit(open: Open, element: Element): Unit {
    const unit: Unit = { element, images: [], near: !open.imageWatch };
    open.units.push(unit);
    if (open.imageWatch) {
      open.byElement.push({ element, unit });
      open.imageWatch.observe(element);
    }
    return unit;
  }

  /** The images of a unit that is being drawn again or dropped lose their sources (they are detached: nothing should still hold a picture). */
  #clearImages(unit: Unit): void {
    for (const one of unit.images) one.image.removeAttribute('src');
  }

  /** A unit that goes (the hero before it is drawn again): no longer watched or kept, and its images let go. */
  #dropUnit(open: Open, unit: Unit): void {
    if (open.imageWatch) open.imageWatch.unobserve(unit.element);
    open.units = open.units.filter((one) => one !== unit);
    open.byElement = open.byElement.filter((one) => one.unit !== unit);
    this.#clearImages(unit);
    unit.images = [];
  }

  #addRow(open: Open, variant: RowView['variant'], request: DiscoverRequest, key: string, heading: string, eager: boolean, feeds: boolean, network?: DiscoverNetwork): RowView {
    const section = this.#el('div', `${JELLYFIN_CLASSES.section} jellypass-tv-discover-row`);
    const headingContainer = this.#el('div', JELLYFIN_CLASSES.headingContainer);
    const title = this.#el('h2', JELLYFIN_CLASSES.heading);
    if (network) title.appendChild(this.#serviceLink(open, network, heading, request));
    else title.textContent = heading;
    headingContainer.appendChild(title);
    if (request.kind === 'list') headingContainer.appendChild(this.#seeAll(open, request.list, heading));
    section.appendChild(headingContainer);
    const body = this.#el('div', 'jellypass-tv-discover-row-body');
    section.appendChild(body);
    const row: RowView = { scope: { open, render: open.render, paint: open.paint }, id: key, heading, variant, request, eager, feeds, section, body, unit: this.#unit(open, section), asked: false, answered: undefined, drawn: [], fill: 0, retry: undefined };
    this.#skeleton(row);
    open.rows.push(row);
    return row;
  }

  /**
   * A service row's heading is the link to the service's page: the `h2` stays a heading (a screen reader lists it as one, and the
   * link inside (a button with role=link: the add-on prevents no event, so there is no `href` to cancel) is named "<heading>, see all"), and the link is the one focus stop above the row (Up from its first card), where
   * Back returns to. A chevron after the words is drawn by the stylesheet. The page opens on the list the row shows.
   */
  #serviceLink(open: Open, network: DiscoverNetwork, heading: string, request: DiscoverRequest): HTMLElement {
    const render = open.render;
    const paint = open.paint;
    const link = this.#el('button', 'jellypass-tv-discover-link', heading) as HTMLButtonElement;
    link.type = 'button';
    link.setAttribute('role', 'link');
    link.setAttribute('aria-label', DISCOVER_TEXT.seeAll(heading));
    link.setAttribute(FOCUS_ATTR, `link:net${network.id}`);
    if (this.#tv()) link.className += ' show-focus';
    const list = request.kind === 'network' ? request.list : 'all';
    link.addEventListener('click', () => {
      if (!this.#live(open, render, paint)) return;
      this.#host.openService(network.id, list);
      this.#host.navigate(serviceHash(network.id));
    });
    return link;
  }

  /**
   * A list row's "see all": a button beside the heading (the `h2` stays only the heading, so a screen reader lists it as one), named
   * "<heading>, see all", the one focus stop above the row that Back returns to. It opens the list's grid page, whose first page
   * is this row's own answer, so nothing is asked.
   */
  #seeAll(open: Open, list: DiscoverList, heading: string): HTMLElement {
    const render = open.render;
    const paint = open.paint;
    const button = this.#el('button', `jellypass-tv-discover-link jellypass-tv-discover-see-all${this.#tv() ? ' show-focus' : ''}`, DISCOVER_TEXT.seeAllWords) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute('aria-label', DISCOVER_TEXT.seeAll(heading));
    button.setAttribute(FOCUS_ATTR, `see:${list}`);
    button.addEventListener('click', () => {
      if (!this.#live(open, render, paint)) return;
      this.#host.navigate(listHash(list));
    });
    return button;
  }

  #skeleton(row: RowView): void {
    this.#teardown(row.scope.open, 'row', row);
    const scroller = this.#el('div', 'jellypass-tv-row-scroller padded-left padded-right jellypass-tv-discover-skeleton');
    scroller.setAttribute('aria-hidden', 'true');
    const list = this.#el('div', listClasses('jellypass-tv-row-list', this.#tv()));
    for (let i = 0; i < SKELETON_CARDS; i += 1) list.appendChild(skeletonCard(this.#document, row.variant === 'backdrop' ? 'overflowBackdrop' : 'overflowPortrait'));
    scroller.appendChild(list);
    row.body.appendChild(scroller);
    row.body.setAttribute('aria-busy', 'true');
  }

  /** A row is drawn from what is kept at once; otherwise asked for now (eager) or when it comes near the screen. */
  #start(open: Open, paint: number, row: RowView): void {
    const kept = this.#data.peek(row.request) as { ok: true; value: { cards: DiscoverCard[] } } | Failure | undefined;
    if (kept && kept.ok) {
      this.#settle(open, row, kept.value.cards);
      return;
    }
    if (row.eager || !open.dataWatch) {
      this.#load(open, paint, row, false);
      return;
    }
    open.byElement.push({ element: row.section, row });
    open.dataWatch.observe(row.section);
  }

  #onData(open: Open, paint: number, entries: IntersectionObserverEntry[]): void {
    if (open.paint !== paint || !this.#current(open)) return;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const found = open.byElement.filter((one) => one.element === entry.target && one.row)[0];
      if (!found || !found.row || found.row.asked) continue;
      if (open.dataWatch) open.dataWatch.unobserve(entry.target);
      this.#load(open, paint, found.row, false);
    }
  }

  #onImages(open: Open, paint: number, entries: IntersectionObserverEntry[]): void {
    if (open.paint !== paint || !this.#current(open)) return;
    for (const entry of entries) {
      const found = open.byElement.filter((one) => one.element === entry.target && one.unit)[0];
      if (found && found.unit) setNear(found.unit, entry.isIntersecting);
    }
  }

  async #load(open: Open, paint: number, row: RowView, retry: boolean): Promise<void> {
    row.asked = true;
    const result = await this.#data.get(row.request, { retry });
    if (open.paint !== paint || !this.#current(open) || 'stale' in result) return;
    if (result.ok) this.#settle(open, row, (result.value as { cards: DiscoverCard[] }).cards);
    else {
      if (row.feeds) open.heroSlot.className = 'jellypass-tv-discover-hero-slot';
      this.#failed(open, paint, result, row.body, row, () => { this.#skeleton(row); this.#load(open, paint, row, true); }, row.id);
    }
  }

  /** A failure in `into`: its words, and Try again (never by itself) unless the sign-in is refused, which ends the page's rows. */
  #failed(open: Open, paint: number, failure: Failure, into: HTMLElement, owner: { retry: HTMLElement | undefined }, again: () => void, key: string): void {
    if (into === open.networks) this.#teardown(open, 'networks');
    else this.#teardown(open, 'row', owner as RowView);
    const kind = ERROR_TEXT[kindOf(failure)];
    if (failure.status === 401) {
      into.appendChild(this.#note(kind.title, kind.body));
      return;
    }
    const note = this.#el('div', 'jellypass-tv-discover-row-note padded-left padded-right');
    note.appendChild(this.#el('p', 'jellypass-tv-discover-row-note-text', `${kind.title}. ${kind.body}`));
    const retry = this.#button('raised jellypass-tv-discover-button', DISCOVER_TEXT.retry, `retry:${key}`);
    owner.retry = retry;
    retry.addEventListener('click', () => {
      if (owner.retry !== retry || open.paint !== paint || !this.#current(open)) return;
      owner.retry = undefined;
      again();
    });
    note.appendChild(retry);
    into.appendChild(note);
  }

  /** The row's answer arrived (or was kept): its cards are drawn, and the first row's are the hero's. */
  #settle(open: Open, row: RowView, cards: DiscoverCard[]): void {
    row.asked = true;
    row.answered = cards;
    this.#fill(row);
    if (row.feeds) this.#drawHero(open);
  }

  /** The row's cards, as "New only" and the overlay leave them, or why there are none. */
  #fill(row: RowView): void {
    this.#teardown(row.scope.open, 'row', row);
    const cards = this.#visible(row);
    if (cards.length === 0) {
      row.body.appendChild(this.#el('p', 'jellypass-tv-discover-row-note-text padded-left padded-right', this.#hide.held && (row.answered as DiscoverCard[]).length > 0 ? DISCOVER_TEXT.nothingLeft : DISCOVER_TEXT.nothing));
      return;
    }
    const scroller = this.#el('div', 'jellypass-tv-row-scroller padded-left padded-right');
    const list = this.#el('div', listClasses(`jellypass-tv-row-list ${JELLYFIN_CLASSES.row}`, this.#tv()));
    for (const card of cards) {
      const one = this.#card(row, card);
      row.drawn.push(one);
      list.appendChild(one.button);
    }
    scroller.appendChild(list);
    row.body.appendChild(scroller);
  }

  #card(row: RowView, card: DiscoverCard): Drawn {
    const one = drawCard(this.#document, row.unit, { card, shape: row.variant === 'backdrop' ? 'overflowBackdrop' : 'overflowPortrait', tv: this.#tv(), key: `${row.id}:${card.mediaType}:${card.tmdbId}` });
    const fill = row.fill;
    one.button.addEventListener('click', () => {
      if (row.fill === fill) this.#openTitle(row.scope, card);
    });
    this.#mark(one);
    return one;
  }

  /** A card's badge and name, from its state now: the words are always there, and the colour goes with them. */
  #mark(one: Drawn): void {
    markCard(one, this.#stateOf(one.card));
  }

  /** A card was chosen: the title page opens, for the member who is signed in (a card of a session since ended opens nothing). */
  #openTitle(scope: Scope, card: DiscoverCard): void {
    if (!this.#live(scope.open, scope.render, scope.paint)) return;
    this.#host.navigate(titleHash(card.mediaType, card.tmdbId));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The hero

  /** The slides the first row's answer gives now: with "New only" on, none that is in the library or asked for. */
  #heroSlides(open: Open): DiscoverCard[] {
    const feeding = open.rows.filter((row) => row.feeds && row.answered)[0];
    if (!feeding) return [];
    const held = this.#hide.held;
    return heroCards(feeding.answered as DiscoverCard[], held ? (card) => isHeld({ state: this.#stateOf(card) }) : undefined);
  }

  /** The hero drawn again after "New only" or the overlay changed what it may show: no call, and focus never falls off the page. */
  #refreshHero(open: Open): void {
    const slides = this.#heroSlides(open);
    const hero = open.hero;
    if (hero && slides.length === hero.slides.length && slides.every((card, index) => this.#cardKey(card) === this.#cardKey(hero.slides[index] as DiscoverCard))) {
      this.#showSlide(hero);
      return;
    }
    if (!hero && slides.length === 0) return;
    const inside = open.heroSlot.contains(this.#document.activeElement);
    this.#drawHero(open);
    // Focus was on a button of the hero that is gone: the new hero's View takes it, or the chip when there is no hero.
    if (inside && this.#current(open) && !open.heroSlot.contains(this.#document.activeElement)) {
      const target = open.hero ? open.hero.view : open.chips.hide;
      if (target) target.focus();
    }
  }

  #drawHero(open: Open): void {
    open.heroSlot.className = 'jellypass-tv-discover-hero-slot';
    this.#teardown(open, 'hero');
    const slides = this.#heroSlides(open);
    if (slides.length === 0) return;
    const section = this.#el('section', 'jellypass-tv-discover-hero');
    section.setAttribute('aria-roledescription', 'carousel');
    section.setAttribute('aria-label', DISCOVER_TEXT.heroLabel);
    const unit = this.#unit(open, section);
    const picture = this.#el('div', 'jellypass-tv-discover-hero-picture');
    const shade = this.#el('div', 'jellypass-tv-discover-hero-shade');
    const text = this.#el('div', 'jellypass-tv-discover-hero-text padded-left');
    const title = this.#el('h1', 'jellypass-tv-discover-hero-title');
    const facts = this.#el('div', 'jellypass-tv-discover-hero-facts');
    const overview = this.#el('p', 'jellypass-tv-discover-hero-overview');
    const buttons = this.#el('div', 'jellypass-tv-discover-hero-buttons focuscontainer-x');
    const previous = this.#button('raised jellypass-tv-discover-button jellypass-tv-discover-hero-step', '‹', 'hero:previous');
    previous.setAttribute('aria-label', DISCOVER_TEXT.previous);
    const view = this.#button('raised button-submit jellypass-tv-discover-button jellypass-tv-discover-hero-view', DISCOVER_TEXT.view, 'hero');
    const next = this.#button('raised jellypass-tv-discover-button jellypass-tv-discover-hero-step', '›', 'hero:next');
    next.setAttribute('aria-label', DISCOVER_TEXT.next);
    const dots = this.#el('span', 'jellypass-tv-discover-hero-dots');
    dots.setAttribute('aria-hidden', 'true');
    for (const node of [previous, view, next, dots]) buttons.appendChild(node);
    for (const node of [title, facts, overview, buttons]) text.appendChild(node);
    const image = imageIn(this.#document, unit, 'jellypass-tv-discover-hero-image', slides[0]?.backdropUrl as string);
    picture.appendChild(image);
    section.appendChild(picture);
    section.appendChild(shade);
    section.appendChild(text);
    open.heroSlot.appendChild(section);
    const scope: Scope = { open, render: open.render, paint: open.paint };
    const hero: Hero = { slides, unit, title, facts, overview, dots, view, image };
    open.hero = hero;
    // A button of a hero since drawn again does nothing: only the hero on the page is answered.
    previous.addEventListener('click', () => this.#step(scope, hero, -1));
    next.addEventListener('click', () => this.#step(scope, hero, 1));
    view.addEventListener('click', () => {
      if (open.hero !== hero) return;
      const card = hero.slides[this.#slide];
      if (card) this.#openTitle(scope, card);
    });
    this.#slide = Math.min(this.#slide, slides.length - 1);
    this.#showSlide(hero);
    // The hero is what the page opens on (or what Back finds again): the host leaves focus alone once the member has moved it.
    open.context.focus(view);
  }

  #step(scope: Scope, hero: Hero, by: number): void {
    if (scope.open.hero !== hero || !this.#live(scope.open, scope.render, scope.paint)) return;
    this.#slide = (Math.min(this.#slide, hero.slides.length - 1) + by + hero.slides.length) % hero.slides.length;
    this.#showSlide(hero);
  }

  #showSlide(hero: Hero): void {
    this.#slide = Math.max(0, Math.min(this.#slide, hero.slides.length - 1));
    const card = hero.slides[this.#slide] as DiscoverCard;
    const state = this.#stateOf(card);
    hero.title.textContent = card.title;
    hero.facts.textContent = [card.mediaType === 'tv' ? DISCOVER_TEXT.series : DISCOVER_TEXT.movie, card.year, card.rating === null ? null : `★ ${card.rating.toFixed(1)} TMDB`, STATE_LABELS[state]].filter((part) => part !== null && part !== '').join('  ·  ');
    hero.overview.textContent = card.overview;
    hero.dots.textContent = hero.slides.map((_, index) => (index === this.#slide ? '●' : '○')).join(' ');
    hero.view.setAttribute('aria-label', `${DISCOVER_TEXT.view} ${card.title}`);
    const entry = hero.unit.images[0];
    if (entry) {
      entry.url = card.backdropUrl as string;
      if (hero.unit.near) hero.image.setAttribute('src', entry.url);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Services and studios

  /** The sources (services and studios) are asked at once with the eager rows: they say which rows and which logos there are. */
  #sources(open: Open, paint: number, retry: boolean): void {
    const request: DiscoverRequest = { kind: 'sources' };
    const kept = this.#data.peek(request) as { ok: true; value: DiscoverSources } | Failure | undefined;
    if (kept && kept.ok && !retry) {
      this.#drawSources(open, paint, kept.value);
      return;
    }
    this.#data.get(request, { retry }).then((result) => {
      if (open.paint !== paint || !this.#current(open) || 'stale' in result) return;
      if (result.ok) this.#drawSources(open, paint, result.value as DiscoverSources);
      else if (open.networks) this.#failed(open, paint, result, open.networks, open, () => this.#sources(open, paint, true), 'sources');
    });
  }

  #drawSources(open: Open, paint: number, sources: DiscoverSources): void {
    const slot = open.networks;
    if (slot) {
      this.#teardown(open, 'networks');
      for (const network of networksFor(this.#filter, sources.networks)) {
        const row = this.#addRow(open, 'poster', { kind: 'network', id: network.id, list: networkListFor(this.#filter, network) }, `net${network.id}`, DISCOVER_TEXT.networkHeading(network.name), false, false, network);
        slot.appendChild(row.section);
        this.#start(open, paint, row);
      }
    }
    const foot = open.foot;
    const studiosSlot = open.studios;
    if (!foot || !studiosSlot) return;
    const parts = DISCOVER_LAYOUT[this.#filter];
    const studios = parts.some((part) => part.part === 'studios') && sources.studios.length > 0;
    const credit = parts.some((part) => part.part === 'credit') && sources.networks.some((network: DiscoverNetwork) => network.hasFilms);
    if (studios) {
      studiosSlot.appendChild(this.#el('h2', `${JELLYFIN_CLASSES.heading} jellypass-tv-discover-foot-heading`, DISCOVER_TEXT.studios));
      const strip = this.#el('ul', 'jellypass-tv-discover-logos');
      const unit = this.#unit(open, strip);
      const render = open.render;
      for (const studio of sources.studios) {
        const item = this.#el('li', 'jellypass-tv-discover-logo-item');
        // The tile is the link to the studio's page, named as the app names it ("Pixar movies"); the logo inside says nothing more.
        const tile = this.#el('button', 'jellypass-tv-discover-logo') as HTMLButtonElement;
        tile.type = 'button';
        tile.setAttribute('role', 'link');
        tile.setAttribute('aria-label', DISCOVER_TEXT.studioMovies(studio.name));
        tile.setAttribute(FOCUS_ATTR, `studio:${studio.id}`);
        if (this.#tv()) tile.className += ' show-focus';
        if (studio.logoUrl) tile.appendChild(imageIn(this.#document, unit, 'jellypass-tv-discover-logo-image', studio.logoUrl));
        else tile.textContent = studio.name;
        tile.addEventListener('click', () => {
          if (!this.#live(open, render, paint)) return;
          this.#host.navigate(studioHash(studio.id));
        });
        item.appendChild(tile);
        strip.appendChild(item);
      }
      studiosSlot.appendChild(strip);
    }
    if (credit) foot.insertBefore(this.#el('p', 'jellypass-tv-discover-credit', JUSTWATCH_NOTE), foot.firstChild);
  }
}
