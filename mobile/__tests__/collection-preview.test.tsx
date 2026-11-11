// A film page's collection section (server apiVersion 6), through the real router, signed in, with a fake gateway: under
// the film's overview, the heading "Part of <name>" (its row and its chevron open the collection page) and the
// collection's other films as poster cards with their states, each opening its own page. The collection is read once,
// after the film's page is drawn (placeholder posters meanwhile); a failed read leaves the plain link and no error, a 401
// signs the member out, and a server before apiVersion 6 shows nothing. Films the member hid say so, as on the collection
// page. Queries are queryAll* and assertions read single fields, so a failure never prints the component tree.
import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';

import type { FetchLike } from '../src/api/client';
import { ERROR_TEXT } from '../src/home/text';
import { HIDE_TEXT } from '../src/hidden/text';
import { GET_THIS_TEXT } from '../src/title/text';
import { API, showAll } from './support/home';
import { ORIGIN, TOKEN, answer, fixture, keepSession, settle, shows, store, storedSession, type Call } from './support/household';
import { linkNamed, movieAnswer, pressNode, titleGateway } from './support/title';

jest.setTimeout(30_000);

let mockFetch: FetchLike;
jest.mock('../src/api/transport', () => ({
  ...jest.requireActual('../src/api/transport'),
  householdFetch: (url: string, init: never) => mockFetch(url, init),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: jest.requireActual('../app.config').default } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);

const COLLECTION_ID = 900100;
const NAME = 'Synthetic Collection';
const LINK = { id: COLLECTION_ID, name: NAME };
const COLLECTION_READ = `GET ${API}/collection/${COLLECTION_ID}`;

type State = 'in_library' | 'get_this' | 'unavailable' | 'requested';
function film(tmdbId: number, state: State, extra: Record<string, unknown> = {}) {
  return { ...movieAnswer(tmdbId, state), year: 2020, hidden: false, releaseDate: '2020-01-01', released: true, ...extra } as Record<string, unknown>;
}

/** Film 7 (the page's own), one in the library, one requested, one to get that the member hid. */
const FILMS = () => [film(7, 'get_this'), film(1, 'in_library'), film(2, 'requested'), film(3, 'get_this', { hidden: true })];
const collectionAnswer = (films = FILMS()) => ({ id: COLLECTION_ID, name: NAME, overview: 'A synthetic film series.', posterUrl: null, backdropUrl: null, films });

let gateway: ReturnType<typeof titleGateway>;
let apiVersion = 6;
type Answer = ReturnType<typeof answer>;

function useHousehold(collectionRead: () => Answer | Promise<Answer> = () => answer(200, collectionAnswer())) {
  gateway = titleGateway({
    movies: { 7: { ...movieAnswer(7), collection: LINK } as never },
    override: (call: Call) => {
      if (call.route === `GET ${API}/me`) return answer(200, { ...fixture('me'), apiVersion });
      if (call.route === COLLECTION_READ) return collectionRead();
      return undefined;
    },
  });
  mockFetch = gateway.fetch;
}

beforeEach(() => {
  apiVersion = 6;
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  useHousehold();
});

async function open(path = '/home/movie/7') {
  const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  await showAll();
  const before = gateway.calls.length;
  await act(async () => router.push(path));
  await settle();
  return { app, made: () => gateway.calls.slice(before).map((call) => call.route.replace(`${API}/`, '/')) };
}

const ids = (id: string) => screen.queryAllByTestId(id, { includeHiddenElements: true }).length;
/** The section's own nodes (Home stays drawn under the film's page, with rows of its own). */
const section = () => screen.queryAllByTestId('collection-preview', { includeHiddenElements: true });
const inSection = (id: string) => section().flatMap((node) => within(node).queryAllByTestId(id, { includeHiddenElements: true })).length;
const posterNames = () =>
  section().flatMap((node) => within(node).queryAllByRole('link', { name: /, Movie, / })).map((node) => String(node.props.accessibilityLabel));

/** Every string drawn, in the page's order (depth first). */
function textOrder(): string[] {
  type Walk = { children: readonly (Walk | string)[] };
  const out: string[] = [];
  const walk = (node: Walk | string) => {
    if (typeof node === 'string') out.push(node);
    else node.children.forEach(walk);
  };
  walk(screen.root as unknown as Walk);
  return out;
}

/** The collection read, answered when the test says. */
function heldRead() {
  let release: ((response: Answer) => void) | undefined;
  useHousehold(() => new Promise<Answer>((resolve) => (release = resolve)));
  return async (response: Answer) => {
    await act(async () => release!(response));
    await settle();
  };
}

describe("a film page's collection section", () => {
  it('draws the film first, with the heading over placeholder posters, while the collection is read', async () => {
    heldRead();
    await open();
    expect(shows('Film 7')).toBe(true);
    expect(shows('The overview of film 7.')).toBe(true);
    expect(screen.queryAllByRole('header', { name: `Part of ${NAME}` })).toHaveLength(1);
    expect(ids('collection-preview')).toBe(1);
    expect(ids('collection-link')).toBe(1);
    expect(ids('collection-see-all')).toBe(1);
    // The placeholders are drawn but hidden from screen readers; no poster yet.
    expect(inSection('skeleton-row')).toBe(1);
    expect(section().flatMap((node) => within(node).queryAllByTestId('skeleton-row'))).toHaveLength(0);
    expect(inSection('card-row')).toBe(0);
  });

  it('lists the other films as poster cards with their states, after the overview, from one collection read', async () => {
    const { made } = await open();
    expect(made().filter((route) => route !== 'GET /me').sort()).toEqual([`GET /collection/${COLLECTION_ID}`, 'GET /movie/7', 'GET /requests']);
    expect(inSection('skeleton-row')).toBe(0);
    expect(posterNames()).toEqual(['Film 1, 2020, Movie, TMDB rating 7.4 out of 10, Ready to watch', 'Film 2, 2020, Movie, TMDB rating 7.4 out of 10, Requested', `Film 3, 2020, Movie, TMDB rating 7.4 out of 10, Available to get, ${HIDE_TEXT.state}`]);
    // The film's own page is the one open: it is not a card.
    expect(screen.queryAllByRole('link', { name: /^Film 7,/ })).toHaveLength(0);
    // The hidden film says so in words under its card.
    expect(screen.queryAllByText(HIDE_TEXT.badge, { includeHiddenElements: true })).toHaveLength(1);
    // Under the overview: the overview comes first in the page.
    const order = textOrder();
    const overview = order.indexOf('The overview of film 7.');
    const heading = order.lastIndexOf('Film 7', overview);
    expect(heading).toBeGreaterThan(-1);
    expect(overview).toBeLessThan(order.indexOf(`Part of ${NAME}`));
    // And after the film's own actions (its title, then Get this, then the overview).
    const action = order.indexOf(GET_THIS_TEXT.button, heading);
    expect(action).toBeGreaterThan(heading);
    expect(action).toBeLessThan(overview);
  });

  it("opens a film's own page from its poster, and the collection page from the heading and from its chevron", async () => {
    const { app } = await open();
    await pressNode(linkNamed(/^Film 1, /));
    expect(app.getPathname()).toBe('/home/movie/1');
    await act(async () => router.back());
    await settle();
    await pressNode(screen.getByTestId('collection-link'));
    expect(app.getPathname()).toBe(`/home/collection/${COLLECTION_ID}`);
    await act(async () => router.back());
    await settle();
    expect(app.getPathname()).toBe('/home/movie/7');
    await pressNode(linkNamed(`See all films in ${NAME}`));
    expect(app.getPathname()).toBe(`/home/collection/${COLLECTION_ID}`);
  });

  it('opens the collection page from a press on the heading text itself (as the screenshot flow taps it)', async () => {
    const { app } = await open();
    await act(async () => fireEvent.press(screen.getByText(`Part of ${NAME}`)));
    await settle();
    expect(app.getPathname()).toBe(`/home/collection/${COLLECTION_ID}`);
  });

  it('shows only the heading when the film is the only one listed', async () => {
    useHousehold(() => answer(200, collectionAnswer([film(7, 'get_this')])));
    await open();
    expect(ids('collection-link')).toBe(1);
    expect(inSection('card-row')).toBe(0);
    expect(inSection('skeleton-row')).toBe(0);
  });

  it('falls back to the plain "Part of" link when the read fails, with no error and no retry', async () => {
    const release = heldRead();
    const { app, made } = await open();
    await release(answer(503, { error: 'unavailable' }));
    await act(async () => {
      jest.advanceTimersByTime(10 * 60_000);
    });
    await settle();
    expect(ids('collection-preview')).toBe(0);
    expect(inSection('skeleton-row')).toBe(0);
    expect(inSection('card-row')).toBe(0);
    expect(shows(ERROR_TEXT.unavailable.title)).toBe(false);
    expect(shows('Film 7')).toBe(true);
    expect(made().filter((route) => route === `GET /collection/${COLLECTION_ID}`)).toHaveLength(1);
    const link = linkNamed(`Part of ${NAME}`);
    expect(link.props.testID).toBe('collection-link');
    await pressNode(link);
    expect(app.getPathname()).toBe(`/home/collection/${COLLECTION_ID}`);
  });

  it('signs the member out on a 401 from the collection read', async () => {
    const release = heldRead();
    const { app } = await open();
    await release(answer(401, { error: 'unauthorized' }));
    expect(storedSession()).toBeUndefined();
    expect(app.getPathname()).toBe('/');
  });

  it('shows nothing, and reads nothing, on a server before apiVersion 6', async () => {
    apiVersion = 5;
    useHousehold();
    const { made } = await open();
    expect(shows('Film 7')).toBe(true);
    expect(ids('collection-preview')).toBe(0);
    expect(ids('collection-link')).toBe(0);
    expect(shows(/^Part of/)).toBe(false);
    expect(made().some((route) => route.includes('/collection/'))).toBe(false);
  });

  it('makes no collection read for a film in no collection', async () => {
    gateway = titleGateway({
      override: (call: Call) => (call.route === `GET ${API}/me` ? answer(200, { ...fixture('me'), apiVersion }) : undefined),
    });
    mockFetch = gateway.fetch;
    const { made } = await open('/home/movie/8');
    expect(ids('collection-link')).toBe(0);
    expect(made().some((route) => route.includes('/collection/'))).toBe(false);
  });
});
