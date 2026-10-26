import { ApiError, createApi, createSignInApi, type Api, type ApiErrorKind, type SignInApi } from './api.js';
import {
  accountText,
  accountView,
  cardList,
  el,
  errorState,
  type GetThisHandler,
  HEADER_TITLE,
  heroCarousel,
  HOME_FILTERS,
  HOME_TEXT,
  type HomeFilter,
  homeHref,
  homeSwitch,
  NETWORK_ACCENTS,
  type RowAccent,
  REQUESTS_TEXT,
  requestItem,
  searchForm,
  searchStatusText,
  seasonView,
  setRequestTitle,
  skeletonDetail,
  skeletonHero,
  skeletonGrid,
  skeletonRequests,
  skeletonRow,
  justWatchNote,
  SOURCE_LISTS,
  SOURCE_TEXT,
  sourceHeading,
  sourceHref,
  sourceRow,
  sourceTabs,
  type SourceList,
  studioStrip,
  titleDetail,
  titleRow,
  type RowVariant,
} from './render.js';
import { icon } from './icons.js';
import { clearSignIn, deviceId, jellyfinToken } from './session.js';
import { showSignIn } from './signin.js';
import type { DiscoverList, MediaType, Me, Network, Page, RequestEntry, Source, SourceKind, Sources } from './types.js';

/** One of Home's rows, fetched from a discover list; `eager` rows are asked for at once, the others as they near the screen. */
interface HomeRow {
  part: 'row';
  list: DiscoverList;
  heading: string;
  variant: RowVariant;
  eager: boolean;
  accent: RowAccent;
}
/** Home is these in order: discover rows, and the places where the services' rows, the studios' strip and the JustWatch credit go. */
type HomePart = HomeRow | { part: 'networks' } | { part: 'studios' } | { part: 'credit' };
const row = (list: DiscoverList, heading: string, variant: RowVariant, eager: boolean, accent: RowAccent = 'default'): HomeRow =>
  ({ part: 'row', list, heading, variant, eager, accent });
/**
 * What Home shows under each filter. The first row is also the hero's source. Only the first four rows are eager (three
 * under TV, which has fewer): that is Home's whole TMDB cost on first load, and everything below waits to near the
 * screen. Movies and TV ask for their own lists (a mixed page is never filtered on the phone, which would leave rows
 * half empty): the per-kind trending lists, a service's films or its series.
 */
const HOME_LAYOUT: Record<HomeFilter, readonly HomePart[]> = {
  all: [
    row('trending', 'Trending', 'poster', true),
    row('popular-movies', 'Popular movies', 'backdrop', true),
    row('popular-tv', 'Popular series', 'backdrop', true),
    row('new-movies', 'New movie releases', 'backdrop', true),
    row('upcoming', 'Upcoming movies', 'poster', false),
    row('upcoming-tv', 'Upcoming series', 'poster', false),
    { part: 'networks' },
    { part: 'studios' },
    { part: 'credit' },
  ],
  movies: [
    row('trending-movies', 'Trending movies', 'poster', true),
    row('popular-movies', 'Popular movies', 'backdrop', true),
    row('new-movies', 'New movie releases', 'backdrop', true),
    row('upcoming', 'Upcoming movies', 'poster', true),
    { part: 'networks' },
    { part: 'studios' },
    { part: 'credit' },
  ],
  tv: [
    row('trending-tv', 'Trending series', 'poster', true),
    row('popular-tv', 'Popular series', 'backdrop', true),
    row('upcoming-tv', 'Upcoming series', 'poster', true),
    { part: 'networks' },
  ],
};
/** What a service's row lists under each filter: its films and series mixed, its films, or its series. */
const NETWORK_LIST: Record<HomeFilter, SourceList> = { all: 'all', movies: 'films', tv: 'series' };
/** How far below (or above) the screen a lazy row starts loading, so it is usually there by the time it scrolls in. */
const LAZY_MARGIN_PX = 400;
const SEARCH_DEBOUNCE_MS = 300;
const MAX_QUERY_LENGTH = 100;
/** "My requests" names its titles from TMDB a few at a time, so a long list is never a burst of calls. */
const REQUESTS_PER_PAGE = 10;
const REQUEST_TITLE_CALLS = 4;

const doc = document;
const main = doc.getElementById('screen') as HTMLElement;
const status = doc.getElementById('status') as HTMLElement;
const backButton = doc.getElementById('back') as HTMLButtonElement;
/** The header: the Back button and the screen's title, nothing else. */
const appHeader = doc.querySelector('.app-header') as HTMLElement;
const headerTitle = doc.getElementById('header-title') as HTMLElement;
const TAB_ICONS = { home: 'home', search: 'search', requests: 'requests', account: 'account' } as const;

// The chrome's icons are drawn here, node by node, so the page itself carries no markup for them.
backButton.append(icon(doc, 'back'));
for (const link of doc.querySelectorAll<HTMLAnchorElement>('nav a[data-nav]')) {
  const name = TAB_ICONS[link.dataset['nav'] as keyof typeof TAB_ICONS];
  if (name) link.prepend(icon(doc, name));
}
const origin = location.origin;

const api: Api = createApi({
  // Through the window, so a test page can stand in for the network without replacing Node's own fetch.
  fetch: (input, init) => window.fetch(input, init),
  token: () => {
    try {
      return jellyfinToken(localStorage, origin);
    } catch {
      return undefined;
    }
  },
});

const signInApi: SignInApi = createSignInApi({
  fetch: (input, init) => window.fetch(input, init),
  deviceId: () => deviceId(localStorage),
  deviceName: deviceName(typeof navigator === 'object' ? navigator.userAgent ?? '' : ''),
});

/** A short name for Jellyfin's device list, from the browser's own description of the device. */
function deviceName(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Macintosh/.test(userAgent)) return 'Mac';
  if (/Windows/.test(userAgent)) return 'Windows';
  if (/Linux/.test(userAgent)) return 'Linux';
  return 'Browser';
}

/** Each navigation gets a new one; work for an earlier navigation checks it before touching the page. */
let navigation = 0;
let navigationAbort: AbortController | undefined;
let me: Me | undefined;
let first = true;

function announce(message: string): void {
  status.textContent = message;
}

function setTitle(title?: string): void {
  doc.title = title ? `${title} – JellyPass` : 'JellyPass';
}

function kindOf(error: unknown): ApiErrorKind {
  return error instanceof ApiError ? error.kind : 'unavailable';
}

/** The fixed chrome's real heights go onto the root as custom properties through the CSSOM (no style attribute is written via markup or setAttribute; style-src 'self' allows CSSOM writes). At large text or zoom the header grows, the tab bar grows and the chips would wrap, so the scroll padding follows what is measured, not a one-row guess. The stylesheet's rem estimates stay as the fallback until then. */
const watchers = new Map<string, ResizeObserver>();

function measure(property: string, element: HTMLElement | null): void {
  watchers.get(property)?.disconnect();
  watchers.delete(property);
  const root = doc.documentElement;
  if (!element) {
    root.style.removeProperty(property);
    return;
  }
  const apply = (): void => {
    const height = element.getBoundingClientRect().height;
    if (height >= 0) root.style.setProperty(property, `${height}px`);
  };
  apply();
  if (typeof ResizeObserver === 'function') {
    const watcher = new ResizeObserver(apply);
    watcher.observe(element);
    watchers.set(property, watcher);
  }
}

