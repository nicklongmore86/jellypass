// "Hide what I have" on Home: on at every sign-in, it leaves what the member has (in the library, or asked for, the
// overlay's Requested too) out of the rows and the hero; the hero fills from the next titles of the same answer and is
// not drawn when none is left; choosing it reads nothing; and it is kept in memory for the session only (reset by a
// sign-out, a 401, a change of household and another sign-in). Queries are queryAll* and assertions read single fields,
// so a failure never prints the component tree.
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { renderRouter } from 'expo-router/testing-library';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { FetchLike } from '../src/api/client';
import type { Card } from '../src/api/types';
import { createHideStore, heroSlides, isHeld, visibleCards } from '../src/home/hide';
import { SessionProvider, useSession, type Session } from '../src/session/SessionProvider';
import { layout } from '../src/theme';
import { API, choose, homeGateway, homeHousehold, pageAnswer } from './support/home';
import { ORIGIN, TOKEN, answer, fakeGateway, fixture, IDENTITY, keepSession, METRICS, settle, store } from './support/household';

jest.setTimeout(30_000);

let mockFetch: FetchLike;
jest.mock('../src/api/transport', () => ({
  ...jest.requireActual('../src/api/transport'),
  householdFetch: (url: string, init: never) => mockFetch(url, init),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: jest.requireActual('../app.config').default } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);

// The session Home is using, for the tests that change the overlay from outside (as a request on a title page does).
let mockSession: Session | undefined;
jest.mock('../src/session/SessionProvider', () => {
  const actual = jest.requireActual('../src/session/SessionProvider');
  return { ...actual, useSession: () => (mockSession = actual.useSession()) };
});

const STATES = ['in_library', 'get_this', 'unavailable', 'requested'] as const;
type State = (typeof STATES)[number];

/** Trending answers `states` (ids of their own: a fresher answer for the same title would win over them) (one title each, named `trending N`) and every other list the usual page. */
function useTrending(states: readonly State[], backdrops = true) {
  const base = pageAnswer('trending', states.length);
  const page = { ...base, nextPage: null, results: base.results.map((card, index) => ({ ...card, tmdbId: 5000 + index, state: states[index]!, backdropUrl: backdrops ? card.backdropUrl : null })) };
  const gateway = homeGateway(homeHousehold((call) => (call.route === `GET ${API}/discover/trending` ? answer(200, page) : undefined)));
  mockFetch = gateway.fetch;
  return gateway;
}

let gateway: ReturnType<typeof homeGateway>;

beforeEach(() => {
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  gateway = homeGateway(homeHousehold());
  mockFetch = gateway.fetch;
});

async function start() {
  await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
}

const chip = () => screen.queryAllByTestId('home-hide')[0]!;
const toggle = async () => {
  await fireEvent.press(chip());
  await settle();
};
/** The titles of the first row's cards (Trending, under each filter), by their link names. */
const trendingCards = (): string[] => {
  const slot = screen.queryAllByTestId(/^home-slot-/)[0];
  const row = slot && within(slot).queryAllByTestId('card-row')[0];
  return row ? within(row).queryAllByRole('link').map((node) => String(node.props.accessibilityLabel).split(',')[0]!) : [];
};
/** The hero's titles, by its dots ("Show title 2 of 5: trending 3"); a single slide has no dots, so by its slide. */
const heroTitles = (): string[] => {
  const dots = screen.queryAllByLabelText(/^Show title \d+ of \d+: /).map((node) => String(node.props.accessibilityLabel).replace(/^Show title \d+ of \d+: /, ''));
  if (dots.length) return dots;
  return screen.queryAllByTestId('hero-slide-first').length ? ['one'] : [];
};
const callsMade = () => gateway.routes().length;

describe('Hide what I have: the chip', () => {
  it('is on by default, ticked, and a checkbox named Hide what I have', async () => {
    await start();
    expect([chip().props.accessibilityRole, chip().props.accessibilityLabel, chip().props.accessibilityState]).toEqual(['checkbox', 'Hide what I have', { checked: true }]);
    expect(within(chip()).queryAllByText('Hide what I have').length).toBe(1);
  });

  it('is a thumb tall, styled as the other chips, and is not one of the filters\' radios', async () => {
    await start();
    const style = StyleSheet.flatten(chip().props.style);
    const filter = StyleSheet.flatten(screen.queryAllByRole('radio', { name: 'All' })[0]!.props.style);
    expect([style.minHeight! >= layout.touchTarget, style.borderRadius, style.borderWidth]).toEqual([true, filter.borderRadius, filter.borderWidth]);
    expect(style.backgroundColor).not.toBe(StyleSheet.flatten(screen.queryAllByRole('radio', { name: 'Movies' })[0]!.props.style).backgroundColor);
    expect(screen.queryAllByRole('radio').map((node) => node.props.accessibilityLabel)).toEqual(['All', 'Movies', 'TV']);
    const group = screen.queryAllByTestId('home-filter-group')[0]!;
    expect(within(group).queryAllByTestId('home-hide').length).toBe(0);
  });

  it('turns off and on, announcing its state to a screen reader as checked', async () => {
    await start();
    await toggle();
    expect(chip().props.accessibilityState).toEqual({ checked: false });
    await toggle();
    expect(chip().props.accessibilityState).toEqual({ checked: true });
  });
});

describe('Hide what I have: the rows and the hero', () => {
  it('hides the library\'s and the requested titles from the rows, filling from the cards already loaded', async () => {
    await start();
    // The fixture cycles in_library, get_this, unavailable, requested: 1, 4, 5, 8, … are held.
    const shown = trendingCards();
    expect(shown.slice(0, 4)).toEqual(['trending 2', 'trending 3', 'trending 6', 'trending 7']);
    expect(shown.some((title) => ['trending 1', 'trending 4', 'trending 5'].includes(title))).toBe(false);
  });

  it('hides the same titles from the hero, which fills from the next ones of the same answer', async () => {
    await start();
    expect(heroTitles()).toEqual(['trending 2', 'trending 3', 'trending 6', 'trending 7', 'trending 10']);
  });

  it('shows everything again when it is turned off', async () => {
    await start();
    await toggle();
    expect(trendingCards().slice(0, 5)).toEqual(['trending 1', 'trending 2', 'trending 3', 'trending 4', 'trending 5']);
    expect(heroTitles()).toEqual(['trending 1', 'trending 2', 'trending 3', 'trending 4', 'trending 5']);
  });

  it('keeps the titles that can\'t be requested, which the member does not have', async () => {
    await start();
    expect(trendingCards()).toContain('trending 3');
  });

  it('draws no hero at all when every title is held or has no wide picture', async () => {
    gateway = useTrending(['in_library', 'requested', 'in_library']);
    await start();
    expect(screen.queryAllByTestId('hero').length).toBe(0);
    await toggle();
    expect(screen.queryAllByTestId('hero').length).toBe(1);
    await toggle();
    expect(screen.queryAllByTestId('hero').length).toBe(0);
  });

  it('skips a title with no backdrop for the hero when hiding, and not when everything shows', async () => {
    gateway = useTrending(['get_this', 'get_this'], false);
    await start();
    expect(screen.queryAllByTestId('hero').length).toBe(0);
    await toggle();
    expect(screen.queryAllByTestId('hero').length).toBe(1);
  });

  it('says what an empty row says today when hiding leaves it nothing', async () => {
    gateway = useTrending(['in_library', 'requested']);
    await start();
    expect(trendingCards()).toEqual([]);
    expect(screen.queryAllByText('Nothing to show here right now.').length).toBeGreaterThan(0);
    await toggle();
    expect(trendingCards()).toEqual(['trending 1', 'trending 2']);
  });

  it('clamps the hero\'s place when fewer slides are left, and never throws', async () => {
    gateway = useTrending(['get_this', 'in_library', 'get_this', 'in_library', 'requested']);
    await start();
    await toggle();
    expect(heroTitles().length).toBe(5);
    for (let step = 0; step < 4; step += 1) await fireEvent.press(screen.queryAllByLabelText('Next title')[0]!);
    await settle();
    await toggle();
    expect(heroTitles()).toEqual(['trending 1', 'trending 3']);
    await toggle();
    expect(heroTitles().length).toBe(5);
    expect(heroSlides([], true, 5)).toEqual([]);
  });

  it('applies to every filter and keeps the choice when the filter changes', async () => {
    await start();
    await choose('Movies');
    expect(chip().props.accessibilityState).toEqual({ checked: true });
    expect(trendingCards().some((title) => title === 'trending-movies 1')).toBe(false);
    await toggle();
    await choose('TV');
    expect(chip().props.accessibilityState).toEqual({ checked: false });
    expect(trendingCards()[0]).toBe('trending-tv 1');
  });

  it('makes no call of its own: choosing it reads nothing', async () => {
    await start();
    const before = callsMade();
    await toggle();
    await toggle();
    await toggle();
    expect(callsMade() - before).toBe(0);
  });
});

describe('Hide what I have: the hero keeps its place', () => {
  let scrolls: jest.SpyInstance;
  beforeEach(() => {
    scrolls = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => undefined);
  });
  afterEach(() => scrolls.mockRestore());

  /** The slide the track was last put at, as a title index (the track starts at 0). */
  const visible = (): number => {
    const SLIDE = screen.queryAllByTestId('hero-slide-first')[0]!.props.style.width as number;
    const last = scrolls.mock.calls[scrolls.mock.calls.length - 1]?.[0] as { x: number } | undefined;
    return Math.round((last?.x ?? 0) / SLIDE);
  };
  const selected = (): string[] =>
    screen
      .queryAllByLabelText(/^Show title \d+ of \d+: /)
      .filter((node) => node.props.accessibilityState?.selected === true)
      .map((node) => String(node.props.accessibilityLabel).replace(/^Show title \d+ of \d+: /, ''));
  const agree = () => expect([selected(), heroTitles()[visible()]]).toEqual([[heroTitles()[visible()]], heroTitles()[visible()]]);
  const dot = (n: number) => screen.queryAllByLabelText(new RegExp(`^Show title ${n} of \\d+: `))[0]!;

  it('keeps the selected title (and scrolls to it) when hiding takes the others away and brings them back', async () => {
    gateway = useTrending(['get_this', 'in_library', 'requested', 'in_library', 'get_this']);
    await start();
    await toggle();
    await fireEvent.press(dot(5));
    await settle();
    expect([selected(), visible()]).toEqual([['trending 5'], 4]);
    await toggle();
    expect(heroTitles()).toEqual(['trending 1', 'trending 5']);
    expect([selected(), visible()]).toEqual([['trending 5'], 1]);
    await toggle();
    expect([selected(), visible()]).toEqual([['trending 5'], 4]);
    agree();
  });

  it('clamps to the last slide, moves the scroll there, and stays there when the others return', async () => {
    gateway = useTrending(['get_this', 'get_this', 'in_library', 'requested', 'requested']);
    await start();
    await toggle();
    await fireEvent.press(dot(5));
    await settle();
    expect([selected(), visible()]).toEqual([['trending 5'], 4]);
    await toggle();
    expect(heroTitles()).toEqual(['trending 1', 'trending 2']);
    expect([selected(), visible()]).toEqual([['trending 2'], 1]);
    await toggle();
    // Not back at the fifth: the selection is the title it was clamped to.
    expect([selected(), visible()]).toEqual([['trending 2'], 1]);
    agree();
  });

  it('keeps dots, scroll and slide in step when a request shrinks the hero', async () => {
    gateway = useTrending(['get_this', 'get_this', 'get_this']);
    await start();
    expect(heroTitles()).toEqual(['trending 1', 'trending 2', 'trending 3']);
    await fireEvent.press(dot(3));
    await settle();
    expect([selected(), visible()]).toEqual([['trending 3'], 2]);
    await act(async () => mockSession!.asked.add('movie', 5002, []));
    await settle();
    expect(heroTitles()).toEqual(['trending 1', 'trending 2']);
    expect([selected(), visible()]).toEqual([['trending 2'], 1]);
    agree();
  });
});

