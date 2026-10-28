import type { DiscoverCard, DiscoverNetwork, DiscoverSources, Failure, HouseholdState } from './api.js';
import type { Asked } from './asked.js';
import type { DiscoverData, DiscoverRequest } from './discover-data.js';
import {
  badgeOf,
  DISCOVER_FILTERS,
  DISCOVER_LAYOUT,
  DISCOVER_TEXT,
  heroCards,
  JUSTWATCH_NOTE,
  networkListFor,
  networksFor,
  rowCards,
  STATE_LABELS,
  TMDB_NOTICE,
  type DiscoverFilter,
} from './discover-model.js';
import { JELLYFIN_CLASSES } from './jellyfin-web.js';
import { FOCUS_ATTR, type PageContext, type PageView } from './page-host.js';
import type { SessionWatch, Stamp } from './session-watch.js';
import { ERROR_TEXT, kindOf, titleHash } from './title.js';

/**
 * The JellyPass Discover page (docs/tv-addon.md, "The Discover page"): the household app's Home as a page of Jellyfin web's
 * at `#/jellypass/discover`, on the page host (page-host.ts), under Jellyfin's real header and Back. A hero of up to five
 * slides (Previous / View / Next and dots, no auto-advance, no swipe), the All / Movies / TV chips and "Hide what I have",
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
  /** Opens Jellyfin web's page at `hash` (a title). */
  navigate(hash: string): void;
}

/** Images that are set only while the element holding them is near the screen. */
interface Unit {
  element: Element;
  images: Array<{ image: HTMLImageElement; url: string }>;
  near: boolean;
}

interface Drawn {
  card: DiscoverCard;
  button: HTMLElement;
  badge: HTMLElement;
}

interface RowView {
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
  /** The session the page was drawn under (member, token and sign-in generation): every callback checks it still holds. */
  stamp: Stamp;
  context: PageContext;
  view: HTMLElement;
  heroSlot: HTMLElement;
  chips: { [key: string]: HTMLElement };
  body: HTMLElement;
  /** Bumped by every drawing of the body and by leaving: an answer that comes for an earlier one is dropped. */
  paint: number;
  rows: RowView[];
  units: Unit[];
  hero: Hero | undefined;
  /** Where the services' rows, and the foot, go in the body once the sources are known. */
  networks: HTMLElement | undefined;
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
  #filter: DiscoverFilter = 'all';
  #hideHeld = false;
  #slide = 0;
  #open: Open | undefined;

