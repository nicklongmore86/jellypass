import { ApiError, createApi, type Api, type ApiErrorKind } from './api.js';
import {
  aboutView,
  cardList,
  el,
  errorState,
  type GetThisHandler,
  REQUESTS_TEXT,
  requestItem,
  searchStatusText,
  seasonView,
  setRequestTitle,
  skeletonDetail,
  skeletonRow,
  titleDetail,
  titleRow,
} from './render.js';
import { jellyfinToken } from './session.js';
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
const who = doc.getElementById('who') as HTMLElement;
const status = doc.getElementById('status') as HTMLElement;
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
  window.scrollTo(0, 0);
}

async function loadMe(signal: AbortSignal): Promise<void> {
  if (me) return;
  me = await api.me(signal);
  who.textContent = [me.name, me.household].filter(Boolean).join(' · ');
}

function failure(kind: ApiErrorKind, retry: () => void): void {
  if (kind === 'unauthorized') {
    me = undefined;
    who.textContent = '';
  }
  setTitle(kind === 'unauthorized' ? 'Sign in' : 'Error');
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
  const current = route.name === 'search' || route.name === 'requests' || route.name === 'about' ? route.name : 'home';
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
  markNav(route);
  const retry = () => void render();

  if (route.name === 'about') {
    setTitle('About & credits');
    show(aboutView(doc));
    announce('');
    focusHeading();
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
  busy(el(doc, 'h1', { class: 'visually-hidden', text: 'Home', attrs: { tabindex: '-1' } }), ...ROWS.map(() => skeletonRow(doc)));
  await loadMe(signal);
  if (!current()) return;
  const slots = ROWS.map(() => el(doc, 'div'));
  const heading = el(doc, 'h1', { class: 'visually-hidden', text: 'Home', attrs: { tabindex: '-1' } });
  show(heading, ...slots);
  slots.forEach((slot) => slot.append(skeletonRow(doc)));
  let unauthorized = false;
  await Promise.all(
    ROWS.map(async (row, index) => {
      const slot = slots[index] as HTMLElement;
      try {
        const page = await api.discover(row.list, signal);
        if (current()) slot.replaceChildren(titleRow(doc, `row-${row.list}`, row.heading, page, origin));
      } catch (error) {
        if (!current() || signal.aborted) return;
        const kind = kindOf(error);
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
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    pending?.abort();
  });
  const input = el(doc, 'input', {
    attrs: { id: 'q', type: 'search', name: 'q', autocomplete: 'off', enterkeyhint: 'search', maxlength: String(MAX_QUERY_LENGTH), placeholder: 'Movies and series', value: initial },
  });
  const form = el(doc, 'form', { class: 'search-form', attrs: { role: 'search' } }, [
    el(doc, 'label', { class: 'visually-hidden', text: 'Search movies and series', attrs: { for: 'q' } }),
    input,
  ]);
  const results = el(doc, 'div', { class: 'search-results' });

  function run(raw: string): void {
    clearTimeout(timer);
    pending?.abort();
    const query = raw.trim().slice(0, MAX_QUERY_LENGTH);
    history.replaceState(null, '', query ? `#/search?q=${encodeURIComponent(query)}` : '#/search');
    const mine = ++sequence;
    if (!query) {
      results.replaceChildren();
      announce('');
      return;
    }
    const controller = new AbortController();
    pending = controller;
    results.replaceChildren(skeletonRow(doc));
    announce('Searching…');
    void fetchPage(query, 1, controller, mine, false);
  }

  async function fetchPage(query: string, page: number, controller: AbortController, mine: number, append: boolean): Promise<void> {
    try {
      const answer = await api.search(query, page, controller.signal);
      if (mine !== sequence || !current()) return;
      const fresh = cardList(doc, answer.results, origin, 'grid');
      const firstNew = fresh.querySelector<HTMLElement>('a.card-link');
      results.querySelector('.load-more')?.remove();
      if (append) {
        results.querySelector('ul.grid')?.append(...Array.from(fresh.children));
      } else {
        const empty = searchStatusText(answer.results.length, query);
        results.replaceChildren(empty ? el(doc, 'p', { class: 'muted', text: empty }) : fresh);
      }
      announce(append ? 'More results loaded.' : answer.results.length ? 'Results loaded.' : '');
      if (answer.nextPage) {
        const more = el(doc, 'button', { class: 'button button-secondary load-more', text: 'Load more', attrs: { type: 'button' } });
        more.addEventListener('click', () => {
          more.disabled = true;
          more.textContent = 'Loading…';
          void fetchPage(query, answer.nextPage as number, controller, mine, true);
        });
        results.append(more);
      }
      if (append) firstNew?.focus();
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
    clearTimeout(timer);
    timer = setTimeout(() => run(input.value), SEARCH_DEBOUNCE_MS);
  });

  show(el(doc, 'h1', { class: 'screen-title', text: 'Search', attrs: { tabindex: '-1' } }), form, results);
  announce('');
  focusHeading();
  if (initial.trim()) run(initial);
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
  return async (seasons) => {
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
    // The screen is read again; if that fails the confirmation stays and the next visit shows the state.
    await redraw(asked).catch((error: unknown) => {
      if (kindOf(error) === 'unauthorized' && current()) failure('unauthorized', () => void render());
    });
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
    show(titleDetail(doc, answer, origin, { onGet, asked, failed, confirmed }));
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
    show(seasonView(doc, answer, series?.title, { onGet, asked, failed, confirmed }));
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
  busy(el(doc, 'h1', { class: 'screen-title', text: REQUESTS_TEXT.title, attrs: { tabindex: '-1' } }), skeletonRow(doc));
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
  const list = el(doc, 'ul', { class: 'request-list' });
  const more = el(doc, 'button', { class: 'button button-secondary load-more', text: 'Load more', attrs: { type: 'button' } });
  let shown = 0;

  async function showMore(): Promise<void> {
    const batch = entries.slice(shown, shown + REQUESTS_PER_PAGE);
    shown += batch.length;
    const items = batch.map((entry) => requestItem(doc, entry));
    list.append(...items);
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
  await showMore();
}

// Signing in on the same address (in another tab, or before coming back here) is picked up without a reload.
function resumeIfSignedIn(): void {
  if (jellyfinToken(localStorage, origin) && main.querySelector('a[href="/web/"]')) void render();
}

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
  if (event.key === 'jellyfin_credentials') resumeIfSignedIn();
});
window.addEventListener('pageshow', resumeIfSignedIn);
doc.addEventListener('visibilitychange', () => {
  if (!doc.hidden) resumeIfSignedIn();
});

if ('serviceWorker' in navigator) {
  // Only static app files are ever cached (see sw.js); a failure to register changes nothing else.
  navigator.serviceWorker.register('/jellypass/app/sw.js', { scope: '/jellypass/app/' }).catch(() => undefined);
}

void render();