describe('Hide what I have: a request just made', () => {
  it('removes the title from the rows and the hero, and a page of the same title elsewhere is left alone', async () => {
    gateway = useTrending(['get_this', 'get_this', 'get_this']);
    await start();
    expect(trendingCards().slice(0, 3)).toEqual(['trending 1', 'trending 2', 'trending 3']);
    expect(heroTitles()).toEqual(['trending 1', 'trending 2', 'trending 3']);
    await act(async () => mockSession!.asked.add('tv', 5001, []));
    await settle();
    expect(trendingCards().slice(0, 2)).toEqual(['trending 1', 'trending 3']);
    expect(heroTitles()).toEqual(['trending 1', 'trending 3']);
    await toggle();
    expect(trendingCards().slice(0, 3)).toEqual(['trending 1', 'trending 2', 'trending 3']);
    expect(heroTitles()).toEqual(['trending 1', 'trending 2', 'trending 3']);
  });
});

describe('Hide what I have: the helpers', () => {
  const card = (state: State, backdropUrl: string | null = 'https://image.tmdb.org/t/p/w780/b.jpg') => ({ state, backdropUrl });
  it('keeps every card when off, and leaves the held ones out when on', () => {
    const cards = [card('in_library'), card('get_this'), card('requested'), card('unavailable')];
    expect(visibleCards(cards, false)).toHaveLength(4);
    expect(visibleCards(cards, true).map((c) => c.state)).toEqual(['get_this', 'unavailable']);
  });
  it('counts the library and the requested as held, and nothing else', () => {
    expect(STATES.map((state) => isHeld({ state }))).toEqual([true, false, false, true]);
  });
  it('fills at most the hero\'s slides, skipping the held and the pictureless', () => {
    const cards = [card('in_library'), card('get_this', null), card('get_this'), card('get_this'), card('get_this'), card('get_this'), card('get_this'), card('get_this')];
    expect(heroSlides(cards, true, 5)).toHaveLength(5);
    expect(heroSlides(cards, false, 5)[0]!.state).toBe('in_library');
  });
  it('is on when made and back on after a reset, telling its listeners of a change only', () => {
    const hide = createHideStore();
    const heard = jest.fn();
    hide.subscribe(heard);
    expect(hide.get()).toBe(true);
    hide.set(true);
    hide.reset();
    expect(heard).not.toHaveBeenCalled();
    hide.set(false);
    hide.reset();
    expect([hide.get(), heard.mock.calls.length]).toEqual([true, 2]);
  });
});

