// Search's and My requests' calls against the server's pinned fetch budget (docs/app-api/fetch-budget.json, read from
// the repo, not copied): the real app through the router, signed in, with a fake gateway. A search makes exactly the
// call the PWA makes for Search opened on a query (the start-up /me counted as the PWA's own), however fast the member
// types, and My requests makes the PWA's calls for the same household: the list, then one title call for each request
// shown, at most titlesAtOnce before the member asks for more. Nothing is polled or retried while either is open. A
// change that makes either chattier fails here until the budget file (and the PWA) changes with it.
import { act } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';

import type { FetchLike } from '../src/api/client';
import { SEARCH_DEBOUNCE_MS } from '../src/search/text';
import { BUDGET } from './support/app-api';
import { budgetRoute } from './support/home';
import { ORIGIN, TOKEN, keepSession, settle, store, type Call } from './support/household';
import { requestEntry, searchGateway, submitQuery, typeQuery, wait, type SearchHousehold } from './support/search';

jest.setTimeout(30_000);

let mockFetch: FetchLike;
jest.mock('../src/api/transport', () => ({
  ...jest.requireActual('../src/api/transport'),
  householdFetch: (url: string, init: never) => mockFetch(url, init),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: jest.requireActual('../app.config').default } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);

let gateway: ReturnType<typeof searchGateway>;

function useHousehold(household: SearchHousehold = {}) {
  gateway = searchGateway(household);
  mockFetch = gateway.fetch;
}

beforeEach(() => {
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
});

/** A call as the budget writes it: the title's ID and the query as their placeholders, the query string kept. */
const templated = (call: Call) =>
  budgetRoute(`${call.init.method} ${call.url.replace(/^https:\/\/[^/]+/, '')}`)
    .replace(/^(GET \/search)\?q=[^&]*&/, '$1?q={query}&')
    .replace(/\/(movie|tv)\/\d+$/, '/$1/{tmdbId}');
const sorted = (routes: readonly string[]) => [...routes].sort();

/** Opens `tab` from Home; `since()` is every call made from then on, as the budget writes it. */
async function open(tab: '/search' | '/requests') {
  await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  const before = gateway.calls.length;
  await act(async () => router.navigate(tab));
  await settle();
  return { since: () => gateway.calls.slice(before).map(templated) };
}

describe('Search', () => {
  const budget = BUDGET.screens['search']!;

  it('is pinned in the budget file with no lazy calls', () => {
    expect({ total: budget.atOnce.length, lazy: budget.belowTheFold ?? [] }).toEqual({ total: budget.calls, lazy: [] });
  });

  it("asks for exactly the budget's call for one query, however it is typed, and nothing more while it is open", async () => {
    useHousehold();
    const { since } = await open('/search');
    expect(since()).toEqual([]);
    for (const text of ['d', 'du', 'dun', 'dune']) {
      await typeQuery(text);
      await wait(SEARCH_DEBOUNCE_MS / 3);
    }
    await wait(SEARCH_DEBOUNCE_MS);
    // The member was asked for when the app started: the PWA asks again on each screen, the app once.
    expect(sorted(['GET /me', ...since()])).toEqual(sorted(budget.atOnce));
    await wait(10 * 60_000);
    expect(since()).toHaveLength(budget.calls - 1);
  });

  it('makes one call on the Search key, not another when the pause after typing ends', async () => {
    useHousehold();
    const { since } = await open('/search');
    await typeQuery('dune');
    await submitQuery();
    await wait(SEARCH_DEBOUNCE_MS * 2);
    expect(sorted(['GET /me', ...since()])).toEqual(sorted(budget.atOnce));
  });
});

describe('My requests', () => {
  const budget = BUDGET.screens['requests']! as (typeof BUDGET.screens)[string] & { titlesAtOnce: number };

  it('is pinned in the budget file with no lazy calls, naming ten at once', () => {
    expect({ total: budget.atOnce.length, lazy: budget.belowTheFold ?? [], titles: budget.titlesAtOnce }).toEqual({ total: budget.calls, lazy: [], titles: 10 });
  });

  it("asks for exactly the budget's calls for one film and one series request, each once, and nothing more while it is open", async () => {
    useHousehold({ requests: { results: [requestEntry('m', 'movie', 7, 'requested'), requestEntry('s', 'tv', 9, 'ready', { seasons: [{ seasonNumber: 1, status: 'ready' }] })] } });
    const { since } = await open('/requests');
    expect(sorted(['GET /me', ...since()])).toEqual(sorted(budget.atOnce));
    await wait(10 * 60_000);
    expect(since()).toHaveLength(budget.calls - 1);
  });

  it('names at most titlesAtOnce requests until the member asks for more', async () => {
    useHousehold({ requests: { results: Array.from({ length: 25 }, (_, index) => requestEntry(`r${index}`, 'movie', 100 + index, 'requested')) } });
    const { since } = await open('/requests');
    await wait(10 * 60_000);
    expect(since().filter((route) => route === 'GET /movie/{tmdbId}')).toHaveLength(budget.titlesAtOnce);
    expect(since()).toHaveLength(1 + budget.titlesAtOnce);
  });
});
