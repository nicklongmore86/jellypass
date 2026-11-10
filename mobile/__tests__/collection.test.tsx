// Collections (server apiVersion 6) and "Get all missing seasons", through the real router, signed in, with a fake
// gateway: a film's page links to its collection only when the server has collections and the film is in one; the
// collection page lists its films with the household's state, ticks the released ones it can ask for (never one not out
// yet), asks for the ticked films one Get this each, in order, never two at once, and on a refusal stops, says which were
// asked for and which were not with the wait the server gave, and reads the collection again. A series page's "Get all
// missing seasons" sends the seasons still to get in the one request Select all and Get this would.
// Queries are queryAll* and assertions read single fields, so a failure never prints the component tree.
import { act, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { Linking } from 'react-native';

import type { FetchLike } from '../src/api/client';
import { ALL_SEASONS_TEXT, COLLECTION_TEXT } from '../src/collection/text';
import { ERROR_TEXT, REQUEST_LABELS } from '../src/home/text';
import { layout } from '../src/theme';
import { GET_THIS_TEXT } from '../src/title/text';
import { API, showAll } from './support/home';
import { ORIGIN, TOKEN, answer, fixture, keepSession, settle, shows, store, storedSession, type Call } from './support/household';
import { buttonNamed, checkboxes, checkboxNamed, flat, linkNamed, movieAnswer, pressNode, seriesAnswer, titleGateway, type TitleHousehold } from './support/title';

jest.setTimeout(30_000);

let mockFetch: FetchLike;
jest.mock('../src/api/transport', () => ({
  ...jest.requireActual('../src/api/transport'),
  householdFetch: (url: string, init: never) => mockFetch(url, init),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: jest.requireActual('../app.config').default } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);

const COLLECTION_ID = 900100;
const LINK = { id: COLLECTION_ID, name: 'Synthetic Collection' };

type State = 'in_library' | 'get_this' | 'unavailable' | 'requested';

function film(tmdbId: number, state: State, released: boolean, releaseDate: string | null = released ? '2020-01-01' : '2999-12-31') {
  return {
    ...movieAnswer(tmdbId, state),
    title: `Film ${tmdbId}`,
    year: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
    hidden: false,
    releaseDate,
    released,
  } as Record<string, unknown>;
}

/** A collection: one in the library, three to get (out), one requested, one not out yet. */
function collectionAnswer(films = [film(1, 'in_library', true), film(2, 'get_this', true), film(3, 'get_this', true), film(4, 'requested', true), film(5, 'get_this', true), film(6, 'get_this', false)]) {
  return { id: COLLECTION_ID, name: 'Synthetic Collection', overview: 'A synthetic film series.', posterUrl: null, backdropUrl: null, films };
}

let gateway: ReturnType<typeof titleGateway>;
let apiVersion = 6;

interface Options extends TitleHousehold {
  collection?: () => Record<string, unknown>;
  /** The collection read's whole answer, in place of a 200 with `collection`'s body. */
  collectionRead?: () => ReturnType<typeof answer> | undefined;
}

function useHousehold(household: Options = {}) {
  const collection = household.collection ?? (() => collectionAnswer());
  gateway = titleGateway({
    ...household,
    override: (call: Call) => {
      if (call.route === `GET ${API}/me`) return answer(200, { ...fixture('me'), apiVersion });
      if (call.route === `GET ${API}/collection/${COLLECTION_ID}`) return household.collectionRead?.() ?? answer(200, collection());
      return household.override?.(call);
    },
  });
  mockFetch = gateway.fetch;
}

let openURL: jest.SpyInstance;
beforeEach(() => {
  apiVersion = 6;
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  useHousehold();
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});
afterEach(() => openURL.mockRestore());

async function open(path: string) {
  const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  await showAll();
  await act(async () => router.push(path));
  await settle();
  return app;
}

const routes = () => gateway.calls.map((call) => call.route.replace(`${API}/`, '/'));
const posts = () => routes().filter((route) => route.startsWith('POST '));
const collectionReads = () => routes().filter((route) => route === `GET /collection/${COLLECTION_ID}`).length;
const message = () =>
  screen
    .queryAllByTestId('films-message')
    .flatMap((node) => screen.queryAllByText(/./).filter((text) => isInside(text, node)))
    .map((node) => [node.props.children].flat().join(''));
type Node = NonNullable<ReturnType<typeof screen.queryAllByText>[number]>;
function isInside(node: Node, ancestor: Node): boolean {
  for (let at: Node | null = node; at; at = at.parent as Node | null) if (at === ancestor) return true;
  return false;
}
const getButton = (label: string) => buttonNamed(`${label}: Synthetic Collection`);

/** POSTs answered one at a time, when the test lets each answer. */
function held() {
  const waiting: ((response: ReturnType<typeof answer>) => void)[] = [];
  return {
    override: (call: Call) =>
      call.route.startsWith('POST ') ? new Promise<ReturnType<typeof answer>>((resolve) => waiting.push(resolve)) : undefined,
    release: async (response = answer(202, { status: 'accepted' })) => {
      await act(async () => waiting.shift()!(response));
      await settle();
    },
    waiting: () => waiting.length,
  };
}

describe("a film's collection link", () => {
  it('says "Part of" its collection and opens the collection page on the same tab', async () => {
    useHousehold({ movies: { 7: { ...movieAnswer(7), collection: LINK } as never } });
    const app = await open('/home/movie/7');
    const link = linkNamed('Part of Synthetic Collection');
    expect(flat(link).minHeight).toBe(layout.touchTarget);
    await pressNode(link);
    expect(app.getPathname()).toBe(`/home/collection/${COLLECTION_ID}`);
    expect(screen.queryAllByRole('header', { name: 'Synthetic Collection' })).toHaveLength(1);
  });

  it('shows no link on a server before apiVersion 6, and none for a film in no collection', async () => {
    apiVersion = 5;
    useHousehold({ movies: { 7: { ...movieAnswer(7), collection: LINK } as never } });
    await open('/home/movie/7');
    expect(screen.queryAllByRole('link', { name: /^Part of/ })).toHaveLength(0);
    expect(shows(/^Part of/)).toBe(false);
    apiVersion = 6;
    // A server before 6 sends no field at all: decoded as none.
    useHousehold({ movies: { 8: movieAnswer(8) as never, 9: { ...movieAnswer(9), collection: null } as never } });
    await act(async () => router.push('/search/movie/8'));
    await settle();
    expect(screen.queryAllByRole('link', { name: /^Part of/ })).toHaveLength(0);
    await act(async () => router.push('/search/movie/9'));
    await settle();
    expect(screen.queryAllByRole('link', { name: /^Part of/ })).toHaveLength(0);
  });
});

describe('a collection page', () => {
  it('lists every film with its state, and ticks the released ones it can ask for, never one not out yet', async () => {
    await open(`/home/collection/${COLLECTION_ID}`);
    // The collection, and My requests for the films whose request failed (as a film's page reads it).
    expect(routes().filter((route) => !route.startsWith('GET /discover') && route !== 'GET /me').sort()).toEqual([`GET /collection/${COLLECTION_ID}`, 'GET /requests']);
    for (const text of ['Synthetic Collection', 'A synthetic film series.', COLLECTION_TEXT.films]) expect(shows(text)).toBe(true);
    expect(screen.queryAllByTestId('film-row')).toHaveLength(6);
    expect(screen.queryAllByRole('link', { name: 'Film 1, 2020, Ready to watch' })).toHaveLength(1);
    expect(screen.queryAllByRole('link', { name: 'Film 4, 2020, Requested' })).toHaveLength(1);
    expect(screen.queryAllByRole('link', { name: `Film 6, 2999, Available to get, ${COLLECTION_TEXT.notReleased}` })).toHaveLength(1);
    expect(checkboxes()).toEqual(['Film 2 ✓', 'Film 3 ✓', 'Film 5 ✓', 'Film 6']);
    expect(getButton(COLLECTION_TEXT.getAll).props.accessibilityState?.disabled).toBe(false);
    expect(posts()).toEqual([]);
  });

  it('says "Get selected (N)" once the ticks differ, and asks for nothing with none ticked', async () => {
    await open(`/home/collection/${COLLECTION_ID}`);
    await pressNode(checkboxNamed('Film 3'));
    expect(getButton('Get selected (2)')).toBeTruthy();
    await pressNode(checkboxNamed('Film 6'));
    expect(getButton('Get selected (3)')).toBeTruthy();
    await pressNode(checkboxNamed('Film 6'));
    await pressNode(checkboxNamed('Film 3'));
    expect(getButton(COLLECTION_TEXT.getAll)).toBeTruthy();
    for (const name of ['Film 2', 'Film 3', 'Film 5']) await pressNode(checkboxNamed(name));
    expect(getButton('Get selected (0)').props.accessibilityState?.disabled).toBe(true);
    expect(shows(COLLECTION_TEXT.chooseBelow)).toBe(true);
    expect(posts()).toEqual([]);
  });

  it('asks for the missing films one Get this each, in order and one at a time, then reads the collection again', async () => {
    const gate = held();
    let read = 0;
    useHousehold({
      override: gate.override,
      collection: () => {
        read += 1;
        return read === 1 ? collectionAnswer() : collectionAnswer([film(1, 'in_library', true), film(2, 'requested', true), film(3, 'requested', true), film(4, 'requested', true), film(5, 'requested', true), film(6, 'get_this', false)]);
      },
    });
    await open(`/home/collection/${COLLECTION_ID}`);
    await pressNode(getButton(COLLECTION_TEXT.getAll));
    // The first is out; nothing else is sent until it answers, and nothing can be ticked meanwhile.
    expect(posts()).toEqual(['POST /movie/2/get']);
    expect(checkboxNamed('Film 3').props.accessibilityState?.disabled).toBe(true);
    expect(buttonNamed(GET_THIS_TEXT.sending).props.accessibilityState?.busy).toBe(true);
    await gate.release();
    expect(posts()).toEqual(['POST /movie/2/get', 'POST /movie/3/get']);
    await gate.release();
    await gate.release();
    expect(posts()).toEqual(['POST /movie/2/get', 'POST /movie/3/get', 'POST /movie/5/get']);
    expect(gateway.calls.filter((call) => call.init.method === 'POST').map((call) => call.init.body)).toEqual(['{}', '{}', '{}']);
    expect(message()).toEqual([GET_THIS_TEXT.confirmation]);
    expect(collectionReads()).toBe(2);
    // Only the film not out yet is left to tick, and it is not ticked.
    expect(checkboxes()).toEqual(['Film 6']);
    expect(screen.queryAllByRole('link', { name: 'Film 3, 2020, Requested' })).toHaveLength(1);
  });

  it('stops at a refusal: says which films were asked for, which were not, and how long to wait', async () => {
    let asked = 0;
    useHousehold({
      getThis: () => {
        asked += 1;
        return asked === 1 ? answer(202, { status: 'accepted' }) : answer(429, { error: 'too_many_requests', retryAfterSeconds: 600 }, { 'Retry-After': '600' });
      },
    });
    await open(`/home/collection/${COLLECTION_ID}`);
    await pressNode(checkboxNamed('Film 6'));
    await pressNode(getButton('Get selected (4)'));
    // Film 5 and Film 6 were never sent.
    expect(posts()).toEqual(['POST /movie/2/get', 'POST /movie/3/get']);
    expect(message()).toEqual(['Asked for: Film 2.', 'Not asked for: Film 3, Film 5, Film 6.', 'Too many tries. Try again in 10 minutes.']);
    // Read again, as something was asked for; the film asked for is Requested and no longer offered.
    expect(collectionReads()).toBe(2);
    expect(screen.queryAllByRole('link', { name: 'Film 2, 2020, Requested' })).toHaveLength(1);
    expect(checkboxes()).toEqual(['Film 3 ✓', 'Film 5 ✓', 'Film 6']);
  });

  it('says nothing was asked for when the first is refused, and does not read the collection again', async () => {
    useHousehold({ getThis: () => answer(429, { error: 'too_many_requests' }) });
    await open(`/home/collection/${COLLECTION_ID}`);
    await pressNode(getButton(COLLECTION_TEXT.getAll));
    expect(posts()).toEqual(['POST /movie/2/get']);
    expect(message()).toEqual(['Not asked for: Film 2, Film 3, Film 5.', GET_THIS_TEXT.rate_limited]);
    expect(collectionReads()).toBe(1);
  });

  it('shows a film whose request failed as such, never offers or ticks it, and so never sends it as newly asked for', async () => {
    useHousehold({
      requests: { results: [{ id: 'AAAAAAAAAAAAAAAAAAAAAA', mediaType: 'movie', tmdbId: 2, status: 'failed', seasons: [], byYou: true, cancellable: false, requestedOn: '2026-11-01' }] },
    });
    await open(`/home/collection/${COLLECTION_ID}`);
    expect(screen.queryAllByRole('link', { name: `Film 2, 2020, ${REQUEST_LABELS.failed}` })).toHaveLength(1);
    expect(checkboxes()).toEqual(['Film 3 ✓', 'Film 5 ✓', 'Film 6']);
    await pressNode(getButton(COLLECTION_TEXT.getAll));
    expect(posts()).toEqual(['POST /movie/3/get', 'POST /movie/5/get']);
    expect(message()).toEqual([GET_THIS_TEXT.confirmation]);
  });

  it('marks a film the member hid as Not interested and leaves it unticked, though it can be ticked by hand', async () => {
    useHousehold({ collection: () => collectionAnswer([film(2, 'get_this', true), { ...film(3, 'get_this', true), hidden: true }, film(5, 'get_this', true)]) });
    await open(`/home/collection/${COLLECTION_ID}`);
    expect(screen.queryAllByRole('link', { name: `Film 3, 2020, Available to get, ${COLLECTION_TEXT.hidden}` })).toHaveLength(1);
    expect(shows(COLLECTION_TEXT.hidden)).toBe(true);
    expect(checkboxes()).toEqual(['Film 2 ✓', 'Film 3', 'Film 5 ✓']);
    expect(getButton(COLLECTION_TEXT.getAll)).toBeTruthy();
    await pressNode(checkboxNamed('Film 3'));
    expect(getButton('Get selected (3)')).toBeTruthy();
  });

  it('offers nothing when every film is held or asked for', async () => {
    useHousehold({ collection: () => collectionAnswer([film(1, 'in_library', true), film(4, 'requested', true), film(7, 'unavailable', true)]) });
    await open(`/home/collection/${COLLECTION_ID}`);
    expect(checkboxes()).toEqual([]);
    expect(screen.queryAllByRole('button', { name: /^Get / })).toHaveLength(0);
  });

  describe('a 401 from My requests, read with the collection', () => {
    /** The collection read fails at once (when `failing`); My requests answers 401 only when the test lets it, after. */
    function useLateRefusal() {
      const waiting: ((response: ReturnType<typeof answer>) => void)[] = [];
      const state = { failing: true };
      useHousehold({
        collectionRead: () => (state.failing ? answer(503, { error: 'unavailable' }) : undefined),
        override: (call: Call) =>
          state.failing && call.route === `GET ${API}/requests` ? new Promise<ReturnType<typeof answer>>((resolve) => waiting.push(resolve)) : undefined,
      });
      return {
        state,
        refuse: async () => {
          await act(async () => waiting.shift()!(answer(401, { error: 'unauthorized' })));
          await settle();
        },
        waiting: () => waiting.length,
      };
    }

    it('signs the member out on opening, though the collection read failed first', async () => {
      const late = useLateRefusal();
      const app = await open(`/home/collection/${COLLECTION_ID}`);
      expect(late.waiting()).toBe(1);
      await late.refuse();
      expect(storedSession()).toBeUndefined();
      expect(app.getPathname()).toBe('/');
      expect(shows(ERROR_TEXT.unavailable.title)).toBe(false);
    });

    it('signs the member out when the collection is read again after a film was asked for', async () => {
      const late = useLateRefusal();
      late.state.failing = false;
      const app = await open(`/home/collection/${COLLECTION_ID}`);
      late.state.failing = true;
      await pressNode(getButton(COLLECTION_TEXT.getAll));
      expect(late.waiting()).toBe(1);
      await late.refuse();
      expect(storedSession()).toBeUndefined();
      expect(app.getPathname()).toBe('/');
    });
  });

  it('is Not found without a call for an address that names no collection', async () => {
    await open('/home/collection/abc');
    expect(shows(ERROR_TEXT.not_found.title)).toBe(true);
    expect(collectionReads()).toBe(0);
  });
});

describe('"Get all missing seasons"', () => {
  const bodies = () => gateway.calls.filter((call) => call.init.method === 'POST').map((call) => call.init.body);

  it('asks for every season still to get in one request, as Select all and Get this would', async () => {
    useHousehold({ series: { 9: seriesAnswer(9, ['in_library', 'get_this', 'requested', 'get_this']) } });
    await open('/home/tv/9');
    expect(flat(buttonNamed(ALL_SEASONS_TEXT)).minHeight).toBe(layout.touchTarget);
    await pressNode(buttonNamed(ALL_SEASONS_TEXT));
    expect(bodies()).toEqual([JSON.stringify({ seasons: [2, 4] })]);
    expect(shows(GET_THIS_TEXT.confirmation)).toBe(true);
  });

  it('leaves out a season that failed, and is not offered when nothing is left to get', async () => {
    useHousehold({
      series: { 9: seriesAnswer(9, ['get_this', 'get_this', 'get_this']), 10: seriesAnswer(10, ['in_library', 'requested']) },
      requests: { results: [{ id: 'AAAAAAAAAAAAAAAAAAAAAA', mediaType: 'tv', tmdbId: 9, status: 'requested', seasons: [{ seasonNumber: 2, status: 'failed' }], byYou: false }] },
    });
    await open('/home/tv/9');
    await pressNode(buttonNamed(ALL_SEASONS_TEXT));
    expect(bodies()).toEqual([JSON.stringify({ seasons: [1, 3] })]);
    await act(async () => router.push('/home/tv/10'));
    await settle();
    expect(screen.queryAllByRole('button', { name: ALL_SEASONS_TEXT })).toHaveLength(0);
  });

  it('shows the wait a refusal gave', async () => {
    useHousehold({
      series: { 9: seriesAnswer(9, ['get_this', 'get_this']) },
      getThis: () => answer(429, { error: 'too_many_requests', retryAfterSeconds: 90 }, { 'Retry-After': '90' }),
    });
    await open('/home/tv/9');
    await pressNode(buttonNamed(ALL_SEASONS_TEXT));
    expect(bodies()).toEqual([JSON.stringify({ seasons: [1, 2] })]);
    expect(shows('Too many tries. Try again in 2 minutes.')).toBe(true);
  });
});