describe('Hide what I have: in the session', () => {
  let session: Session | undefined;
  function Probe() {
    session = useSession();
    return null;
  }

  async function startSession() {
    const fake = fakeGateway({
      'GET /jellypass/app/v1/me': () => answer(200, fixture('me')),
      'GET /Users/Public': () => answer(200, []),
      'POST /Sessions/Logout': () => answer(204),
    });
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <SessionProvider deps={{ fetch: fake.fetch, identity: async () => IDENTITY }}>
          <Probe />
        </SessionProvider>
      </SafeAreaProvider>,
    );
    await settle();
  }

  beforeEach(() => {
    session = undefined;
  });

  it.each(['sign-out', 'a 401', 'a change of household'] as const)('is back on after %s', async (move) => {
    await startSession();
    const before = session!.hideHeld;
    before.set(false);
    await act(async () => (move === 'sign-out' ? session!.signOut() : move === 'a 401' ? session!.expire() : session!.changeHousehold()));
    await settle();
    expect(before.get()).toBe(true);
    expect(session!.hideHeld.get()).toBe(true);
  });

  it.each([
    ['the same token', TOKEN],
    ['another member', 'synthetic-other-token-0002'],
  ])('starts on for another sign-in (%s), never carrying the last person\'s choice', async (_what, token) => {
    await startSession();
    const before = session!.hideHeld;
    before.set(false);
    await act(async () => session!.signOut());
    await settle();
    await act(async () => session!.completeSignIn(session!.household!, { token, userId: 'synthetic-user-0001', name: 'Ana Lima' }, session!.epoch()));
    await settle();
    expect(session!.phase.kind).toBe('signedIn');
    expect(session!.hideHeld === before).toBe(false);
    expect(session!.hideHeld.get()).toBe(true);
  });

  it('counts a title just asked for as held, with no call', async () => {
    await startSession();
    const card = { ...pageAnswer('trending', 2).results[1]!, mediaType: 'tv' as const } as Card;
    expect(card.state).toBe('get_this');
    expect(visibleCards([session!.asked.card(card)], true).length).toBe(1);
    session!.asked.add('tv', card.tmdbId, []);
    expect(session!.asked.card(card).state).toBe('requested');
    expect(visibleCards([session!.asked.card(card)], true).length).toBe(0);
  });

  it('is never written to the device', async () => {
    await startSession();
    const writes = JSON.stringify([...store.__items.entries()]);
    session!.hideHeld.set(false);
    expect(JSON.stringify([...store.__items.entries()])).toBe(writes);
  });
});

describe('Hide what I have: a late answer', () => {
  it('is drawn with the choice as it stands when it arrives, not as it was when it was asked for', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    gateway = homeGateway(
      homeHousehold((call) => (call.route === `GET ${API}/discover/trending` ? held.then(() => answer(200, pageAnswer('trending'))) : undefined)),
    );
    mockFetch = gateway.fetch;
    await start();
    await toggle();
    expect(chip().props.accessibilityState).toEqual({ checked: false });
    await act(async () => release!());
    await settle();
    expect(trendingCards().slice(0, 2)).toEqual(['trending 1', 'trending 2']);
  });
});
