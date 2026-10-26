// The My requests tab through the real router, signed in, with a fake gateway: the household's requests with their
// titles and thumbnails (TMDB's only) named from each title's own answer, ten at a time, the coarse status (per season
// for a series), who asked, and "We couldn't get this" with the admin note and no button. The PWA's fixed wording
// when there is nothing and on each failure, Try again, never retried by itself, a 401 signing out; read again each
// time it is shown and on pull to refresh; Load more. Title answers are seen by the overlay, so Home shows the state
// read here. An entry opens its title on the My requests tab's own stack. Then accessibility, the iPad width and
// privacy. The calls are pinned against the budget by search-requests-budget.test.tsx. Queries are queryAll* and
// assertions read single fields, so a failure never prints the component tree.
import { act, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';

import type { FetchLike } from '../src/api/client';
import { REQUESTS_TEXT } from '../src/requests/text';
import { REQUESTS_MAX_WIDTH } from '../src/screens/RequestsScreen';
import { layout } from '../src/theme';
import { GET_THIS_TEXT } from '../src/title/text';
import { API } from './support/home';
import { ORIGIN, TOKEN, answer, fixture, keepSession, offline, settle, shows, store, storedSession, type Call } from './support/household';
import { requestEntry, searchGateway, wait, type SearchHousehold } from './support/search';
import { buttonNamed, flat, movieAnswer, only, pressNode, seriesAnswer } from './support/title';

// Home sits under the My requests tab: slower CI runners need more than Jest's 5 s.
jest.setTimeout(30_000);

let mockFetch: FetchLike;
jest.mock('../src/api/transport', () => ({
  ...jest.requireActual('../src/api/transport'),
  householdFetch: (url: string, init: never) => mockFetch(url, init),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: jest.requireActual('../app.config').default } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);

const PHONE = { width: 390, height: 844, scale: 2, fontScale: 1 };
let mockWindow = PHONE;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow }));

let gateway: ReturnType<typeof searchGateway>;

function useHousehold(household: SearchHousehold = {}) {
  gateway = searchGateway(household);
  mockFetch = gateway.fetch;
}

/** The fixture's two requests: a series asked for by this member (season 1 ready, season 2 failed), a film by another. */
const FIXTURE = fixture('requests') as { results: unknown[] };

beforeEach(() => {
  mockWindow = PHONE;
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  useHousehold({ requests: FIXTURE });
});

async function openRequests() {
  const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  const before = gateway.calls.length;
  await act(async () => router.navigate('/requests'));
  await settle();
  return { app, since: () => gateway.routes().slice(before) };
}

const entries = () => screen.queryAllByTestId('request-item').map((node) => String(node.props.accessibilityLabel));
const thumbnails = () =>
  screen.queryAllByTestId('request-item').map((item) => {
    const images = within(item).queryAllByTestId('tmdb-image', { includeHiddenElements: true });
    return images.length ? String(images[0]!.props.source?.uri) : '';
  });
const titleCalls = (routes: readonly string[]) => routes.filter((route) => /\/(movie|tv)\/\d+$/.test(route));
const tabSelected = () =>
  screen
    .queryAllByRole('tab')
    .filter((node) => node.props.accessibilityState?.selected)
    .map((node) => String(node.props.accessibilityLabel));

const SERIES_NAME =
  "Series 900002, 2023 · Series, Requested, Asked for by you, Season 1: Ready to watch, Season 2: We couldn't get this, Ask your JellyPass admin to try again.";
const FILM_NAME = 'Film 900001, 2024 · Movie, Ready to watch, Asked for by someone in your household';