measure('--header-box', doc.querySelector<HTMLElement>('.app-header'));
measure('--tabbar-box', doc.querySelector<HTMLElement>('.tabbar'));

/** `data-home-switch` is on the body whenever the sticky All | Movies | TV switch is on the page, hero or no hero, so the scroll padding that clears it never depends on the hero. */
function markSwitch(): void {
  const band = main.querySelector<HTMLElement>('.home-switch');
  if (band) doc.body.setAttribute('data-home-switch', '');
  else doc.body.removeAttribute('data-home-switch');
  measure('--switch-height', band);
}

/** The header shows the screen's title (the page's own heading marked `data-header-title`); with neither a Back button nor a title it shrinks to the status bar's safe area (Home). */
function syncHeader(): void {
  const text = main.querySelector<HTMLElement>(`h1[${HEADER_TITLE}]`)?.textContent ?? '';
  headerTitle.textContent = text;
  if (backButton.hidden && !text) appHeader.setAttribute('data-bare', '');
  else appHeader.removeAttribute('data-bare');
}

function show(...nodes: Node[]): void {
  main.replaceChildren(...nodes);
  syncHeader();
  markSwitch();
  main.setAttribute('aria-busy', 'false');
}

function busy(...nodes: Node[]): void {
  main.replaceChildren(...nodes);
  syncHeader();
  markSwitch();
  main.setAttribute('aria-busy', 'true');
  announce('Loading…');
}

function focusHeading(): void {
  if (first) {
    first = false;
    return;
  }
  const heading = main.querySelector<HTMLElement>('h1');
  heading?.focus({ preventScroll: true });
  // Coming back, the page goes where it was unless the member has taken over; a new screen starts at the top.
  if (!restoring) appScrollTo(0);
  else if (restoreLive(restoring)) appScrollTo(restoring.y);
}

/**
 * The app moves the page here. A plain `scroll` event is never read as the member's: the browser clamps, re-anchors and
 * lays out on its own, and fires one each time. Only wheel, touch, pointer and key input (and typing in search) take
 * a pending restoration away.
 */
function appScrollTo(y: number): void {
  window.scrollTo(0, y);
  markScrolled();
}
/** The chosen Home chip, ring included, sits fully inside the chip row's horizontal scroll. Runs after the browser's own focus scroll and after the tick has changed the chips' widths (a frame later, so the final bounds are measured), and jumps rather than glides under reduced motion. */
const CHIP_RING = 4; // the focus outline: 3px wide, 1px offset
function revealChip(chip: HTMLElement | null): void {
  const scroller = chip?.closest<HTMLElement>('.segmented-home');
  if (!chip || !scroller) return;
  const settle = (): void => {
    const box = chip.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const over = box.right + CHIP_RING - (view.left + scroller.clientWidth);
    const under = view.left - (box.left - CHIP_RING);
    const by = under > 0 ? -under : over > 0 ? over : 0;
    if (!by) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    scroller.scrollTo({ left: scroller.scrollLeft + by, behavior: reduced ? 'auto' : 'smooth' });
  };
  // Without frames there is no layout to measure (a test page), so there is nothing to reveal.
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => window.requestAnimationFrame(settle));
}
function appScrollLeft(list: HTMLElement, left: number): void {
  list.scrollLeft = left;
}

/**
 * A card focused by Tab sits fully in its row: a row scrolls sideways, and the browser's own focus scroll can leave the
 * card almost off the edge. The card is brought to the row's start (where its scroll snap would put it), straight away
 * so reduced motion needs nothing special. This is the page's own scroll, not the member's: it neither cancels nor
 * fights a restoration (the keydown that moved focus already cancelled it).
 */
function showFocusedCard(event: FocusEvent): void {
  const link = event.target instanceof Element ? event.target.closest('.row-list .card-link') : null;
  // After the browser's own focus scroll, which would otherwise settle last.
  if (link) requestAnimationFrame(() => bringCardIntoRow(link));
}
/** The browser's focus scroll can leave a tall card's foot behind the tab bar at large text; the root's bottom scroll padding is the measured tab bar plus the focus ring's room, so the page is nudged up to it. */
function clearTabBar(box: DOMRect): void {
  const padding = parseFloat(getComputedStyle(doc.documentElement).scrollPaddingBottom);
  const limit = (window.innerHeight || doc.documentElement.clientHeight) - (Number.isFinite(padding) ? padding : 0);
  if (box.bottom > limit && box.height > 0) window.scrollBy(0, box.bottom - limit);
}
function bringCardIntoRow(link: Element): void {
  const list = link.closest<HTMLElement>('.row-list');
  if (!list || document.activeElement !== link) return;
  const card = link.closest('.card') ?? link;
  const box = card.getBoundingClientRect();
  clearTabBar(box);
  const view = list.getBoundingClientRect();
  const right = Math.min(view.right, document.documentElement.clientWidth);
  if (box.left >= view.left && box.right <= right) return;
  list.scrollLeft += box.left - view.left;
}

/** Home runs its sticky filter band the page's full width (`home`); every other screen has the page's own gutters. */
function setChrome(kind?: 'home'): void {
  if (kind) doc.body.setAttribute('data-chrome', kind);
  else doc.body.removeAttribute('data-chrome');
}
/** A plain `scroll` listener only styles the header; it is never read as the member taking over a restoration. */
let scrolledState = false;
let scrollFrame = 0;
function markScrolled(): void {
  const scrolled = (window.scrollY || 0) > 40;
  if (scrolled === scrolledState) return;
  scrolledState = scrolled;
  if (scrolled) doc.body.setAttribute('data-scrolled', '');
  else doc.body.removeAttribute('data-scrolled');
}
/** The scroll listener: at most one check per frame, and the body is written only when the offset crosses 40px. */
function onScroll(): void {
  if (scrollFrame) return;
  if (typeof window.requestAnimationFrame !== 'function') return markScrolled();
  scrollFrame = window.requestAnimationFrame(() => {
    scrollFrame = 0;
    markScrolled();
  });
}

/**
 * Where the member was on each screen they left, kept in memory only and keyed by the app's own history entry. It holds
 * scroll offsets and how much was loaded, never anything the API returned: the data itself is fetched again.
 */
interface Position {
  y: number;
  /** Each discover row's horizontal scroll, by the row list's `aria-labelledby`. */
  rows?: Record<string, number>;
  /** Home's hero carousel's horizontal scroll. */
  hero?: number;
  /** Search, a network's or a studio's page: result pages loaded. My requests: entries shown. */
  loaded?: number;
  /** Home: the lazy rows that had been fetched (by their slot's key), fetched again at once on coming back. */
  lazy?: string[];
}
const positions = new Map<number, Position>();
/** This history entry's place among the entries the app itself pushed; 0 is where the app was opened. */
let depth = 0;
let lastDepth = -1;
/** Set when Back replaces the entry with its parent, so the parent is entry 0 and the next Back leaves nothing behind. */
let replacingEntry = false;
let shownDepth: number | undefined;
let shownRoute: Route | undefined;
/** What the screen being drawn should come back to, when the member got here by going back (or forward). */
let restoring: Position | undefined;
/** Set by anything the member does after the screen was drawn: from then on the position is theirs and not put back. */
let restoreCancelled = false;
/** A restoration still owed: it belongs to the screen on show (stale completions never match) and nobody has taken over. */
function restoreLive(position: Position | undefined): position is Position {
  return position !== undefined && position === restoring && !restoreCancelled;
}
/** Most entries kept; the oldest are forgotten first. */
const MAX_POSITIONS = 50;
let searchPages = 1;
let requestsShown = 0;
let sourcePages = 1;

