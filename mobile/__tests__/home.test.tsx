// The Home tab through the real router, signed in, with a fake gateway: the rows of each filter in the PWA's order, the
// hero, the filter chips, the cards' text, names and status words, TMDB-only images (a bad one dropped, not the
// screen), each row's own failure with Try again and nothing retried by itself, pull to refresh, a 401, the iPad
// layout, the sideways rows coming to rest with a card centred, and that every pressable is named and a thumb's size
// and every text can grow. The calls themselves are pinned by home-budget.test.tsx. Queries are queryAll* and
// assertions read single fields, so a failure never prints the component tree.
import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { renderRouter } from 'expo-router/testing-library';
import { ScrollView, StyleSheet } from 'react-native';

import type { FetchLike } from '../src/api/client';
import { CARD_GAP, STUDIO_TILE_WIDTH } from '../src/home/components';
import { snapOffsets } from '../src/home/layout';
import { STATE_LABELS } from '../src/home/text';
import { cardWidths } from '../src/screens/HomeScreen';
import { layout } from '../src/theme';
import {
  API,
  choose,
  chosen,
  headings,
  homeGateway,
  homeHousehold,
  links,
  NETWORKS,
  pageAnswer,
  scrollToEnd,
  sourcesAnswer,
} from './support/home';
import { ORIGIN, TOKEN, answer, keepSession, offline, settle, shows, store, storedSession } from './support/household';
import { titleGateway } from './support/title';

// Scrolling to the end a step at a time lays Home out many times: slower CI runners need more than Jest's 5 s.
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
/** The narrowest iPhone (SE, first generation): a 288 pt column inside the gutters. */
const NARROW = { width: 320, height: 568, scale: 2, fontScale: 1 };
let mockWindow = PHONE;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow }));

let gateway: ReturnType<typeof homeGateway>;

function useHousehold(override?: Parameters<typeof homeHousehold>[0], sources?: ReturnType<typeof sourcesAnswer>) {
  gateway = homeGateway(homeHousehold(override, sources));
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

const callsTo = (list: string) => gateway.routes().filter((route) => route === `GET ${API}/discover/${list}`).length;

type Node = NonNullable<ReturnType<typeof screen.queryAllByText>[number]>;
const flat = (node: Node) => StyleSheet.flatten(node.props.style) ?? {};

function only(found: Node[], what: string): Node {
  if (found.length !== 1) throw new Error(`expected one ${what}, found ${found.length}`);
  return found[0]!;
}

const link = (name: string) => only(screen.queryAllByRole('link', { name }), `link "${name}"`);
const buttonNamed = (name: string) => only(screen.queryAllByRole('button', { name }), `button "${name}"`);

async function pressNode(node: Node) {
  await fireEvent.press(node);
  await settle();
}

/** Lets `ms` pass, on the fake clock the router's test renderer runs on. */
async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
}

const SERVICE_NAMES = NETWORKS.map(([, name]) => name);

