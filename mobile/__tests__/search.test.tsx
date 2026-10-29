// The Search tab through the real router, signed in, with a fake gateway: results as the member types (one call per
// pause) or at once on the Search key, the poster grid with each card's status said once in its name, Load more, the
// PWA's fixed wording for no results and each failure with Try again for the one page, never retried by itself, a 401
// signing out, and an older search's late answer never replacing a newer one. Cards draw through the overlay: Requested
// right after Get this, and a title's latest state read anywhere since. A card opens its title on the Search tab's own
// stack. Then the layout (three columns, two on a very narrow phone, more on an iPad), accessibility and privacy. The
// calls are pinned against the budget by search-requests-budget.test.tsx. Queries are queryAll* and assertions read
// single fields, so a failure never prints the component tree.
import { act, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { StyleSheet } from 'react-native';

import type { FetchLike } from '../src/api/client';
import { NARROW_WIDTH, noResultsText, SEARCH_DEBOUNCE_MS } from '../src/search/text';
import { layout } from '../src/theme';
import { API } from './support/home';
import { ORIGIN, TOKEN, answer, keepSession, offline, settle, shows, store, storedSession } from './support/household';
import { field, resultNames, searchAnswer, searches, searchGateway, submitQuery, typeQuery, wait, type SearchHousehold } from './support/search';
import { buttonNamed, checkboxNamed, flat, only, pressNode, seriesAnswer, spokenStatus } from './support/title';

// Home sits under the Search tab, and every test types and waits: slower CI runners need more than Jest's 5 s.
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

function serveHousehold(household: SearchHousehold = {}) {
  gateway = searchGateway(household);
  mockFetch = gateway.fetch;
}

beforeEach(() => {
  mockWindow = PHONE;
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  serveHousehold();
});

/** Starts on Home, signed in, then opens the Search tab. */
async function openSearch() {
  const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  await act(async () => router.navigate('/search'));
  await settle();
  return app;
}

const made = () => searches(gateway.calls);
const tabSelected = () =>
  screen
    .queryAllByRole('tab')
    .filter((node) => node.props.accessibilityState?.selected)
    .map((node) => String(node.props.accessibilityLabel));

/** A search held until the test lets it answer, by its query. */
function heldSearches() {
  const waiting = new Map<string, () => void>();
  const search = (q: string, page: number) =>
    new Promise<ReturnType<typeof answer>>((resolve) => {
      waiting.set(`${q}@${page}`, () => resolve(answer(200, searchAnswer(q, page))));
    });
  return {
    search,
    release: async (key: string) => {
      await act(async () => waiting.get(key)!());
      await settle();
    },
  };
}

describe('searching', () => {
  it('shows nothing and asks for nothing until the member types', async () => {
    await openSearch();
    expect(String(field().props.placeholder)).toBe('Movies and series');
    await wait(60_000);
    expect(made()).toEqual([]);
    expect(resultNames()).toEqual([]);
  });

  it('searches once the member pauses: one call for the last text, trimmed', async () => {
    await openSearch();
    await typeQuery('d');
    await wait(100);
    await typeQuery('du');
    await wait(100);
    await typeQuery('  dune ');
    await wait(SEARCH_DEBOUNCE_MS - 1);
    expect(made()).toEqual([]);
    await wait(1);
    expect(made()).toEqual(['dune@1']);
    expect(resultNames().slice(0, 4)).toEqual([
      'dune 1, 2010, Movie, Available to get',
      'dune 2, 2011, Series, Ready to watch',
      "dune 3, 2012, Movie, Can't request",
      'dune 4, 2013, Series, Requested',
    ]);
    expect(resultNames()).toHaveLength(20);
  });

  it('searches at once on the keyboard\'s Search key, and not again when the pause ends', async () => {
    await openSearch();
    await typeQuery('dune');
    await submitQuery();
    expect(made()).toEqual(['dune@1']);
    await wait(SEARCH_DEBOUNCE_MS * 2);
    expect(made()).toEqual(['dune@1']);
  });

  it('clears the results, with no call, when the field is emptied', async () => {
    await openSearch();
    await typeQuery('dune');
    await wait(SEARCH_DEBOUNCE_MS);
    await typeQuery('   ');
    await wait(SEARCH_DEBOUNCE_MS);
    expect(made()).toEqual(['dune@1']);
    expect(resultNames()).toEqual([]);
  });

  it('shows a skeleton while the first page loads, hidden from screen readers', async () => {
    const gate = heldSearches();
    serveHousehold({ search: gate.search });
    await openSearch();
    await typeQuery('dune');
    await wait(SEARCH_DEBOUNCE_MS);
    expect(screen.queryAllByTestId('skeleton-grid')).toHaveLength(0);
    expect(screen.queryAllByTestId('skeleton-grid', { includeHiddenElements: true })).toHaveLength(1);
    await gate.release('dune@1');
    expect(screen.queryAllByTestId('skeleton-grid', { includeHiddenElements: true })).toHaveLength(0);
    expect(resultNames()).toHaveLength(20);
  });

  it('says the PWA\'s words when nothing matches', async () => {
    serveHousehold({ search: (q, page) => answer(200, searchAnswer(q, page, { count: 0 })) });
    await openSearch();
    await typeQuery('zzz');
    await wait(SEARCH_DEBOUNCE_MS);
    expect(shows(noResultsText('zzz'))).toBe(true);
    expect(shows('No results for “zzz”.')).toBe(true);
    expect(screen.queryAllByRole('button', { name: 'Load more' })).toHaveLength(0);
  });

  it('never lets an older search answering late replace a newer one', async () => {
    const gate = heldSearches();
    serveHousehold({ search: gate.search });
    await openSearch();
    await typeQuery('first');
    await wait(SEARCH_DEBOUNCE_MS);
    await typeQuery('second');
    await submitQuery();
    await gate.release('second@1');
    await gate.release('first@1');
    expect(made()).toEqual(['first@1', 'second@1']);
    expect(resultNames()[0]).toBe('second 1, 2010, Movie, Available to get');
    // The older call was aborted when the newer one went out.
    const first = gateway.calls.find((call) => call.url.includes('q=first'))!;
    expect(first.init.signal.aborted).toBe(true);
  });
});

describe('Load more', () => {
  it('adds the next page under the results, says Loading… (disabled) while it comes, and goes once there is no next page', async () => {
    const gate = heldSearches();
    serveHousehold({ search: gate.search });
    await openSearch();
    await typeQuery('dune');
    await submitQuery();
    await gate.release('dune@1');
    await pressNode(buttonNamed('Load more'));
    const loading = buttonNamed('Loading…');
    expect(String(loading.props.accessibilityState?.disabled)).toBe('true');
    await pressNode(loading);
    expect(made()).toEqual(['dune@1', 'dune@2']);
    await gate.release('dune@2');
    expect(resultNames()).toHaveLength(40);
    expect(resultNames()[20]).toBe('dune 21, 2010, Movie, Available to get');
    await pressNode(buttonNamed('Load more'));
    await gate.release('dune@3');
    expect(resultNames()).toHaveLength(60);
    expect(screen.queryAllByRole('button', { name: /^(Load more|Loading…)$/ })).toHaveLength(0);
    expect(made()).toEqual(['dune@1', 'dune@2', 'dune@3']);
  });

  it('drops a page asked for under a search the member has since replaced', async () => {
    const gate = heldSearches();
    serveHousehold({ search: gate.search });
    await openSearch();
    await typeQuery('dune');
    await submitQuery();
    await gate.release('dune@1');
    await pressNode(buttonNamed('Load more'));
    await typeQuery('arrival');
    await submitQuery();
    await gate.release('arrival@1');
    await gate.release('dune@2');
    expect(resultNames()).toHaveLength(20);
    expect(resultNames()[0]).toBe('arrival 1, 2010, Movie, Available to get');
  });
});

describe('failures', () => {
  it.each([
    ['429', () => answer(429, { error: 'too_many_requests' }), 'Too many requests', 'Wait a minute, then try again.'],
    ['502', () => answer(502, { error: 'unavailable' }), "Can't load this right now", 'Something went wrong. Try again in a moment.'],
    ['no connection', offline, "You're offline", 'Check your connection, then try again.'],
    ['an answer of the wrong shape', () => answer(200, { results: 'canary' }), "Can't load this right now", 'Something went wrong. Try again in a moment.'],
  ] as const)('shows the fixed words for %s, with Try again for that search, and never asks again by itself', async (_what, respond, title, body) => {
    let fail = true;
    serveHousehold({ search: (q, page, call) => (fail ? respond(call) : answer(200, searchAnswer(q, page))) });
    await openSearch();
    await typeQuery('dune');
    await submitQuery();
    expect([shows(title), shows(body)]).toEqual([true, true]);
    expect(shows(/canary/)).toBe(false);
    await wait(10 * 60_000);
    expect(made()).toEqual(['dune@1']);
    fail = false;
    await pressNode(buttonNamed('Try again'));
    expect(made()).toEqual(['dune@1', 'dune@1']);
    expect(resultNames()).toHaveLength(20);
    expect(shows(title)).toBe(false);
  });

  it('keeps the results when Load more fails, and Try again asks for that page alone', async () => {
    let fail = true;
    serveHousehold({ search: (q, page) => (page === 2 && fail ? answer(502, { error: 'unavailable' }) : answer(200, searchAnswer(q, page))) });
    await openSearch();
    await typeQuery('dune');
    await submitQuery();
    await pressNode(buttonNamed('Load more'));
    expect(resultNames()).toHaveLength(20);
    expect(shows("Can't load this right now")).toBe(true);
    expect(screen.queryAllByRole('button', { name: 'Load more' })).toHaveLength(0);
    fail = false;
    await pressNode(buttonNamed('Try again'));
    expect(made()).toEqual(['dune@1', 'dune@2', 'dune@2']);
    expect(resultNames()).toHaveLength(40);
  });

  it('signs the member out on a 401, back to the profile picker, and forgets the sign-in', async () => {
    serveHousehold({ search: () => answer(401, { error: 'unauthorized' }) });
    const app = await openSearch();
    await typeQuery('dune');
    await submitQuery();
    expect(storedSession()).toBeUndefined();
    expect(app.getPathname()).toBe('/');
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});

describe('a result', () => {
  it('opens its title on the Search tab\'s own stack, and Back comes back to the results as they were', async () => {
    const app = await openSearch();
    await typeQuery('dune');
    await submitQuery();
    await pressNode(only(screen.queryAllByRole('link', { name: 'dune 2, 2011, Series, Ready to watch' }), 'card'));
    expect(app.getPathname()).toBe('/search/tv/3002');
    expect(tabSelected()).toEqual(['Search']);
    // Its seasons open on the same stack.
    await pressNode(only(screen.queryAllByRole('link', { name: /^Season 1/ }), 'season'));
    expect(app.getPathname()).toBe('/search/tv/3002/season/1');
    await pressNode(buttonNamed('Back'));
    await pressNode(buttonNamed('Back'));
    expect(app.getPathname()).toBe('/search');
    expect(resultNames()).toHaveLength(20);
    expect(made()).toEqual(['dune@1']);
  });

  it('shows Requested right after Get this on its title page, with no call, and the server\'s state once it is read again', async () => {
    let server: 'get_this' | 'in_library' = 'get_this';
    serveHousehold({ override: (call) => (call.route === `GET ${API}/tv/3006` ? answer(200, seriesAnswer(3006, [server])) : undefined) });
    await openSearch();
    await typeQuery('dune');
    await submitQuery();
    const card = (state: string) => screen.queryAllByRole('link', { name: `dune 6, 2015, Series, ${state}` });
    expect(card('Ready to watch')).toHaveLength(1);
    await pressNode(card('Ready to watch')[0]!);
    expect(spokenStatus()).toEqual(['Available to get']);
    await pressNode(checkboxNamed('Season 1'));
    await pressNode(buttonNamed('Get this: Series 3006'));
    const before = gateway.calls.length;
    await pressNode(buttonNamed('Back'));
    // The title page's answer (get_this) is fresher than the search's, and the overlay says Requested over it.
    expect(card('Requested')).toHaveLength(1);
    expect(gateway.calls.length).toBe(before);

    // Read again later: the server's own state, fresher than the search's page, wins.
    server = 'in_library';
    await pressNode(card('Requested')[0]!);
    await pressNode(buttonNamed('Back'));
    expect(card('Ready to watch')).toHaveLength(1);
  });
});

describe('layout', () => {
  const posterWidths = () =>
    screen.queryAllByTestId('search-grid').length
      ? only(screen.queryAllByTestId('search-grid'), 'grid')
          .props.children.map((child: { props: { width: number } }) => child.props.width)
          .slice(0, 1)
      : [];
  const columnsOf = (width: number, cardWidth: number) => {
    const inner = Math.min(width, layout.maxContentWidth) - 32;
    return Math.round((inner + 9.6) / (cardWidth + 9.6));
  };

  it.each([
    ['a phone', 390, 3],
    ['a very narrow phone', NARROW_WIDTH - 16, 2],
    ['an iPad upright', 768, 4],
    ['an iPad on its side', 1366, 6],
  ] as const)('lays the posters out in columns on %s', async (_what, width, columns) => {
    mockWindow = { ...PHONE, width };
    await openSearch();
    await typeQuery('dune');
    await submitQuery();
    const [cardWidth] = posterWidths() as number[];
    expect(columnsOf(width, cardWidth!)).toBe(columns);
    // On an iPad the column stops widening at the PWA's 72rem.
    expect(flat(only(screen.queryAllByTestId('screen-column'), 'column')).maxWidth).toBe(layout.maxContentWidth);
  });
});

describe('accessibility', () => {
  it('names the field once, and every pressable on the results is named and a thumb\'s size', async () => {
    await openSearch();
    expect(screen.queryAllByLabelText('Search movies and series')).toHaveLength(1);
    await typeQuery('dune');
    await submitQuery();
    const pressables = [...screen.queryAllByRole('link', { name: /^dune / }), buttonNamed('Load more')];
    expect(pressables).toHaveLength(21);
    for (const node of pressables) {
      const name = String(node.props.accessibilityLabel ?? [node.props.children].flat().join(''));
      const height = StyleSheet.flatten(node.props.style)?.minHeight;
      expect({ name, height: typeof height === 'number' && height >= layout.touchTarget }).toEqual({ name, height: true });
    }
    // The status chip on each card is said in the card's name, not again.
    expect(screen.queryAllByTestId('status-chip').filter((chip) => chip.props.accessibilityLabel)).toHaveLength(0);
  });

  it('keeps everything the results show out of the device\'s storage', async () => {
    await openSearch();
    await typeQuery('dune');
    await submitQuery();
    expect(store.setItemAsync.mock.calls.map(([key]) => String(key))).toEqual([]);
  });
});
