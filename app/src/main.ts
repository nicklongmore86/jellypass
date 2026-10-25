import { ApiError, createApi, createSignInApi, type Api, type ApiErrorKind, type SignInApi } from './api.js';
import {
  aboutView,
  accountText,
  cardList,
  el,
  errorState,
  type GetThisHandler,
  heroCarousel,
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
  titleDetail,
  titleRow,
} from './render.js';
import { icon } from './icons.js';
import { clearSignIn, deviceId, jellyfinToken } from './session.js';
import { showSignIn } from './signin.js';
import type { DiscoverList, MediaType, Me, RequestEntry } from './types.js';

const ROWS: Array<{ list: DiscoverList; heading: string }> = [
  { list: 'trending', heading: 'Trending' },
  { list: 'popular-movies', heading: 'Popular movies' },
  { list: 'popular-tv', heading: 'Popular series' },
  { list: 'upcoming', heading: 'Upcoming movies' },
];
const SEARCH_DEBOUNCE_MS = 300;
const MAX_QUERY_LENGTH = 100;
/** "My requests" names its titles from TMDB a few at a time, so a long list is never a burst of calls. */
const REQUESTS_PER_PAGE = 10;
const REQUEST_TITLE_CALLS = 4;

const doc = document;
const main = doc.getElementById('screen') as HTMLElement;
const status = doc.getElementById('status') as HTMLElement;
const backButton = doc.getElementById('back') as HTMLButtonElement;
/** Home's top row: the (i) that opens About, the only way to it (and so to Sign out and the TMDB credit). */
const aboutLink = doc.getElementById('about-link') as HTMLAnchorElement;
const TAB_ICONS = { home: 'home', search: 'search', requests: 'requests' } as const;

// The chrome's icons are drawn here, node by node, so the page itself carries no markup for them.
backButton.append(icon(doc, 'back'));
aboutLink.append(icon(doc, 'info'));
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

function show(...nodes: Node[]): void {
  main.replaceChildren(...nodes);
  main.setAttribute('aria-busy', 'false');
}

