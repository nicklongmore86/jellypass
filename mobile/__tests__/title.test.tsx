// The movie, series and season pages through the real router, signed in, with a fake gateway: what each shows (the
// backdrop, title, facts, genres, the status said once, its note), the one action (Play through the allowlist, Get
// this, or nothing), the season cards with their selection circles and Select all, Get this's one fixed confirmation
// whatever the answer, disabled while it is out, its fixed errors, never sent again by itself, a 401 signing out, and
// Requested right after Get this here and on Home with no call. Then accessibility (every control named and a thumb's
// size, text that grows, the iPad layout) and privacy. The calls on opening are pinned by title-budget.test.tsx.
// Queries are queryAll* and assertions read single fields, so a failure never prints the component tree.
import { act, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { AppState, Linking, type AppStateStatus } from 'react-native';

import type { FetchLike } from '../src/api/client';
import { layout } from '../src/theme';
import { ASKED_TTL_MS } from '../src/title/asked';
import { GET_THIS_TEXT } from '../src/title/text';
import { API } from './support/home';
import { ORIGIN, TOKEN, answer, keepSession, offline, settle, shows, store, storedSession, type Call } from './support/household';
import {
  buttonNamed,
  checkboxes,
  checkboxNamed,
  flat,
  getMessage,
  headings,
  linkNamed,
  movieAnswer,
  only,
  PLAY_URL,
  pressNode,
  seasonAnswer,
  seriesAnswer,
  spokenStatus,
  titleGateway,
  type TitleHousehold,
} from './support/title';

// Home sits under every title page here, and is laid out with it: slower CI runners need more than Jest's 5 s.
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
let mockWindow = PHONE;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow }));

let gateway: ReturnType<typeof titleGateway>;
let openURL: jest.SpyInstance;

function useHousehold(household: TitleHousehold = {}) {
  gateway = titleGateway(household);
  mockFetch = gateway.fetch;
}

