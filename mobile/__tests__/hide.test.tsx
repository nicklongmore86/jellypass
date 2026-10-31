// "Not interested" through the real router, signed in to a household that can hide (apiVersion 3), with a fake gateway
// that hides as the server does: the title page's button (one call, the page stays open, Unhide after, the toast and its
// Undo), a card's long press (the sheet) and its screen-reader action on Home's rows and hero, See all and a network's
// page, the title leaving every list on screen at once with no call, Search keeping hidden titles marked with Unhide, each
// failure's fixed words (the 2,000-title limit its own) with nothing retried, a 401 signing out, a server page with every
// title left out still offering Load more, and an older server (apiVersion 2) showing none of it. Then accessibility.
// Queries are queryAll* and assertions read single fields, so a failure never prints the component tree.
import { act, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { AccessibilityInfo } from 'react-native';

import type { FetchLike } from '../src/api/client';
import { HIDE_TEXT, TOAST_MS } from '../src/hidden/text';
import { EMPTY_ROW_TEXT } from '../src/home/text';
import { MORE_TEXT } from '../src/search/text';
import { layout } from '../src/theme';
import { showAll } from './support/home';
import { ORIGIN, TOKEN, answer, keepSession, offline, settle, shows, store, storedSession, type Call } from './support/household';
import { action, cardsNamed, hideGateway, hides, longPress, toastText, type HideHousehold } from './support/hide';
import { submitQuery, typeQuery, wait } from './support/search';
import { gridNames, held } from './support/source';
import { buttonNamed, flat, headings, pressNode } from './support/title';

jest.setTimeout(30_000);

let mockFetch: FetchLike;
jest.mock('../src/api/transport', () => ({
  ...jest.requireActual('../src/api/transport'),
  householdFetch: (url: string, init: never) => mockFetch(url, init),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: jest.requireActual('../app.config').default } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
}));

let gateway: ReturnType<typeof hideGateway>;

function useHousehold(household: HideHousehold = {}) {
  gateway = hideGateway(household);
  mockFetch = gateway.fetch;
}

beforeEach(() => {
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  useHousehold();
});

/** Every call from now on, as `METHOD path` under the API. */
function since() {
  const before = gateway.calls.length;
  return () => gateway.calls.slice(before).map((call: Call) => call.route.replace(' /jellypass/app/v1/', ' /'));
}

async function start(path?: string) {
  const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  await showAll();
  if (path) {
    await act(async () => router.push(path, { withAnchor: true }));
    await settle();
  }
  return app;
}

const FILM = 'Film 7 (Movie, 2024)';

/** The card named `name` in the grid on screen (Home, under it, has the same cards). */
function gridCard(name: string) {
  const grid = screen.queryAllByTestId('source-grid')[0]!;
  return screen.queryAllByRole('link').find((node) => {
    if (String(node.props.accessibilityLabel) !== name) return false;
    for (let at = node.parent; at; at = at.parent) if (at === grid) return true;
    return false;
  })!;
}
const hasButton = (name: string | RegExp) => screen.queryAllByRole('button', { name }).length > 0;