  public constructor(document: Document, watch: SessionWatch, data: DiscoverData, asked: Asked, host: DiscoverHost) {
    this.#document = document;
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
    this.#hideHeld = false;
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
    } else if (!this.#watch.holds(open.stamp)) {
      // The same member under a new token (or a new sign-in): what the old session fetched is not shown, the page is drawn afresh.
      this.#asked.sync(session.userId);
      open.stamp = this.#watch.stamp(session);
      this.#paint(open);
    }
  }

  /**
   * Whether `open` is still the page shown, under the very session it was drawn for. Every callback that can arrive later than the
   * thing that started it (an observer, a click, an answer) asks this first and does nothing if not: sign-out, another member or a
   * new token are seen here at once, before `update` has had its turn to end the page.
   */
  #live(open: Open): boolean {
    return this.#open === open && this.#watch.holds(open.stamp) !== undefined;
  }

  /** The "Get this" overlay changed (an accepted request, a cancel, or an expiry): the statuses are drawn again, no call. */
  public overlayChanged(): void {
    const open = this.#open;
    if (!open || !this.#live(open)) return;
    for (const row of open.rows) {
      if (!row.answered) continue;
      if (this.#hideHeld && this.#visibleKeys(row) !== row.drawn.map((one) => this.#cardKey(one.card)).join(' ')) this.#fill(row);
      else for (const one of row.drawn) this.#mark(one);
    }
    if (open.hero) this.#showSlide(open.hero);
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
    const open: Open = { userId: session.userId, stamp: this.#watch.stamp(session), context, view, heroSlot, chips: {}, body, paint: 0, rows: [], units: [], hero: undefined, networks: undefined, foot: undefined, dataWatch: undefined, imageWatch: undefined, byElement: [] };
    for (const filter of DISCOVER_FILTERS) {
      const chip = this.#chip(DISCOVER_TEXT.filters[filter], `chip:${filter}`, this.#filter === filter);
      chip.addEventListener('click', () => this.#choose(open, filter));
      open.chips[filter] = chip;
      chips.appendChild(chip);
    }
    const hide = this.#chip(DISCOVER_TEXT.hideHeld, 'chip:hide', this.#hideHeld);
    hide.className += ' jellypass-tv-discover-chip-toggle';
    hide.addEventListener('click', () => this.#toggleHide(open));
    open.chips.hide = hide;
    chips.appendChild(hide);
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
    if (open.dataWatch) open.dataWatch.disconnect();
    if (open.imageWatch) open.imageWatch.disconnect();
    open.dataWatch = undefined;
    open.imageWatch = undefined;
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

  #choose(open: Open, filter: DiscoverFilter): void {
    if (!this.#live(open) || filter === this.#filter) return;
    this.#filter = filter;
    this.#slide = 0;
    for (const one of DISCOVER_FILTERS) (open.chips[one] as HTMLElement).setAttribute('aria-pressed', String(one === filter));
    this.#paint(open);
  }

  #toggleHide(open: Open): void {
    if (!this.#live(open)) return;
    this.#hideHeld = !this.#hideHeld;
    open.chips.hide?.setAttribute('aria-pressed', String(this.#hideHeld));
    for (const row of open.rows) if (row.answered) this.#fill(row);
  }

  /** A card's state as the member sees it: the household's own, with what they just asked for on this TV. */
  #stateOf(card: DiscoverCard): HouseholdState {
    return this.#asked.state(card.mediaType, card.tmdbId, card.state);
  }

  #cardKey(card: DiscoverCard): string {
    return `${card.mediaType}:${card.tmdbId}`;
  }

  /** The cards a row shows now, as keys: what "Hide what I have" leaves, at most the row's 14. */
  #visible(row: RowView): DiscoverCard[] {
    const states = (row.answered as DiscoverCard[]).map((card) => ({ card, state: this.#stateOf(card) }));
    return rowCards(states, this.#hideHeld).map((one) => one.card);
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
    open.body.textContent = '';
    open.heroSlot.textContent = '';
    open.rows = [];
    open.units = [];
    open.byElement = [];
    open.hero = undefined;
    open.networks = undefined;
    open.foot = undefined;
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

  #addRow(open: Open, variant: RowView['variant'], request: DiscoverRequest, key: string, heading: string, eager: boolean, feeds: boolean): RowView {
    const section = this.#el('div', `${JELLYFIN_CLASSES.section} jellypass-tv-discover-row`);
    const headingContainer = this.#el('div', JELLYFIN_CLASSES.headingContainer);
    headingContainer.appendChild(this.#el('h2', JELLYFIN_CLASSES.heading, heading));
    section.appendChild(headingContainer);
    const body = this.#el('div', 'jellypass-tv-discover-row-body');
    section.appendChild(body);
    const row: RowView = { id: key, heading, variant, request, eager, feeds, section, body, unit: this.#unit(open, section), asked: false, answered: undefined, drawn: [] };
    this.#skeleton(row);
    open.rows.push(row);
    return row;
  }

  #skeleton(row: RowView): void {
    row.body.textContent = '';
    const scroller = this.#el('div', 'jellypass-tv-row-scroller padded-left padded-right jellypass-tv-discover-skeleton');
    scroller.setAttribute('aria-hidden', 'true');
    const list = this.#el('div', 'jellypass-tv-row-list');
    for (let i = 0; i < SKELETON_CARDS; i += 1) list.appendChild(this.#el('div', `jellypass-tv-discover-skeleton-card jellypass-tv-discover-skeleton-${row.variant}`));
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
    if (open.paint !== paint || !this.#live(open)) return;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const found = open.byElement.filter((one) => one.element === entry.target && one.row)[0];
      if (!found || !found.row || found.row.asked) continue;
      if (open.dataWatch) open.dataWatch.unobserve(entry.target);
      this.#load(open, paint, found.row, false);
    }
  }

  #onImages(open: Open, paint: number, entries: IntersectionObserverEntry[]): void {
    if (open.paint !== paint || !this.#live(open)) return;
    for (const entry of entries) {
      const found = open.byElement.filter((one) => one.element === entry.target && one.unit)[0];
      if (found && found.unit) this.#near(found.unit, entry.isIntersecting);
    }
  }

  /** Sets the images of what is near the screen, and takes them from what is not (their boxes keep their size). */
  #near(unit: Unit, on: boolean): void {
    unit.near = on;
    for (const one of unit.images) {
      if (on) {
        if (one.image.getAttribute('src') !== one.url) one.image.setAttribute('src', one.url);
      } else if (one.image.hasAttribute('src')) {
        one.image.removeAttribute('src');
      }
    }
  }

  /** An image for `unit`: set now only if the unit is near the screen. */
  #image(unit: Unit, className: string, url: string): HTMLImageElement {
    const image = this.#document.createElement('img');
    image.className = className;
    image.setAttribute('alt', '');
    image.setAttribute('referrerpolicy', 'no-referrer');
    unit.images.push({ image, url });
    if (unit.near) image.setAttribute('src', url);
    return image;
  }

  async #load(open: Open, paint: number, row: RowView, retry: boolean): Promise<void> {
    row.asked = true;
    const result = await this.#data.get(row.request, { retry });
    if (open.paint !== paint || !this.#live(open) || 'stale' in result) return;
    if (result.ok) this.#settle(open, row, (result.value as { cards: DiscoverCard[] }).cards);
    else {
      if (row.feeds) open.heroSlot.className = 'jellypass-tv-discover-hero-slot';
      this.#failed(open, paint, result, row.body, () => { this.#skeleton(row); this.#load(open, paint, row, true); }, row.id);
    }
  }

  /** A failure in `into`: its words, and Try again (never by itself) unless the sign-in is refused, which ends the page's rows. */
  #failed(open: Open, paint: number, failure: Failure, into: HTMLElement, again: () => void, key: string): void {
    into.textContent = '';
    into.removeAttribute('aria-busy');
    const kind = ERROR_TEXT[kindOf(failure)];
    if (failure.status === 401) {
      into.appendChild(this.#note(kind.title, kind.body));
      return;
    }
    const note = this.#el('div', 'jellypass-tv-discover-row-note padded-left padded-right');
    note.appendChild(this.#el('p', 'jellypass-tv-discover-row-note-text', `${kind.title}. ${kind.body}`));
    const retry = this.#button('raised jellypass-tv-discover-button', DISCOVER_TEXT.retry, `retry:${key}`);
    retry.addEventListener('click', () => {
      if (open.paint === paint && this.#live(open)) again();
    });
    note.appendChild(retry);
    into.appendChild(note);
  }

  /** The row's answer arrived (or was kept): its cards are drawn, and the first row's are the hero's. */
  #settle(open: Open, row: RowView, cards: DiscoverCard[]): void {
    row.asked = true;
    row.answered = cards;
    this.#fill(row);
    if (row.feeds) this.#drawHero(open, cards);
  }

  /** The row's cards, as "Hide what I have" and the overlay leave them, or why there are none. */
  #fill(row: RowView): void {
    row.body.textContent = '';
    row.body.removeAttribute('aria-busy');
    row.drawn = [];
    row.unit.images = [];
    const cards = this.#visible(row);
    if (cards.length === 0) {
      row.body.appendChild(this.#el('p', 'jellypass-tv-discover-row-note-text padded-left padded-right', this.#hideHeld && (row.answered as DiscoverCard[]).length > 0 ? DISCOVER_TEXT.nothingLeft : DISCOVER_TEXT.nothing));
      return;
    }
    const scroller = this.#el('div', 'jellypass-tv-row-scroller padded-left padded-right');
    const list = this.#el('div', `jellypass-tv-row-list ${JELLYFIN_CLASSES.row}`);
    for (const card of cards) {
      const one = this.#card(row, card);
      row.drawn.push(one);
      list.appendChild(one.button);
    }
    scroller.appendChild(list);
    row.body.appendChild(scroller);
  }

  #card(row: RowView, card: DiscoverCard): Drawn {
    const backdrop = row.variant === 'backdrop';
    const button = this.#el('button', `${backdrop ? JELLYFIN_CLASSES.cardBackdrop : JELLYFIN_CLASSES.card} jellypass-tv-card${this.#tv() ? ` ${JELLYFIN_CLASSES.cardTv}` : ''}`) as HTMLButtonElement;
    button.type = 'button';
    button.setAttribute('data-media-type', card.mediaType);
    button.setAttribute('data-tmdb-id', String(card.tmdbId));
    button.setAttribute(FOCUS_ATTR, `${row.id}:${card.mediaType}:${card.tmdbId}`);
    const box = this.#el('div', 'cardBox cardBox-bottompadded');
    const frame = this.#el('div', 'cardScalable');
    frame.appendChild(this.#el('div', `cardPadder cardPadder-${backdrop ? 'overflowBackdrop' : 'overflowPortrait'}`));
    const picture = this.#el('div', 'cardImageContainer coveredImage cardContent');
    const url = backdrop ? card.backdropUrl || card.posterUrl : card.posterUrl;
    if (url) picture.appendChild(this.#image(row.unit, 'jellypass-tv-card-image', url));
    frame.appendChild(picture);
    const badge = this.#el('div', 'jellypass-tv-discover-badge');
    frame.appendChild(badge);
    box.appendChild(frame);
    box.appendChild(this.#el('div', 'cardText cardTextCentered cardText-first jellypass-tv-card-title', card.title));
    if (card.year !== null) box.appendChild(this.#el('div', 'cardText cardText-secondary cardTextCentered jellypass-tv-card-year', String(card.year)));
    button.appendChild(box);
    button.addEventListener('click', () => this.#openTitle(card));
    const one = { card, button, badge };
    this.#mark(one);
    return one;
  }

  /** A card's badge and name, from its state now: the words are always there, and the colour goes with them. */
  #mark(one: Drawn): void {
    const state = this.#stateOf(one.card);
    const badge = badgeOf(state);
    one.badge.textContent = badge.label;
    one.badge.className = `jellypass-tv-discover-badge jellypass-tv-discover-badge-${badge.tone}`;
    one.button.setAttribute('aria-label', this.#label(one.card, state));
  }

  #label(card: DiscoverCard, state: HouseholdState): string {
    return card.year === null ? `${card.title}, ${STATE_LABELS[state]}` : `${card.title}, ${card.year}, ${STATE_LABELS[state]}`;
  }

  /** A card was chosen: the title page opens, for the member who is signed in (a card of a session since ended opens nothing). */
  #openTitle(card: DiscoverCard): void {
    const open = this.#open;
    if (!open || !this.#live(open)) return;
    this.#host.navigate(titleHash(card.mediaType, card.tmdbId));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The hero

  #drawHero(open: Open, cards: DiscoverCard[]): void {
    open.heroSlot.className = 'jellypass-tv-discover-hero-slot';
    open.heroSlot.textContent = '';
    open.hero = undefined;
    const slides = heroCards(cards);
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
    const image = this.#image(unit, 'jellypass-tv-discover-hero-image', slides[0]?.backdropUrl as string);
    picture.appendChild(image);
    section.appendChild(picture);
    section.appendChild(shade);
    section.appendChild(text);
    open.heroSlot.appendChild(section);
    const hero: Hero = { slides, unit, title, facts, overview, dots, view, image };
    open.hero = hero;
    previous.addEventListener('click', () => this.#step(open, hero, -1));
    next.addEventListener('click', () => this.#step(open, hero, 1));
    view.addEventListener('click', () => this.#openTitle(hero.slides[this.#slide] as DiscoverCard));
    this.#slide = Math.min(this.#slide, slides.length - 1);
    this.#showSlide(hero);
    // The hero is what the page opens on (or what Back finds again): the host leaves focus alone once the member has moved it.
    open.context.focus(view);
  }

  #step(open: Open, hero: Hero, by: number): void {
    if (!this.#live(open)) return;
    this.#slide = (this.#slide + by + hero.slides.length) % hero.slides.length;
    this.#showSlide(hero);
  }

  #showSlide(hero: Hero): void {
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
      if (open.paint !== paint || !this.#live(open) || 'stale' in result) return;
      if (result.ok) this.#drawSources(open, paint, result.value as DiscoverSources);
      else if (open.networks) this.#failed(open, paint, result, open.networks, () => this.#sources(open, paint, true), 'sources');
    });
  }

  #drawSources(open: Open, paint: number, sources: DiscoverSources): void {
    const slot = open.networks;
    if (slot) {
      slot.textContent = '';
      slot.removeAttribute('aria-busy');
      for (const network of networksFor(this.#filter, sources.networks)) {
        const row = this.#addRow(open, 'poster', { kind: 'network', id: network.id, list: networkListFor(this.#filter, network) }, `net${network.id}`, DISCOVER_TEXT.networkHeading(network.name), false, false);
        slot.appendChild(row.section);
        this.#start(open, paint, row);
      }
    }
    const foot = open.foot;
    if (!foot) return;
    const parts = DISCOVER_LAYOUT[this.#filter];
    const studios = parts.some((part) => part.part === 'studios') && sources.studios.length > 0;
    const credit = parts.some((part) => part.part === 'credit') && sources.networks.some((network: DiscoverNetwork) => network.hasFilms);
    const lead = foot.firstChild;
    if (studios) {
      const heading = this.#el('h2', `${JELLYFIN_CLASSES.heading} jellypass-tv-discover-foot-heading`, DISCOVER_TEXT.studios);
      const strip = this.#el('ul', 'jellypass-tv-discover-logos');
      const unit = this.#unit(open, strip);
      for (const studio of sources.studios) {
        const tile = this.#el('li', 'jellypass-tv-discover-logo');
        if (studio.logoUrl) {
          const image = this.#image(unit, 'jellypass-tv-discover-logo-image', studio.logoUrl);
          image.setAttribute('alt', studio.name);
          tile.appendChild(image);
        } else {
          tile.textContent = studio.name;
        }
        strip.appendChild(tile);
      }
      foot.insertBefore(heading, lead);
      foot.insertBefore(strip, lead);
    }
    if (credit) foot.insertBefore(this.#el('p', 'jellypass-tv-discover-credit', JUSTWATCH_NOTE), lead);
  }
}

