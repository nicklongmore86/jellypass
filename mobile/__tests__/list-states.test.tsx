// The Discover rows' See all pages, continued from list.test.tsx (split so neither file's Jest worker outgrows CI's
// heap): the fixed failures with Try again, Load more failing, offline, a 401 and an empty list; every pressable named
// and a thumb's size, every text free to grow, nothing stored; the badges as on the service page, and the grid on a
// phone and an iPad. Queries are queryAll* and assertions read single fields, so a failure never prints the tree.
import { act, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { StyleSheet } from 'react-native';

import type { FetchLike } from '../src/api/client';
import { POSTER_BADGE } from '../src/home/layout';
import { gridCardWidth, gridColumns } from '../src/search/text';
import { layout } from '../src/theme';
import { API, scrollToEnd, showAll } from './support/home';
import { listGateway } from './support/list';
import { ORIGIN, TOKEN, answer, keepSession, offline, settle, shows, store, storedSession } from './support/household';
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
const IPAD = { width: 1024, height: 1366, scale: 2, fontScale: 1 };
const NARROW = { width: 320, height: 568, scale: 2, fontScale: 1 };
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

const title = () => headings()[0];
const listChip = () => only(screen.queryAllByTestId('list-hide'), 'New only chip');

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
