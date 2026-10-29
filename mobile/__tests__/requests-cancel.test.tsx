// Cancel request on My requests, through the real router, signed in, with a fake gateway: the button only on entries the
// server lists as cancellable (never from a server before apiVersion 2, which sends no such field), 44pt, named by its
// request; asked first in a sheet that says what Cancel does, where Keep sends nothing; on confirming one POST with an
// empty object, the same "Request cancelled" on the fixed 202, the entry gone, the list read again (the budget's `cancel`
// calls), and the title Get this again in the overlay. Each failure its own fixed words, nothing from the response, never
// retried by itself, and a 401 signs out. Queries are queryAll* and assertions read single fields, so a failure never
// prints the component tree.
import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';

import type { FetchLike } from '../src/api/client';
import { CANCEL_TEXT } from '../src/requests/text';
import { layout } from '../src/theme';
import { BUDGET } from './support/app-api';
import { API, budgetRoute } from './support/home';
import { ORIGIN, TOKEN, answer, fixture, keepSession, settle, shows, store, storedSession, type Call } from './support/household';
import { requestEntry, searchGateway, type SearchHousehold } from './support/search';
import { pressNode } from './support/title';

jest.setTimeout(30_000);

let mockFetch: FetchLike;
jest.mock('../src/api/transport', () => ({
  ...jest.requireActual('../src/api/transport'),
  householdFetch: (url: string, init: never) => mockFetch(url, init),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: jest.requireActual('../app.config').default } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);

const CANCEL_BUDGET = BUDGET.screens['requests']!.cancel!;
const FIXTURE = fixture('requests') as { results: { id: string; tmdbId: number }[] };
const SERIES_ID = FIXTURE.results[0]!.id;

/** What the fake server holds: the list it answers and what a cancel gets. */
let list: unknown[];
let cancelAs: { status: number; body: unknown } | 'offline';
/** A cancel is held until this is called, when set. */
let hold: Promise<void> | undefined;
let gateway: ReturnType<typeof searchGateway>;

const cancelCall = (call: Call) => call.init.method === 'POST' && /\/requests\/[A-Za-z0-9_-]{22}\/cancel$/.test(call.url);

function serveHousehold(household: SearchHousehold = {}) {
  gateway = searchGateway({
    ...household,
    override: (call) => {
      if (call.route === `GET ${API}/requests`) return answer(200, { results: list });
      if (cancelCall(call)) {
        if (hold) return hold.then(() => answer(202, { status: 'accepted' }));
        if (cancelAs === 'offline') return Promise.reject(new TypeError('Network request failed'));
        if (cancelAs.status === 202) list = list.filter((entry) => !call.url.includes((entry as { id: string }).id));
        return answer(cancelAs.status, cancelAs.body);
      }
      return household.override?.(call);
    },
  });
  mockFetch = gateway.fetch;
}

beforeEach(() => {
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  list = JSON.parse(JSON.stringify(FIXTURE.results)) as unknown[];
  cancelAs = { status: 202, body: { status: 'accepted' } };
  hold = undefined;
  serveHousehold();
});

async function openRequests() {
  const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  const before = gateway.calls.length;
  await act(async () => router.navigate('/requests'));
  await settle();
  return { app, since: () => gateway.calls.slice(before) };
}

const cancelButtons = () => screen.queryAllByTestId('request-cancel').map((node) => String(node.props.accessibilityLabel));
const sheetShown = () => screen.queryAllByTestId('cancel-sheet').length > 0;
const posts = () => gateway.calls.filter(cancelCall);
const first = (testID: string) => screen.queryAllByTestId(testID)[0]!;
const errorText = () => String(screen.queryAllByTestId('cancel-error')[0]?.props.children ?? '');
const noticeText = () => String(screen.queryAllByTestId('cancel-notice')[0]?.props.children ?? '');

async function openSheet() {
  const view = await openRequests();
  await pressNode(first('request-cancel'));
  return view;
}

describe('the button', () => {
  it('is on the entries the server lists as cancellable only, named by its request, with a 44pt target', async () => {
    await openRequests();
    expect(cancelButtons()).toEqual(['Cancel request: Series 900002']);
    const style = [first('request-cancel').props.style].flat(2).filter(Boolean) as { minHeight?: number }[];
    expect(Math.max(...style.map((entry) => entry.minHeight ?? 0))).toBeGreaterThanOrEqual(layout.touchTarget);
    expect(first('request-cancel').props.accessibilityRole).toBe('button');
  });

  it('is not on any entry from a server before apiVersion 2 (no cancellable field)', async () => {
    list = [requestEntry('a', 'movie', 900001, 'requested'), requestEntry('b', 'tv', 900002, 'requested')];
    await openRequests();
    expect(cancelButtons()).toEqual([]);
  });

  it('shows the day each request was made, no time', async () => {
    await openRequests();
    expect(screen.queryAllByTestId('request-on', { includeHiddenElements: true }).map((node) => String(node.props.children))).toEqual(['Requested on Oct 27, 2026', 'Requested on Sep 30, 2026']);
  });
});

describe('asking first', () => {
  it('opens a sheet that says what Cancel does, and sends nothing', async () => {
    await openSheet();
    expect(sheetShown()).toBe(true);
    expect(shows(CANCEL_TEXT.heading)).toBe(true);
    expect(shows(CANCEL_TEXT.body)).toBe(true);
    expect(shows(CANCEL_TEXT.confirm)).toBe(true);
    expect(shows(CANCEL_TEXT.keep)).toBe(true);
    expect(posts()).toHaveLength(0);
  });

  it('closes on Keep request with nothing sent, and the entry stays', async () => {
    await openSheet();
    await pressNode(first('cancel-keep'));
    expect(sheetShown()).toBe(false);
    expect(posts()).toHaveLength(0);
    expect(cancelButtons()).toHaveLength(1);
    expect(screen.queryAllByTestId('cancel-notice')).toHaveLength(0);
  });

  it('has 44pt buttons that scroll, for the largest text', async () => {
    await openSheet();
    for (const id of ['cancel-confirm', 'cancel-keep']) {
      const style = [first(id).props.style].flat(2).filter(Boolean) as { minHeight?: number }[];
      expect(Math.max(...style.map((entry) => entry.minHeight ?? 0))).toBeGreaterThanOrEqual(layout.touchTarget);
    }
    expect(first('cancel-sheet').type).toBe('RCTScrollView');
  });
});

describe('cancelling', () => {
  it('sends one POST with an empty object, says Request cancelled, drops the entry and reads the list again (the pinned calls)', async () => {
    const { since } = await openSheet();
    await pressNode(first('cancel-confirm'));
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.route).toBe(`POST ${API}/requests/${SERIES_ID}/cancel`);
    expect(posts()[0]!.init.body).toBe('{}');
    expect(sheetShown()).toBe(false);
    expect(noticeText()).toBe('Request cancelled');
    expect(cancelButtons()).toEqual([]);
    expect(screen.queryAllByTestId('request-item')).toHaveLength(1);
    const made = since().map((call) => budgetRoute(`${call.init.method} ${call.url.replace(/^https:\/\/[^/]+/, '')}`).replace(/\/requests\/[A-Za-z0-9_-]{22}\/cancel$/, '/requests/{id}/cancel'));
    // The screen opened (the list and its titles), then the cancel's own calls.
    expect(made.slice(-CANCEL_BUDGET.length).sort()).toEqual([...CANCEL_BUDGET].sort());
    expect(made.filter((route) => /\/(movie|tv)\//.test(route))).toHaveLength(2);
  });

  it.each([
    [429, CANCEL_TEXT.rate_limited],
    [500, CANCEL_TEXT.unavailable],
    [404, CANCEL_TEXT.unavailable],
  ])('says the fixed words for a %i, nothing from the response, sends it once, and lets the member try again', async (status, text) => {
    cancelAs = { status, body: { error: 'upstream said something private' } };
    await openSheet();
    await pressNode(first('cancel-confirm'));
    expect(errorText()).toBe(text);
    expect(sheetShown()).toBe(true);
    expect(shows('upstream said something private')).toBe(false);
    expect(posts()).toHaveLength(1);
    expect(screen.queryAllByTestId('cancel-notice')).toHaveLength(0);
    cancelAs = { status: 202, body: { status: 'accepted' } };
    await pressNode(first('cancel-confirm'));
    expect(posts()).toHaveLength(2);
    expect(noticeText()).toBe('Request cancelled');
  });

  it('says the offline words with no connection', async () => {
    cancelAs = 'offline';
    await openSheet();
    await pressNode(first('cancel-confirm'));
    expect(errorText()).toBe(CANCEL_TEXT.offline);
    expect(posts()).toHaveLength(1);
  });

  it('sends once however often the button is pressed while the call is out', async () => {
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => (release = resolve));
    await openSheet();
    await act(async () => {
      fireEvent.press(first('cancel-confirm'));
      fireEvent.press(first('cancel-confirm'));
    });
    await settle();
    expect(posts()).toHaveLength(1);
    expect(first('cancel-confirm').props.accessibilityState?.disabled).toBe(true);
    expect(first('cancel-keep').props.accessibilityState?.disabled).toBe(true);
    await act(async () => release());
    await settle();
    expect(posts()).toHaveLength(1);
    expect(noticeText()).toBe('Request cancelled');
  });

  it('clears Request cancelled on leaving the screen, and when another cancel is opened', async () => {
    list = [
      requestEntry(SERIES_ID, 'tv', 900002, 'requested', { cancellable: true, requestedOn: '2026-10-27' }),
      requestEntry('MMMMMMMMMMMMMMMMMMMMMM', 'movie', 900001, 'requested', { cancellable: true, requestedOn: '2026-10-26' }),
    ];
    const { app } = await openSheet();
    await pressNode(first('cancel-confirm'));
    expect(noticeText()).toBe('Request cancelled');
    // Opening the other request's sheet takes the confirmation of the first away.
    await pressNode(first('request-cancel'));
    expect(sheetShown()).toBe(true);
    expect(screen.queryAllByTestId('cancel-notice')).toHaveLength(0);
    await pressNode(first('cancel-keep'));
    await pressNode(first('request-cancel'));
    await pressNode(first('cancel-confirm'));
    expect(noticeText()).toBe('Request cancelled');
    // Leaving and coming back shows no confirmation.
    await act(async () => router.navigate('/'));
    await settle();
    await act(async () => router.navigate('/requests'));
    await settle();
    expect(app.getPathname()).toBe('/requests');
    expect(screen.queryAllByTestId('cancel-notice')).toHaveLength(0);
  });

  it('signs the member out on a 401', async () => {
    cancelAs = { status: 401, body: { error: 'unauthorized' } };
    const { app } = await openSheet();
    await pressNode(first('cancel-confirm'));
    expect(storedSession()).toBeUndefined();
    expect(app.getPathname()).toBe('/');
  });

  it('shows the same confirmation whatever the server did with it', async () => {
    const run = async (extra: Record<string, unknown>) => {
      list = [requestEntry(SERIES_ID, 'tv', 900002, 'requested', { cancellable: true, requestedOn: '2026-10-27', ...extra })];
      serveHousehold();
      await openRequests();
      await pressNode(first('request-cancel'));
      await pressNode(first('cancel-confirm'));
      return [noticeText(), screen.queryAllByTestId('request-item').length, sheetShown()];
    };
    expect(await run({})).toEqual(['Request cancelled', 0, false]);
  });
});