try {
  // The page puts the scroll back itself, once its screen is drawn; the browser's own guess would fight it.
  history.scrollRestoration = 'manual';
} catch {
  // Not every browser lets the page choose.
}

/** Reads the screen that is about to be replaced; run first, while its scroll offsets are still in the page. */
function capturePosition(): void {
  if (shownDepth === undefined || shownRoute === undefined) return;
  if (main.getAttribute('aria-busy') !== 'false') return;
  // A lazy row still waiting to come near the screen is a skeleton by design; any other skeleton is a screen still loading.
  if (Array.from(main.querySelectorAll('.skeleton')).some((node) => !node.closest('[data-lazy]'))) return;
  const position: Position = { y: Math.max(0, Math.round(window.scrollY || 0)) };
  const rows: Record<string, number> = {};
  for (const list of main.querySelectorAll<HTMLElement>('ul.row-list[aria-labelledby], ul.logo-list[aria-labelledby]')) {
    const id = list.getAttribute('aria-labelledby') ?? '';
    if (id) rows[id] = Math.max(0, Math.round(list.scrollLeft || 0));
  }
  if (Object.keys(rows).length) position.rows = rows;
  const hero = main.querySelector<HTMLElement>('.hero-track');
  if (hero) position.hero = Math.max(0, Math.round(hero.scrollLeft || 0));
  if (shownRoute.name === 'search') position.loaded = searchPages;
  if (shownRoute.name === 'requests') position.loaded = requestsShown;
  if (shownRoute.name === 'network' || shownRoute.name === 'studio') position.loaded = sourcePages;
  const lazy = Array.from(main.querySelectorAll<HTMLElement>('[data-lazy="loaded"], [data-lazy="loading"]')).map((slot) => slot.dataset['key'] ?? '');
  if (lazy.length) position.lazy = lazy;
  positions.delete(shownDepth);
  positions.set(shownDepth, position);
  while (positions.size > MAX_POSITIONS) positions.delete(positions.keys().next().value as number);
}

/** Numbers this history entry. An entry the app has not seen is a new one (or Back's replacement) and drops what lay ahead. */
function stampHistory(): void {
  const state: unknown = history.state;
  const stamped = state && typeof state === 'object' ? (state as { jp?: unknown }).jp : undefined;
  if (typeof stamped === 'number') {
    depth = stamped;
  } else {
    depth = replacingEntry ? 0 : lastDepth + 1;
    try {
      history.replaceState({ jp: depth }, '');
    } catch {
      // The number is still known in memory.
    }
    for (const key of [...positions.keys()]) if (key >= depth) positions.delete(key);
  }
  replacingEntry = false;
  lastDepth = depth;
}

/** Where Back goes when the app was opened on this screen and there is nothing in the app to go back to. */
function parentHash(route: Route): string {
  return route.name === 'season' ? `#/tv/${route.id}` : '#/';
}

function goBack(): void {
  if (depth > 0) {
    history.back();
    return;
  }
  const route = shownRoute ?? parse(location.hash);
  replacingEntry = true;
  location.replace(parentHash(route));
}

async function loadMe(signal: AbortSignal): Promise<void> {
  if (me) return;
  me = await api.me(signal);
}

/** The sign-in screen, in place of whatever was showing; `expired` when a sign-in the app held was refused. */
function signIn(signal: AbortSignal, current: () => boolean, expired: boolean): void {
  me = undefined;
  api.forgetAsked();
  setChrome();
  void showSignIn({
    doc,
    api: signInApi,
    storage: localStorage,
    origin,
    show,
    announce,
    setTitle,
    focusHeading,
    signedIn: () => void render(),
    current,
    signal,
  }, expired);
}

function failure(kind: ApiErrorKind, retry: () => void): void {
  if (kind === 'unauthorized') {
    // No sign-in, or one Jellyfin no longer accepts: the app's own sign-in takes over this screen.
    const mine = navigation;
    signIn((navigationAbort as AbortController).signal, () => mine === navigation, Boolean(jellyfinToken(localStorage, origin)));
    return;
  }
  setTitle('Error');
  setChrome();
  show(errorState(doc, kind, retry));
  announce('');
  focusHeading();
}

interface Route {
  name: 'home' | 'search' | 'requests' | 'movie' | 'tv' | 'season' | 'account' | SourceKind;
  id?: number;
  season?: number;
  query?: string;
  /** A network's page: which of its lists (`?kind=series` or `films`; anything else is All). */
  list?: SourceList;
  /** Home: which filter (`?kind=movies` or `tv`; anything else is All). */
  filter?: HomeFilter;
}

/** Only an empty hash or one that starts `#/` names a screen; anything else (the skip link's `#screen`) is not a route. */
function isRouteHash(hash: string): boolean {
  return hash === '' || hash === '#' || hash.startsWith('#/');
}