beforeEach(() => {
  mockWindow = PHONE;
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  useHousehold();
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

afterEach(() => openURL.mockRestore());

/** Starts on Home, signed in, then opens `path` on the Home tab's stack. */
async function open(path: string) {
  const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  await act(async () => router.push(path));
  await settle();
  return app;
}

/** Lets `ms` pass, on the fake clock the router's test renderer runs on. */
async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
}

const posts = () => gateway.calls.filter((call) => call.init.method === 'POST' && call.route.endsWith('/get'));
const bodies = () => posts().map((call) => call.init.body);

/** A Get this held until the test lets it answer. */
function held() {
  const waiting: ((status: number) => void)[] = [];
  const getThis = () =>
    new Promise<ReturnType<typeof answer>>((resolve) => {
      waiting.push((status) => resolve(answer(status, status < 300 ? { status: 'accepted' } : { error: 'unavailable' })));
    });
  return { getThis, release: (status = 202) => waiting.shift()!(status) };
}

describe('a movie page', () => {
  it('shows the backdrop, the title, its facts and genres, the status said once, and Play for a film in the library', async () => {
    useHousehold({ movies: { 7: movieAnswer(7, 'in_library') } });
    await open('/home/movie/7');
    expect(headings()[0]).toBe('Film 7');
    for (const text of ['2024', '1 h 58 min', '★ 7.4 TMDB', 'Drama', 'Comedy', 'The overview of film 7.']) expect(shows(text)).toBe(true);
    expect(screen.queryAllByLabelText('TMDB rating 7.4 out of 10')).toHaveLength(1);
    expect(spokenStatus()).toEqual(['Ready to watch']);
    const backdrop = only(screen.queryAllByTestId('detail-backdrop', { includeHiddenElements: true }), 'backdrop');
    expect(flat(backdrop).aspectRatio).toBeCloseTo(16 / 9);
    expect(flat(backdrop).borderRadius).toBe(30);
    // The phone has no poster beside the title.
    expect(screen.queryAllByTestId('detail-poster', { includeHiddenElements: true })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: /^Get this/ })).toHaveLength(0);
    await pressNode(buttonNamed('Play Film 7'));
    expect(openURL.mock.calls).toEqual([[PLAY_URL]]);
  });

  it('offers no Play when the link is not the household\'s own Jellyfin, and shows only the status', async () => {
    useHousehold({ movies: { 7: movieAnswer(7, 'in_library', { play: { itemId: 'abc', url: 'https://elsewhere.example.test/web/#/details?id=abc' } }) } });
    await open('/home/movie/7');
    expect(screen.queryAllByRole('button', { name: /^Play/ })).toHaveLength(0);
    expect(spokenStatus()).toEqual(['Ready to watch']);
  });

  it.each([
    ['unavailable', "Can't request", "This title can't be requested."],
    ['requested', 'Requested', 'Check My requests to follow it.'],
  ] as const)('shows a %s film\'s status and its one note, and no button', async (state, word, note) => {
    useHousehold({ movies: { 7: movieAnswer(7, state) } });
    await open('/home/movie/7');
    expect(spokenStatus()).toEqual([word]);
    expect(shows(note)).toBe(true);
    expect(screen.queryAllByRole('button', { name: /^(Get this|Play)/ })).toHaveLength(0);
  });

  it('shows a film the household asked for that failed as "We couldn\'t get this", with the admin note and no button', async () => {
    useHousehold({ requests: { results: [{ id: 'AAAAAAAAAAAAAAAAAAAAAA', mediaType: 'movie', tmdbId: 7, status: 'failed', seasons: [], byYou: true }] } });
    await open('/home/movie/7');
    expect(spokenStatus()).toEqual(["We couldn't get this"]);
    expect(shows(GET_THIS_TEXT.failedNote)).toBe(true);
    expect(screen.queryAllByRole('button', { name: /^Get this/ })).toHaveLength(0);
  });

  it('shows Not found for a title the API does not know, with no Try again', async () => {
    useHousehold({ override: (call) => (call.route === `GET ${API}/movie/7` ? answer(404, { error: 'not_found' }) : undefined) });
    await open('/home/movie/7');
    expect(shows('Not found')).toBe(true);
    expect(screen.queryAllByRole('button', { name: 'Try again' })).toHaveLength(0);
  });

  it('shows a failure to load with Try again, which reads the page once more, and never by itself', async () => {
    let fail = true;
    useHousehold({ override: (call) => (call.route === `GET ${API}/movie/7` && fail ? answer(502, { error: 'unavailable' }) : undefined) });
    await open('/home/movie/7');
    expect(shows("Can't load this right now")).toBe(true);
    await wait(60_000);
    expect(gateway.routes().filter((route) => route === `GET ${API}/movie/7`)).toHaveLength(1);
    fail = false;
    await pressNode(buttonNamed('Try again'));
    expect(headings()[0]).toBe('Film 7');
    expect(gateway.routes().filter((route) => route === `GET ${API}/movie/7`)).toHaveLength(2);
  });

  it('makes no call for an address that names no title', async () => {
    await open('/home/movie/07');
    expect(shows('Not found')).toBe(true);
    expect(gateway.routes().filter((route) => route.includes('/movie/'))).toEqual([]);
  });
});