describe('the list', () => {
  it('shows each request with its title, kind, coarse status, who asked and each season, named once', async () => {
    const { since } = await openRequests();
    expect(entries()).toEqual([SERIES_NAME, FILM_NAME]);
    expect(since().sort()).toEqual([`GET ${API}/movie/900001`, `GET ${API}/requests`, `GET ${API}/tv/900002`]);
    // What it draws, hidden from screen readers (the entry's name says it all once).
    for (const text of ['Series 900002', '2023 · Series', 'Asked for by you', 'Season 1', 'Season 2', 'Asked for by someone in your household']) {
      expect({ text, shown: shows(text, { hidden: true }) }).toEqual({ text, shown: true });
    }
    // A chip for each request and each of the series' seasons.
    const list = only(screen.queryAllByTestId('request-list'), 'list');
    expect(within(list).queryAllByTestId('status-chip', { includeHiddenElements: true })).toHaveLength(4);
  });

  it('shows TMDB\'s poster as each thumbnail, and nothing from anywhere else', async () => {
    useHousehold({
      requests: FIXTURE,
      series: { 900002: seriesAnswer(900002, ['get_this'], { posterUrl: 'https://elsewhere.example.test/poster.jpg' }) },
    });
    await openRequests();
    expect(thumbnails()).toEqual(['', 'https://image.tmdb.org/t/p/w342/poster-900001.jpg']);
  });

  it('says "Loading title…" until a title is read, and "Title unavailable" (keeping the status) if it cannot be, with no retry', async () => {
    let releaseFilm: () => void = () => undefined;
    useHousehold({
      requests: FIXTURE,
      override: (call) => {
        if (call.route === `GET ${API}/tv/900002`) return answer(502, { error: 'unavailable' });
        if (call.route === `GET ${API}/movie/900001`) return new Promise((resolve) => (releaseFilm = () => resolve(answer(200, movieAnswer(900001, 'in_library')))));
        return undefined;
      },
    });
    const { since } = await openRequests();
    expect(entries()[0]!.startsWith('Title unavailable, Series, Requested')).toBe(true);
    expect(entries()[1]!.startsWith('Loading title…, Movie, Ready to watch')).toBe(true);
    await act(async () => releaseFilm());
    await settle();
    expect(entries()[1]).toBe(FILM_NAME);
    await wait(10 * 60_000);
    expect(titleCalls(since())).toHaveLength(2);
    expect(screen.queryAllByRole('button', { name: 'Try again' })).toHaveLength(0);
  });

  it('shows "We couldn\'t get this" with the admin note and no button', async () => {
    useHousehold({ requests: { results: [requestEntry('f', 'movie', 7, 'failed')] } });
    await openRequests();
    expect(entries()).toEqual([`Film 7, 2024 · Movie, We couldn't get this, Asked for by you, ${GET_THIS_TEXT.failedNote}`]);
    expect(shows(GET_THIS_TEXT.failedNote, { hidden: true })).toBe(true);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('says the PWA\'s words when the household has asked for nothing', async () => {
    useHousehold({ requests: { results: [] } });
    const { since } = await openRequests();
    expect(shows(REQUESTS_TEXT.empty)).toBe(true);
    expect(since()).toEqual([`GET ${API}/requests`]);
  });

  it('names ten at a time, a few calls at once, and Load more names the next ten', async () => {
    const many = Array.from({ length: 25 }, (_, index) => requestEntry(`r${index}`, 'movie', 100 + index, 'requested'));
    let out = 0;
    let most = 0;
    useHousehold({
      requests: { results: many },
      override: (call) => {
        if (!/\/movie\/\d+$/.test(call.route)) return undefined;
        out += 1;
        most = Math.max(most, out);
        return Promise.resolve().then(() => {
          out -= 1;
          return answer(200, movieAnswer(Number(call.route.split('/').pop())));
        });
      },
    });
    const { since } = await openRequests();
    expect(entries()).toHaveLength(10);
    expect(titleCalls(since())).toHaveLength(10);
    expect(most).toBeLessThanOrEqual(4);
    await pressNode(buttonNamed('Load more'));
    expect(entries()).toHaveLength(20);
    expect(titleCalls(since())).toHaveLength(20);
    await pressNode(buttonNamed('Load more'));
    expect(entries()).toHaveLength(25);
    expect(entries()[24]!.startsWith('Film 124, 2024 · Movie')).toBe(true);
    expect(screen.queryAllByRole('button', { name: /^(Load more|Loading…)$/ })).toHaveLength(0);
    expect(titleCalls(since())).toHaveLength(25);
  });
});

describe('failures', () => {
  it.each([
    ['429', () => answer(429, { error: 'too_many_requests' }), 'Too many requests', 'Wait a minute, then try again.'],
    ['502', () => answer(502, { error: 'canary' }), "Can't load this right now", 'Something went wrong. Try again in a moment.'],
    ['no connection', offline, "You're offline", 'Check your connection, then try again.'],
  ] as const)('shows the fixed words for %s with Try again, and never asks again by itself', async (_what, respond, title, body) => {
    let fail = true;
    useHousehold({ requests: FIXTURE, override: (call: Call) => (fail && call.route === `GET ${API}/requests` ? respond(call) : undefined) });
    const { since } = await openRequests();
    expect([shows(title), shows(body)]).toEqual([true, true]);
    expect(shows(/canary/)).toBe(false);
    await wait(10 * 60_000);
    expect(since()).toEqual([`GET ${API}/requests`]);
    fail = false;
    await pressNode(buttonNamed('Try again'));
    expect(entries()).toEqual([SERIES_NAME, FILM_NAME]);
  });

  it.each([
    ['the list', `GET ${API}/requests`],
    ['a title', `GET ${API}/movie/900001`],
  ])('signs the member out on a 401 for %s', async (_what, route) => {
    useHousehold({ requests: FIXTURE, override: (call) => (call.route === route ? answer(401, { error: 'unauthorized' }) : undefined) });
    const { app } = await openRequests();
    expect(storedSession()).toBeUndefined();
    expect(app.getPathname()).toBe('/');
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});

describe('reading it again', () => {
  it('opens a title on the My requests tab\'s own stack, and reads the list again on coming back', async () => {
    const { app, since } = await openRequests();
    await pressNode(only(screen.queryAllByRole('link', { name: SERIES_NAME }), 'entry'));
    expect(app.getPathname()).toBe('/requests/tv/900002');
    expect(tabSelected()).toEqual(['My requests']);
    await pressNode(only(screen.queryAllByRole('link', { name: /^Season 1/ }), 'season'));
    expect(app.getPathname()).toBe('/requests/tv/900002/season/1');
    await pressNode(buttonNamed('Back'));
    await pressNode(buttonNamed('Back'));
    expect(app.getPathname()).toBe('/requests');
    expect(entries()).toEqual([SERIES_NAME, FILM_NAME]);
    expect(since().filter((route) => route === `GET ${API}/requests`).length).toBeGreaterThanOrEqual(2);
  });

  it('reads the list and its titles again on pull to refresh', async () => {
    const { since } = await openRequests();
    const before = since().length;
    const scroll = only(screen.queryAllByTestId('requests-scroll'), 'scroll view');
    await act(async () => scroll.props.refreshControl.props.onRefresh());
    await settle();
    expect(since().slice(before).sort()).toEqual([`GET ${API}/movie/900001`, `GET ${API}/requests`, `GET ${API}/tv/900002`]);
    expect(entries()).toEqual([SERIES_NAME, FILM_NAME]);
  });

  it('hands each title it reads to the overlay, so Home\'s card shows the state read here', async () => {
    // Home's Trending 2 is series 1002, `get_this` in the row's answer; its own answer says it is requested.
    useHousehold({ requests: { results: [requestEntry('h', 'tv', 1002, 'requested')] }, series: { 1002: seriesAnswer(1002, ['requested']) } });
    const card = (state: string) => screen.queryAllByRole('link', { name: `trending 2, 2021, Series, TMDB rating 6.5 out of 10, ${state}`, includeHiddenElements: true });
    await openRequests();
    expect(card('Requested')).toHaveLength(1);
    expect(card('Available to get')).toHaveLength(0);
  });
});

describe('accessibility and layout', () => {
  it('names each entry once, at least a thumb\'s height, as a link', async () => {
    await openRequests();
    for (const node of screen.queryAllByTestId('request-item')) {
      expect({ role: node.props.accessibilityRole, tall: flat(node).minHeight >= layout.touchTarget }).toEqual({ role: 'link', tall: true });
    }
    // The chips are said in the entry's name, not again.
    expect(screen.queryAllByTestId('status-chip').filter((chip) => chip.props.accessibilityLabel)).toHaveLength(0);
  });

  it('stops widening on an iPad at the PWA\'s 46rem', async () => {
    mockWindow = { ...PHONE, width: 1024 };
    await openRequests();
    expect(flat(only(screen.queryAllByTestId('screen-column'), 'column')).maxWidth).toBe(REQUESTS_MAX_WIDTH);
  });

  it('keeps nothing it reads on the device', async () => {
    await openRequests();
    expect(store.setItemAsync.mock.calls.map(([key]) => String(key))).toEqual([]);
  });
});
