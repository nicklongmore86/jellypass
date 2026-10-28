// My requests' filters, the PWA's (app/src/render.ts) natively: Status (All, Requested, Ready to watch, Couldn't get
// this), Type (All, Films, Series) and Asked by me, all worked out from the fields GET /requests already lists. The rule
// (a series matches a status any of its seasons shows), the combinations, the words for an empty result, then the screen:
// choosing a filter makes no call at all (the API's or a title's), the titles read stay read, the choice is kept while the
// app is open and reset by a sign-out, a 401, another sign-in and the provider going; the chips are labelled, ticked,
// 44 points and wrap at large text; the admin note stays where something failed. Queries are queryAll* and assertions
// read single fields, so a failure never prints the component tree.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { FetchLike } from '../src/api/client';
import type { Request } from '../src/api/types';
import { createRequestFilterStore } from '../src/requests/filters';
import {
  matchesRequestFilter,
  NO_REQUEST_FILTER,
  REQUEST_FILTER_TEXT,
  requestFilterActive,
  requestFilterEmptyText,
  requestStatuses,
  type RequestFilter,
} from '../src/requests/text';
import { SessionProvider, useSession, type Session } from '../src/session/SessionProvider';
import { layout } from '../src/theme';
import { GET_THIS_TEXT } from '../src/title/text';
import { BUDGET } from './support/app-api';
import { API } from './support/home';
import { ORIGIN, TOKEN, answer, fakeGateway, fixture, IDENTITY, keepSession, METRICS, settle, store } from './support/household';
import { requestEntry, searchGateway, wait, type SearchHousehold } from './support/search';
import { flat, only, pressNode } from './support/title';

jest.setTimeout(30_000);

