// The title pages' calls against the server's pinned fetch budget (docs/app-api/fetch-budget.json, read from the repo,
// not copied): the real app through the router, signed in, with a fake gateway. Opening a movie, a series or a season
// makes exactly the calls the PWA makes for that screen (the start-up /me counted as the PWA's own), each once, and
// nothing more while it is open: nothing is polled or retried. A change that makes a title page chattier fails here
// until the budget file (and the PWA) changes with it.
import { act } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';

import type { FetchLike } from '../src/api/client';
import { BUDGET } from './support/app-api';
import { budgetRoute } from './support/home';
import { ORIGIN, TOKEN, keepSession, settle, store } from './support/household';
import { titleGateway } from './support/title';

jest.setTimeout(30_000);

let mockFetch: FetchLike;
jest.mock('../src/api/transport', () => ({
  ...jest.requireActual('../src/api/transport'),
  householdFetch: (url: string, init: never) => mockFetch(url, init),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: jest.requireActual('../app.config').default } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);

let gateway: ReturnType<typeof titleGateway>;

beforeEach(() => {
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  gateway = titleGateway();
  mockFetch = gateway.fetch;
});

const sorted = (routes: readonly string[]) => [...routes].sort();
/** A call as the budget writes it, with the title's ID and season as its placeholders. */
const templated = (route: string) => budgetRoute(route).replace(/\/(movie|tv)\/\d+/, '/$1/{tmdbId}').replace(/\/season\/\d+$/, '/season/{n}');

const SCREENS = [
  ['movie', '/home/movie/7'],
  ['series', '/home/tv/9'],
  ['season', '/home/tv/9/season/2'],
] as const;

describe.each(SCREENS)('the %s page', (name, path) => {
  const budget = BUDGET.screens[name]!;

  it('is pinned in the budget file with no lazy calls', () => {
    expect({ total: budget.atOnce.length, lazy: budget.belowTheFold ?? [] }).toEqual({ total: budget.calls, lazy: [] });
  });

  it("asks on opening for exactly the budget's calls, each once, and nothing more while it is open", async () => {
    await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
    await settle();
    const before = gateway.routes().length;
    await act(async () => router.push(path));
    await settle();
    // The member was asked for when the app started: the PWA asks again on each screen, the app once.
    const made = ['GET /me', ...gateway.routes().slice(before).map(templated)];
    expect(sorted(made)).toEqual(sorted(budget.atOnce));
    await act(async () => {
      jest.advanceTimersByTime(10 * 60_000);
    });
    await settle();
    expect(gateway.routes().length - before).toBe(budget.calls - 1);
  });
});
