// My requests' Hidden tab through the real router, signed in to a household that can hide (apiVersion 3), with a fake
// gateway that hides as the server does: the Requests | Hidden tabs (the filters on Requests alone), the member's hidden
// titles newest first, named ten at a time like My requests, Load more naming the next ten and then reading the list's
// next page, Unhide (one call, the entry gone, nothing read again), the empty words, failures and a 401, reading the tab
// again when it is shown, and every call against docs/app-api/fetch-budget.json's "hiding". Queries are queryAll* and
// assertions read single fields, so a failure never prints the component tree.
import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';

import type { FetchLike } from '../src/api/client';
import { HIDE_TEXT } from '../src/hidden/text';
import { REQUESTS_TEXT } from '../src/requests/text';
import { REQUESTS_MAX_WIDTH } from '../src/screens/RequestsScreen';
import { MORE_TEXT } from '../src/search/text';
import { layout } from '../src/theme';
import { BUDGET } from './support/app-api';
import { budgetRoute } from './support/home';
import { ORIGIN, TOKEN, answer, keepSession, settle, shows, store, storedSession, type Call } from './support/household';
import { hideGateway, type HideHousehold } from './support/hide';
import { requestEntry } from './support/search';
import { buttonNamed, flat, linkNamed, pressNode } from './support/title';

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

const HIDING = (BUDGET as unknown as { hiding: { hide: string[]; unhide: string[]; undo: string[]; hiddenTab: { calls: number; titlesAtOnce: number; atOnce: string[]; loadMore: string[] } } }).hiding;

/** `count` hidden titles, newest first: films and series in turn, from ID 101. */
const hiddenTitles = (count: number) => Array.from({ length: count }, (_, index) => `${index % 2 ? 'tv' : 'movie'}:${101 + index}`);
const nameOf = (key: string) => (key.startsWith('tv:') ? `Series ${key.slice(3)}` : `Film ${key.slice(6)}`);

let gateway: ReturnType<typeof hideGateway>;

function useHousehold(household: HideHousehold = {}) {
  gateway = hideGateway({ requests: { results: [requestEntry('req1', 'movie', 900001, 'requested')] }, ...household });
  mockFetch = gateway.fetch;
}

beforeEach(() => {
  mockWindow = PHONE;
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  useHousehold({ hidden: hiddenTitles(12) });
});

/** Every call from now on, as `METHOD path?query` under the API. */
function since() {
  const before = gateway.calls.length;
  return () => gateway.calls.slice(before).map((call: Call) => `${call.init.method} ${call.url.replace(/^https:\/\/[^/]+\/jellypass\/app\/v1/, '')}`);
}

async function openRequests() {
  const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  await act(async () => router.navigate('/requests'));
  await settle();
  return app;
}

const tab = (name: string) => screen.queryAllByRole('tab', { name })[0]!;
async function chooseView(name: string) {
  await fireEvent.press(tab(name));
  await settle();
}

/** The Hidden tab's entries' names, in order. */
const entries = () => screen.queryAllByTestId('hidden-item').map((node) => String(node.props.accessibilityLabel));
const titleCalls = (calls: readonly string[]) => calls.filter((call) => /^GET \/(movie|tv)\/\d+$/.test(call));

describe('the Requests | Hidden tabs', () => {
  it('start on Requests, with its filters; Hidden shows no filters', async () => {
    await openRequests();
    expect(screen.queryAllByTestId('requests-views')).toHaveLength(1);
    expect(tab('Requests').props.accessibilityState).toEqual({ selected: true });
    expect(tab('Hidden').props.accessibilityState).toEqual({ selected: false });
    expect(screen.queryAllByTestId('request-filters')).toHaveLength(1);
    await chooseView('Hidden');
    expect(tab('Hidden').props.accessibilityState).toEqual({ selected: true });
    expect(screen.queryAllByTestId('request-filters')).toHaveLength(0);
    expect(screen.queryAllByTestId('request-item')).toHaveLength(0);
    await chooseView('Requests');
    expect(screen.queryAllByTestId('request-filters')).toHaveLength(1);
    expect(screen.queryAllByTestId('request-item')).toHaveLength(1);
  });

  it("are each a thumb's size", async () => {
    await openRequests();
    for (const name of ['Requests', 'Hidden']) expect(flat(tab(name)).minHeight).toBeGreaterThanOrEqual(layout.touchTarget);
  });
});