let mockFetch: FetchLike;
jest.mock('../src/api/transport', () => ({
  ...jest.requireActual('../src/api/transport'),
  householdFetch: (url: string, init: never) => mockFetch(url, init),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: jest.requireActual('../app.config').default } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);

const season = (seasonNumber: number, status: 'requested' | 'ready' | 'failed') => ({ seasonNumber, status });
// Six requests: a film asked for and requested (r1), a film by someone else ready (r2), a series of mine whose seasons
// differ (r3: ready and requested), a series by someone else that failed (r4), my film that failed (r5), a series by someone else, ready (r6).
const LIST = [
  requestEntry('r1', 'movie', 910001, 'requested'),
  requestEntry('r2', 'movie', 910002, 'ready', { byYou: false }),
  requestEntry('r3', 'tv', 910003, 'requested', { seasons: [season(1, 'ready'), season(2, 'requested')] }),
  requestEntry('r4', 'tv', 910004, 'failed', { byYou: false }),
  requestEntry('r5', 'movie', 910005, 'failed'),
  requestEntry('r6', 'tv', 910006, 'ready', { byYou: false, seasons: [season(1, 'ready')] }),
];
const asRequest = (entry: (typeof LIST)[number]) => entry as unknown as Request;

describe('the rule', () => {
  const match = (entry: (typeof LIST)[number], filter: Partial<RequestFilter>) => matchesRequestFilter(asRequest(entry), { ...NO_REQUEST_FILTER, ...filter });

  it('matches a movie, or a series without seasons, by its own status', () => {
    expect(requestStatuses(asRequest(LIST[0]!))).toEqual(['requested']);
    expect(requestStatuses(asRequest(LIST[3]!))).toEqual(['failed']);
  });

  it('matches a series by every status it shows: its one chip, or a chip per season when they differ', () => {
    // Seasons share a status: that status, whatever the series' own says.
    expect(requestStatuses(asRequest(requestEntry('a', 'tv', 1, 'requested', { seasons: [season(1, 'ready'), season(2, 'ready')] })))).toEqual(['ready']);
    // Seasons differ: each of them.
    expect(requestStatuses(asRequest(LIST[2]!)).sort()).toEqual(['ready', 'requested']);
    expect(match(LIST[2]!, { status: 'ready' })).toBe(true);
    expect(match(LIST[2]!, { status: 'requested' })).toBe(true);
    expect(match(LIST[2]!, { status: 'failed' })).toBe(false);
    // Differing seasons and the series itself failed with no season failed (never sent): the note is under the series, so it matches failed.
    const never = requestEntry('n', 'tv', 2, 'failed', { seasons: [season(1, 'ready'), season(2, 'requested')] });
    expect(requestStatuses(asRequest(never)).sort()).toEqual(['failed', 'ready', 'requested']);
    // Seasons differ and one failed: failed through that season, once.
    const some = requestEntry('s', 'tv', 3, 'requested', { seasons: [season(1, 'ready'), season(2, 'failed')] });
    expect(requestStatuses(asRequest(some)).sort()).toEqual(['failed', 'ready']);
  });

  it('combines the three parts: all of them must hold', () => {
    const ids = (filter: Partial<RequestFilter>) => LIST.filter((entry) => match(entry, filter)).map((entry) => entry.id.slice(0, 2));
    expect(ids({})).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect(ids({ status: 'requested' })).toEqual(['r1', 'r3']);
    expect(ids({ status: 'ready' })).toEqual(['r2', 'r3', 'r6']);
    expect(ids({ status: 'failed' })).toEqual(['r4', 'r5']);
    expect(ids({ kind: 'movie' })).toEqual(['r1', 'r2', 'r5']);
    expect(ids({ kind: 'tv' })).toEqual(['r3', 'r4', 'r6']);
    expect(ids({ byYou: true })).toEqual(['r1', 'r3', 'r5']);
    expect(ids({ status: 'requested', kind: 'tv', byYou: true })).toEqual(['r3']);
    expect(ids({ status: 'ready', kind: 'movie' })).toEqual(['r2']);
    expect(ids({ status: 'ready', kind: 'movie', byYou: true })).toEqual([]);
    expect(ids({ status: 'failed', byYou: true })).toEqual(['r5']);
  });

  it('says what a filter left nothing of, for each combination, as the PWA does', () => {
    const text = (filter: Partial<RequestFilter>, more = false) => requestFilterEmptyText({ ...NO_REQUEST_FILTER, ...filter }, more);
    expect(text({ status: 'failed' })).toBe("No requests we couldn't get.");
    expect(text({ status: 'ready', kind: 'movie' })).toBe('No films ready to watch.');
    expect(text({ status: 'requested', kind: 'tv' })).toBe('No series still requested.');
    expect(text({ byYou: true })).toBe('No requests asked for by you.');
    expect(text({ kind: 'tv', byYou: true })).toBe('No series asked for by you.');
    expect(text({ status: 'ready', kind: 'tv', byYou: true })).toBe('No series ready to watch, asked for by you.');
    expect(text({ status: 'failed', kind: 'movie', byYou: true })).toBe("No films we couldn't get, asked for by you.");
    expect(text({ status: 'ready' }, true)).toBe(`No requests ready to watch. ${REQUEST_FILTER_TEXT.more}`);
    expect(requestFilterActive(NO_REQUEST_FILTER)).toBe(false);
    expect(requestFilterActive({ ...NO_REQUEST_FILTER, byYou: true })).toBe(true);
  });
});

describe('the PWA\'s words', () => {
  it('are word for word those of app/src/render.ts', () => {
    const render = readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'render.ts'), 'utf8');
    const texts = [
      ...Object.values(REQUEST_FILTER_TEXT.status),
      ...Object.values(REQUEST_FILTER_TEXT.kind),
      REQUEST_FILTER_TEXT.statusLabel,
      REQUEST_FILTER_TEXT.kindLabel,
      REQUEST_FILTER_TEXT.whoLabel,
      REQUEST_FILTER_TEXT.byYou,
      REQUEST_FILTER_TEXT.showAll,
      REQUEST_FILTER_TEXT.more,
    ];
    for (const text of texts) expect({ text, inPwa: render.includes(text) }).toEqual({ text, inPwa: true });
    // The empty-state sentences are built the same way.
    for (const part of ["'films'", "'series'", "'requests'", "' still requested'", "' ready to watch'", `" we couldn't get"`, " asked for by you`"]) {
      expect({ part, inPwa: render.includes(part) }).toEqual({ part, inPwa: true });
    }
  });
});