function parse(hash: string): Route {
  const [path = '', queryString = ''] = hash.replace(/^#/, '').split('?', 2);
  if (path === '/search') return { name: 'search', query: new URLSearchParams(queryString).get('q') ?? '' };
  // The old About address is the Account tab now.
  if (path === '/account' || path === '/about') return { name: 'account' };
  if (path === '/requests') return { name: 'requests' };
  const season = /^\/tv\/(\d{1,10})\/season\/(\d{1,4})$/.exec(path);
  if (season) return { name: 'season', id: Number(season[1]), season: Number(season[2]) };
  const source = /^\/(network|studio)\/(\d{1,10})$/.exec(path);
  if (source?.[1] === 'studio') return { name: 'studio', id: Number(source[2]) };
  if (source) {
    const list = new URLSearchParams(queryString).get('kind');
    return { name: 'network', id: Number(source[2]), list: list === 'series' || list === 'films' ? list : 'all' };
  }
  const title = /^\/(movie|tv)\/(\d{1,10})$/.exec(path);
  if (title) return { name: title[1] === 'tv' ? 'tv' : 'movie', id: Number(title[2]) };
  const filter = new URLSearchParams(queryString).get('kind');
  return { name: 'home', filter: filter === 'movies' || filter === 'tv' ? filter : 'all' };
}

function markNav(route: Route): void {
  const current = route.name === 'search' || route.name === 'requests' || route.name === 'account' ? route.name : 'home';
  for (const link of doc.querySelectorAll<HTMLAnchorElement>('nav a[data-nav]')) {
    if (link.dataset['nav'] === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function render(): Promise<void> {
  navigationAbort?.abort();
  const abort = new AbortController();
  navigationAbort = abort;
  const mine = ++navigation;
  const current = () => mine === navigation;
  // An old About address is replaced in place by Account's, so Back and a reload keep to the new one.
  const legacy = /^#\/about(\?.*)?$/.exec(location.hash);
  if (legacy) {
    try {
      history.replaceState(history.state, '', `#/account${legacy[1] ?? ''}`);
    } catch {
      // The route is the same either way.
    }
  }
  const route = parse(location.hash);
  capturePosition();
  stampHistory();
  restoring = positions.get(depth);
  restoreCancelled = false;
  shownDepth = depth;
  shownRoute = route;
  setChrome(route.name === 'home' ? 'home' : undefined);
  backButton.hidden = route.name === 'home';
  markNav(route);
  const retry = () => void render();

  if (route.name === 'account') {
    setTitle('Account');
    const signedIn = Boolean(jellyfinToken(localStorage, origin));
    show(accountView(doc, signedIn ? { me, onSignOut: (button) => void signOut(button) } : undefined, !signedIn));
    announce('');
    focusHeading();
    // The name and household fill in when /me answers (it is asked once); the card is useful without them.
    if (signedIn && !me) {
      void loadMe(abort.signal).then(
        () => {
          const name = main.querySelector('.account-name');
          if (current() && name) name.textContent = accountText(me);
        },
        () => undefined,
      );
    }
    return;
  }
  if (!jellyfinToken(localStorage, origin)) return failure('unauthorized', retry);

  try {
    if (route.name === 'home') await home(route.filter ?? 'all', abort.signal, current);
    else if (route.name === 'search') await search(route.query ?? '', abort.signal, current);
    else if (route.name === 'requests') await requestsScreen(abort.signal, current);
    else if (route.name === 'movie' || route.name === 'tv') await title(route, abort.signal, current);
    else if (route.name === 'network' || route.name === 'studio') await sourceScreen(route, abort.signal, current);
    else await season(route, abort.signal, current);
  } catch (error) {
    if (!current() || abort.signal.aborted) return;
    failure(kindOf(error), retry);
  }
}

async function home(filter: HomeFilter, signal: AbortSignal, current: () => boolean): Promise<void> {
  setTitle();
  const eagerRows = HOME_LAYOUT[filter].filter((part): part is HomeRow => part.part === 'row' && part.eager);
  busy(el(doc, 'h1', { class: 'visually-hidden', text: 'Home', attrs: { tabindex: '-1' } }), skeletonHero(doc), ...eagerRows.map((part) => skeletonRow(doc, part.variant)));
  await loadMe(signal);
  if (!current()) return;
  const heading = el(doc, 'h1', { class: 'visually-hidden', text: 'Home', attrs: { tabindex: '-1' } });
  const heroSlot = el(doc, 'div', {}, [skeletonHero(doc)]);
  const panelId = 'home-panel';
  const switcher = homeSwitch(doc, filter, panelId);
  const panel = el(doc, 'div', { attrs: { id: panelId, role: 'group', 'aria-labelledby': `home-filter-${filter}` } });
  show(heading, switcher, heroSlot, panel);
  revealChip(switcher.querySelector<HTMLElement>('[aria-checked="true"]'));

  /** The studios and networks the API lists (no TMDB call), asked for once however often the filter changes. */
  let found: Sources | undefined;
  /** Each drawing gets a new number and its own abort; a drawing switched away from stops touching the page. */
  let drawing = 0;
  let drawAbort: AbortController | undefined;
  signal.addEventListener('abort', () => drawAbort?.abort());

  /**
   * Draws the hero and the rows of one filter, once everything that is asked for at once has answered. `unauthorized` is
   * true when the API refused the member (the caller shows the sign-in); `start` lets the rows below the fold be asked
   * for as they near the screen, called once the page is in place and any position put back. Until the drawing is
   * replaced, that is.
   */
  const draw = async (shown: HomeFilter, restore: Position | undefined): Promise<{ unauthorized: boolean; start: () => void }> => {
    drawAbort?.abort();
    const controller = new AbortController();
    drawAbort = controller;
    const sig = controller.signal;
    const mine = ++drawing;
    const live = () => current() && mine === drawing && !sig.aborted;
    const layout = HOME_LAYOUT[shown];
    heroSlot.hidden = false;
    heroSlot.replaceChildren(skeletonHero(doc));
    setChrome('home');
    /** Without a hero (the first row failed or is empty) the header is its own bar again. */
    const noHero = () => {
      heroSlot.replaceChildren();
      heroSlot.hidden = true;
      setChrome();
    };
    let unauthorized = false;
    const lazy = lazyLoader(sig);
    /** Lazy rows fetched again at once because the member is coming back to where they were; awaited before the scroll is put back. */
    const again: Array<Promise<void>> = [];
    const watch = (slot: HTMLElement, load: () => Promise<Page>, drawRow: (page: Page) => HTMLElement, rowHeading: string) => {
      const run = () => lazyRow(slot, load, drawRow, rowHeading, sig, live, restore);
      if (restore?.lazy?.includes(slot.dataset['key'] ?? '') && restoreLive(restore)) again.push(run());
      else lazy.watch(slot, () => void run());
    };
    const networksSlot = el(doc, 'div');
    const studiosSlot = el(doc, 'div', { class: 'home-row' });
    const creditSlot = el(doc, 'div');
    const slots: HTMLElement[] = [];
    const eager: Array<Promise<void>> = [];
    layout.forEach((part, index) => {
      if (part.part === 'networks') return void slots.push(networksSlot);
      if (part.part === 'studios') return void slots.push(studiosSlot);
      if (part.part === 'credit') return void slots.push(creditSlot);
      const id = `row-${part.list}`;
      if (!part.eager) {
        const slot = lazySlot(id);
        slots.push(slot);
        watch(slot, () => api.discover(part.list, sig), (page) => titleRow(doc, id, part.heading, page, part.variant, part.accent), part.heading);
        return;
      }
      const slot = el(doc, 'div', { class: 'home-row' }, [skeletonRow(doc, part.variant)]);
      slots.push(slot);
      const isHero = index === 0;
      eager.push((async () => {
        try {
          const page = await api.discover(part.list, sig);
          if (!live()) return;
          slot.replaceChildren(titleRow(doc, id, part.heading, page, part.variant, part.accent));
          if (isHero) {
            // The hero is drawn from the first row's own answer: it asks for nothing more.
            const hero = heroCarousel(doc, page.results, shown);
            if (hero) {
              heroSlot.replaceChildren(hero);
              const track = hero.querySelector<HTMLElement>('.hero-track');
              if (track && restore?.hero && restoreLive(restore)) appScrollLeft(track, restore.hero);
            } else noHero();
          }
          const list = slot.querySelector<HTMLElement>('ul.row-list');
          const left = restore?.rows?.[`${id}-heading`];
          if (list && left && restoreLive(restore)) appScrollLeft(list, left);
        } catch (error) {
          if (!live()) return;
          const kind = kindOf(error);
          if (isHero) noHero();
          if (kind === 'unauthorized') unauthorized = true;
          else slot.replaceChildren(rowFailure(part.heading, kind, () => void render()));
        }
      })());
    });
    panel.replaceChildren(...slots);
    panel.setAttribute('aria-labelledby', `home-filter-${shown}`);

    /** The studios' strip and the services' rows, once the API has said which there are (no TMDB call). */
    const sources = async (): Promise<void> => {
      let listing: Sources;
      try {
        listing = found ??= await api.sources(sig);
      } catch (error) {
        if (!live()) return;
        const kind = kindOf(error);
        if (kind === 'unauthorized') unauthorized = true;
        else (layout.some((part) => part.part === 'studios') ? studiosSlot : networksSlot).replaceChildren(rowFailure('Studios and networks', kind, () => void render()));
        return;
      }
      if (!live()) return;
      if (listing.studios.length) {
        const strip = studioStrip(doc, 'row-studios', listing.studios);
        studiosSlot.replaceChildren(strip);
        const list = strip.querySelector<HTMLElement>('ul.logo-list');
        const left = restore?.rows?.['row-studios-heading'];
        if (list && left && restoreLive(restore)) appScrollLeft(list, left);
      }
      // Each service's row: its series and films mixed (two TMDB calls), only its films or only its series (one), once it comes near the screen.
      const listed = listing.networks.filter((network) => shown !== 'movies' || network.hasFilms);
      for (const network of listed) {
        const slot = lazySlot(`row-network-${network.id}`);
        const list: SourceList = network.hasFilms ? NETWORK_LIST[shown] : 'series';
        const accent = NETWORK_ACCENTS[network.id];
        networksSlot.append(slot);
        watch(slot, () => api.source('network', network.id, 1, sig, list === 'all' || list === 'films' ? list : undefined),
          (page) => sourceRow(doc, slot.dataset['key'] as string, 'network', network, page, list, accent), SOURCE_TEXT.heading('network', network.name, list));
      }
      if (listed.some((network) => network.hasFilms) && shown !== 'tv') creditSlot.append(el(doc, 'div', { class: 'home-row' }, [justWatchNote(doc)]));
      await Promise.all(again);
    };
    await Promise.all([sources(), ...eager, ...again]);
    return { unauthorized, start: () => (live() ? lazy.start() : undefined) };
  };

  const drawn = await draw(filter, restoring);
  if (!current()) return;
  if (drawn.unauthorized) throw new ApiError('unauthorized');
  announce('');
  focusHeading();
  drawn.start();

  // The control: choosing replaces the address (not pushes it), so Back still leaves Home, and coming back is to this filter.
  let chosen = filter;
  const choose = (next: HomeFilter, focus: boolean): void => {
    const button = switcher.querySelector<HTMLElement>(`[data-filter="${next}"]`);
    if (focus) button?.focus();
    if (next === chosen) return revealChip(button);
    // (revealChip runs again below once the selection has changed the chips' widths.)
    chosen = next;
    history.replaceState(history.state, '', homeHref(next));
    shownRoute = parse(location.hash);
    // What was being put back belonged to the other filter.
    restoreCancelled = true;
    for (const radio of switcher.querySelectorAll<HTMLElement>('[role="radio"]')) {
      const checked = radio.dataset['filter'] === next;
      radio.setAttribute('aria-checked', String(checked));
      radio.setAttribute('tabindex', checked ? '0' : '-1');
    }
    revealChip(button);
    // The sticky control stays where it is; a member far down the page starts the new filter at its first row.
    const edge = heroSlot.offsetHeight || 0;
    if ((window.scrollY || 0) > edge) appScrollTo(edge);
    announce('Loading…');
    void draw(next, undefined).then((result) => {
      if (!current() || chosen !== next) return;
      if (result.unauthorized) return failure('unauthorized', () => void render());
      announce(HOME_TEXT.shown[next]);
      result.start();
    });
  };
  for (const radio of switcher.querySelectorAll<HTMLElement>('[role="radio"]')) {
    radio.addEventListener('click', () => choose(radio.dataset['filter'] as HomeFilter, false));
  }
  switcher.addEventListener('keydown', (event) => {
    const at = HOME_FILTERS.indexOf(chosen);
    const key = (event as KeyboardEvent).key;
    const last = HOME_FILTERS.length - 1;
    const next = key === 'ArrowRight' || key === 'ArrowDown' ? HOME_FILTERS[at === last ? 0 : at + 1]
      : key === 'ArrowLeft' || key === 'ArrowUp' ? HOME_FILTERS[at === 0 ? last : at - 1]
        : key === 'Home' ? HOME_FILTERS[0] : key === 'End' ? HOME_FILTERS[last] : undefined;
    if (!next) return;
    event.preventDefault();
    choose(next, true);
  });
}

/** A Home row that is fetched only when it comes near the screen: a row-shaped skeleton until then, so nothing shifts. */
function lazySlot(key: string): HTMLElement {
  return el(doc, 'div', { class: 'home-row', attrs: { 'data-lazy': 'waiting', 'data-key': key } }, [skeletonRow(doc)]);
}

/** Fetches and draws one lazy row into its slot; a failure shows the row's own error with a retry for that row alone. */
async function lazyRow(
  slot: HTMLElement,
  load: () => Promise<Page>,
  draw: (page: Page) => HTMLElement,
  heading: string,
  signal: AbortSignal,
  current: () => boolean,
  restore: Position | undefined,
): Promise<void> {
  slot.setAttribute('data-lazy', 'loading');
  try {
    const page = await load();
    if (!current()) return;
    slot.replaceChildren(draw(page));
    slot.setAttribute('data-lazy', 'loaded');
    const list = slot.querySelector<HTMLElement>('ul.row-list');
    const left = restore?.rows?.[`${slot.dataset['key']}-heading`];
    if (list && left && restoreLive(restore)) appScrollLeft(list, left);
  } catch (error) {
    if (!current() || signal.aborted) return;
    const kind = kindOf(error);
    if (kind === 'unauthorized') return failure(kind, () => void render());
    slot.setAttribute('data-lazy', 'failed');
    slot.replaceChildren(rowFailure(heading, kind, () => void lazyRow(slot, load, draw, heading, signal, current, restore)));
  }
}

/**
 * Runs each watched slot's `load` once, when the slot comes within {@link LAZY_MARGIN_PX} of the screen, so Home never
 * asks for all of its rows at once. With IntersectionObserver the browser says when; without it, the slots are checked
 * on scroll (at most once a frame) and once when Home is drawn. Nothing is watched before `start()` (Home is drawn and
 * any position put back first), and nothing after the navigation is over.
 */
function lazyLoader(signal: AbortSignal): { watch(slot: HTMLElement, load: () => void): void; start(): void } {
  const pending = new Map<Element, () => void>();
  let started = false;
  const fire = (slot: Element) => {
    const load = pending.get(slot);
    pending.delete(slot);
    if (load && !signal.aborted) load();
  };
  if (typeof IntersectionObserver === 'function') {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        fire(entry.target);
      }
    }, { rootMargin: `${LAZY_MARGIN_PX}px 0px` });
    signal.addEventListener('abort', () => observer.disconnect());
    return {
      watch(slot, load) {
        pending.set(slot, load);
        if (started) observer.observe(slot);
      },
      start() {
        started = true;
        for (const slot of pending.keys()) observer.observe(slot);
      },
    };
  }
  let frame = false;
  const near = (slot: Element) => {
    const height = window.innerHeight || doc.documentElement.clientHeight || 0;
    return slot.getBoundingClientRect().top < height + LAZY_MARGIN_PX;
  };
  const check = () => {
    frame = false;
    if (signal.aborted || !started) return;
    for (const slot of [...pending.keys()]) if (near(slot)) fire(slot);
  };
  const onScroll = () => {
    if (frame) return;
    frame = true;
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(check);
    else check();
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  signal.addEventListener('abort', () => window.removeEventListener?.('scroll', onScroll));
  return {
    watch(slot, load) {
      pending.set(slot, load);
      if (started && near(slot)) fire(slot);
    },
    start() {
      started = true;
      check();
    },
  };
}

function rowFailure(heading: string, kind: ApiErrorKind, retry: () => void): HTMLElement {
  const section = el(doc, 'section', { class: 'row' }, [el(doc, 'h2', { class: 'row-heading', text: heading })]);
  const box = errorState(doc, kind, retry);
  box.querySelector('h1')?.replaceWith(el(doc, 'h3', { class: 'notice-title', text: box.querySelector('h1')?.textContent ?? '' }));
  section.append(box);
  return section;
}

async function search(initial: string, signal: AbortSignal, current: () => boolean): Promise<void> {
  setTitle('Search');
  // All of the search's state and handlers exist before the form is on the page, so nothing the member does while
  // /me is still loading can reach a half-built screen: they search at once, and /me only fills in the header.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let pending: AbortController | undefined;
  /** Coming back: this many pages are fetched again, then the screen is put back where it was. */
  const back = restoring;
  let wanted = back?.loaded ?? 1;
  let scrollBack = back;
  /** True while the screen is still being put back and the member has not taken over. */
  const resuming = () => scrollBack !== undefined && restoreLive(scrollBack);
  searchPages = 1;
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    pending?.abort();
  });
  const input = el(doc, 'input', {
    attrs: { id: 'q', type: 'search', name: 'q', autocomplete: 'off', enterkeyhint: 'search', maxlength: String(MAX_QUERY_LENGTH), placeholder: 'Movies and series', value: initial },
  });
  const form = searchForm(doc, input);
  const results = el(doc, 'div', { class: 'search-results' });

  function run(raw: string, restoringRun = false): void {
    clearTimeout(timer);
    pending?.abort();
    const query = raw.trim().slice(0, MAX_QUERY_LENGTH);
    history.replaceState(history.state, '', query ? `#/search?q=${encodeURIComponent(query)}` : '#/search');
    const mine = ++sequence;
    searchPages = 1;
    // A different search is not the one that was left: it keeps nothing of that screen's pages or scroll.
    if (!restoringRun) {
      scrollBack = undefined;
      wanted = 1;
    }
    if (!query) {
      results.replaceChildren();
      announce('');
      return;
    }
    const controller = new AbortController();
    pending = controller;
    results.replaceChildren(skeletonGrid(doc));
    announce('Searching…');
    void fetchPage(query, 1, controller, mine, false);
  }

  function settled(): void {
    // Once, after the pages that were showing are back; later pages are the member's own.
    if (resuming() && scrollBack) appScrollTo(scrollBack.y);
    scrollBack = undefined;
    wanted = 1;
  }

  async function fetchPage(query: string, page: number, controller: AbortController, mine: number, append: boolean): Promise<void> {
    const wasResuming = resuming();
    try {
      const answer = await api.search(query, page, controller.signal);
      if (mine !== sequence || !current()) return;
      const fresh = cardList(doc, answer.results, 'grid');
      const firstNew = fresh.querySelector<HTMLElement>('a.card-link');
      results.querySelector('.load-more')?.remove();
      if (append) {
        results.querySelector('ul.grid')?.append(...Array.from(fresh.children));
      } else {
        const empty = searchStatusText(answer.results.length, query);
        results.replaceChildren(empty ? el(doc, 'p', { class: 'muted', text: empty }) : fresh);
      }
      searchPages = page;
      announce(append ? 'More results loaded.' : answer.results.length ? 'Results loaded.' : '');
      if (answer.nextPage && page < wanted && resuming()) {
        await fetchPage(query, answer.nextPage, controller, mine, true);
        return;
      }
      if (scrollBack && !answer.nextPage) settled();
      if (answer.nextPage) {
        const more = el(doc, 'button', { class: 'button button-secondary load-more', text: 'Load more', attrs: { type: 'button' } });
        more.addEventListener('click', () => {
          more.disabled = true;
          more.textContent = 'Loading…';
          void fetchPage(query, answer.nextPage as number, controller, mine, true);
        });
        results.append(more);
        if (scrollBack) settled();
      }
      if (append && !wasResuming) firstNew?.focus();
    } catch (error) {
      if (mine !== sequence || !current() || controller.signal.aborted) return;
      const kind = kindOf(error);
      if (kind === 'unauthorized') return failure(kind, () => void render());
      announce('');
      results.querySelector('.load-more')?.remove();
      results.append(errorState(doc, kind, () => run(query)));
    }
  }

  // Search is done by the page as you type; the form has nowhere to go.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    run(input.value);
  });
  input.addEventListener('input', () => {
    restoreCancelled = true;
    clearTimeout(timer);
    timer = setTimeout(() => run(input.value), SEARCH_DEBOUNCE_MS);
  });

  show(el(doc, 'h1', { class: 'screen-title visually-hidden', text: 'Search', attrs: { tabindex: '-1', [HEADER_TITLE]: '' } }), form, results);
  announce('');
  focusHeading();
  if (initial.trim()) run(initial, true);
  await loadMe(signal);
}