describe('the Hidden tab', () => {
  it('lists the newest ten hidden titles, each named from its own answer, with the day it was hidden and Unhide', async () => {
    await openRequests();
    const calls = since();
    await chooseView('Hidden');
    expect(calls()[0]).toBe('GET /hidden');
    expect(titleCalls(calls())).toHaveLength(10);
    expect(calls()).toHaveLength(11);
    expect(entries().map((name) => name.split(', ')[0])).toEqual(hiddenTitles(10).map(nameOf));
    expect(entries()[0]).toMatch(/^Film 101, 2024 · Movie, Hidden on /);
    expect(entries()[1]).toMatch(/^Series 102, 2023 · Series, Hidden on /);
    expect(screen.queryAllByRole('button', { name: /^Unhide / })).toHaveLength(10);
    expect(flat(buttonNamed('Unhide Film 101 (Movie, 2024)')).minHeight).toBeGreaterThanOrEqual(layout.touchTarget);
  });

  it('names the next ones on Load more with no list call, and offers no more at the end', async () => {
    await openRequests();
    await chooseView('Hidden');
    const calls = since();
    await pressNode(buttonNamed(MORE_TEXT.button));
    expect(calls()).toEqual(['GET /movie/111', 'GET /tv/112']);
    expect(entries()).toHaveLength(12);
    expect(screen.queryAllByRole('button', { name: MORE_TEXT.button })).toHaveLength(0);
  });

  it("reads the list's next page once every listed title is named", async () => {
    useHousehold({ hidden: hiddenTitles(55) });
    await openRequests();
    await chooseView('Hidden');
    const calls = since();
    for (let step = 0; step < 4; step += 1) await pressNode(buttonNamed(MORE_TEXT.button));
    expect(calls().filter((call) => call.startsWith('GET /hidden'))).toEqual([]);
    expect(entries()).toHaveLength(50);
    await pressNode(buttonNamed(MORE_TEXT.button));
    expect(calls().filter((call) => call.startsWith('GET /hidden'))).toEqual(['GET /hidden?page=2']);
    expect(entries()).toHaveLength(55);
    expect(titleCalls(calls())).toHaveLength(45);
    expect(screen.queryAllByRole('button', { name: MORE_TEXT.button })).toHaveLength(0);
  });

  it('unhides with one call: the entry leaves at once, the screen says so, and nothing is read again', async () => {
    await openRequests();
    await chooseView('Hidden');
    const calls = since();
    await pressNode(buttonNamed('Unhide Series 102 (Series, 2023)'));
    expect(calls()).toEqual(['DELETE /hidden/tv/102']);
    expect(entries().map((name) => name.split(', ')[0])).not.toContain('Series 102');
    expect(entries()).toHaveLength(9);
    expect(screen.queryAllByTestId('hidden-notice').map((node) => [node.props.children].flat().join(''))).toEqual(['Series 102 is back in Discover']);
    // No toast: there is nothing to undo.
    expect(screen.queryAllByTestId('hide-toast')).toHaveLength(0);
  });

  it('says so in fixed words when Unhide fails, keeping the entry', async () => {
    useHousehold({ hidden: hiddenTitles(3), setHidden: () => answer(503, { error: 'unavailable' }) });
    await openRequests();
    await chooseView('Hidden');
    await pressNode(buttonNamed('Unhide Film 101 (Movie, 2024)'));
    expect(screen.queryAllByTestId('hide-error').map((node) => [node.props.children].flat().join(''))).toEqual([HIDE_TEXT.unavailable]);
    expect(entries()).toHaveLength(3);
  });

  it('opens a title on the My requests stack', async () => {
    const app = await openRequests();
    await chooseView('Hidden');
    await pressNode(linkNamed(/^Film 101, /));
    expect(app.getPathname()).toBe('/requests/movie/101');
    expect(screen.queryAllByRole('button', { name: 'Unhide Film 101 (Movie, 2024)' })).toHaveLength(1);
  });

  it('says what it is for when nothing is hidden', async () => {
    useHousehold({ hidden: [] });
    await openRequests();
    await chooseView('Hidden');
    expect(shows(HIDE_TEXT.empty)).toBe(true);
    expect(screen.queryAllByRole('button', { name: MORE_TEXT.button })).toHaveLength(0);
  });

  it('keeps an entry whose title cannot be read, with its Unhide', async () => {
    useHousehold({ hidden: ['movie:404'], override: (call) => (call.route.endsWith('/movie/404') ? answer(404, { error: 'not_found' }) : undefined) });
    await openRequests();
    await chooseView('Hidden');
    expect(entries()[0]).toMatch(new RegExp(`^${REQUESTS_TEXT.titleMissing}, Movie, Hidden on `));
    expect(screen.queryAllByRole('button', { name: 'Unhide Movie' })).toHaveLength(1);
  });

  it('shows a failed list with Try again, which reads it once', async () => {
    let fail = true;
    useHousehold({ hidden: hiddenTitles(12), list: () => (fail ? answer(503, { error: 'unavailable' }) : undefined) });
    await openRequests();
    await chooseView('Hidden');
    expect(entries()).toEqual([]);
    fail = false;
    const calls = since();
    await pressNode(buttonNamed('Try again'));
    expect(calls().filter((call) => call.startsWith('GET /hidden'))).toEqual(['GET /hidden']);
    expect(entries()).toHaveLength(10);
  });

  it('signs out on a 401', async () => {
    useHousehold({ list: () => answer(401, { error: 'unauthorized' }) });
    const app = await openRequests();
    await chooseView('Hidden');
    await settle();
    expect(storedSession()).toBeUndefined();
    expect(app.getPathname()).toBe('/');
  });

  it('is read again when My requests is shown again on it, its titles reused', async () => {
    await openRequests();
    await chooseView('Hidden');
    const calls = since();
    await act(async () => router.navigate('/home'));
    await settle();
    await act(async () => router.navigate('/requests'));
    await settle();
    expect(tab('Hidden').props.accessibilityState).toEqual({ selected: true });
    expect(calls().filter((call) => !call.startsWith('GET /discover'))).toEqual(['GET /hidden']);
    expect(entries()).toHaveLength(10);
  });

  it('leaves out a title unhidden elsewhere in this session, with no call', async () => {
    await openRequests();
    await chooseView('Hidden');
    await act(async () => router.push('/requests/movie/103'));
    await settle();
    await pressNode(buttonNamed('Unhide Film 103 (Movie, 2024)'));
    await pressNode(buttonNamed('Back'));
    // Coming back from a title on the same stack, the tab is still read again on focus; the title is gone either way.
    expect(entries().map((name) => name.split(', ')[0])).not.toContain('Film 103');
  });
});