describe('the store', () => {
  it('starts with no filter, tells its listeners of a change only, and resets', () => {
    const filters = createRequestFilterStore();
    let told = 0;
    const stop = filters.subscribe(() => (told += 1));
    expect(filters.get()).toEqual(NO_REQUEST_FILTER);
    filters.reset();
    expect(told).toBe(0);
    filters.set({ status: 'ready', kind: 'tv', byYou: true });
    filters.set({ status: 'ready', kind: 'tv', byYou: true });
    expect([told, filters.get()]).toEqual([1, { status: 'ready', kind: 'tv', byYou: true }]);
    filters.reset();
    expect([told, filters.get()]).toEqual([2, NO_REQUEST_FILTER]);
    stop();
    filters.set({ ...NO_REQUEST_FILTER, byYou: true });
    expect(told).toBe(2);
  });
});

describe('the screen', () => {
  let gateway: ReturnType<typeof searchGateway>;
  function useHousehold(household: SearchHousehold = {}) {
    gateway = searchGateway(household);
    mockFetch = gateway.fetch;
  }

  beforeEach(() => {
    store.__items.clear();
    keepSession(TOKEN, ORIGIN);
    useHousehold({ requests: { results: LIST } });
  });

  async function openRequests() {
    const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
    await settle();
    await act(async () => router.navigate('/requests'));
    await settle();
    return app;
  }

  const ids = () => screen.queryAllByTestId('request-item').map((node) => /\d{6}/.exec(String(node.props.accessibilityLabel))?.[0]?.replace('91000', 'r'));
  const chip = (testID: string) => only(screen.queryAllByTestId(testID), testID);
  const choose = (testID: string) => pressNode(chip(testID));
  const checked = () =>
    screen
      .queryAllByTestId(/^request-filter-(status|kind|by-you)/)
      .filter((node) => node.props.accessibilityState?.checked)
      .map((node) => String(node.props.accessibilityLabel));
  const emptyText = () => {
    const box = screen.queryAllByTestId('request-filter-empty');
    return box.length ? String(only(screen.queryAllByText(/^No /), 'empty text').props.children) : undefined;
  };
  const apiCalls = () => gateway.calls.length;

  it('has Status, Type and Asked by me: named groups, chips that say what they are, All chosen', async () => {
    await openRequests();
    const groups = screen.queryAllByTestId(/^request-filter-group-/);
    expect(groups.map((node) => `${String(node.props.accessibilityRole)} ${String(node.props.accessibilityLabel)}`)).toEqual(['radiogroup Status', 'radiogroup Type']);
    expect(screen.queryAllByRole('radio').map((node) => String(node.props.accessibilityLabel))).toEqual([
      'All', 'Requested', 'Ready to watch', "Couldn't get this", 'All', 'Films', 'Series',
    ]);
    expect(screen.queryAllByRole('checkbox').map((node) => String(node.props.accessibilityLabel))).toEqual(['Asked by me']);
    expect(checked()).toEqual(['All', 'All']);
    expect(ids()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect(emptyText()).toBeUndefined();
  });

  it('keeps the chips 44 points high at least, and lets them wrap at large text rather than hide', async () => {
    await openRequests();
    for (const node of screen.queryAllByTestId(/^request-filter-(status|kind|by-you)/)) {
      expect({ id: String(node.props.testID), tall: Number(flat(node).minHeight) >= layout.touchTarget }).toEqual({ id: String(node.props.testID), tall: true });
    }
    expect(layout.touchTarget).toBeGreaterThanOrEqual(44);
    for (const group of screen.queryAllByTestId(/^request-filter-group-/)) expect(flat(group).flexWrap).toBe('wrap');
  });

  it('shows the entries that pass, alone and together, and a series under every status its seasons show', async () => {
    await openRequests();
    await choose('request-filter-status-requested');
    expect(ids()).toEqual(['r1', 'r3']);
    await choose('request-filter-status-ready');
    expect(ids()).toEqual(['r2', 'r3', 'r6']);
    await choose('request-filter-status-failed');
    expect(ids()).toEqual(['r4', 'r5']);
    // The admin note stays under each failed entry.
    expect(screen.queryAllByText(GET_THIS_TEXT.failedNote, { includeHiddenElements: true })).toHaveLength(2);
    await choose('request-filter-status-all');
    await choose('request-filter-kind-tv');
    expect(ids()).toEqual(['r3', 'r4', 'r6']);
    await choose('request-filter-kind-movie');
    expect(ids()).toEqual(['r1', 'r2', 'r5']);
    await choose('request-filter-kind-all');
    await choose('request-filter-by-you');
    expect(ids()).toEqual(['r1', 'r3', 'r5']);
    expect(checked()).toEqual(['All', 'All', 'Asked by me']);
    await choose('request-filter-status-requested');
    await choose('request-filter-kind-tv');
    expect(ids()).toEqual(['r3']);
    expect(checked()).toEqual(['Requested', 'Series', 'Asked by me']);
    await choose('request-filter-by-you');
    expect(checked()).toEqual(['Requested', 'Series']);
  });

  it('makes no call when a filter changes: not the API\'s, not a title\'s, and the titles stay named', async () => {
    await openRequests();
    const before = apiCalls();
    const names = () => screen.queryAllByTestId('request-item').map((node) => String(node.props.accessibilityLabel));
    const named = names();
    for (const id of ['request-filter-status-ready', 'request-filter-kind-tv', 'request-filter-by-you', 'request-filter-status-failed', 'request-filter-kind-movie', 'request-filter-status-all', 'request-filter-kind-all', 'request-filter-by-you']) {
      await choose(id);
      await wait(5_000);
    }
    expect(apiCalls()).toBe(before);
    expect(names()).toEqual(named);
    // What was read when the screen opened: the list once and each title once, nothing since.
    const routes = gateway.routes();
    expect(routes.filter((route) => route === `GET ${API}/requests`)).toHaveLength(1);
    expect(routes.filter((route) => /\/(movie|tv)\/\d+$/.test(route))).toHaveLength(LIST.length);
  });

  it('says what the filter left nothing of, and Show all requests clears every filter', async () => {
    await openRequests();
    await choose('request-filter-status-ready');
    await choose('request-filter-kind-movie');
    await choose('request-filter-by-you');
    expect(ids()).toEqual([]);
    expect(emptyText()).toBe('No films ready to watch, asked for by you.');
    await pressNode(only(screen.queryAllByRole('button', { name: REQUEST_FILTER_TEXT.showAll }), 'Show all requests'));
    expect(emptyText()).toBeUndefined();
    expect(checked()).toEqual(['All', 'All']);
    expect(ids()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
  });

  it('says more may match, under the entries that pass, while a filter is on and entries are still to load', async () => {
    const twelve = Array.from({ length: 12 }, (_, index) => requestEntry(`r${index + 1}`, 'movie', 910001 + index, index % 2 ? 'ready' : 'requested'));
    useHousehold({ requests: { results: twelve } });
    await openRequests();
    const hint = () => screen.queryAllByText(REQUEST_FILTER_TEXT.more).length;
    expect(hint()).toBe(0);
    await choose('request-filter-status-ready');
    expect(ids()).toHaveLength(5);
    expect(hint()).toBe(1);
    expect(screen.queryAllByTestId('request-filter-empty')).toHaveLength(0);
    await pressNode(only(screen.queryAllByRole('button', { name: 'Load more' }), 'Load more'));
    await settle();
    expect(ids()).toHaveLength(6);
    expect(hint()).toBe(0);
  });

  it('keeps the choice while the app is open: leaving the tab and coming back', async () => {
    const app = await openRequests();
    await choose('request-filter-status-failed');
    await choose('request-filter-by-you');
    expect(ids()).toEqual(['r5']);
    await act(async () => router.navigate('/account'));
    await settle();
    await act(async () => router.navigate('/requests'));
    await settle();
    expect(app.getPathname()).toBe('/requests');
    expect(checked()).toEqual(["Couldn't get this", 'All', 'Asked by me']);
    expect(ids()).toEqual(['r5']);
  });

  it('leaves the reuse of read titles alone: with a filter chosen, coming back reads the list only', async () => {
    await openRequests();
    await choose('request-filter-status-ready');
    await act(async () => router.navigate('/account'));
    await settle();
    const mark = gateway.routes().length;
    await act(async () => router.navigate('/requests'));
    await settle();
    expect(gateway.routes().slice(mark)).toEqual((BUDGET.screens['requests'] as unknown as { revisit: string[] }).revisit.map((route: string) => route.replace('GET ', `GET ${API}`)));
    expect(ids()).toEqual(['r2', 'r3', 'r6']);
  });

  it('keeps the entry\'s own link, name and the single-chip rule while filtered', async () => {
    await openRequests();
    await choose('request-filter-kind-tv');
    // r6 is a series of one season: one chip (said on the meta line), no season rows; r3 differs: a chip per season.
    const labels = screen.queryAllByTestId('request-item').map((node) => String(node.props.accessibilityLabel));
    expect(labels[2]).toBe('Series 910006, 2023 · Series · Season 1, Ready to watch, Asked for by someone in your household');
    expect(screen.queryAllByTestId('request-season', { includeHiddenElements: true })).toHaveLength(2);
  });
});

describe('in the session', () => {
  let session: Session | undefined;
  function Probe() {
    session = useSession();
    return null;
  }

  async function start() {
    const gateway = fakeGateway({
      'GET /jellypass/app/v1/me': () => answer(200, fixture('me')),
      'GET /Users/Public': () => answer(200, []),
      'POST /Sessions/Logout': () => answer(204),
    });
    const view = await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <SessionProvider deps={{ fetch: gateway.fetch, identity: async () => IDENTITY }}>
          <Probe />
        </SessionProvider>
      </SafeAreaProvider>,
    );
    await settle();
    return view;
  }

  beforeEach(() => {
    session = undefined;
    store.__items.clear();
    keepSession(TOKEN, ORIGIN);
  });

  const chosen: RequestFilter = { status: 'ready', kind: 'tv', byYou: true };

  it.each(['sign-out', 'a 401', 'a change of household'] as const)('resets the filters on %s', async (move) => {
    await start();
    const before = session!.requestFilters;
    before.set(chosen);
    expect(before.get()).toEqual(chosen);
    await act(async () => (move === 'sign-out' ? session!.signOut() : move === 'a 401' ? session!.expire() : session!.changeHousehold()));
    await settle();
    expect(before.get()).toEqual(NO_REQUEST_FILTER);
    expect(session!.requestFilters.get()).toEqual(NO_REQUEST_FILTER);
  });

  it.each([
    ['the same token', TOKEN],
    ['another member', 'synthetic-other-token-0002'],
  ])('starts unfiltered for another sign-in (%s)', async (_what, token) => {
    await start();
    const before = session!.requestFilters;
    before.set(chosen);
    await act(async () => session!.signOut());
    await settle();
    await act(async () => session!.completeSignIn(session!.household!, { token, userId: 'synthetic-user-0001', name: 'Ana Lima' }, session!.epoch()));
    await settle();
    expect(session!.phase.kind).toBe('signedIn');
    expect(session!.requestFilters === before).toBe(false);
    expect(session!.requestFilters.get()).toEqual(NO_REQUEST_FILTER);
  });

  it('is never written to the device', async () => {
    await start();
    const writes = JSON.stringify([...store.__items.entries()]);
    session!.requestFilters.set(chosen);
    expect(JSON.stringify([...store.__items.entries()])).toBe(writes);
    expect(API).toBeTruthy();
  });
});
