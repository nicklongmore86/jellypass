// The My requests tab through the real router, signed in, with a fake gateway: the household's requests with their
// titles and thumbnails (TMDB's only) named from each title's own answer, ten at a time, the coarse status (per season
// for a series), who asked, and "We couldn't get this" with the admin note and no button. The PWA's fixed wording
// when there is nothing and on each failure, Try again, never retried by itself, a 401 signing out; read again each
// time it is shown and on pull to refresh; Load more. Title answers are seen by the overlay, so Home shows the state
// read here. Titles named in the last ten minutes of the sign-in are reused (never their status, never seen again by the
// overlay): shown again, it reads the list and only the titles it has not named. An entry opens its title on the My requests tab's own stack. Then accessibility, the iPad width and
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
// Every answer the session's overlay is handed, as `mediaType:tmdbId` (a title) or `page` (a Home row).
const mockSeen: string[] = [];
jest.mock('../src/title/asked', () => {
  const actual = jest.requireActual('../src/title/asked');
  return {
    ...actual,
    createAsked: (...args: unknown[]) => {
      const asked = actual.createAsked(...args);
      const seen = asked.seen;
      asked.seen = (answer: { mediaType?: string; tmdbId?: number }) => {
        mockSeen.push(answer.mediaType ? `${answer.mediaType}:${answer.tmdbId}` : 'page');
        seen(answer);
      };
      return asked;
    },
  };
});

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
  mockSeen.length = 0;
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
const inItems = (count: (item: ReturnType<typeof screen.queryAllByTestId>[number]) => number) => screen.queryAllByTestId('request-item').map(count);
const chipCounts = () => inItems((item) => within(item).queryAllByTestId('status-chip', { includeHiddenElements: true }).length);
const seasonRows = () => inItems((item) => within(item).queryAllByTestId('request-season', { includeHiddenElements: true }).length);
const notes = () => inItems((item) => within(item).queryAllByText(GET_THIS_TEXT.failedNote, { includeHiddenElements: true }).length);
const titleCalls = (routes: readonly string[]) => routes.filter((route) => /\/(movie|tv)\/\d+$/.test(route));
const tabSelected = () =>
  screen
    .queryAllByRole('tab')
    .filter((node) => node.props.accessibilityState?.selected)
    .map((node) => String(node.props.accessibilityLabel));

const SERIES_NAME =
  "Series 900002, 2023 · Series, Asked for by you, Requested on Oct 27, 2026, Season 1: Ready to watch, Season 2: We couldn't get this, Ask your JellyPass admin to try again.";
const FILM_NAME = 'Film 900001, 2024 · Movie, Ready to watch, Asked for by someone in your household, Requested on Sep 30, 2026';

