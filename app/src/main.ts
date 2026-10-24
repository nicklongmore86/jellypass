import { ApiError, createApi, createSignInApi, type Api, type ApiErrorKind, type SignInApi } from './api.js';
import {
  aboutView,
  cardList,
  el,
  errorState,
  searchStatusText,
  seasonView,
  skeletonDetail,
  skeletonRow,
  titleDetail,
  titleRow,
} from './render.js';
import { clearSignIn, deviceId, jellyfinToken } from './session.js';
import { showSignIn } from './signin.js';
import type { DiscoverList, Me } from './types.js';

const ROWS: Array<{ list: DiscoverList; heading: string }> = [
  { list: 'trending', heading: 'Trending' },
  { list: 'popular-movies', heading: 'Popular movies' },
  { list: 'popular-tv', heading: 'Popular series' },
  { list: 'upcoming', heading: 'Upcoming movies' },
];
const SEARCH_DEBOUNCE_MS = 300;
const MAX_QUERY_LENGTH = 100;

const doc = document;
const main = doc.getElementById('screen') as HTMLElement;
const who = doc.getElementById('who') as HTMLElement;
const status = doc.getElementById('status') as HTMLElement;
const signOutButton = doc.getElementById('signout') as HTMLButtonElement;
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
  window.scrollTo(0, 0);
}

async function loadMe(signal: AbortSignal): Promise<void> {
  if (me) return;
  me = await api.me(signal);
  who.textContent = [me.name, me.household].filter(Boolean).join(' · ');
}

/** The sign-in screen, in place of whatever was showing; `expired` when a sign-in the app held was refused. */
function signIn(signal: AbortSignal, current: () => boolean, expired: boolean): void {
  me = undefined;
  who.textContent = '';
  signOutButton.hidden = true;
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
  show(errorState(doc, kind, retry));
  announce('');
  focusHeading();
}

interface Route {
  name: 'home' | 'search' | 'movie' | 'tv' | 'season' | 'about';
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
  const season = /^\/tv\/(\d{1,10})\/season\/(\d{1,4})$/.exec(path);
  if (season) return { name: 'season', id: Number(season[1]), season: Number(season[2]) };
  const title = /^\/(movie|tv)\/(\d{1,10})$/.exec(path);
  if (title) return { name: title[1] === 'tv' ? 'tv' : 'movie', id: Number(title[2]) };
  return { name: 'home' };
}

function markNav(route: Route): void {
  const current = route.name === 'search' ? 'search' : route.name === 'about' ? 'about' : 'home';
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
  signOutButton.hidden = !jellyfinToken(localStorage, origin);

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

async function title(route: Route, signal: AbortSignal, current: () => boolean): Promise<void> {
  busy(skeletonDetail(doc));
  setTitle();
  await loadMe(signal);
  const id = route.id as number;
  const answer = route.name === 'tv' ? await api.tv(id, signal) : await api.movie(id, signal);
  if (!current()) return;
  setTitle(answer.title);
  show(titleDetail(doc, answer, origin));
  announce('');
  focusHeading();
}

async function season(route: Route, signal: AbortSignal, current: () => boolean): Promise<void> {
  busy(skeletonDetail(doc));
  setTitle();
  await loadMe(signal);
  const id = route.id as number;
  const [answer, series] = await Promise.all([
    api.season(id, route.season as number, signal),
    api.tv(id, signal).then((value) => value, () => undefined),
  ]);
  if (!current()) return;
  setTitle(`${series ? `${series.title}: ` : ''}${answer.name}`);
  show(seasonView(doc, answer, series?.title));
  announce('');
  focusHeading();
}

// Signing in or out on the same address (in another tab, or in Jellyfin web) is picked up without a reload.
function resumeIfChanged(): void {
  const signedIn = Boolean(jellyfinToken(localStorage, origin));
  const showingSignIn = Boolean(main.querySelector('[data-screen="signin"]'));
  if (signedIn === showingSignIn && parse(location.hash).name !== 'about') void render();
}

async function signOut(): Promise<void> {
  const token = jellyfinToken(localStorage, origin);
  signOutButton.disabled = true;
  announce('Signing out…');
  // The token is revoked at Jellyfin first, so it is dead everywhere, Jellyfin web included; then it leaves this browser.
  if (token) await signInApi.signOut(token);
  const cleared = clearSignIn(localStorage, origin);
  signOutButton.disabled = false;
  me = undefined;
  who.textContent = '';
  if (!cleared) {
    announce("Couldn't remove your sign-in from this browser.");
    return;
  }
  announce('Signed out.');
  void render();
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
signOutButton.addEventListener('click', () => void signOut());
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
