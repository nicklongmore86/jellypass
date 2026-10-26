// Home's calls against the server's pinned fetch budget (docs/app-api/fetch-budget.json, read from the repo, not
// copied): the real app through the router, signed in, with a fake gateway. When Home opens, each filter makes exactly
// the calls the PWA makes at once (the start-up /me included), nothing below the fold is asked for until it comes near
// the screen, and scrolling to the end adds exactly the budget's lazy calls, each once. A change that makes Home
// chattier fails here until the budget file (and the PWA) changes with it. Rows that come back short (empty, failed
// or a single title) on a tall iPad must not pull the rows under them near the screen: only the member scrolling does.
import { renderRouter } from 'expo-router/testing-library';

import type { FetchLike } from '../src/api/client';
import { BUDGET } from './support/app-api';
import { budgetRoute, choose, homeGateway, homeHousehold, layOut, listOf, pageAnswer, PHONE_SCREEN, scrollTo, scrollToEnd, type ScreenSize } from './support/home';
import { ORIGIN, TOKEN, answer, keepSession, settle, store, type Call } from './support/household';

let mockFetch: FetchLike;
jest.mock('../src/api/transport', () => ({
  ...jest.requireActual('../src/api/transport'),
  householdFetch: (url: string, init: never) => mockFetch(url, init),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: jest.requireActual('../app.config').default } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);

const PHONE = { width: 390, height: 844, scale: 2, fontScale: 1 };
/** A 12.9-inch iPad upright: the tallest screen Home is laid out on. */
const IPAD = { width: 1024, height: 1366, scale: 2, fontScale: 1 };
const IPAD_SCREEN: ScreenSize = { width: 1024, height: 1366 };
let mockWindow = PHONE;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow }));

let gateway: ReturnType<typeof homeGateway>;

beforeEach(() => {
  mockWindow = PHONE;
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  gateway = homeGateway(homeHousehold());
  mockFetch = gateway.fetch;
});

async function start() {
  await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
}

const made = () => gateway.routes().map(budgetRoute);
const sorted = (routes: readonly string[]) => [...routes].sort();

const FILTERS = [
  ['All', 'home-all'],
  ['Movies', 'home-movies'],
  ['TV', 'home-tv'],
] as const;

describe('the fetch budget file', () => {
  it('pins the three Home filters this test checks', () => {
    for (const [, name] of FILTERS) {
      const screen = BUDGET.screens[name]!;
      expect({ name, total: screen.atOnce.length + (screen.belowTheFold ?? []).length }).toEqual({ name, total: screen.calls });
    }
  });
});

describe.each(FILTERS)("Home under %s", (filter, name) => {
  const budget = BUDGET.screens[name]!;
  const below = budget.belowTheFold ?? [];

  /** Opens Home and shows `filter`; `since()` is what has been asked for since the filter was chosen (all, for All). */
  async function open() {
    await start();
    const before = filter === 'All' ? 0 : made().length;
    if (filter !== 'All') await choose(filter);
    return { since: () => made().slice(before) };
  }

  /** The filter's calls as the budget counts them: the member and the services were asked for when Home opened. */
  const counted = (since: readonly string[]) => (filter === 'All' ? [...since] : ['GET /me', 'GET /discover/sources', ...since]);

  it("asks at once for exactly the budget's first calls, and no more", async () => {
    const { since } = await open();
    expect(sorted(counted(since()))).toEqual(sorted(budget.atOnce));
  });

  it('asks for nothing below the fold until it nears the screen, even once laid out', async () => {
    const { since } = await open();
    await layOut();
    expect(sorted(counted(since()))).toEqual(sorted(budget.atOnce));
  });

  it("asks for the budget's lazy calls a few at a time as they near the screen, each once and no others", async () => {
    const { since } = await open();
    await layOut();
    // A screen down: the next row or two, never everything.
    await scrollTo(PHONE_SCREEN.height);
    const first = since().filter((route) => below.includes(route)).length;
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(2);

    await scrollToEnd();
    await scrollTo(0);
    await scrollToEnd();
    const calls = counted(since());
    expect(sorted(calls)).toEqual(sorted([...budget.atOnce, ...below]));
    expect(calls.length).toBe(budget.calls);
  });
});

/** Every list answering short, as a row can: nothing in it, a failure, or a single title. */
const SHORT: [string, (call: Call) => ReturnType<typeof answer> | undefined][] = [
  ['empty', (call) => (listOf(call.route) ? answer(200, pageAnswer(listOf(call.route)!, 0)) : undefined)],
  ['failing', (call) => (listOf(call.route) ? answer(502, { error: 'unavailable' }) : undefined)],
  ['a single title', (call) => (listOf(call.route) ? answer(200, pageAnswer(listOf(call.route)!, 1)) : undefined)],
];

describe.each(FILTERS)('Home under %s on a tall iPad', (filter, name) => {
  const budget = BUDGET.screens[name]!;
  const below = budget.belowTheFold ?? [];
  const counted = (since: readonly string[]) => (filter === 'All' ? [...since] : ['GET /me', 'GET /discover/sources', ...since]);

  it.each(SHORT)('with every row %s: asks for no lazy row until the member scrolls, then a screen at a time', async (_, respond) => {
    mockWindow = IPAD;
    gateway = homeGateway(homeHousehold(respond));
    mockFetch = gateway.fetch;
    await start();
    const before = filter === 'All' ? 0 : made().length;
    if (filter !== 'All') await choose(filter);
    const since = () => made().slice(before);

    // Laid out, and again as each short row settles: still only the first calls.
    await layOut(IPAD_SCREEN);
    await layOut(IPAD_SCREEN);
    expect(sorted(counted(since()))).toEqual(sorted(budget.atOnce));

    await scrollTo(IPAD_SCREEN.height);
    const first = since().filter((route) => below.includes(route)).length;
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThan(below.length);

    await scrollToEnd();
    const calls = counted(since());
    expect(sorted(calls)).toEqual(sorted([...budget.atOnce, ...below]));
    expect(calls.length).toBe(budget.calls);
  });
});
