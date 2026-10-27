// The network and studio pages through the real router, signed in, with a fake gateway: opened from Home's Studios tiles
// and service headings, the grid with Load more and the cards' status words, a card opening its title on Home's stack,
// a network's All | Series | Films tabs (Films only where the API lists films) kept under a title and on coming back,
// the JustWatch credit on All and Films, Not found for an ID the API does not list (no call at all for one that is not
// a number), the fixed failures with Try again and nothing retried by itself, a 401, late answers dropped, the overlay,
// and that every pressable is named and a thumb's size, every text can grow and the grid fits a phone and an iPad.
// The calls themselves are pinned by source-budget.test.tsx. Queries are queryAll* and assertions read single fields,
// so a failure never prints the component tree.
import { act, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { StyleSheet } from 'react-native';

import type { FetchLike } from '../src/api/client';
import { SOURCE_TEXT } from '../src/home/text';
import { gridCardWidth, gridColumns } from '../src/search/text';
import { layout } from '../src/theme';
import { API, scrollToEnd, sourcesAnswer } from './support/home';
import { ORIGIN, TOKEN, answer, keepSession, offline, settle, shows, store, storedSession } from './support/household';
import { wait } from './support/search';
import { gridNames, held, sourceAnswer, sourceGateway, tabs, type SourceHousehold } from './support/source';
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

let gateway: ReturnType<typeof sourceGateway>;

function useHousehold(household: SourceHousehold = {}) {
  gateway = sourceGateway(household);
  mockFetch = gateway.fetch;
}

beforeEach(() => {
  mockWindow = PHONE;
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  useHousehold();
});

async function start() {
  const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  return app;
}

/** Opens `path` on Home's stack, as a link would; `since()` is every call (route and query) made from then on. */
async function open(path: string) {
  const app = await start();
  const before = gateway.calls.length;
  await act(async () => router.push(path, { withAnchor: true }));
  await settle();
  return { app, since: () => gateway.calls.slice(before).map((call) => call.url.replace(/^https:\/\/[^/]+/, '').replace(API, '')) };
}

const tab = (name: string) => only(screen.queryAllByRole('tab', { name }).filter((node) => String(node.props.testID).startsWith('source-tab-')), `tab "${name}"`);
const title = () => headings()[0];
const justWatch = () => shows(SOURCE_TEXT.justWatch);

describe('from Home', () => {
  it("opens a studio's page from its tile: its name in the header, the grid, Load more, and a card's title on Home's stack", async () => {
    const app = await start();
    await pressNode(linkNamed('Marvel Studios, studio'));
    expect(app.getPathname()).toBe('/home/studio/420');
    expect(title()).toBe('Marvel Studios movies');
    expect(gridNames()).toHaveLength(20);
    expect(gridNames().slice(0, 4)).toEqual([
      'studio-420 1, 2015, Movie, Available to get',
      'studio-420 2, 2016, Movie, Ready to watch',
      "studio-420 3, 2017, Movie, Can't request",
      'studio-420 4, 2018, Movie, Requested',
    ]);
    // A studio has one list: no tabs, and no JustWatch credit (its movies are not where-to-watch data).
    expect(tabs()).toEqual([]);
    expect(justWatch()).toBe(false);

    const before = gateway.routes().length;
    await pressNode(buttonNamed('Load more'));
    expect(gateway.calls.slice(before).map((call) => call.url.replace(ORIGIN, ''))).toEqual([`${API}/discover/studio/420?page=2`]);
    expect(gridNames()).toHaveLength(40);

    await pressNode(linkNamed('studio-420 21, 2015, Movie, Available to get'));
    expect(app.getPathname()).toBe('/home/movie/5021');
    await pressNode(buttonNamed('Back'));
    expect(app.getPathname()).toBe('/home/studio/420');
    expect(gridNames()).toHaveLength(40);
    await pressNode(buttonNamed('Back'));
    // Home, its tab's first screen.
    expect(app.getPathname()).toMatch(/^\/(home)?$/);
  });

  it("opens a service's page from its row heading, on the list that row showed", async () => {
    const app = await start();
    await scrollToEnd();
    await pressNode(linkNamed('Popular on Netflix, see all'));
    expect(app.getPathname()).toBe('/home/network/213');
    expect(title()).toBe('Popular on Netflix');
    expect(tabs()).toEqual(['All ✓', 'Series', 'Films']);
    expect(gridNames()[1]).toBe('network-213-all 2, 2016, Series, Ready to watch');
  });
});

describe("a network's tabs", () => {
  it('shows All, Series and Films, each its own list, with the JustWatch credit on All and Films only', async () => {
    const { since } = await open('/home/network/213');
    expect(since()).toEqual(['/discover/sources', '/discover/network/213/all']);
    expect(justWatch()).toBe(true);

    await pressNode(tab('Series'));
    expect(tabs()).toEqual(['All', 'Series ✓', 'Films']);
    expect(title()).toBe('Series on Netflix');
    expect(gridNames()[0]).toBe('network-213-series 1, 2015, Series, Available to get');
    expect(justWatch()).toBe(false);

    await pressNode(tab('Films'));
    expect(title()).toBe('Films on Netflix');
    expect(gridNames()[0]).toBe('network-213-films 1, 2015, Movie, Available to get');
    expect(justWatch()).toBe(true);
    // The tab chosen again asks for nothing.
    await pressNode(tab('Films'));
    expect(since()).toEqual(['/discover/sources', '/discover/network/213/all', '/discover/network/213', '/discover/network/213/films']);
  });

  it('keeps the tab and its pages under a title opened from it, and on coming back', async () => {
    const { app, since } = await open('/home/network/213');
    await pressNode(tab('Films'));
    await pressNode(buttonNamed('Load more'));
    const calls = since().length;
    await pressNode(linkNamed('network-213-films 22, 2016, Movie, Ready to watch'));
    expect(app.getPathname()).toBe('/home/movie/5022');
    await pressNode(buttonNamed('Back'));
    expect(app.getPathname()).toBe('/home/network/213');
    expect(tabs()).toEqual(['All', 'Series', 'Films ✓']);
    expect(title()).toBe('Films on Netflix');
    expect(gridNames()).toHaveLength(40);
    // Coming back asked for nothing: the title page's own calls only.
    expect(since().slice(calls).filter((call) => call.startsWith('/discover/'))).toEqual([]);
  });

  it('opens on the tab its address names, and on All for anything else', async () => {
    await open('/home/network/213?kind=series');
    expect(tabs()).toEqual(['All', 'Series ✓', 'Films']);
    await open('/home/network/213?kind=Films');
    expect(tabs()).toEqual(['All ✓', 'Series', 'Films']);
  });

  it('has no tabs for a service the API lists no films for, and its Films address is Not found', async () => {
    useHousehold({ override: (call) => (call.route === `GET ${API}/discover/sources` ? answer(200, sourcesAnswer((id) => id !== 453)) : undefined) });
    const { since } = await open('/home/network/453');
    expect(tabs()).toEqual([]);
    expect(title()).toBe('Series on Hulu');
    expect(justWatch()).toBe(false);
    expect(since()).toEqual(['/discover/sources', '/discover/network/453']);

    const films = await open('/home/network/453?kind=films');
    expect(shows('Not found')).toBe(true);
    expect(films.since()).toEqual(['/discover/sources']);
  });
});

describe('Not found', () => {
  it.each(['/home/studio/abc', '/home/studio/012', '/home/network/1e3', '/home/network/0', '/home/studio/99999999999'])(
    'is shown for %s without a call',
    async (path) => {
      const { since } = await open(path);
      expect(shows('Not found')).toBe(true);
      expect(since()).toEqual([]);
    },
  );

  it.each(['/home/studio/213', '/home/network/49', '/home/network/41077'])('is shown for %s, an ID the API does not list, without asking for titles', async (path) => {
    const { since } = await open(path);
    expect(shows('Not found')).toBe(true);
    expect(buttonNamedOrNone('Try again')).toBe(0);
    expect(since()).toEqual(['/discover/sources']);
  });
});

function buttonNamedOrNone(name: string): number {
  return screen.queryAllByRole('button', { name }).length;
}

describe('failures', () => {
  it('shows the fixed message for the first page and asks again only on Try again', async () => {
    let fail = true;
    useHousehold({ source: () => (fail ? answer(502, { error: 'unavailable' }) : undefined) });
    const { since } = await open('/home/studio/2');
    expect(shows("Can't load this right now")).toBe(true);
    expect(title()).toBe('Disney movies');
    await wait(10 * 60_000);
    expect(since()).toEqual(['/discover/sources', '/discover/studio/2']);
    fail = false;
    await pressNode(buttonNamed('Try again'));
    expect(since()).toEqual(['/discover/sources', '/discover/studio/2', '/discover/studio/2']);
    expect(gridNames()).toHaveLength(20);
  });

  it("keeps the pages it has when Load more fails, and Try again asks for that page alone", async () => {
    let fail = true;
    useHousehold({ source: (_list, page) => (page === 2 && fail ? answer(429, { error: 'too_many_requests' }) : undefined) });
    const { since } = await open('/home/studio/2');
    await pressNode(buttonNamed('Load more'));
    expect(shows('Too many requests')).toBe(true);
    expect(gridNames()).toHaveLength(20);
    expect(buttonNamedOrNone('Load more')).toBe(0);
    await wait(10 * 60_000);
    fail = false;
    await pressNode(buttonNamed('Try again'));
    expect(since()).toEqual(['/discover/sources', '/discover/studio/2', '/discover/studio/2?page=2', '/discover/studio/2?page=2']);
    expect(gridNames()).toHaveLength(40);
  });

  it('shows the sources failing with Try again, which reads them and the list again', async () => {
    let fail = true;
    useHousehold({ override: (call) => (call.route === `GET ${API}/discover/sources` && fail ? offline(call) : undefined) });
    const { since } = await open('/home/network/213');
    expect(shows("You're offline")).toBe(true);
    fail = false;
    await pressNode(buttonNamed('Try again'));
    expect(since()).toEqual(['/discover/sources', '/discover/sources', '/discover/network/213/all']);
    expect(gridNames()).toHaveLength(20);
  });

  it('signs the member out on a 401: the device forgets the sign-in', async () => {
    useHousehold({
      source: () => answer(401, { error: 'unauthorized' }),
      override: (call) => (call.route === 'GET /Users/Public' ? answer(200, []) : undefined),
    });
    await open('/home/studio/2');
    expect(storedSession()).toBeUndefined();
    expect(gridNames()).toEqual([]);
  });
});

describe('late answers', () => {
  it("drop the tab switched away from: All's first page answering after Films does not replace it", async () => {
    const all = held();
    useHousehold({ source: (list) => (list === 'network-213-all' ? all.promise : undefined) });
    await open('/home/network/213');
    await pressNode(tab('Films'));
    expect(gridNames()[0]).toBe('network-213-films 1, 2015, Movie, Available to get');
    await act(async () => all.release(answer(200, sourceAnswer('network-213-all'))));
    await settle();
    expect(tabs()).toEqual(['All', 'Series', 'Films ✓']);
    expect(gridNames()[0]).toBe('network-213-films 1, 2015, Movie, Available to get');
  });

  it("drop a Load more asked for before the switch: All's second page never lands on Films", async () => {
    const more = held();
    useHousehold({ source: (list, page) => (list === 'network-213-all' && page === 2 ? more.promise : undefined) });
    await open('/home/network/213');
    await pressNode(buttonNamed('Load more'));
    await pressNode(tab('Films'));
    await act(async () => more.release(answer(200, sourceAnswer('network-213-all', 2))));
    await settle();
    expect(gridNames()).toHaveLength(20);
    expect(gridNames().every((name) => name.startsWith('network-213-films'))).toBe(true);
    // And coming back to All starts it again, from its first page.
    await pressNode(tab('All'));
    expect(gridNames()).toHaveLength(20);
  });

  it('ask for nothing on a second Load more while the first is out', async () => {
    const more = held();
    useHousehold({ source: (_list, page) => (page === 2 ? more.promise : undefined) });
    const { since } = await open('/home/studio/2');
    await pressNode(buttonNamed('Load more'));
    expect(screen.queryAllByRole('button', { name: 'Loading…' })).toHaveLength(1);
    await pressNode(buttonNamed('Loading…'));
    expect(since().filter((call) => call.endsWith('page=2'))).toHaveLength(1);
    await act(async () => more.release(answer(200, sourceAnswer('studio-2', 2))));
    await settle();
    expect(gridNames()).toHaveLength(40);
  });
});

describe('the overlay', () => {
  it('shows Requested right after Get this on a title opened from the page, with no call', async () => {
    await open('/home/studio/2');
    const card = (state: string) => screen.queryAllByRole('link', { name: `studio-2 1, 2015, Movie, ${state}` });
    expect(card('Available to get')).toHaveLength(1);
    await pressNode(card('Available to get')[0]!);
    await pressNode(buttonNamed(/^Get this/));
    const before = gateway.calls.length;
    await pressNode(buttonNamed('Back'));
    expect(card('Requested')).toHaveLength(1);
    expect(gateway.calls.length).toBe(before);
  });
});

type Node = NonNullable<ReturnType<typeof screen.queryAllByText>[number]>;
const flat = (node: Node) => StyleSheet.flatten(node.props.style) ?? {};

/** Every pressable on the page (not the tab bar or Home underneath): anything that answers a press. */
function pagePressables(): Node[] {
  const page = only(screen.queryAllByTestId('source-scroll'), 'page');
  const found: Node[] = [];
  const visit = (node: Node) => {
    const { onPress, onClick, onResponderRelease } = node.props;
    if ([onPress, onClick, onResponderRelease].some((handler) => typeof handler === 'function')) found.push(node);
    for (const child of node.children) if (typeof child !== 'string') visit(child);
  };
  visit(page);
  return found;
}

/** The words drawn inside a node: a pressable with no label is named by them. */
function textOf(node: Node): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

describe('accessibility', () => {
  it.each([
    ['a studio', '/home/studio/2', 20 + 1],
    ["a network's", '/home/network/213', 3 + 20 + 1],
  ] as const)("keeps every pressable on %s page named and a thumb's size", async (_what, path, count) => {
    await open(path);
    const found = pagePressables();
    expect(found).toHaveLength(count);
    const problems = found
      .map((node) => {
        const what = String(node.props.accessibilityLabel ?? textOf(node));
        const height = flat(node).minHeight;
        return [
          !['button', 'link', 'tab'].includes(node.props.accessibilityRole) && `${what}: role ${String(node.props.accessibilityRole)}`,
          what.length === 0 && 'a pressable with no name',
          !(typeof height === 'number' && height >= layout.touchTarget) && `${what}: under 44 pt`,
        ];
      })
      .flat()
      .filter(Boolean);
    expect(problems).toEqual([]);
    // The status chips are said in each card's name, not again; the logo is decorative (the header names it).
    expect(screen.queryAllByTestId('status-chip').filter((chip) => chip.props.accessibilityLabel)).toHaveLength(0);
    expect(screen.queryAllByTestId('tmdb-logo-image')).toHaveLength(0);
  });

  it('names the tab list and says which tab is selected', async () => {
    await open('/home/network/213');
    const list = only(screen.queryAllByTestId('source-tabs'), 'tab list');
    expect({ role: list.props.accessibilityRole, name: list.props.accessibilityLabel }).toEqual({ role: 'tablist', name: 'Show' });
    expect(tab('All').props.accessibilityState).toEqual({ selected: true });
  });

  it('lets every text on the page grow with the font size, wrapping, never clipped or cut short', async () => {
    await open('/home/network/213');
    const page = only(screen.queryAllByTestId('source-scroll'), 'page');
    const found = screen.queryAllByText(/[\s\S]/, { includeHiddenElements: true }).filter((node) => {
      for (let at: Node | null = node; at; at = at.parent) if (at === page) return true;
      return false;
    });
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
    await open('/home/network/213');
    await pressNode(tab('Films'));
    expect(store.setItemAsync.mock.calls.map(([key]) => String(key))).toEqual([]);
  });

  it('loads only TMDB images', async () => {
    await open('/home/network/213');
    const images = screen.queryAllByTestId(/^tmdb-(image|logo-image)$/, { includeHiddenElements: true }).map((node) => String(node.props.source?.uri));
    expect(images.length).toBeGreaterThan(20);
    expect(images.filter((uri) => !uri.startsWith('https://image.tmdb.org/t/p/'))).toEqual([]);
  });
});

describe('layout', () => {
  const cardWidth = () => Number(flat(screen.queryAllByRole('link', { name: /^studio-2 1,/ })[0]!).width);

  it.each([
    ['a phone', PHONE, 3],
    ['a very narrow phone', NARROW, 2],
    ['an iPad', IPAD, 5],
  ] as const)('lays the posters out as Search does on %s', async (_what, size, columns) => {
    mockWindow = size;
    await open('/home/studio/2');
    const column = Math.min(size.width, layout.maxContentWidth) - 32;
    expect(gridColumns(size.width, column)).toBe(columns);
    expect(cardWidth()).toBe(gridCardWidth(column, columns));
    // On an iPad the column stops widening at the PWA's 72rem.
    const page = only(screen.queryAllByTestId('source-scroll'), 'page');
    expect(flat(only(within(page).queryAllByTestId('screen-column'), 'column')).maxWidth).toBe(layout.maxContentWidth);
  });
});