/**
 * "Get this" for one screen. It asks the API, and says only whether the call was accepted: the answer to a call the API
 * accepted is the same whatever followed. On `accepted` the screen's own data is read again and the screen redrawn
 * with the one fixed confirmation. A 401 replaces the screen with the sign-in state.
 */
function getThisFor(
  mediaType: MediaType,
  id: number,
  signal: AbortSignal,
  current: () => boolean,
  redraw: (asked: ReadonlySet<number>) => Promise<void>,
): GetThisHandler {
  const asked = new Set<number>();
  return async (seasons, onAccepted) => {
    let kind: ApiErrorKind | 'accepted' = 'accepted';
    try {
      await api.getThis(mediaType, id, seasons, signal);
    } catch (error) {
      if (signal.aborted) return 'unavailable';
      kind = kindOf(error);
    }
    if (kind === 'unauthorized' && current()) failure(kind, () => void render());
    if (kind !== 'accepted') return kind;
    for (const season of seasons.length ? seasons : [0]) asked.add(season);
    onAccepted();
    // The screen is read again; if that fails the confirmation stays, with the one fixed refresh error and a retry.
    try {
      await redraw(asked);
    } catch (error) {
      if (signal.aborted || !current()) return 'accepted';
      if (kindOf(error) === 'unauthorized') {
        failure('unauthorized', () => void render());
        return 'unauthorized';
      }
      return 'refresh_failed';
    }
    return 'accepted';
  };
}