describe('Get this', () => {
  it('sends a film once, says "Sending…" with everything disabled while it is out, then the one confirmation and Requested', async () => {
    const gate = held();
    useHousehold({ getThis: gate.getThis });
    await open('/home/movie/7');
    expect(spokenStatus()).toEqual(['Available to get']);
    await pressNode(buttonNamed('Get this: Film 7'));
    const sending = buttonNamed('Get this: Film 7');
    expect([String(sending.props.accessibilityState?.disabled), String(sending.props.accessibilityState?.busy)]).toEqual(['true', 'true']);
    expect(shows(GET_THIS_TEXT.sending)).toBe(true);
    await pressNode(sending);
    expect(bodies()).toEqual(['{}']);
    await act(async () => gate.release(202));
    await settle();
    expect(getMessage()).toBe(GET_THIS_TEXT.confirmation);
    // The server still says get_this (it records a moment later): the overlay says Requested.
    expect(spokenStatus()).toEqual(['Requested']);
    expect(screen.queryAllByRole('button', { name: /^Get this/ })).toHaveLength(0);
    expect(posts().map((call) => call.route)).toEqual([`POST ${API}/movie/7/get`]);
  });

  it.each([
    ['202 accepted', () => answer(202, { status: 'accepted' })],
    ['200 with no body', () => answer(200)],
    ['204', () => answer(204)],
  ])('says the same fixed confirmation whatever the 2xx (%s)', async (_what, respond) => {
    useHousehold({ getThis: respond });
    await open('/home/movie/7');
    await pressNode(buttonNamed('Get this: Film 7'));
    expect(getMessage()).toBe(GET_THIS_TEXT.confirmation);
  });

  it.each([
    ['a 429', () => answer(429, { error: 'too_many_requests' }, { 'Retry-After': '30' }), GET_THIS_TEXT.rate_limited],
    ['no answer', offline, GET_THIS_TEXT.offline],
    ['a 502', () => answer(502, { error: 'unavailable' }), GET_THIS_TEXT.unavailable],
    ['a 404', () => answer(404, { error: 'not_found' }), GET_THIS_TEXT.unavailable],
    ['a 400', () => answer(400, { error: 'invalid_request' }), GET_THIS_TEXT.unavailable],
  ] as const)('says the fixed words for %s, offers the button again, and never sends again by itself', async (_what, respond, words) => {
    useHousehold({ getThis: respond as (call: Call) => ReturnType<typeof answer> });
    await open('/home/movie/7');
    await pressNode(buttonNamed('Get this: Film 7'));
    expect(getMessage()).toBe(words);
    expect(spokenStatus()).toEqual(['Available to get']);
    const again = buttonNamed('Get this: Film 7');
    expect(again.props.accessibilityState?.disabled).toBe(false);
    await wait(5 * 60_000);
    expect(posts()).toHaveLength(1);
  });

  it('signs the member out on a 401 and forgets the overlay', async () => {
    useHousehold({ getThis: () => answer(401, { error: 'unauthorized' }), override: (call) => (call.route === 'GET /Users/Public' ? answer(200, []) : undefined) });
    const app = await open('/home/movie/7');
    await pressNode(buttonNamed('Get this: Film 7'));
    await settle();
    expect(storedSession()).toBeUndefined();
    expect(app.getPathname()).toBe('/');
    expect(shows(/Your sign-in has expired/)).toBe(true);
  });

  it('keeps the confirmation when the page cannot be read again, with the fixed error and Try again', async () => {
    let reads = 0;
    useHousehold({
      override: (call) => {
        if (call.route !== `GET ${API}/movie/7`) return undefined;
        reads += 1;
        return reads > 1 ? answer(502, { error: 'unavailable' }) : undefined;
      },
    });
    await open('/home/movie/7');
    await pressNode(buttonNamed('Get this: Film 7'));
    expect(getMessage()).toBe(GET_THIS_TEXT.confirmation);
    expect(shows('Something went wrong. Try again in a moment.')).toBe(true);
    expect(screen.queryAllByRole('button', { name: 'Try again' })).toHaveLength(1);
    expect(screen.queryAllByRole('button', { name: /^Get this/ })).toHaveLength(0);
  });
});