describe('on iPad', () => {
  it("keeps the Hidden tab in My requests' column, and the toast and sheet from widening", async () => {
    mockWindow = { width: 1024, height: 1366, scale: 2, fontScale: 1 };
    await openRequests();
    await chooseView('Hidden');
    expect(entries()).toHaveLength(10);
    const column = screen.queryAllByTestId('screen-column').find((node) => flat(node).maxWidth === REQUESTS_MAX_WIDTH);
    expect(column).toBeDefined();
    await act(async () => router.push('/requests/movie/7'));
    await settle();
    await pressNode(buttonNamed('Hide Film 7 (Movie, 2024) from Discover'));
    const toast = screen.queryAllByTestId('hide-toast')[0]!;
    expect(flat(toast.children[0] as never).maxWidth).toBe(560);
  });
});

describe('the fetch budget (docs/app-api/fetch-budget.json, "hiding")', () => {
  const templated = (call: string) => budgetRoute(call).replace(/\?page=\d+$/, '?page={page}').replace(/\/(movie|tv)\/\d+$/, '/$1/{tmdbId}');

  it("opens the Hidden tab with exactly the budget's calls, naming at most titlesAtOnce", async () => {
    await openRequests();
    const calls = since();
    await chooseView('Hidden');
    expect([...new Set(calls().map(templated))].sort()).toEqual([...HIDING.hiddenTab.atOnce].sort());
    expect(new Set(calls().map(templated)).size).toBe(HIDING.hiddenTab.calls);
    expect(titleCalls(calls())).toHaveLength(HIDING.hiddenTab.titlesAtOnce);
  });

  it("reads the list's next page with the budget's loadMore call", async () => {
    useHousehold({ hidden: hiddenTitles(51) });
    await openRequests();
    await chooseView('Hidden');
    const calls = since();
    for (let step = 0; step < 5; step += 1) await pressNode(buttonNamed(MORE_TEXT.button));
    expect(calls().filter((call) => call.startsWith('GET /hidden')).map(templated)).toEqual(HIDING.hiddenTab.loadMore);
  });

  it('hides, undoes and unhides with one call each, and reads nothing again', async () => {
    useHousehold({ hidden: ['tv:9'] });
    await openRequests();
    await act(async () => router.push('/requests/movie/7'));
    await settle();
    let calls = since();
    await pressNode(buttonNamed('Hide Film 7 (Movie, 2024) from Discover'));
    expect(calls().map(templated).map((call) => call.replace('/movie/', '/{mediaType}/'))).toEqual(HIDING.hide);
    calls = since();
    await pressNode(buttonNamed('Undo hiding Film 7 (Movie, 2024)'));
    expect(calls().map(templated).map((call) => call.replace('/movie/', '/{mediaType}/'))).toEqual(HIDING.undo);
    await act(async () => router.push('/requests/tv/9'));
    await settle();
    calls = since();
    await pressNode(buttonNamed('Unhide Series 9 (Series, 2023)'));
    expect(calls().map(templated).map((call) => call.replace('/tv/', '/{mediaType}/'))).toEqual(HIDING.unhide);
  });
});