/** The seasons (0 for a movie) of a title the household asked for that did not work out. Best effort: never an error. */
async function failedSeasons(mediaType: MediaType, id: number, signal: AbortSignal): Promise<Set<number>> {
  try {
    const list = await api.requests(signal);
    const entry = list.results.find((candidate) => candidate.mediaType === mediaType && candidate.tmdbId === id);
    if (!entry) return new Set();
    return new Set(mediaType === 'movie'
      ? entry.status === 'failed' ? [0] : []
      : entry.seasons.filter((season) => season.status === 'failed').map((season) => season.seasonNumber));
  } catch (error) {
    if (kindOf(error) === 'unauthorized') throw error;
    return new Set();
  }
}

async function title(route: Route, signal: AbortSignal, current: () => boolean): Promise<void> {
  busy(skeletonDetail(doc));
  setTitle();
  await loadMe(signal);
  const id = route.id as number;
  const mediaType: MediaType = route.name === 'tv' ? 'tv' : 'movie';
  const load = () => Promise.all([mediaType === 'tv' ? api.tv(id, signal) : api.movie(id, signal), failedSeasons(mediaType, id, signal)]);
  let [answer, failed] = await load();
  if (!current()) return;
  const draw = (asked: ReadonlySet<number>, confirmed: boolean) => {
    show(titleDetail(doc, answer, origin, { onGet, asked, failed, confirmed, onReload: () => void render() }));
    if (confirmed) main.querySelector<HTMLElement>('.get-message')?.focus({ preventScroll: true });
  };
  const onGet = getThisFor(mediaType, id, signal, current, async (asked) => {
    [answer, failed] = await load();
    if (current()) draw(asked, true);
  });
  setTitle(answer.title);
  draw(new Set(), false);
  announce('');
  focusHeading();
}