describe('a series page', () => {
  it('lists the seasons as cards, each a link with its episodes and status, a circle only where the household can ask', async () => {
    useHousehold({ series: { 9: seriesAnswer(9, ['in_library', 'get_this', 'get_this', 'unavailable']) } });
    await open('/home/tv/9');
    expect(headings()).toEqual(['Series 9', 'Seasons']);
    for (const text of ['2023', '4 seasons', '★ 8.1 TMDB', 'Drama']) expect(shows(text)).toBe(true);
    expect(screen.queryAllByRole('link').filter((node) => /^(Specials|Season)/.test(String(node.props.accessibilityLabel))).map((node) => node.props.accessibilityLabel)).toEqual([
      "Specials, 2 episodes, Can't request",
      'Season 1, 8 episodes, Ready to watch',
      'Season 2, 9 episodes, Available to get',
      'Season 3, 10 episodes, Available to get',
      "Season 4, 11 episodes, Can't request",
    ]);
    expect(checkboxes()).toEqual(['Season 2', 'Season 3']);
    expect(shows(GET_THIS_TEXT.chooseSeasons)).toBe(true);
  });

  it('keeps Play as the main action of a series partly in the library, with Get this outlined', async () => {
    useHousehold({ series: { 9: seriesAnswer(9, ['in_library', 'get_this']) } });
    await open('/home/tv/9');
    expect(flat(buttonNamed('Play Series 9')).backgroundColor).toBe('#00a4dc');
    const get = buttonNamed('Get this: Series 9');
    expect(flat(get).backgroundColor).not.toBe('#00a4dc');
    expect(flat(get).borderColor).toBe('#00a4dc');
  });

  it('asks for nothing until a season is chosen; Select all only moves the circles; Get this sends exactly those chosen', async () => {
    useHousehold({ series: { 9: seriesAnswer(9, ['get_this', 'get_this', 'get_this']) } });
    await open('/home/tv/9');
    expect(buttonNamed('Get this: Series 9').props.accessibilityState?.disabled).toBe(true);
    expect(shows(GET_THIS_TEXT.chooseBelow)).toBe(true);
    await pressNode(buttonNamed('Select all'));
    expect(checkboxes()).toEqual(['Season 1 ✓', 'Season 2 ✓', 'Season 3 ✓']);
    expect(posts()).toHaveLength(0);
    await pressNode(buttonNamed('Clear all'));
    expect(checkboxes()).toEqual(['Season 1', 'Season 2', 'Season 3']);
    await pressNode(checkboxNamed('Season 3'));
    await pressNode(checkboxNamed('Season 1'));
    expect(shows(GET_THIS_TEXT.chooseBelow)).toBe(false);
    await pressNode(buttonNamed('Get this: Series 9'));
    expect(bodies()).toEqual([JSON.stringify({ seasons: [1, 3] })]);
    expect(getMessage()).toBe(GET_THIS_TEXT.confirmation);
    // Read again: the seasons asked for show Requested and are not offered again; the other still is.
    expect(checkboxes()).toEqual(['Season 2']);
    expect(spokenStatus()).toEqual(['Requested']);
    expect(screen.queryAllByRole('link', { name: 'Season 1, 8 episodes, Requested' })).toHaveLength(1);
    expect(screen.queryAllByRole('link', { name: 'Season 2, 9 episodes, Available to get' })).toHaveLength(1);
  });

  it('disables the circles and Select all while Get this is out', async () => {
    const gate = held();
    useHousehold({ series: { 9: seriesAnswer(9, ['get_this', 'get_this']) }, getThis: gate.getThis });
    await open('/home/tv/9');
    await pressNode(checkboxNamed('Season 2'));
    await pressNode(buttonNamed('Get this: Series 9'));
    expect(checkboxNamed('Season 1').props.accessibilityState?.disabled).toBe(true);
    expect(buttonNamed('Select all').props.accessibilityState?.disabled).toBe(true);
    await act(async () => gate.release(202));
    await settle();
  });

  it('shows a season the household asked for that failed as "We couldn\'t get this", not offered again', async () => {
    useHousehold({
      series: { 9: seriesAnswer(9, ['get_this', 'get_this']) },
      requests: { results: [{ id: 'AAAAAAAAAAAAAAAAAAAAAA', mediaType: 'tv', tmdbId: 9, status: 'requested', seasons: [{ seasonNumber: 2, status: 'failed' }], byYou: false }] },
    });
    await open('/home/tv/9');
    expect(checkboxes()).toEqual(['Season 1']);
    expect(screen.queryAllByRole('link', { name: "Season 2, 9 episodes, We couldn't get this" })).toHaveLength(1);
    expect(shows(GET_THIS_TEXT.failedNote)).toBe(true);
  });

  it('opens a season\'s page from its card, with Back to the series', async () => {
    const app = await open('/home/tv/9');
    await pressNode(linkNamed('Season 2, 9 episodes, Available to get'));
    expect(app.getPathname()).toBe('/home/tv/9/season/2');
    await pressNode(buttonNamed('Back'));
    expect(app.getPathname()).toBe('/home/tv/9');
  });
});

