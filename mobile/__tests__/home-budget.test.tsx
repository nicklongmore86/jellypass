// Home's calls against the server's pinned fetch budget (docs/app-api/fetch-budget.json, read from the repo, not
// copied): the real app through the router, signed in, with a fake gateway. When Home opens, each filter makes exactly
// the calls the PWA makes at once (the start-up /me included), nothing below the fold is asked for until it comes near
// the screen, and scrolling to the end adds exactly the budget's lazy calls, each once. A change that makes Home
// chattier fails here until the budget file (and the PWA) changes with it. Rows that come back short (empty, failed
// or a single title) on a tall iPad load only the lazy rows on screen at rest, once: the rows they pull up after that
// wait for the member to drag. Only the member's own drag (and its glide) in the filter on screen moves Home on: not
// the offset left from the filter before, nor the app's own scroll back to the first row, nor a glide from before.
import { renderRouter } from 'expo-router/testing-library';

import type { FetchLike } from '../src/api/client';
import { BUDGET } from './support/app-api';
import {
  budgetRoute,
  choose,
  drag,
  glide,
  homeGateway,
  homeHousehold,
  layOut,
  listOf,
  pageAnswer,
  PHONE_SCREEN,
  scrollEvent,
  scrollTo,
  scrollToEnd,
  skeletonsOnScreen,
  type ScreenSize,
} from './support/home';
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
  const lazy = (since: readonly string[]) => since.filter((route) => below.includes(route));

  it.each(SHORT)('with every row %s: loads the lazy rows on screen at rest once, never those pulled up after, then more as the member drags', async (kind, respond) => {
    mockWindow = IPAD;
    gateway = homeGateway(homeHousehold(respond));
    mockFetch = gateway.fetch;
    await start();
    const before = filter === 'All' ? 0 : made().length;
    if (filter !== 'All') await choose(filter);
    const since = () => made().slice(before);

    // The first layout: exactly the lazy rows it shows on screen are asked for, each once, within the budget.
    await layOut(IPAD_SCREEN);
    const onScreen = skeletonsOnScreen('first');
    const atRest = lazy(since());
    expect(atRest.length).toBe(onScreen.length);
    expect(new Set(atRest).size).toBe(atRest.length);
    if (kind !== 'a single title') expect(onScreen.length).toBeGreaterThanOrEqual(1);
    expect(since().filter((route) => !below.includes(route) && !budget.atOnce.includes(route))).toEqual([]);

    // Those come back short too and pull more rows on screen, laid out again and again: none of them is asked for.
    await layOut(IPAD_SCREEN);
    await layOut(IPAD_SCREEN);
    if (kind !== 'a single title') expect(skeletonsOnScreen('last').length).toBeGreaterThanOrEqual(1);
    expect(lazy(since()).length).toBe(atRest.length);

    // The member drags a little way: more rows, still each once and from the budget.
    await scrollTo(IPAD_SCREEN.height / 2);
    expect(lazy(since()).length).toBeGreaterThan(atRest.length);

    await scrollToEnd();
    const calls = counted(since());
    expect(sorted(calls)).toEqual(sorted([...budget.atOnce, ...below]));
    expect(calls.length).toBe(budget.calls);
  });
});

describe('Home after the filter changes', () => {
  const tv = BUDGET.screens['home-tv']!;
  const tvBelow = tv.belowTheFold ?? [];

  /** Opens Home under All down to its last services, as the member left it. */
  async function deepUnderAll() {
    await start();
    await scrollToEnd();
    await scrollTo(6000);
    const before = made().length;
    return () => made().slice(before).filter((route) => tvBelow.includes(route));
  }

  it("starts TV at its first row: the old offset and the app's own scroll back, landing late, load nothing", async () => {
    const lazyTv = await deepUnderAll();
    await choose('TV');
    // The jump back to the first row lands after the switch: the scroll view still says where All was left, first.
    await scrollEvent('scroll', 6000, 5800, 0);
    await layOut();
    await layOut();
    expect(lazyTv()).toEqual([]);

    // The member's own drag down TV loads its rows a few at a time.
    await drag(0, PHONE_SCREEN.height);
    await layOut();
    expect(lazyTv().length).toBeGreaterThanOrEqual(1);
    expect(lazyTv().length).toBeLessThanOrEqual(2);
    await scrollToEnd();
    expect(sorted(lazyTv())).toEqual(sorted(tvBelow));
  });

  it('ignores a glide set off under All that carries on after TV is chosen, and one the member did not start', async () => {
    await start();
    await layOut();
    await drag(0, PHONE_SCREEN.height);
    await scrollEvent('momentumScrollBegin', PHONE_SCREEN.height);
    const before = made().length;
    const lazyTv = () => made().slice(before).filter((route) => tvBelow.includes(route));

    await choose('TV');
    await layOut();
    // The old glide runs on far down the page and stops.
    await scrollEvent('scroll', 1600, 2400, 4000);
    await scrollEvent('momentumScrollEnd', 4000);
    // A glide with no drag of the member's before it in TV: the app's own scrolling.
    await glide(0, 3000, 5000);
    await layOut();
    expect(lazyTv()).toEqual([]);

    // A drag in TV, and the glide it sets off, load as far as they go: a few rows, not all of them.
    await drag(0, PHONE_SCREEN.height / 2);
    await glide(PHONE_SCREEN.height / 2, PHONE_SCREEN.height);
    await layOut();
    expect(lazyTv().length).toBeGreaterThanOrEqual(1);
    expect(lazyTv().length).toBeLessThan(tvBelow.length);
  });
});