async function season(route: Route, signal: AbortSignal, current: () => boolean): Promise<void> {
  busy(skeletonDetail(doc));
  setTitle();
  await loadMe(signal);
  const id = route.id as number;
  const number = route.season as number;
  const load = () => Promise.all([
    api.season(id, number, signal),
    api.tv(id, signal).then((value) => value, () => undefined),
    failedSeasons('tv', id, signal),
  ]);
  let [answer, series, failed] = await load();
  if (!current()) return;
  const draw = (asked: ReadonlySet<number>, confirmed: boolean) => {
    show(seasonView(doc, answer, series?.title, { onGet, asked, failed, confirmed, backdropUrl: series?.backdropUrl, onReload: () => void render() }));
    if (confirmed) main.querySelector<HTMLElement>('.get-message')?.focus({ preventScroll: true });
  };
  const onGet = getThisFor('tv', id, signal, current, async (asked) => {
    [answer, series, failed] = await load();
    if (current()) draw(asked, true);
  });
  setTitle(`${series ? `${series.title}: ` : ''}${answer.name}`);
  draw(new Set(), false);
  announce('');
  focusHeading();
}

/**
 * A network's or a studio's page: a grid with **Load more** (the API's `nextPage`). A network whose films the API lists
 * has an All | Series | Films control (All, its series and films mixed, as on Home); the list shown is in the address
 * (`?kind=`), replaced in place on switching, so Back and coming back are per list. Only the networks and studios the
 * API lists have a page; any other is "Not found" without asking for titles. Coming back, the pages that were showing
 * are fetched again and the scroll put back.
 */
async function sourceScreen(route: Route, signal: AbortSignal, current: () => boolean): Promise<void> {
  const kind = route.name as SourceKind;
  const id = route.id as number;
  setTitle();
  busy(el(doc, 'div', { class: 'skeleton skeleton-heading', attrs: { 'aria-hidden': 'true' } }), skeletonGrid(doc));
  await loadMe(signal);
  const sources = await api.sources(signal);
  const source: Source | undefined = (kind === 'network' ? sources.networks : sources.studios).find((candidate) => candidate.id === id);
  if (!source) throw new ApiError('not_found');
  const lists: readonly SourceList[] = kind === 'studio' ? ['all'] : (source as Network).hasFilms ? SOURCE_LISTS : ['series'];
  let list: SourceList = kind === 'studio' ? 'all' : route.list ?? 'all';
  // A network the API lists no films for has its series only, and no All or Films to link to.
  if (!lists.includes(list)) {
    if (list === 'films') throw new ApiError('not_found');
    list = 'series';
  }
  const fetchList = (shown: SourceList, page: number, listSignal: AbortSignal) => {
    if (kind === 'studio' || shown === 'series') return api.source(kind, id, page, listSignal);
    return api.source(kind, id, page, listSignal, shown);
  };
  const panelId = 'source-panel';
  const panel = el(doc, 'div', { class: 'source-panel', attrs: { id: panelId } });
  const tabs = lists.length > 1 ? sourceTabs(doc, 'source-tab', panelId, list) : undefined;
  if (tabs) {
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `source-tab-${list}`);
  }
  const head = sourceHeading(doc, kind, source, list);
  /** Each list drawn gets a new one; a list switched away from stops touching the panel. */
  let shownList = 0;
  let listAbort: AbortController | undefined;
  signal.addEventListener('abort', () => listAbort?.abort());

  /** Draws one list into the panel, with the pages `back` had loaded fetched again first. Throws if its first page fails. */
  const load = async (shown: SourceList, back: Position | undefined): Promise<void> => {
    listAbort?.abort();
    const controller = new AbortController();
    listAbort = controller;
    const mine = ++shownList;
    const live = () => current() && mine === shownList && !controller.signal.aborted;
    sourcePages = 1;
    const wanted = back?.loaded ?? 1;
    let answer = await fetchList(shown, 1, controller.signal);
    if (!live()) return;
    const grid = cardList(doc, answer.results, 'grid');
    const results = el(doc, 'div', { class: 'search-results' }, [
      answer.results.length ? grid : el(doc, 'p', { class: 'muted', text: 'Nothing to show here right now.' }),
    ]);
    const more = el(doc, 'button', { class: 'button button-secondary load-more', text: 'Load more', attrs: { type: 'button' } });
    // A service's films are TMDB's where-to-watch data, which is JustWatch's.
    panel.replaceChildren(results, ...(kind === 'network' && shown !== 'series' ? [justWatchNote(doc)] : []));
    const append = (page: Page) => {
      const fresh = cardList(doc, page.results, 'grid');
      const firstNew = fresh.querySelector<HTMLElement>('a.card-link');
      grid.append(...Array.from(fresh.children));
      return firstNew;
    };
    // Coming back: the pages that were showing, one after another, before the scroll is put back.
    while (answer.nextPage && sourcePages < wanted && restoreLive(back)) {
      answer = await fetchList(shown, answer.nextPage, controller.signal);
      if (!live()) return;
      append(answer);
      sourcePages = answer.page;
    }
    const offerMore = () => {
      more.remove();
      if (!answer.nextPage) return;
      more.disabled = false;
      more.textContent = 'Load more';
      results.append(more);
    };
    more.addEventListener('click', () => {
      if (!answer.nextPage) return;
      more.disabled = true;
      more.textContent = 'Loading…';
      void fetchList(shown, answer.nextPage, controller.signal).then((page) => {
        if (!live()) return;
        answer = page;
        const firstNew = append(page);
        sourcePages = page.page;
        announce('More results loaded.');
        offerMore();
        firstNew?.focus();
      }, (error: unknown) => {
        if (!live()) return;
        const failed = kindOf(error);
        if (failed === 'unauthorized') return failure(failed, () => void render());
        announce('');
        more.remove();
        results.append(errorState(doc, failed, () => void render()));
      });
    });
    offerMore();
  };

  /** Shows another list: the address is replaced (not pushed), so Back still leaves the page, and coming back is to this list. */
  const select = (next: SourceList, focus: boolean): void => {
    if (!tabs) return;
    const tab = tabs.querySelector<HTMLElement>(`[data-list="${next}"]`);
    if (focus) tab?.focus();
    if (next !== list) showList(next);
  };
  const showList = (next: SourceList): void => {
    if (!tabs) return;
    list = next;
    history.replaceState(history.state, '', sourceHref(kind, source, next));
    shownRoute = parse(location.hash);
    // What was being put back belonged to the other list.
    restoreCancelled = true;
    for (const button of tabs.querySelectorAll<HTMLElement>('[role="tab"]')) {
      const selected = button.dataset['list'] === next;
      button.setAttribute('aria-selected', String(selected));
      button.setAttribute('tabindex', selected ? '0' : '-1');
    }
    panel.setAttribute('aria-labelledby', `source-tab-${next}`);
    const title = SOURCE_TEXT.heading(kind, source.name, next);
    setTitle(title);
    const h1 = head.querySelector('h1');
    if (h1) h1.textContent = title;
    panel.replaceChildren(skeletonGrid(doc));
    announce('Loading…');
    const mine = shownList + 1;
    load(next, undefined).then(() => {
      if (current() && mine === shownList) announce(`${SOURCE_TEXT.lists[next]} shown.`);
    }, (error: unknown) => {
      if (!current() || mine !== shownList || signal.aborted) return;
      const failed = kindOf(error);
      if (failed === 'unauthorized') return failure(failed, () => void render());
      announce('');
      panel.replaceChildren(errorState(doc, failed, () => showList(next)));
    });
  };
  if (tabs) {
    for (const button of tabs.querySelectorAll<HTMLElement>('[role="tab"]')) {
      button.addEventListener('click', () => select(button.dataset['list'] as SourceList, false));
    }
    tabs.addEventListener('keydown', (event) => {
      const at = lists.indexOf(list);
      const key = (event as KeyboardEvent).key;
      const next = key === 'ArrowRight' ? lists[(at + 1) % lists.length]
        : key === 'ArrowLeft' ? lists[(at + lists.length - 1) % lists.length]
          : key === 'Home' ? lists[0] : key === 'End' ? lists[lists.length - 1] : undefined;
      if (!next) return;
      event.preventDefault();
      select(next, true);
    });
  }

  await load(list, restoring);
  if (!current()) return;
  setTitle(SOURCE_TEXT.heading(kind, source.name, list));
  show(head, ...(tabs ? [tabs] : []), panel);
  announce('');
  focusHeading();
}