describe("a title page's Not interested", () => {
  it('hides with one call: the page stays open, says Hidden and offers Unhide, and the toast offers Undo', async () => {
    const app = await start('/home/movie/7');
    const calls = since();
    expect(shows(HIDE_TEXT.note)).toBe(true);
    await pressNode(buttonNamed(`Hide ${FILM} from Discover`));
    expect(calls()).toEqual(['POST /hidden/movie/7']);
    expect(app.getPathname()).toBe('/home/movie/7');
    expect(headings()[0]).toBe('Film 7');
    expect(hasButton(`Unhide ${FILM}`)).toBe(true);
    expect(shows(HIDE_TEXT.state)).toBe(true);
    expect(toastText()).toBe('Hidden Film 7 from Discover');

    await pressNode(buttonNamed(`Undo hiding ${FILM}`));
    expect(calls()).toEqual(['POST /hidden/movie/7', 'DELETE /hidden/movie/7']);
    expect(toastText()).toBe('');
    expect(hasButton(`Hide ${FILM} from Discover`)).toBe(true);
    // Nothing more, however long the page stays open.
    await wait(10 * 60_000);
    expect(calls()).toHaveLength(2);
  });

  it('shows Unhide on a title the server says is hidden, and unhides it with one call and no toast', async () => {
    useHousehold({ hidden: ['movie:7'] });
    await start('/home/movie/7');
    const calls = since();
    await pressNode(buttonNamed(`Unhide ${FILM}`));
    expect(calls()).toEqual(['DELETE /hidden/movie/7']);
    expect(hasButton(`Hide ${FILM} from Discover`)).toBe(true);
    expect(toastText()).toBe('');
  });

  it('is disabled while its call is out: a second press sends nothing', async () => {
    const out = held();
    useHousehold({ setHidden: () => out.promise });
    await start('/home/movie/7');
    const calls = since();
    const button = buttonNamed(`Hide ${FILM} from Discover`);
    await pressNode(button);
    expect(button.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(shows(HIDE_TEXT.hiding)).toBe(true);
    await pressNode(button);
    expect(calls()).toEqual(['POST /hidden/movie/7']);
    out.release(answer(200, { hidden: true }));
    await settle();
    expect(hasButton(`Unhide ${FILM}`)).toBe(true);
  });

  it.each([
    ['the 2,000-title limit (409)', () => answer(409, { error: 'hidden_limit_reached' }), HIDE_TEXT.limit],
    ['a busy server (429)', () => answer(429, { error: 'too_many_requests' }, { 'Retry-After': '30' }), HIDE_TEXT.rate_limited],
    ['no connection', offline, HIDE_TEXT.offline],
    ['any other failure', () => answer(503, { error: 'unavailable' }), HIDE_TEXT.unavailable],
  ] as const)('shows %s in fixed words, hides nothing and never tries again by itself', async (_what, failure, words) => {
    useHousehold({ setHidden: (call) => failure(call) });
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    await start('/home/movie/7');
    const calls = since();
    await pressNode(buttonNamed(`Hide ${FILM} from Discover`));
    expect(screen.queryAllByTestId('hide-error').map((node) => [node.props.children].flat().join(''))).toEqual([words]);
    expect(announce).toHaveBeenCalledWith(words);
    expect(hasButton(`Hide ${FILM} from Discover`)).toBe(true);
    expect(toastText()).toBe('');
    await wait(10 * 60_000);
    expect(calls()).toEqual(['POST /hidden/movie/7']);
    announce.mockRestore();
  });

  it('signs out on a 401', async () => {
    useHousehold({ setHidden: () => answer(401, { error: 'unauthorized' }) });
    const app = await start('/home/movie/7');
    await pressNode(buttonNamed(`Hide ${FILM} from Discover`));
    await settle();
    expect(storedSession()).toBeUndefined();
    expect(app.getPathname()).toBe('/');
  });

  it('is on a series page too, but never on a season page', async () => {
    await start('/home/tv/9');
    expect(hasButton('Hide Series 9 (Series, 2023) from Discover')).toBe(true);
    await act(async () => router.push('/home/tv/9/season/2'));
    await settle();
    expect(hasButton(/^Hide .* from Discover$/)).toBe(false);
  });
});

describe('the toast after a hide', () => {
  it('goes by itself after a while', async () => {
    await start('/home/movie/7');
    await pressNode(buttonNamed(`Hide ${FILM} from Discover`));
    await wait(TOAST_MS - 100);
    expect(toastText()).toBe('Hidden Film 7 from Discover');
    await wait(200);
    expect(toastText()).toBe('');
  });

  it('stays while a screen reader is on, until dismissed', async () => {
    const reader = jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
    await start('/home/movie/7');
    await pressNode(buttonNamed(`Hide ${FILM} from Discover`));
    await wait(TOAST_MS * 4);
    expect(toastText()).toBe('Hidden Film 7 from Discover');
    await pressNode(buttonNamed(HIDE_TEXT.dismiss));
    expect(toastText()).toBe('');
    reader.mockRestore();
  });

  it("keeps Undo after Undo fails, with the failure's words, and sends nothing by itself", async () => {
    useHousehold({ setHidden: (_call, hidden) => (hidden ? undefined : answer(503, { error: 'unavailable' })) });
    await start('/home/movie/7');
    const calls = since();
    await pressNode(buttonNamed(`Hide ${FILM} from Discover`));
    await pressNode(buttonNamed(`Undo hiding ${FILM}`));
    expect(toastText()).toBe(HIDE_TEXT.unavailable);
    await wait(TOAST_MS * 4);
    expect(toastText()).toBe(HIDE_TEXT.unavailable);
    expect(calls()).toEqual(['POST /hidden/movie/7', 'DELETE /hidden/movie/7']);
    expect(hasButton(`Unhide ${FILM}`)).toBe(true);
  });
});

describe('a card held down', () => {
  it("opens the sheet; Not interested takes the title out of Home's row and hero at once, with one call", async () => {
    await start();
    // trending 2: a series to get, so New only shows it in the row and the hero.
    expect(cardsNamed('trending 2')).toHaveLength(2);
    const calls = since();
    await longPress(cardsNamed('trending 2')[0]!);
    expect(screen.queryAllByTestId('hide-sheet')).toHaveLength(1);
    expect(shows(HIDE_TEXT.note)).toBe(true);
    await pressNode(buttonNamed('Hide trending 2 (Series, 2021) from Discover'));
    expect(screen.queryAllByTestId('hide-sheet')).toHaveLength(0);
    expect(cardsNamed('trending 2')).toHaveLength(0);
    expect(cardsNamed('trending 6')).toHaveLength(2);
    expect(calls()).toEqual(['POST /hidden/tv/1002']);
    expect(toastText()).toBe('Hidden trending 2 from Discover');

    // Undo brings it back to the row and the hero, with one call.
    await pressNode(buttonNamed('Undo hiding trending 2 (Series, 2021)'));
    expect(cardsNamed('trending 2')).toHaveLength(2);
    expect(hides(gateway.calls)).toEqual(['POST tv:1002', 'DELETE tv:1002']);
    expect(calls()).toHaveLength(2);
  });

  it('closes the sheet on Close, sending nothing', async () => {
    await start();
    const calls = since();
    await longPress(cardsNamed('trending 2')[0]!);
    await pressNode(buttonNamed(HIDE_TEXT.close));
    expect(screen.queryAllByTestId('hide-sheet')).toHaveLength(0);
    expect(cardsNamed('trending 2')).toHaveLength(2);
    expect(calls()).toEqual([]);
  });

  it('keeps the sheet open with the fixed words when the hide fails', async () => {
    useHousehold({ setHidden: () => answer(409, { error: 'hidden_limit_reached' }) });
    await start();
    await longPress(cardsNamed('trending 2')[0]!);
    await pressNode(buttonNamed('Hide trending 2 (Series, 2021) from Discover'));
    expect(screen.queryAllByTestId('hide-sheet')).toHaveLength(1);
    expect(screen.queryAllByTestId('hide-error').map((node) => [node.props.children].flat().join(''))).toEqual([HIDE_TEXT.limit]);
    await pressNode(buttonNamed(HIDE_TEXT.close));
    expect(cardsNamed('trending 2')).toHaveLength(2);
  });

  it('hides from a screen reader\'s action on the card, with no sheet', async () => {
    await start();
    const card = cardsNamed('popular-movies 2')[0]!;
    expect(card.props.accessibilityActions).toEqual([{ name: 'hide', label: HIDE_TEXT.hide }]);
    const calls = since();
    await action(card, 'hide');
    expect(screen.queryAllByTestId('hide-sheet')).toHaveLength(0);
    expect(cardsNamed('popular-movies 2')).toHaveLength(0);
    expect(calls()).toEqual(['POST /hidden/movie/1002']);
  });

  it("takes the title out of a See all page and, Back on Home, out of its row, with one call", async () => {
    const app = await start('/home/list/trending');
    expect(gridNames().filter((name) => name.startsWith('trending 3, '))).toHaveLength(1);
    const calls = since();
    await longPress(gridCard(gridNames().find((name) => name.startsWith('trending 3, '))!));
    await pressNode(buttonNamed('Hide trending 3 (Movie, 2022) from Discover'));
    expect(gridNames().filter((name) => name.startsWith('trending 3, '))).toEqual([]);
    expect(gridNames()).toHaveLength(19);
    await pressNode(buttonNamed('Back'));
    expect(app.getPathname()).toMatch(/^\/(home)?$/);
    expect(cardsNamed('trending 3')).toHaveLength(0);
    expect(calls()).toEqual(['POST /hidden/movie/1003']);
  });

  it("takes the title out of a network's page", async () => {
    await start('/home/network/213');
    const name = gridNames()[0]!;
    const title = name.split(', ')[0]!;
    await longPress(gridCard(name));
    await pressNode(buttonNamed(new RegExp(`^Hide ${title} \\(`)));
    expect(gridNames()).not.toContain(name);
    expect(hides(gateway.calls)).toHaveLength(1);
  });
});

describe('Search', () => {
  it('keeps a hidden title, marked Hidden with Unhide; Unhide takes the mark away with one call', async () => {
    useHousehold({ hidden: ['tv:3002'] });
    await start('/search');
    await typeQuery('dune');
    await submitQuery();
    const card = cardsNamed('dune 2')[0]!;
    expect(String(card.props.accessibilityLabel)).toMatch(/, Hidden from Discover$/);
    expect(screen.queryAllByTestId('hidden-mark', { includeHiddenElements: true })).toHaveLength(1);
    const calls = since();
    await pressNode(buttonNamed('Unhide dune 2 (Series, 2011)'));
    expect(calls()).toEqual(['DELETE /hidden/tv/3002']);
    expect(String(cardsNamed('dune 2')[0]!.props.accessibilityLabel)).not.toMatch(/Hidden/);
    expect(screen.queryAllByTestId('hidden-mark', { includeHiddenElements: true })).toHaveLength(0);
    expect(hasButton(/^Unhide /)).toBe(false);
    expect(toastText()).toBe('');
  });

  it('keeps a title hidden from its results there, now marked Hidden', async () => {
    await start('/search');
    await typeQuery('dune');
    await submitQuery();
    await longPress(cardsNamed('dune 1')[0]!);
    await pressNode(buttonNamed('Hide dune 1 (Movie, 2010) from Discover'));
    expect(cardsNamed('dune 1')).toHaveLength(1);
    expect(String(cardsNamed('dune 1')[0]!.props.accessibilityLabel)).toMatch(/, Hidden from Discover$/);
    expect(hasButton('Unhide dune 1 (Movie, 2010)')).toBe(true);
    expect(cardsNamed('dune 1')[0]!.props.accessibilityActions).toEqual([{ name: 'hide', label: HIDE_TEXT.unhide }]);
  });
});

describe('a page the server sends with every title left out', () => {
  it('says there is nothing here, and still offers Load more', async () => {
    useHousehold({ override: (call) => (call.route.endsWith('/discover/trending') && !call.url.includes('page=') ? answer(200, { page: 1, nextPage: 2, results: [] }) : undefined) });
    await start('/home/list/trending');
    expect(shows(EMPTY_ROW_TEXT)).toBe(true);
    expect(hasButton(MORE_TEXT.button)).toBe(true);
    const calls = since();
    await pressNode(buttonNamed(MORE_TEXT.button));
    expect(calls()).toEqual(['GET /discover/trending']);
    expect(gridNames()).toHaveLength(20);
  });
});

describe('an older server (apiVersion 2)', () => {
  beforeEach(() => useHousehold({ apiVersion: 2 }));

  it('shows no Not interested on a title page', async () => {
    await start('/home/movie/7');
    expect(hasButton(/^Hide /)).toBe(false);
    expect(shows(HIDE_TEXT.note)).toBe(false);
  });

  it('gives the cards no long press and no action', async () => {
    await start();
    const card = cardsNamed('trending 2')[0]!;
    expect(card.props.accessibilityActions).toBeUndefined();
    expect(card.props.onLongPress).toBeUndefined();
    await longPress(card);
    expect(screen.queryAllByTestId('hide-sheet')).toHaveLength(0);
    expect(hides(gateway.calls)).toEqual([]);
  });

  it('has no Hidden tab on My requests', async () => {
    await start('/requests');
    expect(screen.queryAllByTestId('requests-views')).toHaveLength(0);
    expect(screen.queryAllByRole('tab', { name: HIDE_TEXT.views.hidden })).toHaveLength(0);
    expect(gateway.routes().some((route) => route.includes('/hidden'))).toBe(false);
  });
});

describe('accessibility', () => {
  it("names every hiding control with its title and makes it a thumb's size", async () => {
    await start('/home/movie/7');
    const hide = buttonNamed(`Hide ${FILM} from Discover`);
    expect(flat(hide).minHeight).toBeGreaterThanOrEqual(layout.touchTarget);
    await pressNode(hide);
    for (const name of [`Unhide ${FILM}`, `Undo hiding ${FILM}`, HIDE_TEXT.dismiss]) {
      expect(flat(buttonNamed(name)).minHeight).toBeGreaterThanOrEqual(layout.touchTarget);
    }
    await act(async () => router.navigate('/home'));
    await settle();
    await longPress(cardsNamed('trending 2')[0]!);
    for (const name of ['Hide trending 2 (Series, 2021) from Discover', HIDE_TEXT.close]) {
      expect(flat(buttonNamed(name)).minHeight).toBeGreaterThanOrEqual(layout.touchTarget);
    }
  });

  it('announces a hide and an Undo', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    await start('/home/movie/7');
    await pressNode(buttonNamed(`Hide ${FILM} from Discover`));
    expect(announce).toHaveBeenCalledWith('Hidden Film 7 from Discover');
    await pressNode(buttonNamed(`Undo hiding ${FILM}`));
    expect(announce).toHaveBeenCalledWith('Film 7 is back in Discover');
    announce.mockRestore();
  });

  it('lets its words grow with the text size: no line limit or fixed height', () => {
    const { readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
    const { join } = jest.requireActual<typeof import('node:path')>('node:path');
    for (const file of ['HideProvider.tsx', 'components.tsx']) {
      const source = readFileSync(join(__dirname, '..', 'src', 'hidden', file), 'utf8');
      expect(source).not.toMatch(/numberOfLines|allowFontScaling=\{?false|maxFontSizeMultiplier/);
    }
  });
});