describe('the rows', () => {
  it('under All: Trending, the popular and new rows, upcoming, the eight services mixed, then the studios and the credit', async () => {
    await start();
    await scrollToEnd();
    expect(headings()).toEqual([
      'Trending',
      'Popular movies',
      'Popular series',
      'New movie releases',
      'Upcoming movies',
      'Upcoming series',
      ...SERVICE_NAMES.map((name) => `Popular on ${name}`),
      'Studios',
    ]);
    expect(shows('Where to watch: US streaming availability from JustWatch, via TMDB.')).toBe(true);
    expect(headings().some((text) => /all-time/i.test(text))).toBe(false);
    expect(gateway.routes().filter((route) => /top-(movies|tv)/.test(route))).toEqual([]);
  });

  it('under Movies: the films rows, each service\'s films, the studios and the credit', async () => {
    await start();
    await choose('Movies');
    await scrollToEnd();
    expect(headings()).toEqual([
      'Trending movies',
      'Popular movies',
      'New movie releases',
      'Upcoming movies',
      ...SERVICE_NAMES.map((name) => `Films on ${name}`),
      'Studios',
    ]);
    expect(shows('Where to watch: US streaming availability from JustWatch, via TMDB.')).toBe(true);
  });

  it('under TV: the series rows and each service\'s series, with no studios and no credit', async () => {
    await start();
    await choose('TV');
    await scrollToEnd();
    expect(headings()).toEqual(['Trending series', 'Popular series', 'Upcoming series', ...SERVICE_NAMES.map((name) => `Series on ${name}`)]);
    expect(shows('Where to watch: US streaming availability from JustWatch, via TMDB.')).toBe(false);
  });

  it('keeps a service with no films as its series under All and leaves it out under Movies', async () => {
    useHousehold(undefined, sourcesAnswer((id) => id !== 453));
    await start();
    await scrollToEnd();
    expect(headings()).toContain('Series on Hulu');
    expect(gateway.routes()).toContain(`GET ${API}/discover/network/453`);
    await choose('Movies');
    await scrollToEnd();
    expect(headings().filter((text) => text.includes('Hulu'))).toEqual([]);
  });

  it('draws each service\'s heading with its logo and its own waterline colour, and the others cyan with the purple cap', async () => {
    await start();
    await scrollToEnd();
    for (const accent of ['netflix', 'disney', 'apple', 'prime', 'hbo', 'hulu', 'paramount', 'peacock']) {
      expect({ accent, lines: screen.queryAllByTestId(`waterline-${accent}`, { includeHiddenElements: true }).length }).toEqual({ accent, lines: 1 });
    }
    // Six title rows and the studios.
    expect(screen.queryAllByTestId('waterline-default', { includeHiddenElements: true })).toHaveLength(7);
    expect(screen.queryAllByTestId('tmdb-logo-image', { includeHiddenElements: true }).length).toBeGreaterThanOrEqual(8);
  });

  it('shows the studios as their logos, each named "<studio> movies", and a name where there is no logo', async () => {
    await start();
    await scrollToEnd();
    expect(screen.queryAllByRole('image').map((node) => node.props.accessibilityLabel)).toEqual(['Disney movies', 'Marvel Studios movies', 'A24 movies']);
    expect(shows('A24', { hidden: true })).toBe(true);
  });

  it('draws posters with "year · Movie/Series" and the big cards with "year · ★ rating TMDB" below the image', async () => {
    await start();
    expect(shows('trending 1')).toBe(true);
    expect(shows('2020 · Movie')).toBe(true);
    expect(shows('2021 · Series')).toBe(true);
    expect(shows('popular-movies 1')).toBe(true);
    expect(shows('2020 · ★ 6.0 TMDB')).toBe(true);
  });

  it('says so when a row has nothing in it', async () => {
    useHousehold((call) => (call.route === `GET ${API}/discover/new-movies` ? answer(200, pageAnswer('new-movies', 0)) : undefined));
    await start();
    expect(shows('Nothing to show here right now.')).toBe(true);
  });
});

describe('the cards', () => {
  it('are links named by title, year and rating, then the status, said once', async () => {
    await start();
    expect(link('trending 1, 2020, Movie, TMDB rating 6.0 out of 10, Ready to watch')).toBeTruthy();
    expect(link('trending 2, 2021, Series, TMDB rating 6.5 out of 10, Available to get')).toBeTruthy();
    expect(link('popular-movies 3, 2022, TMDB rating 7.0 out of 10, Can\'t request')).toBeTruthy();
    expect(link('popular-tv 4, 2023, TMDB rating 7.5 out of 10, Requested')).toBeTruthy();
    for (const name of links()) {
      const said = Object.values(STATE_LABELS).filter((word) => name.includes(word));
      expect({ name, said: said.length }).toEqual({ name, said: 1 });
    }
  });

  it('show the status as a dot and the PWA\'s word on the image\'s top-left, hidden from screen readers', async () => {
    await start();
    for (const word of Object.values(STATE_LABELS)) {
      expect({ word, shown: shows(word, { hidden: true }), read: shows(word) }).toEqual({ word, shown: true, read: false });
    }
    const chips = screen.queryAllByTestId('status-chip', { includeHiddenElements: true });
    const overlays = chips.filter((node) => flat(node).position === 'absolute');
    expect(overlays.length).toBeGreaterThan(0);
    expect(overlays.every((node) => flat(node).top === 8 && flat(node).left === 8)).toBe(true);
  });

  it('open the title\'s page on the Home tab, with Back', async () => {
    gateway = titleGateway();
    mockFetch = gateway.fetch;
    const app = await start();
    await pressNode(link('trending 2, 2021, Series, TMDB rating 6.5 out of 10, Available to get'));
    expect(app.getPathname()).toBe('/home/tv/1002');
    expect(headings()).toContain('Series 1002');
    expect(gateway.routes()).toContain(`GET ${API}/tv/1002`);
    await pressNode(buttonNamed('Back'));
    expect(app.getPathname()).toBe('/home');
  });
});