describe('the list', () => {
  it('shows each request with its title, kind, coarse status, who asked and each season, named once', async () => {
    const { since } = await openRequests();
    expect(entries()).toEqual([SERIES_NAME, FILM_NAME]);
    expect(since().sort()).toEqual([`GET ${API}/movie/900001`, `GET ${API}/requests`, `GET ${API}/tv/900002`]);
    // What it draws, hidden from screen readers (the entry's name says it all once).
    for (const text of ['Series 900002', '2023 · Series', 'Asked for by you', 'Season 1', 'Season 2', 'Asked for by someone in your household']) {
      expect({ text, shown: shows(text, { hidden: true }) }).toEqual({ text, shown: true });
    }
    // The series' seasons differ: a chip for each of them and none for the series; one for the film.
    const list = only(screen.queryAllByTestId('request-list'), 'list');
    expect(within(list).queryAllByTestId('status-chip', { includeHiddenElements: true })).toHaveLength(3);
    expect(seasonRows()).toEqual([2, 0]);
  });

  it('shows one chip for a series of one season, with the season on the meta line and no season row', async () => {
    useHousehold({ requests: { results: [requestEntry('s', 'tv', 900002, 'requested', { seasons: [{ seasonNumber: 1, status: 'requested' }] })] } });
    await openRequests();
    expect(entries()).toEqual(['Series 900002, 2023 · Series · Season 1, Requested, Asked for by you']);
    expect(shows('2023 · Series · Season 1', { hidden: true })).toBe(true);
    expect(chipCounts()).toEqual([1]);
    expect(seasonRows()).toEqual([0]);
  });

  it('shows one chip and the seasons as text when they share a status, and a chip per season only when they differ', async () => {
    const seasons = (numbers: number[], status: string) => numbers.map((seasonNumber) => ({ seasonNumber, status }));
    useHousehold({
      requests: {
        results: [
          requestEntry('a', 'tv', 900002, 'ready', { seasons: seasons([1, 2, 3], 'ready') }),
          requestEntry('b', 'tv', 900003, 'failed', { seasons: seasons([1, 3], 'failed') }),
          requestEntry('c', 'tv', 900004, 'requested', { seasons: [...seasons([1], 'ready'), ...seasons([2], 'requested'), ...seasons([3], 'failed')] }),
        ],
      },
    });
    await openRequests();
    expect(entries()).toEqual([
      'Series 900002, 2023 · Series · Seasons 1–3, Ready to watch, Asked for by you',
      `Series 900003, 2023 · Series · Seasons 1, 3, We couldn't get this, Asked for by you, ${GET_THIS_TEXT.failedNote}`,
      `Series 900004, 2023 · Series, Asked for by you, Season 1: Ready to watch, Season 2: Requested, Season 3: We couldn't get this, ${GET_THIS_TEXT.failedNote}`,
    ]);
    expect(chipCounts()).toEqual([1, 1, 3]);
    expect(seasonRows()).toEqual([0, 0, 3]);
    expect(notes()).toEqual([0, 1, 1]);
    // The failed season's own row carries the note.
    const rows = within(screen.queryAllByTestId('request-item')[2]!).queryAllByTestId('request-season', { includeHiddenElements: true });
    expect(rows.map((row) => within(row).queryAllByText(GET_THIS_TEXT.failedNote, { includeHiddenElements: true }).length)).toEqual([0, 0, 1]);
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
    expect(entries()[0]!.startsWith('Title unavailable, Series, Asked for by you, Requested on Oct 27, 2026, Season 1: Ready to watch')).toBe(true);
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

  it('reads the list again on pull to refresh, keeping the titles it named', async () => {
    const { since } = await openRequests();
    const before = since().length;
    const scroll = only(screen.queryAllByTestId('requests-scroll'), 'scroll view');
    await act(async () => scroll.props.refreshControl.props.onRefresh());
    await settle();
    expect(since().slice(before)).toEqual([`GET ${API}/requests`]);
    expect(entries()).toEqual([SERIES_NAME, FILM_NAME]);
  });

  it('waits for the list read again before Load more names anything, so no title is asked for twice', async () => {
    const many = Array.from({ length: 25 }, (_, index) => requestEntry(`r${index}`, 'movie', 100 + index, 'requested'));
    let lists = 0;
    let releaseList: () => void = () => undefined;
    useHousehold({
      requests: { results: many },
      override: (call) => {
        if (call.route !== `GET ${API}/requests` || ++lists < 2) return undefined;
        return new Promise((resolve) => (releaseList = () => resolve(answer(200, { results: many }))));
      },
    });
    const { since } = await openRequests();
    expect(titleCalls(since())).toHaveLength(10);
    const scroll = only(screen.queryAllByTestId('requests-scroll'), 'scroll view');
    let refreshed: Promise<void> = Promise.resolve();
    await act(async () => {
      refreshed = scroll.props.refreshControl.props.onRefresh();
    });
    await settle();
    // Pull to refresh is out: Load more waits (shown as Loading…, and pressing it asks for nothing).
    expect(screen.queryAllByRole('button', { name: 'Load more' })).toHaveLength(0);
    await pressNode(buttonNamed(/^(Load more|Loading…)$/));
    await settle();
    expect(titleCalls(since())).toHaveLength(10);
    await act(async () => releaseList());
    await act(async () => refreshed);
    await settle();
    expect(entries()).toHaveLength(10);
    // The first ten were named on opening: the refresh reads none again.
    expect(titleCalls(since())).toHaveLength(10);
    await pressNode(buttonNamed('Load more'));
    expect(entries()).toHaveLength(20);
    const calls = titleCalls(since());
    expect(calls).toHaveLength(20);
    expect(new Set(calls).size).toBe(20);
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

describe('reusing the titles it named', () => {
  const listCalls = (routes: readonly string[]) => routes.filter((route) => route === `GET ${API}/requests`);
  /** Leaves for Home and comes back; returns the calls made by coming back. */
  async function showAgain(since: () => string[]) {
    await act(async () => router.navigate('/'));
    await settle();
    const before = since().length;
    await act(async () => router.navigate('/requests'));
    await settle();
    return () => since().slice(before);
  }
  const film = (index: number, status: 'requested' | 'ready' | 'failed' = 'requested') => requestEntry(`r${index}`, 'movie', 100 + index, status);

  it('reads the list and each title on the first visit, then only the list within ten minutes, with the statuses it says now', async () => {
    const list = { results: [film(0), film(1), film(2)] };
    useHousehold({ requests: list });
    const { since } = await openRequests();
    expect(listCalls(since()).length).toBe(1);
    expect(titleCalls(since()).join(' ')).toBe([100, 101, 102].map((id) => `GET ${API}/movie/${id}`).join(' '));
    expect(mockSeen.filter((key) => key !== 'page').join(' ')).toBe('movie:100 movie:101 movie:102');
    list.results = [film(0, 'ready'), film(1, 'failed'), film(2)];
    const again = await showAgain(since);
    expect(listCalls(again()).length).toBe(1);
    expect(titleCalls(again()).length).toBe(0);
    // A kept title is not handed to the overlay again.
    expect(mockSeen.filter((key) => key !== 'page').join(' ')).toBe('movie:100 movie:101 movie:102');
    expect(entries()[0]).toBe('Film 100, 2024 · Movie, Ready to watch, Asked for by you');
    expect(entries()[1]!.startsWith("Film 101, 2024 · Movie, We couldn't get this, Asked for by you")).toBe(true);
    expect(entries()[2]).toBe('Film 102, 2024 · Movie, Requested, Asked for by you');
  });

  it('reads only the titles it has not named: a new request, and those Load more shows', async () => {
    const list = { results: Array.from({ length: 12 }, (_, index) => film(index)) };
    useHousehold({ requests: list });
    const { since } = await openRequests();
    expect(titleCalls(since()).length).toBe(10);
    list.results = [film(99), ...list.results];
    const again = await showAgain(since);
    expect(titleCalls(again()).join(' ')).toBe(`GET ${API}/movie/199`);
    expect(entries()[0]!.startsWith('Film 199, 2024 · Movie')).toBe(true);
    await pressNode(buttonNamed('Load more'));
    expect(entries()).toHaveLength(13);
    // Shown again, it named 99 and 0–8; Load more names 9 (named already), 10 and 11.
    expect(titleCalls(again()).join(' ')).toBe([199, 110, 111].map((id) => `GET ${API}/movie/${id}`).join(' '));
  });

  it('reads every title again once ten minutes have passed', async () => {
    useHousehold({ requests: { results: [film(0), film(1)] } });
    const { since } = await openRequests();
    expect(titleCalls(since()).length).toBe(2);
    await wait(10 * 60_000);
    const again = await showAgain(since);
    expect(titleCalls(again()).join(' ')).toBe([100, 101].map((id) => `GET ${API}/movie/${id}`).join(' '));
    expect(mockSeen.filter((key) => key !== 'page').length).toBe(4);
  });

  it('does not keep a title that could not be read', async () => {
    let failing = true;
    useHousehold({ requests: { results: [film(0)] }, override: (call) => (failing && call.route === `GET ${API}/movie/100` ? answer(502, { error: 'unavailable' }) : undefined) });
    const { since } = await openRequests();
    expect(entries()[0]!.startsWith('Title unavailable, Movie')).toBe(true);
    failing = false;
    const again = await showAgain(since);
    expect(titleCalls(again()).join(' ')).toBe(`GET ${API}/movie/100`);
    expect(entries()[0]).toBe('Film 100, 2024 · Movie, Requested, Asked for by you');
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