describe('a season page', () => {
  it('shows the series\' name and backdrop, the season, its episodes and its status, and asks for that season alone', async () => {
    useHousehold({ seasons: { '9:2': seasonAnswer(9, 2, 'get_this') } });
    await open('/home/tv/9/season/2');
    expect(headings()).toEqual(['Season 2', '1. Pilot', '2. Episode 2']);
    for (const text of ['Series 9', '2 episodes', 'The overview of season 2.', 'The first.']) expect(shows(text)).toBe(true);
    expect(screen.queryAllByTestId('tmdb-image', { includeHiddenElements: true }).map((node) => String(node.props.source?.uri))).toContain(
      'https://image.tmdb.org/t/p/w780/backdrop-9.jpg',
    );
    expect(spokenStatus()).toEqual(['Available to get']);
    await pressNode(buttonNamed('Get this: Series 9 Season 2'));
    expect(bodies()).toEqual([JSON.stringify({ seasons: [2] })]);
    expect(getMessage()).toBe(GET_THIS_TEXT.confirmation);
    expect(spokenStatus()).toEqual(['Requested']);
  });

  it('signs the member out when the series behind it answers 401, though the season and the requests were read', async () => {
    useHousehold({
      seasons: { '9:2': seasonAnswer(9, 2, 'get_this') },
      override: (call) =>
        call.route === `GET ${API}/tv/9` ? answer(401, { error: 'unauthorized' }) : call.route === 'GET /Users/Public' ? answer(200, []) : undefined,
    });
    const app = await open('/home/tv/9/season/2');
    await settle();
    expect([`GET ${API}/tv/9/season/2`, `GET ${API}/requests`].map((route) => gateway.routes().includes(route))).toEqual([true, true]);
    expect(storedSession()).toBeUndefined();
    expect(app.getPathname()).toBe('/');
    expect(shows(/Your sign-in has expired/)).toBe(true);
  });

  it('still shows the season when the series behind it fails any other way', async () => {
    useHousehold({
      seasons: { '9:2': seasonAnswer(9, 2, 'get_this') },
      override: (call) => (call.route === `GET ${API}/tv/9` ? answer(502, { error: 'unavailable' }) : undefined),
    });
    await open('/home/tv/9/season/2');
    expect(headings()[0]).toBe('Season 2');
    expect(spokenStatus()).toEqual(['Available to get']);
    expect(storedSession()).toBeDefined();
  });

  it('offers nothing for a season in the library', async () => {
    useHousehold({ seasons: { '9:1': seasonAnswer(9, 1, 'in_library') } });
    await open('/home/tv/9/season/1');
    expect(spokenStatus()).toEqual(['Ready to watch']);
    expect(screen.queryAllByRole('button', { name: /^Get this/ })).toHaveLength(0);
  });
});