describe('images', () => {
  const uris = () => screen.queryAllByTestId(/^tmdb-(image|logo-image)$/, { includeHiddenElements: true }).map((node) => String(node.props.source?.uri));

  it('come only from TMDB, at the allowlisted widths', async () => {
    await start();
    await scrollToEnd();
    const found = uris();
    expect(found.length).toBeGreaterThan(50);
    expect(found.filter((uri) => !/^https:\/\/image\.tmdb\.org\/t\/p\/(w342|w780|w1280|w300)\/[A-Za-z0-9_-]+\.(jpg|png)$/.test(uri))).toEqual([]);
  });

  it('never loads one off the allowlist: the card stays, without its picture', async () => {
    useHousehold((call) => {
      if (call.route !== `GET ${API}/discover/trending`) return undefined;
      const page = pageAnswer('trending');
      page.results[0]!.posterUrl = 'https://images.example.test/t/p/w342/poster-1.jpg';
      page.results[0]!.backdropUrl = 'https://image.tmdb.org/t/p/original/backdrop-1.jpg';
      return answer(200, page);
    });
    await start();
    expect(link('trending 1, 2020, Movie, TMDB rating 6.0 out of 10, Ready to watch')).toBeTruthy();
    expect(uris().filter((uri) => uri.includes('example.test') || uri.includes('/original/'))).toEqual([]);
  });

  it('drops a picture that fails to load, and nothing else', async () => {
    await start();
    const before = uris().length;
    const links = screen.queryAllByRole('link').length;
    const first = screen.queryAllByTestId('tmdb-image', { includeHiddenElements: true })[0]!;
    await act(async () => fireEvent(first, 'error', { nativeEvent: { error: 'failed' } }));
    expect(uris().length).toBe(before - 1);
    expect(screen.queryAllByRole('link').length).toBe(links);
  });
});

