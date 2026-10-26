// Home's calls against the server's pinned fetch budget (docs/app-api/fetch-budget.json, read from the repo, not
// copied): the real app through the router, signed in, with a fake gateway. When Home opens, each filter makes exactly
// the calls the PWA makes at once (the start-up /me included), nothing below the fold is asked for until it comes near
// the screen, and scrolling to the end in one go adds exactly the budget's lazy calls, each once. A change that makes
// Home chattier fails here until the budget file (and the PWA) changes with it. Lazy rows load in order, one per scroll
// event that takes the screen further down: rows that come back short (empty, failed or a single title) on a tall iPad
// load only the lazy rows on screen at rest, once, then one more per step down, however often Home is laid out. Any
// scrolling moves Home on (a screen reader's scroll action or a mouse wheel sends no drag), but not the offset left
// from the filter before, the app's own scroll back to the first row, nor a glide from before the switch.
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
  scrollEnd,
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
    // A screen down in one step: the next row, never everything.
    await scrollTo(PHONE_SCREEN.height);
    expect(since().filter((route) => below.includes(route)).length).toBe(1);

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

  it.each(SHORT)('with every row %s: loads the lazy rows on screen at rest once, never those pulled up after, then one per step down', async (kind, respond) => {
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

    // Half a screen down in one step: the next row and no other, however often Home is laid out after it.
    await scrollTo(IPAD_SCREEN.height / 2);
    expect(lazy(since()).length).toBe(atRest.length + 1);
    await layOut(IPAD_SCREEN);
    await layOut(IPAD_SCREEN);
    expect(lazy(since()).length).toBe(atRest.length + 1);

    await scrollToEnd();
    const calls = counted(since());
    expect(sorted(calls)).toEqual(sorted([...budget.atOnce, ...below]));
    expect(calls.length).toBe(budget.calls);
  });
});

describe.each(FILTERS)('Home under %s scrolled with no drag (a screen reader, a mouse wheel)', (filter, name) => {
  const below = BUDGET.screens[name]!.belowTheFold ?? [];

  it('loads the lazy rows in order, at most one per scroll event, all of them by the end', async () => {
    await start();
    const before = filter === 'All' ? 0 : made().length;
    if (filter !== 'All') await choose(filter);
    const lazy = () => made().slice(before).filter((route) => below.includes(route));
    await layOut();

    // A step down at a time, laid out after each, and no drag or glide around them; twice, from the top again.
    const steps: { added: number; end: boolean }[] = [];
    for (let round = 0; round < 2; round += 1) {
      for (let y = 100; ; y += 100) {
        const was = lazy().length;
        const at = Math.min(y, scrollEnd());
        const end = at >= scrollEnd();
        await scrollEvent('scroll', at);
        steps.push({ added: lazy().length - was, end });
        await layOut();
        if (end && at <= scrollEnd()) break;
      }
      await scrollEvent('scroll', 0);
    }
    // One row a step, except where the screen can go no further: there, every row left on screen.
    expect(Math.max(...steps.filter((step) => !step.end).map((step) => step.added))).toBe(1);
    expect(sorted(lazy())).toEqual(sorted(below));
  });
});

describe.each(FILTERS)('Home under %s on a tall iPad with every row empty, scrolled to the end once', (filter, name) => {
  const below = BUDGET.screens[name]!.belowTheFold ?? [];

  it('loads one row per step down, then every row left on screen where it can go no further', async () => {
    mockWindow = IPAD;
    gateway = homeGateway(homeHousehold(SHORT[0]![1]));
    mockFetch = gateway.fetch;
    await start();
    const before = filter === 'All' ? 0 : made().length;
    if (filter !== 'All') await choose(filter);
    const lazy = () => made().slice(before).filter((route) => below.includes(route));
    await layOut(IPAD_SCREEN);

    // One scroll from the top to the end, a step at a time, laid out after each: the rows shrink as they answer and
    // the end keeps moving up, but nothing is left waiting there.
    const steps: { added: number; end: boolean }[] = [];
    for (let y = 100; ; y += 100) {
      const was = lazy().length;
      const at = Math.min(y, scrollEnd());
      const end = at >= scrollEnd();
      await scrollEvent('scroll', at);
      steps.push({ added: lazy().length - was, end });
      await layOut(IPAD_SCREEN);
      // Done once it is at the end; if rows shrank under it, the scroll view goes up to the new end itself, next.
      if (end && at <= scrollEnd()) break;
    }
    expect(Math.max(...steps.filter((step) => !step.end).map((step) => step.added))).toBe(1);
    expect(sorted(lazy())).toEqual(sorted(below));
  });

});

describe('Home under All on a tall iPad with every row empty, scrolled back up', () => {
  const below = BUDGET.screens['home-all']!.belowTheFold ?? [];

  it('loads the next row when the member goes back up and comes down again, short of where the last one was asked for', async () => {
    mockWindow = IPAD;
    gateway = homeGateway(homeHousehold(SHORT[0]![1]));
    mockFetch = gateway.fetch;
    await start();
    const lazy = () => made().filter((route) => below.includes(route));
    await layOut(IPAD_SCREEN);

    // Two big steps down, a row each; laid out again, the rows they shrank leave others on screen, not asked for.
    await scrollEvent('scroll', 300, 600);
    await layOut(IPAD_SCREEN);
    const down = lazy().length;
    expect(scrollEnd()).toBeGreaterThan(600);
    expect(down).toBeLessThan(below.length);

    // Up a little, then down again, not as far: the screen has moved down, so the next row is asked for.
    await scrollEvent('scroll', 400);
    expect(lazy().length).toBe(down);
    await scrollEvent('scroll', 500);
    expect(lazy().length).toBe(down + 1);
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

    // A step down TV, with no drag (a screen reader's scroll action), loads its next row; laid out again, no more.
    await scrollEvent('scroll', PHONE_SCREEN.height);
    await layOut();
    await layOut();
    expect(lazyTv().length).toBe(1);
    await scrollToEnd();
    expect(sorted(lazyTv())).toEqual(sorted(tvBelow));
  });

  it('ignores a glide set off under All that carries on after TV is chosen, until the screen moves on in TV', async () => {
    await start();
    await layOut();
    await drag(0, PHONE_SCREEN.height);
    await scrollEvent('momentumScrollBegin', PHONE_SCREEN.height);
    const before = made().length;
    const lazyTv = () => made().slice(before).filter((route) => tvBelow.includes(route));

    await choose('TV');
    await layOut();
    // The old glide runs on far down the page and stops; then the app's jump back to the first row lands.
    await scrollEvent('scroll', 1600, 2400, 4000);
    await scrollEvent('momentumScrollEnd', 4000);
    await layOut();
    expect(lazyTv()).toEqual([]);
    await scrollEvent('scroll', 0);
    await layOut();
    await layOut();
    expect(lazyTv()).toEqual([]);

    // Moving on in TV, by any means: one row per step down, then a glide that carries on, one more per step.
    await scrollEvent('scroll', PHONE_SCREEN.height / 2);
    await layOut();
    expect(lazyTv().length).toBe(1);
    await drag(PHONE_SCREEN.height / 2, PHONE_SCREEN.height);
    await glide(PHONE_SCREEN.height, PHONE_SCREEN.height + 100);
    await layOut();
    expect(lazyTv().length).toBe(3);
  });
});