/** The household's requests, with their titles read from TMDB (through the API) ten at a time. */
async function requestsScreen(signal: AbortSignal, current: () => boolean): Promise<void> {
  setTitle(REQUESTS_TEXT.title);
  busy(el(doc, 'h1', { class: 'screen-title visually-hidden', text: REQUESTS_TEXT.title, attrs: { tabindex: '-1', [HEADER_TITLE]: '' } }), skeletonRequests(doc));
  await loadMe(signal);
  const entries: RequestEntry[] = (await api.requests(signal)).results;
  if (!current()) return;
  const heading = el(doc, 'h1', { class: 'screen-title visually-hidden', text: REQUESTS_TEXT.title, attrs: { tabindex: '-1', [HEADER_TITLE]: '' } });
  if (entries.length === 0) {
    show(heading, el(doc, 'p', { class: 'muted', text: REQUESTS_TEXT.empty }));
    announce('');
    focusHeading();
    return;
  }
  const back = restoring;
  const list = el(doc, 'ul', { class: 'request-list' });
  const more = el(doc, 'button', { class: 'button button-secondary load-more', text: 'Load more', attrs: { type: 'button' } });
  let shown = 0;

  async function showMore(size = REQUESTS_PER_PAGE): Promise<void> {
    const batch = entries.slice(shown, shown + size);
    shown += batch.length;
    requestsShown = shown;
    const items = batch.map((entry) => requestItem(doc, entry));
    list.append(...items);
    if (size > REQUESTS_PER_PAGE && restoreLive(back)) appScrollTo(back.y);
    more.hidden = shown >= entries.length;
    more.disabled = false;
    more.textContent = 'Load more';
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < batch.length && current()) {
        const index = next++;
        const entry = batch[index] as RequestEntry;
        try {
          const found = entry.mediaType === 'tv' ? await api.tv(entry.tmdbId, signal) : await api.movie(entry.tmdbId, signal);
          if (current()) setRequestTitle(items[index] as HTMLElement, found);
        } catch (error) {
          if (!current() || signal.aborted) return;
          if (kindOf(error) === 'unauthorized') return failure('unauthorized', () => void render());
          // The status stays; only the name could not be read.
          setRequestTitle(items[index] as HTMLElement, undefined);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(REQUEST_TITLE_CALLS, batch.length) }, worker));
  }

  more.addEventListener('click', () => {
    more.disabled = true;
    more.textContent = 'Loading…';
    const first = shown;
    void showMore().then(() => (list.children[first] as HTMLElement | undefined)?.querySelector('a')?.focus());
  });
  show(heading, list, more);
  announce('');
  focusHeading();
  // Coming back, the entries that were showing are drawn at once (their titles follow) and the scroll put back.
  const again = Math.max(REQUESTS_PER_PAGE, back?.loaded ?? 0);
  requestsShown = 0;
  await showMore(again);
  if (again === REQUESTS_PER_PAGE && restoreLive(back)) appScrollTo(back.y);
}

// Signing in or out on the same address (in another tab, or in Jellyfin web) is picked up without a reload.
function resumeIfChanged(): void {
  const signedIn = Boolean(jellyfinToken(localStorage, origin));
  const showingSignIn = Boolean(main.querySelector('[data-screen="signin"]'));
  const onAccount = parse(location.hash).name === 'account';
  // Account shows its member card only while signed in, so a sign-in or sign-out elsewhere redraws it.
  if (onAccount ? signedIn !== Boolean(main.querySelector('.account')) : signedIn === showingSignIn) void render();
}

async function signOut(button: HTMLButtonElement): Promise<void> {
  const token = jellyfinToken(localStorage, origin);
  button.disabled = true;
  announce('Signing out…');
  // The token is revoked at Jellyfin first, so it is dead everywhere, Jellyfin web included; then it leaves this browser.
  if (token) await signInApi.signOut(token);
  const cleared = clearSignIn(localStorage, origin);
  button.disabled = false;
  me = undefined;
  api.forgetAsked();
  if (!cleared) {
    announce("Couldn't remove your sign-in from this browser.");
    return;
  }
  announce('Signed out.');
  // Straight to the sign-in screen, in place of Account's entry, so Back never lands on a signed-in-looking Account.
  replacingEntry = true;
  location.replace('#/');
}

backButton.addEventListener('click', goBack);
// Anything the member does with the page or a row ends a restoration still owed; scroll events alone do not.
for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(type, () => { restoreCancelled = true; }, { capture: true, passive: true });
window.addEventListener('scroll', onScroll, { passive: true });
document.addEventListener('focusin', showFocusedCard);
window.addEventListener('hashchange', () => {
  if (isRouteHash(location.hash)) void render();
});
// The skip link is an in-page anchor (`#screen`, for when scripts are off); with the router on it must not become a
// route, so it only moves focus.
doc.querySelector('a.skip-link')?.addEventListener('click', (event) => {
  event.preventDefault();
  main.focus();
});
window.addEventListener('storage', (event) => {
  if (event.key === 'jellyfin_credentials') resumeIfChanged();
});
window.addEventListener('pageshow', resumeIfChanged);
doc.addEventListener('visibilitychange', () => {
  if (!doc.hidden) resumeIfChanged();
});

if ('serviceWorker' in navigator) {
  // Only static app files are ever cached (see sw.js); a failure to register changes nothing else.
  navigator.serviceWorker.register('/jellypass/app/sw.js', { scope: '/jellypass/app/', updateViaCache: 'none' }).catch(() => undefined);
}

void render();