describe('Requested right after Get this', () => {
  const homeCard = (state: string) => screen.queryAllByRole('link', { name: `trending 2, 2021, Series, TMDB rating 6.5 out of 10, ${state}` });

  it('shows on Home\'s card at once, with no call, and on the title page the server still calls get_this', async () => {
    useHousehold({ series: { 1002: seriesAnswer(1002, ['get_this']) } });
    await open('/');
    await pressNode(homeCard('Available to get')[0]!);
    await pressNode(checkboxNamed('Season 1'));
    await pressNode(buttonNamed('Get this: Series 1002'));
    const before = gateway.routes().length;
    await pressNode(buttonNamed('Back'));
    expect(homeCard('Requested')).toHaveLength(1);
    expect(homeCard('Available to get')).toHaveLength(0);
    expect(gateway.routes().length).toBe(before);
  });

  it.each([
    ['requested', 'Requested'],
    ['in_library', 'Ready to watch'],
  ] as const)('keeps Home\'s card on the server\'s %s once the title is opened again and its key is dropped', async (state, word) => {
    let server: 'get_this' | typeof state = 'get_this';
    useHousehold({ override: (call) => (call.route === `GET ${API}/tv/1002` ? answer(200, seriesAnswer(1002, [server])) : undefined) });
    await open('/');
    await pressNode(homeCard('Available to get')[0]!);
    await pressNode(checkboxNamed('Season 1'));
    await pressNode(buttonNamed('Get this: Series 1002'));
    await pressNode(buttonNamed('Back'));
    expect(homeCard('Requested')).toHaveLength(1);
    // The server has recorded it now: opening the title again reads that, and the Requested key is dropped.
    server = state;
    await pressNode(homeCard('Requested')[0]!);
    expect(spokenStatus()[0]).toBe(word);
    // Back on Home at once: the row still holds its first answer (get_this), but the fresher one wins.
    await pressNode(buttonNamed('Back'));
    expect(homeCard(word)).toHaveLength(1);
    expect(homeCard('Available to get')).toHaveLength(0);
  });

  // AppState is React Native's Jest mock: what the app listens with is in its calls.
  const addEventListener = AppState.addEventListener as jest.MockedFunction<typeof AppState.addEventListener>;
  beforeEach(() => addEventListener.mockClear());
  /** Tells the app's AppState listeners it is now `state`. */
  async function foreground(state: AppStateStatus) {
    await act(async () => {
      for (const [type, listener] of addEventListener.mock.calls) if (type === 'change') listener(state);
    });
    await settle();
  }

  it('ends after two minutes on the title page left open: the server\'s get_this is shown again, with no call', async () => {
    await open('/home/movie/7');
    await pressNode(buttonNamed('Get this: Film 7'));
    expect(spokenStatus()).toEqual(['Requested']);
    const before = gateway.routes().length;
    await wait(ASKED_TTL_MS - 1_000);
    expect(spokenStatus()).toEqual(['Requested']);
    await wait(1_000);
    expect(spokenStatus()).toEqual(['Available to get']);
    expect(gateway.routes().length).toBe(before);
  });

  it('ends after two minutes on Home left open: its card shows the server\'s state again, with no call', async () => {
    useHousehold({ series: { 1002: seriesAnswer(1002, ['get_this']) } });
    await open('/');
    await pressNode(homeCard('Available to get')[0]!);
    await pressNode(checkboxNamed('Season 1'));
    await pressNode(buttonNamed('Get this: Series 1002'));
    await pressNode(buttonNamed('Back'));
    expect(homeCard('Requested')).toHaveLength(1);
    const before = gateway.routes().length;
    await wait(ASKED_TTL_MS);
    expect(homeCard('Available to get')).toHaveLength(1);
    expect(homeCard('Requested')).toHaveLength(0);
    expect(gateway.routes().length).toBe(before);
  });

  it('ends on coming back to the foreground once the wall clock has moved two minutes while the app slept', async () => {
    useHousehold({ series: { 1002: seriesAnswer(1002, ['get_this']) } });
    await open('/');
    await pressNode(homeCard('Available to get')[0]!);
    await pressNode(checkboxNamed('Season 1'));
    await pressNode(buttonNamed('Get this: Series 1002'));
    await pressNode(buttonNamed('Back'));
    const before = gateway.routes().length;
    // Suspended: the wall clock moved on, the monotonic clock (and the timer) did not.
    jest.setSystemTime(Date.now() + 10 * ASKED_TTL_MS);
    await foreground('background');
    expect(homeCard('Requested')).toHaveLength(1);
    await foreground('active');
    expect(homeCard('Available to get')).toHaveLength(1);
    expect(homeCard('Requested')).toHaveLength(0);
    expect(gateway.routes().length).toBe(before);
  });

  it('ends on the title page left open when the app comes back to the foreground after a long sleep', async () => {
    await open('/home/movie/7');
    await pressNode(buttonNamed('Get this: Film 7'));
    expect(spokenStatus()).toEqual(['Requested']);
    jest.setSystemTime(Date.now() + 10 * ASKED_TTL_MS);
    await foreground('active');
    expect(spokenStatus()).toEqual(['Available to get']);
  });

  it('is dropped once the server says anything but get_this', async () => {
    let state: 'get_this' | 'in_library' = 'get_this';
    useHousehold({ override: (call) => (call.route === `GET ${API}/movie/7` ? answer(200, movieAnswer(7, state)) : undefined) });
    await open('/home/movie/7');
    await pressNode(buttonNamed('Get this: Film 7'));
    state = 'in_library';
    await pressNode(buttonNamed('Back'));
    await act(async () => router.push('/home/movie/7'));
    await settle();
    expect(spokenStatus()).toEqual(['Ready to watch']);
    state = 'get_this';
    await pressNode(buttonNamed('Back'));
    await act(async () => router.push('/home/movie/7'));
    await settle();
    expect(spokenStatus()).toEqual(['Available to get']);
  });
});