describe('the hero', () => {
  const dots = () => screen.queryAllByRole('button', { name: /^Show title / });
  const current = () => dots().filter((node) => node.props.accessibilityState?.selected === true).map((node) => String(node.props.accessibilityLabel));

  it('shows the first five titles of the first row, each with its year, rating, status and overview below the picture', async () => {
    await start();
    expect(screen.queryAllByTestId(/^hero-slide/)).toHaveLength(5);
    expect(only(screen.queryAllByTestId('hero'), 'hero').props.accessibilityLabel).toBe('Trending now');
    expect(shows('★ 6.0 TMDB')).toBe(true);
    expect(shows('The overview of trending 1.')).toBe(true);
    expect(dots().map((node) => node.props.accessibilityLabel)).toEqual([1, 2, 3, 4, 5].map((n) => `Show title ${n} of 5: trending ${n}`));
    expect(current()).toEqual(['Show title 1 of 5: trending 1']);
  });

  it('moves by Next and Previous, wrapping round, and by a dot', async () => {
    await start();
    await pressNode(buttonNamed('Next title'));
    expect(current()).toEqual(['Show title 2 of 5: trending 2']);
    await pressNode(buttonNamed('Previous title'));
    await pressNode(buttonNamed('Previous title'));
    expect(current()).toEqual(['Show title 5 of 5: trending 5']);
    await pressNode(buttonNamed('Next title'));
    expect(current()).toEqual(['Show title 1 of 5: trending 1']);
    await pressNode(buttonNamed('Show title 4 of 5: trending 4'));
    expect(current()).toEqual(['Show title 4 of 5: trending 4']);
  });

  it('follows a swipe', async () => {
    await start();
    const track = only(screen.queryAllByTestId('hero-track'), 'hero track');
    await act(async () => fireEvent(track, 'momentumScrollEnd', { nativeEvent: { contentOffset: { x: 358 * 2, y: 0 } } }));
    expect(current()).toEqual(['Show title 3 of 5: trending 3']);
  });

  it('never moves by itself', async () => {
    await start();
    // A minute: longer than any carousel would wait.
    await wait(60_000);
    expect(current()).toEqual(['Show title 1 of 5: trending 1']);
    const dir = path.join(__dirname, '..', 'src', 'home');
    const sources = [...readdirSync(dir).map((file) => path.join(dir, file)), path.join(__dirname, '..', 'src', 'screens', 'HomeScreen.tsx')];
    expect(sources.filter((file) => /\bset(Interval|Timeout)\s*\(/.test(readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('opens its title', async () => {
    const app = await start();
    const slide = screen.queryAllByRole('link', { name: 'trending 1, 2020, TMDB rating 6.0 out of 10, Ready to watch' });
    expect(slide).toHaveLength(1);
    await pressNode(slide[0]!);
    expect(app.getPathname()).toBe('/home/movie/1001');
  });

  it('follows the filter', async () => {
    await start();
    await choose('Movies');
    expect(only(screen.queryAllByTestId('hero'), 'hero').props.accessibilityLabel).toBe('Trending movies');
    expect(dots()[0]!.props.accessibilityLabel).toBe('Show title 1 of 5: trending-movies 1');
    await choose('TV');
    expect(only(screen.queryAllByTestId('hero'), 'hero').props.accessibilityLabel).toBe('Trending series');
  });

  it('is left out when its row fails, and the row says so', async () => {
    useHousehold((call) => (call.route === `GET ${API}/discover/trending` ? answer(502, { error: 'unavailable' }) : undefined));
    await start();
    expect(screen.queryAllByTestId('hero')).toHaveLength(0);
    expect(shows("Can't load this right now")).toBe(true);
  });
});

describe('the filter', () => {
  it('is a radio group named Show, All chosen first, ticked and tinted', async () => {
    await start();
    // The group itself is not a screen-reader element (that would hide its chips), so it is found by its test ID.
    const group = only(screen.queryAllByTestId('home-filters'), 'filter group');
    expect([group.props.accessibilityRole, group.props.accessibilityLabel]).toEqual(['radiogroup', 'Show']);
    expect(chosen()).toEqual(['All']);
    const all = only(screen.queryAllByTestId('home-filter-all'), 'All chip');
    expect(flat(all)).toMatchObject({ backgroundColor: '#06304d', borderColor: '#00a4dc', borderWidth: 1.5, borderRadius: 12 });
    expect(flat(only(screen.queryAllByTestId('home-filter-tv'), 'TV chip')).backgroundColor).toBeUndefined();
    expect(screen.queryAllByTestId('icon-check', { includeHiddenElements: true })).toHaveLength(1);
  });

  it('is remembered when coming back to Home from a title or another tab', async () => {
    const app = await start();
    await choose('TV');
    expect(chosen()).toEqual(['TV']);
    await pressNode(screen.queryAllByRole('link')[0]!);
    expect(app.getPathname()).toMatch(/^\/home\/(movie|tv)\/\d+$/);
    await pressNode(buttonNamed('Back'));
    expect(chosen()).toEqual(['TV']);
    await pressNode(only(screen.queryAllByRole('tab', { name: 'Account' }), 'Account tab'));
    await pressNode(only(screen.queryAllByRole('tab', { name: 'Home' }), 'Home tab'));
    expect(chosen()).toEqual(['TV']);
    expect(headings()[0]).toBe('Trending series');
  });
});

describe('failures', () => {
  it.each([
    ['a 502', () => answer(502, { error: 'unavailable' }), "Can't load this right now", 'Something went wrong. Try again in a moment.'],
    ['a 429', () => answer(429, { error: 'too_many_requests' }, { 'Retry-After': '30' }), 'Too many requests', 'Wait a minute, then try again.'],
    ['no answer', offline, "You're offline", 'Check your connection, then try again.'],
  ] as const)('show %s on that row alone, with fixed words, and never try again by themselves', async (_what, respond, title, body) => {
    useHousehold((call) => (call.route === `GET ${API}/discover/popular-tv` ? respond(call) : undefined));
    await start();
    expect(shows(title)).toBe(true);
    expect(shows(body)).toBe(true);
    expect(headings()).toEqual(['Trending', 'Popular movies', 'Popular series', 'New movie releases', 'Studios']);
    expect(shows('popular-movies 1')).toBe(true);
    await wait(60_000);
    expect(callsTo('popular-tv')).toBe(1);
  });

  it('try that row again, once, when the member taps Try again', async () => {
    let fail = true;
    useHousehold((call) => (call.route === `GET ${API}/discover/popular-tv` && fail ? answer(502, { error: 'unavailable' }) : undefined));
    await start();
    fail = false;
    const before = gateway.routes().length;
    await pressNode(buttonNamed('Try again'));
    expect(gateway.routes().slice(before)).toEqual([`GET ${API}/discover/popular-tv`]);
    expect(shows('popular-tv 1')).toBe(true);
    expect(shows("Can't load this right now")).toBe(false);
  });

  it('give a lazy row its own failure and Try again', async () => {
    let fail = true;
    useHousehold((call) => (call.route === `GET ${API}/discover/network/213/all` && fail ? answer(502, { error: 'unavailable' }) : undefined));
    await start();
    await scrollToEnd();
    expect(headings()).toContain('Popular on Netflix');
    expect(screen.queryAllByRole('button', { name: 'Try again' })).toHaveLength(1);
    fail = false;
    await pressNode(buttonNamed('Try again'));
    expect(gateway.routes().filter((route) => route === `GET ${API}/discover/network/213/all`)).toHaveLength(2);
    expect(shows('network-213-all 1')).toBe(true);
  });

  it('show the networks and studios failing as one row with Try again', async () => {
    let fail = true;
    useHousehold((call) => (call.route === `GET ${API}/discover/sources` && fail ? answer(502, { error: 'unavailable' }) : undefined));
    await start();
    expect(headings()).toContain('Studios and networks');
    fail = false;
    await pressNode(buttonNamed('Try again'));
    expect(headings()).toContain('Studios');
    expect(headings()).not.toContain('Studios and networks');
  });

  it('sign the member out on a 401: the device forgets the sign-in and the picker shows', async () => {
    useHousehold((call) => {
      if (call.route === `GET ${API}/discover/popular-movies`) return answer(401, { error: 'unauthorized' });
      if (call.route === 'GET /Users/Public') return answer(200, []);
      return undefined;
    });
    const app = await start();
    await settle();
    expect(storedSession()).toBeUndefined();
    expect(app.getPathname()).toBe('/');
    expect(shows(/Your sign-in has expired/)).toBe(true);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});

describe('pull to refresh', () => {
  it('asks for the filter\'s first rows and the services again, and nothing below the fold', async () => {
    await start();
    const before = gateway.routes().length;
    const scroller = only(screen.queryAllByTestId('home-scroll'), 'Home scroller');
    await act(async () => {
      await scroller.props.refreshControl.props.onRefresh();
    });
    await settle();
    expect(
      gateway
        .routes()
        .slice(before)
        .sort(),
    ).toEqual(['discover/new-movies', 'discover/popular-movies', 'discover/popular-tv', 'discover/sources', 'discover/trending'].map((list) => `GET ${API}/${list}`));
  });
});

describe('privacy', () => {
  it('keeps nothing on the device and calls nothing but the household', async () => {
    const global = jest.spyOn(globalThis, 'fetch');
    try {
      await start();
      await scrollToEnd();
      expect(store.setItemAsync).not.toHaveBeenCalled();
      expect(global).not.toHaveBeenCalled();
      expect(gateway.calls.every((call) => call.url.startsWith(`${ORIGIN}/`))).toBe(true);
    } finally {
      global.mockRestore();
    }
  });
});

/** The text a node holds, its own and its descendants'. */
function textOf(node: Node): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

/** Every host node on screen that answers a press. */
function pressables(): Node[] {
  const found: Node[] = [];
  const visit = (node: Node) => {
    const { onPress, onClick, onResponderRelease } = node.props;
    if ([onPress, onClick, onResponderRelease].some((handler) => typeof handler === 'function')) found.push(node);
    for (const child of node.children) if (typeof child !== 'string') visit(child);
  };
  visit(screen.root as Node);
  return found;
}

/**
 * Whether a pressable is at least a thumb wide: by its width or minimum width, or with neither, by filling its parent's
 * width (a column's child, not a row's) or sharing a row by flex (the tab bar's four tabs: 69 pt each at 320 pt).
 */
function wideEnough(node: Node): boolean {
  const style = flat(node);
  if (typeof style.width === 'number') return style.width >= layout.touchTarget;
  if (typeof style.minWidth === 'number' && style.minWidth >= layout.touchTarget) return true;
  if ((typeof style.flex === 'number' && style.flex > 0) || (typeof style.flexGrow === 'number' && style.flexGrow > 0)) return true;
  if (style.alignSelf !== undefined) return false;
  for (let at = node.parent; at; at = at.parent) {
    if (at.props.style === undefined) continue;
    return flat(at).flexDirection !== 'row' && flat(at).flexDirection !== 'row-reverse';
  }
  return false;
}

describe('accessibility', () => {
  it('keeps every pressable on a fully loaded Home named and a thumb\'s size', async () => {
    await start();
    await scrollToEnd();
    const found = pressables();
    expect(found.length).toBeGreaterThan(150);
    const problems = found
      .map((node) => {
        const what = String(node.props.accessibilityLabel ?? textOf(node));
        const role = node.props.accessibilityRole;
        const style = flat(node);
        const height = style.minHeight;
        return [
          !['button', 'link', 'tab', 'radio'].includes(role) && `${what}: role ${role}`,
          what.length === 0 && 'a pressable with no name',
          !(typeof height === 'number' && height >= layout.touchTarget) && `${what}: under 44 pt`,
          !wideEnough(node) && `${what}: under 44 pt wide`,
        ];
      })
      .flat()
      .filter(Boolean);
    expect(problems).toEqual([]);
  });

  it('lets every text on Home grow with the font size, wrapping, never clipped or cut short', async () => {
    await start();
    await scrollToEnd();
    const found = screen.queryAllByText(/[\s\S]/, { includeHiddenElements: true });
    expect(found.length).toBeGreaterThan(100);
    const problems: string[] = [];
    for (const node of found) {
      const text = [node.props.children].flat().join('');
      if (node.props.allowFontScaling === false) problems.push(`${text}: no font scaling`);
      if (node.props.numberOfLines !== undefined) problems.push(`${text}: a line limit`);
      if (node.props.adjustsFontSizeToFit) problems.push(`${text}: shrinks to fit`);
      for (let at: Node | null = node; at && at.props.testID !== 'home-scroll'; at = at.parent) {
        const style = flat(at);
        if (typeof style.height === 'number' || typeof style.maxHeight === 'number') problems.push(`${text}: a fixed height`);
        if (style.overflow === 'hidden') problems.push(`${text}: clipped`);
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it('keeps the chips on one sideways-scrolling line, so large text never pushes them off', async () => {
    await start();
    const group = only(screen.queryAllByTestId('home-filters'), 'filter group');
    expect(group.props.horizontal).toBe(true);
  });
});

describe('on iPad', () => {
  const widthOf = (name: string) => flat(link(name)).width;

  it('shows more cards: posters 168 pt and the big cards about a third of the column, the hero 21:9', async () => {
    mockWindow = IPAD;
    await start();
    expect(widthOf('trending 1, 2020, Movie, TMDB rating 6.0 out of 10, Ready to watch')).toBe(168);
    expect(widthOf('popular-movies 1, 2020, TMDB rating 6.0 out of 10, Ready to watch')).toBe(Math.round((1024 - 32) * 0.36));
    const images = screen.queryAllByTestId('tmdb-image', { includeHiddenElements: true }).map((node) => String(node.props.source?.uri));
    expect(images.some((uri) => uri.includes('/w1280/'))).toBe(true);
    const frames = screen.queryAllByTestId('hero-slide-first').map((node) => node.props.style?.width);
    expect(frames).toEqual([1024 - 32]);
    expect(only(screen.queryAllByTestId('screen-column'), 'column').props.style.flat?.(Infinity).some((style: { maxWidth?: number } | undefined) => style?.maxWidth === 1152)).toBe(true);
  });

  it('on a phone: posters 132 pt and the big cards nearly the column\'s width, the next one peeking', async () => {
    await start();
    expect(widthOf('trending 1, 2020, Movie, TMDB rating 6.0 out of 10, Ready to watch')).toBe(132);
    expect(widthOf('popular-movies 1, 2020, TMDB rating 6.0 out of 10, Ready to watch')).toBe(Math.round((390 - 32) * 0.92));
  });
});

describe('the sideways rows', () => {
  /** Each card row's and the studios' strip's stops, as numbers, with the width of what it holds. */
  const rows = () =>
    [...screen.queryAllByTestId('card-row'), ...screen.queryAllByTestId('studio-strip')].map((node) => {
      const links = within(node).queryAllByRole('link');
      const tiles = within(node).queryAllByRole('image');
      return {
        id: String(node.props.testID),
        count: links.length || tiles.length,
        item: links.length ? Number(flat(links[0]!).width) : STUDIO_TILE_WIDTH,
        offsets: (node.props.snapToOffsets as number[] | undefined) ?? [],
        horizontal: node.props.horizontal === true,
        deceleration: String(node.props.decelerationRate),
        oneAtATime: node.props.disableIntervalMomentum,
        interval: node.props.snapToInterval,
        paging: node.props.pagingEnabled,
      };
    });

  async function checkAll(width: number, tablet: boolean) {
    const column = width - 32;
    const widths = cardWidths(column, tablet);
    const found = rows();
    // Trending, the three big-card rows, Upcoming movies and series, the eight services, and the studios.
    expect(found.filter((row) => row.id === 'card-row').length).toBe(6 + 8);
    expect(found.filter((row) => row.id === 'studio-strip').length).toBe(1);
    expect([...new Set(found.map((row) => row.item))].sort()).toEqual([widths.backdrop, widths.poster, STUDIO_TILE_WIDTH].sort());
    const wrong = found.filter((row) => {
      const expected = snapOffsets(row.count, row.item, CARD_GAP, column) ?? [];
      return expected.length !== row.offsets.length || expected.some((offset, at) => Math.abs(offset - row.offsets[at]!) > 1e-9);
    });
    expect(wrong.map((row) => `${row.id} ${row.item}`)).toEqual([]);
    // Free momentum, so a fast flick still travels several cards; only where it stops snaps. A row that fits whole
    // (the studios on an iPad) has nowhere to scroll and no stops.
    const snapping = found.filter((row) => row.offsets.length > 0);
    expect(found.filter((row) => !row.offsets.length && row.count * row.item + (row.count - 1) * CARD_GAP > column).length).toBe(0);
    expect([...new Set(snapping.map((row) => `${row.horizontal} ${row.deceleration} ${row.oneAtATime} ${row.interval} ${row.paging}`))]).toEqual([
      'true normal undefined undefined undefined',
    ]);
    expect(snapping.filter((row) => row.id === 'card-row').length).toBe(6 + 8);
    return found;
  }

  it('on a phone: every row and the studios snap with a card centred, from the row start to its end', async () => {
    await start();
    await scrollToEnd();
    const found = await checkAll(PHONE.width, false);
    const big = found.find((row) => row.item === cardWidths(PHONE.width - 32, false).backdrop)!;
    expect(big.offsets[0]).toBe(0);
    expect(big.offsets.at(-1)).toBe(big.count * big.item + (big.count - 1) * CARD_GAP - (PHONE.width - 32));
  });

  it('on iPad: the same, for its wider cards and column', async () => {
    mockWindow = IPAD;
    await start();
    await scrollToEnd({ width: IPAD.width, height: IPAD.height });
    await checkAll(IPAD.width, true);
  });

  it('keeps the hero paged a slide at a time, as before', async () => {
    await start();
    const track = only(screen.queryAllByTestId('hero-track'), 'hero track');
    expect(track.props.pagingEnabled).toBe(true);
    expect(track.props.snapToOffsets).toBeUndefined();
  });

  it('keeps each row where it was left, and its stops, on coming Back from a title', async () => {
    // The mock ScrollView's scrollTo is a jest.fn every row shares.
    const scrolls = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => undefined);
    scrolls.mockClear();
    const app = await start();
    const before = rows().map((row) => row.offsets.join(','));
    expect(before.length).toBeGreaterThan(0);
    const first = () => screen.queryAllByTestId('card-row')[0]!;
    const { offsets } = rows()[0]!;
    const column = PHONE.width - 32;
    // The member leaves the first row a little past its third stop (as a focused card can) and opens a title.
    await fireEvent(first(), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: column, height: 240 } } });
    await fireEvent(first(), 'scroll', { nativeEvent: { contentOffset: { x: offsets[2]! + 40, y: 0 } } });
    const row = first();
    await pressNode(screen.queryAllByRole('link')[0]!);
    expect(app.getPathname()).toMatch(/^\/home\/(movie|tv)\/\d+$/);
    await pressNode(buttonNamed('Back'));
    expect(rows().map((found) => found.offsets.join(','))).toEqual(before);
    // The same row, not a new one at its start: a change of width now snaps it from where it was left.
    expect(first() === row).toBe(true);
    expect(scrolls.mock.calls.length).toBe(0);
    await fireEvent(first(), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: column - 1, height: 240 } } });
    expect(scrolls.mock.calls.map(([to]) => (to as { x: number }).x)).toEqual([offsets[2]]);
    scrolls.mockRestore();
  });
});

describe('on a 320 pt phone', () => {
  const widthOf = (node: Node) => {
    const style = flat(node);
    return typeof style.width === 'number' ? style.width : Number(style.minWidth);
  };
  /** The hero's buttons on one line, end to end with the line's gaps: never wider than the column. */
  const lineWidth = (line: Node, buttons: Node[]) => buttons.reduce((sum, node) => sum + widthOf(node), 0) + Number(flat(line).gap ?? 0) * (buttons.length - 1);
  const names = (nodes: Node[]) => nodes.map((node) => String(node.props.accessibilityLabel));

  it("puts the hero's dots on a line of their own over Previous and Next, each a thumb's size and none past the column", async () => {
    mockWindow = NARROW;
    await start();
    const column = NARROW.width - 32;
    const controls = only(screen.queryAllByTestId('hero-controls'), 'hero controls');
    const dotLine = only(screen.queryAllByTestId('hero-dots'), 'hero dots');
    expect(within(controls).queryAllByTestId('hero-dots')).toHaveLength(0);
    const buttons = within(controls).queryAllByRole('button');
    const dots = within(dotLine).queryAllByRole('button');
    expect(names(buttons)).toEqual(['Previous title', 'Next title']);
    expect(dots).toHaveLength(5);
    const small = [...buttons, ...dots]
      .filter((node) => !(widthOf(node) >= layout.touchTarget && Number(flat(node).minHeight) >= layout.touchTarget))
      .map((node) => String(node.props.accessibilityLabel));
    expect(small).toEqual([]);
    expect(lineWidth(controls, buttons)).toBeLessThanOrEqual(column);
    expect(lineWidth(dotLine, dots)).toBeLessThanOrEqual(column);
    // More titles than fit would wrap onto another line rather than run off the screen.
    expect(flat(dotLine).flexWrap).toBe('wrap');
  });

  it('keeps Previous, the dots and Next on one line where they fit', async () => {
    await start();
    const controls = only(screen.queryAllByTestId('hero-controls'), 'hero controls');
    expect(within(controls).queryAllByTestId('hero-dots')).toHaveLength(1);
    expect(within(controls).queryAllByRole('button')).toHaveLength(7);
    const dotLine = only(screen.queryAllByTestId('hero-dots'), 'hero dots');
    // Previous, the gap, the dots, the gap and Next.
    const width = lineWidth(controls, [buttonNamed('Previous title'), buttonNamed('Next title')]) + Number(flat(controls).gap) + lineWidth(dotLine, within(dotLine).queryAllByRole('button'));
    expect(width).toBeLessThanOrEqual(PHONE.width - 32);
  });
});
