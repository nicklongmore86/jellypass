// The Discover rows' See all pages through the real router, signed in, with a fake gateway: each list row's link by its
// heading (named "See all <heading>", after the heading in the reading order) under All, Movies and TV, opening the
// row's own list on Home's stack with the row's titles and no call; the filter and New only kept as TV keeps them; Load
// more one page per press; a card's title on Home's stack and Back to the same grid; the page opened by its address
// (one call), Not found for a list no row shows (no call); the fixed failures with Try again, a 401; and that every
// pressable is named and a thumb's size, every text can grow, the badges sit as on the service page, and the grid fits
// a phone and an iPad. Queries are queryAll* and assertions read single fields, so a failure never prints the tree.
import { act, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { StyleSheet } from 'react-native';

import type { FetchLike } from '../src/api/client';
import { POSTER_BADGE } from '../src/home/layout';
import { gridCardWidth, gridColumns } from '../src/search/text';
import { layout } from '../src/theme';
import { BUDGET } from './support/app-api';
import { API, choose, chosen, pageAnswer, scrollToEnd, showAll } from './support/home';
import { ORIGIN, TOKEN, answer, keepSession, offline, settle, shows, store, storedSession, type Call } from './support/household';
import { wait } from './support/search';
import { gridNames, sourceGateway, type SourceHousehold } from './support/source';
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
const IPAD = { width: 1024, height: 1366, scale: 2, fontScale: 1 };
const NARROW = { width: 320, height: 568, scale: 2, fontScale: 1 };
let mockWindow = PHONE;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow }));

const LIST = new RegExp(`^GET ${API}/discover/([a-z-]+)$`);

/** The page number a call asked for. */
const pageOf = (call: Call) => Number(new URLSearchParams(call.url.includes('?') ? call.url.slice(call.url.indexOf('?') + 1) : '').get('page') ?? 1);

/** Page `page` of a discover list: page 1 is Home's own row (support/home's pageAnswer), each later one IDs of its own, three in all. */
function listPage(list: string, page: number) {
  const first = pageAnswer(list);
  return {
    page,
    nextPage: page < 3 ? page + 1 : null,
    results: first.results.map((card, index) => {
      const n = (page - 1) * 20 + index + 1;
      return { ...card, tmdbId: 1000 + n, title: `${list} ${n}` };
    }),
  };
}

let gateway: ReturnType<typeof sourceGateway>;

/** `list` answers a discover list's page first, when it returns something; by default listPage(list, page). */
function serveHousehold(list?: (name: string, page: number, call: Call) => ReturnType<typeof answer> | Promise<ReturnType<typeof answer>> | undefined, household: SourceHousehold = {}) {
  gateway = sourceGateway({
    ...household,
    override: (call) => {
      const own = household.override?.(call);
      if (own) return own;
      const match = LIST.exec(call.route);
      if (!match || match[1] === 'sources') return undefined;
      return list?.(match[1]!, pageOf(call), call) ?? answer(200, listPage(match[1]!, pageOf(call)));
    },
  });
  mockFetch = gateway.fetch;
}

beforeEach(() => {
  mockWindow = PHONE;
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  serveHousehold();
});