function busy(...nodes: Node[]): void {
  main.replaceChildren(...nodes);
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
function appScrollLeft(list: HTMLElement, left: number): void {
  list.scrollLeft = left;
}

/**
 * How the header sits over the screen: over Home's hero (`home`) or a title's backdrop (`detail`), both of which run
 * under the status bar, or as its own bar. Over a hero it is clear until the page is scrolled, then it is the glass bar.
 */
function setChrome(kind?: 'home' | 'detail'): void {
  if (kind) doc.body.setAttribute('data-chrome', kind);
  else doc.body.removeAttribute('data-chrome');
}
/** A plain `scroll` listener only styles the header; it is never read as the member taking over a restoration. */
function markScrolled(): void {
  if ((window.scrollY || 0) > 40) doc.body.setAttribute('data-scrolled', '');
  else doc.body.removeAttribute('data-scrolled');
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
  /** Search: result pages loaded. My requests: entries shown. */
  loaded?: number;
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

try {
  // The page puts the scroll back itself, once its screen is drawn; the browser's own guess would fight it.
  history.scrollRestoration = 'manual';
} catch {
  // Not every browser lets the page choose.
}

/** Reads the screen that is about to be replaced; run first, while its scroll offsets are still in the page. */
function capturePosition(): void {
  if (shownDepth === undefined || shownRoute === undefined) return;
  if (main.getAttribute('aria-busy') !== 'false' || main.querySelector('.skeleton')) return;
  const position: Position = { y: Math.max(0, Math.round(window.scrollY || 0)) };
  const rows: Record<string, number> = {};
  for (const list of main.querySelectorAll<HTMLElement>('ul.row-list[aria-labelledby]')) {
    const id = list.getAttribute('aria-labelledby') ?? '';
    if (id) rows[id] = Math.max(0, Math.round(list.scrollLeft || 0));
  }
  if (Object.keys(rows).length) position.rows = rows;
  const hero = main.querySelector<HTMLElement>('.hero-track');
  if (hero) position.hero = Math.max(0, Math.round(hero.scrollLeft || 0));
  if (shownRoute.name === 'search') position.loaded = searchPages;
  if (shownRoute.name === 'requests') position.loaded = requestsShown;
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
  name: 'home' | 'search' | 'requests' | 'movie' | 'tv' | 'season' | 'about';
  id?: number;
  season?: number;
  query?: string;
}

/** Only an empty hash or one that starts `#/` names a screen; anything else (the skip link's `#screen`) is not a route. */
function isRouteHash(hash: string): boolean {
  return hash === '' || hash === '#' || hash.startsWith('#/');
}

function parse(hash: string): Route {
  const [path = '', queryString = ''] = hash.replace(/^#/, '').split('?', 2);
  if (path === '/search') return { name: 'search', query: new URLSearchParams(queryString).get('q') ?? '' };
  if (path === '/about') return { name: 'about' };
  if (path === '/requests') return { name: 'requests' };
  const season = /^\/tv\/(\d{1,10})\/season\/(\d{1,4})$/.exec(path);
  if (season) return { name: 'season', id: Number(season[1]), season: Number(season[2]) };
  const title = /^\/(movie|tv)\/(\d{1,10})$/.exec(path);
  if (title) return { name: title[1] === 'tv' ? 'tv' : 'movie', id: Number(title[2]) };
  return { name: 'home' };
}

function markNav(route: Route): void {
  // About is not a tab: reached from Home's (i), it leaves every tab unmarked.
  const current = route.name === 'about' ? undefined : route.name === 'search' || route.name === 'requests' ? route.name : 'home';
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
  const route = parse(location.hash);
  capturePosition();
  stampHistory();
  restoring = positions.get(depth);
  restoreCancelled = false;
  shownDepth = depth;
  shownRoute = route;
  setChrome(route.name === 'home' ? 'home' : route.name === 'movie' || route.name === 'tv' || route.name === 'season' ? 'detail' : undefined);
  backButton.hidden = route.name === 'home';
  aboutLink.hidden = route.name !== 'home';
  markNav(route);
  const retry = () => void render();

  if (route.name === 'about') {
    setTitle('About & credits');
    const signedIn = Boolean(jellyfinToken(localStorage, origin));
    show(aboutView(doc, signedIn ? { me, onSignOut: (button) => void signOut(button) } : undefined, !signedIn));
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
    if (route.name === 'home') await home(abort.signal, current);
    else if (route.name === 'search') await search(route.query ?? '', abort.signal, current);
    else if (route.name === 'requests') await requestsScreen(abort.signal, current);
    else if (route.name === 'movie' || route.name === 'tv') await title(route, abort.signal, current);
    else await season(route, abort.signal, current);
  } catch (error) {
    if (!current() || abort.signal.aborted) return;
    failure(kindOf(error), retry);
  }
}

async function home(signal: AbortSignal, current: () => boolean): Promise<void> {
  setTitle();
  busy(el(doc, 'h1', { class: 'visually-hidden', text: 'Home', attrs: { tabindex: '-1' } }), skeletonHero(doc), ...ROWS.map(() => skeletonRow(doc)));
  await loadMe(signal);
  if (!current()) return;
  const slots = ROWS.map(() => el(doc, 'div', { class: 'home-row' }));
  const heading = el(doc, 'h1', { class: 'visually-hidden', text: 'Home', attrs: { tabindex: '-1' } });
  const heroSlot = el(doc, 'div', {}, [skeletonHero(doc)]);
  show(heading, heroSlot, ...slots);
  /** Without a hero (the first row failed or is empty) the header is its own bar again. */
  const noHero = () => {
    heroSlot.remove();
    setChrome();
  };
  slots.forEach((slot) => slot.append(skeletonRow(doc)));
  let unauthorized = false;
  const restore = restoring;
  await Promise.all(
    ROWS.map(async (row, index) => {
      const slot = slots[index] as HTMLElement;
      try {
        const page = await api.discover(row.list, signal);
        if (!current()) return;
        slot.replaceChildren(titleRow(doc, `row-${row.list}`, row.heading, page));
        if (index === 0) {
          // The hero is drawn from the first row's own answer: it asks for nothing more.
          const hero = heroCarousel(doc, page.results);
          if (hero) {
            heroSlot.replaceChildren(hero);
            const track = hero.querySelector<HTMLElement>('.hero-track');
            if (track && restore?.hero && restoreLive(restore)) appScrollLeft(track, restore.hero);
          } else noHero();
        }
        const list = slot.querySelector<HTMLElement>('ul.row-list');
        const left = restore?.rows?.[`row-${row.list}-heading`];
        if (list && left && restoreLive(restore)) appScrollLeft(list, left);
      } catch (error) {
        if (!current() || signal.aborted) return;
        const kind = kindOf(error);
        if (index === 0) noHero();
        if (kind === 'unauthorized') unauthorized = true;
        else slot.replaceChildren(rowFailure(row.heading, kind, () => void render()));
      }
    }),
  );
  if (!current()) return;
  if (unauthorized) throw new ApiError('unauthorized');
  announce('');
  focusHeading();
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

  show(el(doc, 'h1', { class: 'screen-title', text: 'Search', attrs: { tabindex: '-1' } }), form, results);
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

/** The household's requests, with their titles read from TMDB (through the API) ten at a time. */
async function requestsScreen(signal: AbortSignal, current: () => boolean): Promise<void> {
  setTitle(REQUESTS_TEXT.title);
  busy(el(doc, 'h1', { class: 'screen-title', text: REQUESTS_TEXT.title, attrs: { tabindex: '-1' } }), skeletonRequests(doc));
  await loadMe(signal);
  const entries: RequestEntry[] = (await api.requests(signal)).results;
  if (!current()) return;
  const heading = el(doc, 'h1', { class: 'screen-title', text: REQUESTS_TEXT.title, attrs: { tabindex: '-1' } });
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
  const onAbout = parse(location.hash).name === 'about';
  // About shows an Account card only while signed in, so a sign-in or sign-out elsewhere redraws it.
  if (onAbout ? signedIn !== Boolean(main.querySelector('.account')) : signedIn === showingSignIn) void render();
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
  if (!cleared) {
    announce("Couldn't remove your sign-in from this browser.");
    return;
  }
  announce('Signed out.');
  void render();
}

backButton.addEventListener('click', goBack);
// Anything the member does with the page or a row ends a restoration still owed; scroll events alone do not.
for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(type, () => { restoreCancelled = true; }, { capture: true, passive: true });
window.addEventListener('scroll', markScrolled, { passive: true });
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