/** The text a node holds, its own and its descendants'. */
type Node = NonNullable<ReturnType<typeof screen.queryAllByText>[number]>;
function textOf(node: Node): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

/** Every host node on the title page that answers a press (the page's own, not Home's underneath). */
function pagePressables(): Node[] {
  const found: Node[] = [];
  const visit = (node: Node) => {
    const { onPress, onClick, onResponderRelease } = node.props;
    if ([onPress, onClick, onResponderRelease].some((handler) => typeof handler === 'function')) found.push(node);
    for (const child of node.children) if (typeof child !== 'string') visit(child);
  };
  const columns = screen.queryAllByTestId('screen-column');
  visit(columns[columns.length - 1]!);
  return found;
}

describe('accessibility', () => {
  it.each([
    ['a film in the library', '/home/movie/7', { movies: { 7: movieAnswer(7, 'in_library') } }, ['Play Film 7']],
    ['a film to get', '/home/movie/7', {}, ['Get this: Film 7']],
    ['a series', '/home/tv/9', { series: { 9: seriesAnswer(9, ['in_library', 'get_this', 'get_this']) } }, ['Play Series 9', 'Get this: Series 9', 'Select all']],
    ['a season', '/home/tv/9/season/2', {}, ['Get this: Series 9 Season 2']],
  ] as const)('keeps every control on %s named and a thumb\'s size', async (_what, path, household, expected) => {
    useHousehold(household as TitleHousehold);
    await open(path);
    const found = pagePressables();
    expect(found.length).toBeGreaterThanOrEqual(expected.length);
    const named = found.map((node) => String(node.props.accessibilityLabel ?? textOf(node)));
    expect(named).toEqual(expect.arrayContaining([...expected]));
    const problems = found
      .map((node) => {
        const what = String(node.props.accessibilityLabel ?? textOf(node));
        const style = flat(node);
        return [
          !['button', 'link', 'checkbox'].includes(node.props.accessibilityRole) && `${what}: role ${node.props.accessibilityRole}`,
          what.length === 0 && 'a pressable with no name',
          !(typeof style.minHeight === 'number' && style.minHeight >= layout.touchTarget) && `${what}: under 44 pt`,
          typeof style.width === 'number' && style.width < layout.touchTarget && `${what}: under 44 pt wide`,
        ];
      })
      .flat()
      .filter(Boolean);
    expect(problems).toEqual([]);
    // The header's Back is a thumb's size too.
    expect(flat(buttonNamed('Back')).minHeight).toBe(layout.touchTarget);
  });

  it('names the title, year, rating and status once each', async () => {
    useHousehold({ movies: { 7: movieAnswer(7, 'in_library') } });
    await open('/home/movie/7');
    const page = screen.queryAllByTestId('screen-column').at(-1)!;
    const spoken = (pattern: RegExp) =>
      [...screen.queryAllByText(pattern), ...screen.queryAllByLabelText(pattern)].filter((node, at, all) => all.indexOf(node) === at && isInside(node, page));
    expect(spoken(/^Film 7$/)).toHaveLength(1);
    expect(spoken(/^2024$/)).toHaveLength(1);
    expect(spoken(/^TMDB rating 7\.4 out of 10$/)).toHaveLength(1);
    expect(spoken(/^Ready to watch$/).filter((node) => node.props.accessible)).toHaveLength(1);
    // The header carries only Back: the page's title is its one heading.
    expect(headings().filter((text) => text === 'Film 7')).toHaveLength(1);
  });

  it.each([
    ['a series', '/home/tv/9'],
    ['a season', '/home/tv/9/season/2'],
    ['a film', '/home/movie/7'],
  ])('lets every text on %s grow with the font size, wrapping, never clipped or cut short', async (_what, path) => {
    await open(path);
    const page = screen.queryAllByTestId('screen-column').at(-1)!;
    const found = screen.queryAllByText(/[\s\S]/, { includeHiddenElements: true }).filter((node) => isInside(node, page));
    expect(found.length).toBeGreaterThan(5);
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

  it('on iPad: a wider column, the poster beside the title, the sharper backdrop and the seasons two a row', async () => {
    mockWindow = IPAD;
    await open('/home/tv/9');
    const page = screen.queryAllByTestId('screen-column').at(-1)!;
    expect(flat(page).maxWidth).toBe(960);
    const poster = only(screen.queryAllByTestId('detail-poster', { includeHiddenElements: true }), 'poster');
    expect(flat(poster).width).toBe(144);
    const images = screen.queryAllByTestId('tmdb-image', { includeHiddenElements: true }).map((node) => String(node.props.source?.uri));
    expect(images).toContain('https://image.tmdb.org/t/p/w1280/backdrop-9.jpg');
    expect(flat(only(screen.queryAllByTestId('season-list'), 'season list')).flexWrap).toBe('wrap');
  });
});

function isInside(node: Node, ancestor: Node): boolean {
  for (let at: Node | null = node; at; at = at.parent) if (at === ancestor) return true;
  return false;
}

describe('privacy', () => {
  it('keeps nothing on the device, loads only TMDB images and calls only the household', async () => {
    useHousehold({ series: { 9: seriesAnswer(9, ['get_this']) } });
    await open('/home/tv/9');
    await pressNode(checkboxNamed('Season 1'));
    await pressNode(buttonNamed('Get this: Series 9'));
    expect(store.setItemAsync).not.toHaveBeenCalled();
    const images = screen.queryAllByTestId('tmdb-image', { includeHiddenElements: true }).map((node) => String(node.props.source?.uri));
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((uri) => uri.startsWith('https://image.tmdb.org/t/p/'))).toBe(true);
    expect(gateway.calls.every((call) => call.url.startsWith(`${ORIGIN}/`))).toBe(true);
  });

  it('drops a backdrop off the allowlist, and nothing else', async () => {
    useHousehold({ movies: { 7: movieAnswer(7, 'get_this', { backdropUrl: 'https://elsewhere.example.test/backdrop.jpg' }) } });
    await open('/home/movie/7');
    expect(headings()[0]).toBe('Film 7');
    const images = screen.queryAllByTestId('tmdb-image', { includeHiddenElements: true }).map((node) => String(node.props.source?.uri));
    expect(images.filter((uri) => uri.includes('elsewhere'))).toEqual([]);
  });
});