/** Home, every row loaded and New only off (unless `hide`). */
async function start({ hide = false } = {}) {
  const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  if (!hide) await showAll();
  await scrollToEnd();
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
    const app = await start();
    if (filter !== 'All') {
      await choose(filter);
      await scrollToEnd();
    }
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
    await start();
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

describe('failures', () => {
  it('shows the fixed message for the first page and asks again only on Try again', async () => {
    let fail = true;
    serveHousehold((_list, page) => (fail && page === 1 ? answer(502, { error: 'unavailable' }) : undefined));
    const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
    await settle();
    const calls = since();
    await act(async () => router.push('/home/list/trending', { withAnchor: true }));
    await settle();
    expect(app.getPathname()).toBe('/home/list/trending');
    expect(shows("Can't load this right now")).toBe(true);
    expect(title()).toBe('Trending');
    await wait(10 * 60_000);
    expect(calls()).toEqual(['/discover/trending']);
    fail = false;
    await pressNode(only(screen.queryAllByRole('button', { name: 'Try again' }).filter((node) => isOn(node, 'list-scroll')), 'Try again'));
    expect(calls()).toEqual(['/discover/trending', '/discover/trending']);
    // New only is on, as at every sign-in: the ten the member has are left out.
    expect(gridNames()).toHaveLength(10);
  });

  it('keeps the pages it has when Load more fails, and Try again asks for that page alone', async () => {
    let fail = true;
    serveHousehold((_list, page) => (page === 2 && fail ? answer(429, { error: 'too_many_requests' }) : undefined));
    await start();
    await pressNode(linkNamed('See all Popular movies'));
    const calls = since();
    await pressNode(buttonNamed('Load more'));
    expect(shows('Too many requests')).toBe(true);
    expect(gridNames()).toHaveLength(20);
    expect(screen.queryAllByRole('button', { name: 'Load more' })).toHaveLength(0);
    fail = false;
    await pressNode(buttonNamed('Try again'));
    expect(calls()).toEqual(['/discover/popular-movies?page=2', '/discover/popular-movies?page=2']);
    expect(gridNames()).toHaveLength(40);
  });

  it('says offline, and keeps the grid on a Load more that finds no connection', async () => {
    serveHousehold((_list, page, call) => (page === 2 ? offline(call) : undefined));
    await start();
    await pressNode(linkNamed('See all Trending'));
    await pressNode(buttonNamed('Load more'));
    expect(shows("You're offline")).toBe(true);
    expect(gridNames()).toHaveLength(20);
  });

  it('signs the member out on a 401: the device forgets the sign-in', async () => {
    serveHousehold((_list, page) => (page === 2 ? answer(401, { error: 'unauthorized' }) : undefined), {
      override: (call) => (call.route === 'GET /Users/Public' ? answer(200, []) : undefined),
    });
    await start();
    await pressNode(linkNamed('See all Trending'));
    await pressNode(buttonNamed('Load more'));
    expect(storedSession()).toBeUndefined();
    expect(gridNames()).toEqual([]);
  });

  it('says nothing is there for an empty list', async () => {
    serveHousehold(() => answer(200, { page: 1, nextPage: null, results: [] }));
    await open('/home/list/upcoming-tv');
    expect(shows('Nothing to show here right now.')).toBe(true);
    expect(screen.queryAllByRole('button', { name: 'Load more' })).toHaveLength(0);
  });
});

type Node = NonNullable<ReturnType<typeof screen.queryAllByText>[number]>;
const flat = (node: Node) => StyleSheet.flatten(node.props.style) ?? {};

function isOn(node: Node, testID: string): boolean {
  for (let at: Node | null = node; at; at = at.parent) if (at.props.testID === testID) return true;
  return false;
}

/** Every pressable on the page (not the tab bar or Home underneath): anything that answers a press. */
function pagePressables(): Node[] {
  const page = only(screen.queryAllByTestId('list-scroll'), 'page');
  const found: Node[] = [];
  const visit = (node: Node) => {
    const { onPress, onClick, onResponderRelease } = node.props;
    if ([onPress, onClick, onResponderRelease].some((handler) => typeof handler === 'function')) found.push(node);
    for (const child of node.children) if (typeof child !== 'string') visit(child);
  };
  visit(page);
  return found;
}

function textOf(node: Node): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

describe('accessibility', () => {
  it("keeps every pressable on the page named and a thumb's size: New only, the cards and Load more", async () => {
    await open('/home/list/trending');
    const found = pagePressables();
    expect(found).toHaveLength(1 + 20 + 1);
    const problems = found
      .map((node) => {
        const what = String(node.props.accessibilityLabel ?? textOf(node));
        const height = flat(node).minHeight;
        return [
          !['button', 'link', 'checkbox'].includes(node.props.accessibilityRole) && `${what}: role ${String(node.props.accessibilityRole)}`,
          what.length === 0 && 'a pressable with no name',
          !(typeof height === 'number' && height >= layout.touchTarget) && `${what}: under 44 pt`,
        ];
      })
      .flat()
      .filter(Boolean);
    expect(problems).toEqual([]);
    expect(listChip().props.accessibilityLabel).toBe("New only: show only titles you don't have or haven't requested");
    // The status chips are said in each card's name, not again; no logo.
    expect(screen.queryAllByTestId('status-chip').filter((chip) => chip.props.accessibilityLabel)).toHaveLength(0);
    expect(screen.queryAllByTestId('tmdb-logo-image').filter((node) => isOn(node, 'list-scroll'))).toHaveLength(0);
  });

  it('lets every text on the page grow with the font size, wrapping, never clipped or cut short', async () => {
    await open('/home/list/trending');
    const page = only(screen.queryAllByTestId('list-scroll'), 'page');
    const found = screen.queryAllByText(/[\s\S]/, { includeHiddenElements: true }).filter((node) => isOn(node, 'list-scroll'));
    expect(found.length).toBeGreaterThan(40);
    const problems: string[] = [];
    for (const node of found) {
      const text = [node.props.children].flat().join('');
      if (node.props.allowFontScaling === false) problems.push(`${text}: no font scaling`);
      if (node.props.numberOfLines !== undefined) problems.push(`${text}: a line limit`);
      if (node.props.adjustsFontSizeToFit) problems.push(`${text}: shrinks to fit`);
      for (let at: Node | null = node; at && at !== page; at = at.parent) {
        const style = flat(at);
        if (typeof style.height === 'number' || typeof style.maxHeight === 'number') problems.push(`${text}: a fixed height`);
        if (style.overflow === 'hidden') problems.push(`${text}: clipped`);
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it("keeps everything the page shows out of the device's storage", async () => {
    await start();
    await pressNode(linkNamed('See all Trending'));
    await pressNode(buttonNamed('Load more'));
    expect(store.setItemAsync.mock.calls.map(([key]) => String(key))).toEqual([]);
  });
});

describe('layout', () => {
  const cardWidth = () => Number(flat(screen.queryAllByRole('link', { name: /^trending 1,/ }).filter((node) => isOn(node, 'list-scroll'))[0]!).width);
  const badges = () => screen.queryAllByTestId('status-chip', { includeHiddenElements: true }).filter((node) => isOn(node, 'list-scroll'));

  it.each([
    ['a phone', PHONE, 3],
    ['a very narrow phone', NARROW, 2],
    ['an iPad', IPAD, 5],
  ] as const)('lays the posters out as the service page does on %s', async (_what, size, columns) => {
    mockWindow = size;
    await open('/home/list/trending');
    const column = Math.min(size.width, layout.maxContentWidth) - 32;
    expect(gridColumns(size.width, column)).toBe(columns);
    expect(cardWidth()).toBe(gridCardWidth(column, columns));
    const page = only(screen.queryAllByTestId('list-scroll'), 'page');
    expect(flat(only(within(page).queryAllByTestId('screen-column'), 'column')).maxWidth).toBe(layout.maxContentWidth);
  });

  it('puts the badge in the poster\'s corner at ordinary text size, and below the image at large text', async () => {
    await open('/home/list/trending');
    expect(badges().length).toBe(20);
    expect(badges().every((chip) => flat(chip).position === 'absolute' && flat(chip).top === POSTER_BADGE.inset)).toBe(true);
    mockWindow = { ...PHONE, fontScale: 3 };
    await open('/home/list/trending');
    expect(badges().length).toBe(20);
    expect(badges().every((chip) => flat(chip).position === undefined)).toBe(true);
  });
});
