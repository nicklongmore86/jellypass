// Home's tests: a household whose every Home list answers a synthetic page (example.test addresses and TMDB-shaped
// image URLs only), all eight services and a few studios, and helpers that lay Home out and scroll it the way the
// device would (Jest lays nothing out by itself, so no lazy row comes near the screen until a test says so). Queries
// are queryAll* only and assertions read single fields, so a failure never prints the component tree.
import { act, fireEvent, screen } from '@testing-library/react-native';

import type { FetchLike, ResponseLike } from '../../src/api/client';
import { answer, fixture, settle, type Call } from './household';

export const API = '/jellypass/app/v1';

/** The eight services the server lists, in its order (docs/app-design.md, "Networks and studios"). */
export const NETWORKS = [
  [213, 'Netflix'],
  [2739, 'Disney+'],
  [2552, 'Apple TV'],
  [1024, 'Prime Video'],
  [3186, 'HBO Max'],
  [453, 'Hulu'],
  [4330, 'Paramount+'],
  [3353, 'Peacock'],
] as const;

export const STUDIOS = [
  [2, 'Disney'],
  [420, 'Marvel Studios'],
  [41077, 'A24'],
] as const;

export function sourcesAnswer(hasFilms: (id: number) => boolean = () => true) {
  return {
    networks: NETWORKS.map(([id, name]) => ({ id, name, logoUrl: `https://image.tmdb.org/t/p/w300/logo-${id}.png`, hasFilms: hasFilms(id) })),
    studios: STUDIOS.map(([id, name]) => ({ id, name, logoUrl: id === 41077 ? null : `https://image.tmdb.org/t/p/w300/studio-${id}.png` })),
  };
}

const STATES = ['in_library', 'get_this', 'unavailable', 'requested'] as const;

/** A page of `count` titles named after the list, so a row's cards say which list they came from. */
export function pageAnswer(list: string, count = 20) {
  return {
    page: 1,
    nextPage: count === 20 ? 2 : null,
    results: Array.from({ length: count }, (_, index) => {
      const n = index + 1;
      const tv = list.includes('tv') || list.endsWith('series') ? true : list.includes('movie') || list === 'upcoming' || list.endsWith('films') ? false : index % 2 === 1;
      return {
        mediaType: tv ? 'tv' : 'movie',
        tmdbId: 1000 + n,
        title: `${list} ${n}`,
        year: 2020 + (index % 6),
        overview: `The overview of ${list} ${n}.`,
        posterUrl: `https://image.tmdb.org/t/p/w342/poster-${n}.jpg`,
        backdropUrl: `https://image.tmdb.org/t/p/w780/backdrop-${n}.jpg`,
        rating: 6 + (index % 4) / 2,
        state: STATES[index % 4],
        play: null,
      };
    }),
  };
}

/** The list a Home call asked for, as its page is named: `trending`, `network-213-all`, … */
export function listOf(route: string): string | undefined {
  const discover = /^GET \/jellypass\/app\/v1\/discover\/([a-z-]+)$/.exec(route);
  if (discover && discover[1] !== 'sources') return discover[1];
  const network = /^GET \/jellypass\/app\/v1\/discover\/network\/(\d+)(?:\/(films|all))?$/.exec(route);
  return network ? `network-${network[1]}-${network[2] ?? 'series'}` : undefined;
}

/** Answers every Home call: /me, the sources and any list. `override` answers first when it returns something. */
export function homeHousehold(override: (call: Call) => ResponseLike | Promise<ResponseLike> | undefined = () => undefined, sources = sourcesAnswer()) {
  return (call: Call): ResponseLike | Promise<ResponseLike> => {
    const own = override(call);
    if (own) return own;
    if (call.route === `GET ${API}/me`) return answer(200, fixture('me'));
    if (call.route === `GET ${API}/discover/sources`) return answer(200, sources);
    const list = listOf(call.route);
    return list ? answer(200, pageAnswer(list)) : answer(404, { error: 'not_found' });
  };
}

/** A fake gateway answering every call with `respond`, recording each (as support/household.ts's fakeGateway). */
export function homeGateway(respond: (call: Call) => ResponseLike | Promise<ResponseLike>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const pathname = url.replace(/^https:\/\/[^/]+/, '').replace(/[?#].*$/, '');
    const call: Call = { url, init, route: `${init.method} ${pathname}` };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls, routes: () => calls.map((call) => call.route) };
}

/** A call's route under the API, as fetch-budget.json writes it: `GET /discover/trending`. */
export function budgetRoute(route: string): string {
  return route.replace(` ${API}/`, ' /');
}

const SLOT_STEP = 1000;

/** Lays Home out as a phone would: an 800 pt screen, every row 1000 pt below the one before. */
export async function layOut(): Promise<void> {
  const scroller = screen.queryAllByTestId('home-scroll');
  await act(async () => {
    for (const node of scroller) fireEvent(node, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 800 } } });
    for (const node of screen.queryAllByTestId('screen-column')) fireEvent(node, 'layout', { nativeEvent: { layout: { x: 0, y: 60, width: 390, height: 40000 } } });
    screen.queryAllByTestId(/^home-slot-/).forEach((node, index) => {
      fireEvent(node, 'layout', { nativeEvent: { layout: { x: 0, y: 400 + index * SLOT_STEP, width: 358, height: 300 } } });
    });
  });
  await settle();
}

/** Scrolls Home so its top is at `y`. */
export async function scrollTo(y: number): Promise<void> {
  await act(async () => {
    for (const node of screen.queryAllByTestId('home-scroll')) {
      fireEvent.scroll(node, { nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 390, height: 40000 }, layoutMeasurement: { width: 390, height: 800 } } });
    }
  });
  await settle();
}

/** Lays Home out and scrolls to its end, a screen at a time, as a member would; again once the services' rows are there. */
export async function scrollToEnd(): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    await layOut();
    for (let y = 0; y <= 20 * SLOT_STEP; y += 800) await scrollTo(y);
  }
}

/** The headings on screen, in order: their words, or their accessible name when drawn with a logo. */
export function headings(): string[] {
  return screen
    .queryAllByRole('header')
    .map((node) => String(node.props.accessibilityLabel ?? [node.props.children].flat().join('')))
    .filter((text) => text !== '');
}

/** Every link's accessible name. */
export function links(): string[] {
  return screen.queryAllByRole('link').map((node) => String(node.props.accessibilityLabel));
}

export async function choose(filter: 'All' | 'Movies' | 'TV'): Promise<void> {
  const found = screen.queryAllByRole('radio', { name: filter });
  if (found.length !== 1) throw new Error(`expected one filter "${filter}", found ${found.length}`);
  await fireEvent.press(found[0]!);
  await settle();
}

export function chosen(): string[] {
  return screen
    .queryAllByRole('radio')
    .filter((node) => node.props.accessibilityState?.checked === true)
    .map((node) => String(node.props.accessibilityLabel));
}
