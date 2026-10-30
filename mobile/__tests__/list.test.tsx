// The Discover rows' See all pages through the real router, signed in, with a fake gateway: each list row's link by its
// heading (named "See all <heading>", after the heading in the reading order) under All, Movies and TV, opening the
// row's own list on Home's stack with the row's titles and no call; the filter and New only kept as TV keeps them; Load
// more one page per press; a card's title on Home's stack and Back to the same grid; the page opened by its address
// (one call, the TV add-on's budget), and Not found for a list no row shows (no call). Failures, accessibility and
// layout are in list-states.test.tsx. Queries are queryAll* and assertions read single fields, so a failure never
// prints the component tree.
import { act, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';

import type { FetchLike } from '../src/api/client';
import { BUDGET } from './support/app-api';
import { API, choose, chosen, scrollToEnd, showAll } from './support/home';
import { listGateway } from './support/list';
import { ORIGIN, TOKEN, keepSession, settle, shows, store } from './support/household';
import { wait } from './support/search';
import { gridNames } from './support/source';
import { buttonNamed, headings, linkNamed, only, pressNode } from './support/title';

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

let gateway: ReturnType<typeof listGateway>;

function serveHousehold(...args: Parameters<typeof listGateway>) {
  gateway = listGateway(...args);
  mockFetch = gateway.fetch;
}

beforeEach(() => {
  mockWindow = PHONE;
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  serveHousehold();
});

/** Home with New only off (unless `hide`); scrolled to its end, every lazy row loaded, only with `scroll`. */
async function start({ hide = false, scroll = false } = {}) {
  const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  if (!hide) await showAll();
  if (scroll) await scrollToEnd();
  return app;
}

/** Every call from now on, as its address under the API (query kept). */
function since() {
  const before = gateway.calls.length;
  return () => gateway.calls.slice(before).map((call) => call.url.replace(/^https:\/\/[^/]+/, '').replace(API, ''));
}

/** Opens `path` on Home's stack, as a link would. */
async function open(path: string) {
  const app = await start();
  const calls = since();
  await act(async () => router.push(path, { withAnchor: true }));
  await settle();
  return { app, calls };
}

/** The card links of one of Home's rows, in order. */
function rowNames(list: string): string[] {
  const slot = only(screen.queryAllByTestId(`home-slot-row-${list}`), `row ${list}`);
  return within(slot)
    .queryAllByRole('link')
    .filter((node) => node.props.testID !== 'row-heading-link')
    .map((node) => String(node.props.accessibilityLabel));
}

const title = () => headings()[0];
const listChip = () => only(screen.queryAllByTestId('list-hide'), 'New only chip');
const homeChip = () => only(screen.queryAllByTestId('home-hide', { includeHiddenElements: true }), 'Home chip');

describe('from Home', () => {
  it.each([
    ['All', 'Trending', 'trending'],
    ['All', 'Popular movies', 'popular-movies'],
    ['All', 'Popular series', 'popular-tv'],
    ['All', 'New movie releases', 'new-movies'],
    ['All', 'Upcoming movies', 'upcoming'],
    ['All', 'Upcoming series', 'upcoming-tv'],
    ['Movies', 'Trending movies', 'trending-movies'],
    ['Movies', 'Upcoming movies', 'upcoming'],
    ['TV', 'Trending series', 'trending-tv'],
    ['TV', 'Upcoming series', 'upcoming-tv'],
  ] as const)('under %s, "See all %s" opens its list on Home\'s stack with the row\'s titles and no call', async (filter, heading, list) => {
    // Upcoming movies and series are lazy under All: loaded once Home has scrolled to them.
    const app = await start({ scroll: filter === 'All' && list.startsWith('upcoming') });
    if (filter !== 'All') await choose(filter);
    const row = rowNames(list);
    expect(row).toHaveLength(20);
    const calls = since();
    const link = linkNamed(`See all ${heading}`);
    expect([link.props.accessibilityRole, link.props.testID]).toEqual(['link', 'row-heading-link']);
    await pressNode(link);
    expect(app.getPathname()).toBe(`/home/list/${list}`);
    expect(title()).toBe(heading);
    // The grid is the row's own page, card for card (a poster's name, kind included, on every card).
    expect(gridNames()).toEqual(row.map((name) => (/, (Movie|Series), /.test(name) ? name : name.replace(/^([^,]+, \d+), /, `$1, ${list.endsWith('tv') ? 'Series' : 'Movie'}, `))));
    expect(calls()).toEqual([]);
  });

  it('gives every list row and every service row a See all link, after its heading in the reading order', async () => {
    await start({ scroll: true });
    const order = screen.queryAllByRole(/^(header|link)$/).map((node) => `${String(node.props.accessibilityRole)}: ${String(node.props.accessibilityLabel ?? [node.props.children].flat().join(''))}`);
    for (const heading of ['Trending', 'Popular movies', 'Popular series', 'New movie releases', 'Upcoming movies', 'Upcoming series', 'Popular on Netflix']) {
      const at = order.indexOf(`header: ${heading}`);
      expect({ heading, next: order[at + 1] }).toEqual({ heading, next: `link: See all ${heading}` });
    }
    // The studios' strip is not a list: its tiles are its links.
    expect(order.filter((item) => item.startsWith('link: See all '))).toHaveLength(6 + 8);
  });

  it("keeps Home's filter for Back, and New only is Home's own choice both ways", async () => {
    const app = await start({ hide: true });
    await choose('Movies');
    expect(homeChip().props.accessibilityState).toEqual({ checked: true });
    await pressNode(linkNamed('See all Trending movies'));
    expect(app.getPathname()).toBe('/home/list/trending-movies');
    expect(listChip().props.accessibilityState).toEqual({ checked: true });
    // New only: what the member has (In library, Requested) is left out, with no call.
    expect(gridNames().some((name) => /Ready to watch|Requested/.test(name))).toBe(false);
    expect(gridNames()).toHaveLength(10);
    const calls = since();
    await pressNode(listChip());
    expect(gridNames()).toHaveLength(20);
    expect(calls()).toEqual([]);
    await pressNode(buttonNamed('Back'));
    expect(app.getPathname()).toMatch(/^\/(home)?$/);
    expect(chosen()).toEqual(['Movies']);
    expect(homeChip().props.accessibilityState).toEqual({ checked: false });
    expect(calls()).toEqual([]);
  });

  it('asks for a row that has not answered yet by its address, once', async () => {
    const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
    await settle();
    // Upcoming movies is a lazy row, not asked for until it nears the screen: its link is not drawn yet.
    expect(screen.queryAllByRole('link', { name: 'See all Upcoming movies' })).toHaveLength(0);
    const calls = since();
    await act(async () => router.push('/home/list/upcoming', { withAnchor: true }));
    await settle();
    expect(app.getPathname()).toBe('/home/list/upcoming');
    expect(calls().filter((call) => call.startsWith('/discover/upcoming'))).toEqual(['/discover/upcoming']);
  });
});

describe('the grid', () => {
  it('asks for one page per Load more, opens a card on Home\'s stack, and Back comes to the same grid with no call', async () => {
    const app = await start();
    await pressNode(linkNamed('See all Trending'));
    const calls = since();
    await pressNode(buttonNamed('Load more'));
    expect(calls()).toEqual(['/discover/trending?page=2']);
    expect(gridNames()).toHaveLength(40);
    await pressNode(linkNamed(/^trending 22, /));
    expect(app.getPathname()).toBe('/home/tv/1022');
    await pressNode(buttonNamed('Back'));
    expect(app.getPathname()).toBe('/home/list/trending');
    expect(gridNames()).toHaveLength(40);
    expect(calls().filter((call) => call.startsWith('/discover/'))).toEqual(['/discover/trending?page=2']);
    await pressNode(buttonNamed('Load more'));
    expect(gridNames()).toHaveLength(60);
    // The last page: no Load more.
    expect(screen.queryAllByRole('button', { name: 'Load more' })).toHaveLength(0);
    await act(async () => router.back());
    await settle();
    expect(app.getPathname()).toMatch(/^\/(home)?$/);
  });

  it('opened by its address, asks for its first page alone (nothing to look up), and nothing more while open', async () => {
    const { app, calls } = await open('/home/list/popular-tv');
    expect(app.getPathname()).toBe('/home/list/popular-tv');
    expect(title()).toBe('Popular series');
    expect(calls()).toEqual(['/discover/popular-tv']);
    expect(gridNames()[0]).toBe('popular-tv 1, 2020, Series, TMDB rating 6.0 out of 10, Ready to watch');
    await wait(10 * 60_000);
    expect(calls()).toEqual(['/discover/popular-tv']);
  });

  it('makes the same calls as the TV add-on\'s list page (fetch-budget.json, tv-discover-list)', async () => {
    const budget = BUDGET.screens['tv-discover-list']!;
    const { calls } = await open('/home/list/new-movies');
    const templated = () => calls().map((call) => `GET ${call.replace('/new-movies', '/{list}')}`);
    expect(templated()).toEqual(budget.atOnce);
    await pressNode(buttonNamed('Load more'));
    expect(templated().slice(budget.atOnce.length)).toEqual((budget as { loadMore?: string[] }).loadMore);
  });

  it.each(['/home/list/top-movies', '/home/list/top-tv', '/home/list/sources', '/home/list/Trending', '/home/list/nope'])('is Not found for %s, with no call', async (path) => {
    const { calls } = await open(path);
    expect(shows('Not found')).toBe(true);
    expect(calls()).toEqual([]);
  });
});

