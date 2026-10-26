// The title pages' tests: synthetic movie, series, season and request answers (example.test addresses and TMDB-shaped
// image URLs only), a household that answers them (and Home's calls, so the app can start on Home and open a title from
// there), Get this answering the fixed 202, and small queries that never print the component tree.
import { fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { ResponseLike } from '../../src/api/client';
import { API, homeGateway, homeHousehold } from './home';
import { ORIGIN, answer, settle, type Call } from './household';

type State = 'in_library' | 'get_this' | 'unavailable' | 'requested';

export const PLAY_ITEM = '0123456789abcdef0123456789abcdef';
export const PLAY_URL = `${ORIGIN}/web/#/details?id=${PLAY_ITEM}`;

export function movieAnswer(tmdbId: number, state: State = 'get_this', extra: Record<string, unknown> = {}) {
  return {
    mediaType: 'movie',
    tmdbId,
    title: `Film ${tmdbId}`,
    year: 2024,
    overview: `The overview of film ${tmdbId}.`,
    posterUrl: `https://image.tmdb.org/t/p/w342/poster-${tmdbId}.jpg`,
    backdropUrl: `https://image.tmdb.org/t/p/w780/backdrop-${tmdbId}.jpg`,
    rating: 7.4,
    state,
    play: state === 'in_library' ? { itemId: PLAY_ITEM, url: PLAY_URL } : null,
    genres: ['Drama', 'Comedy'],
    runtime: 118,
    ...extra,
  };
}

/** A series with Specials (0) and seasons 1 to `states.length`, each in the given state. */
export function seriesAnswer(tmdbId: number, states: State[] = ['in_library', 'get_this', 'get_this'], extra: Record<string, unknown> = {}) {
  const state: State = states.includes('in_library') ? 'in_library' : states.includes('requested') ? 'requested' : states.includes('get_this') ? 'get_this' : 'unavailable';
  return {
    mediaType: 'tv',
    tmdbId,
    title: `Series ${tmdbId}`,
    year: 2023,
    overview: `The overview of series ${tmdbId}.`,
    posterUrl: `https://image.tmdb.org/t/p/w342/poster-${tmdbId}.jpg`,
    backdropUrl: `https://image.tmdb.org/t/p/w780/backdrop-${tmdbId}.jpg`,
    rating: 8.1,
    state,
    play: state === 'in_library' ? { itemId: PLAY_ITEM, url: PLAY_URL } : null,
    genres: ['Drama'],
    runtime: 52,
    seasons: [
      { seasonNumber: 0, name: 'Specials', episodeCount: 2, state: 'unavailable' },
      ...states.map((season, index) => ({ seasonNumber: index + 1, name: `Season ${index + 1}`, episodeCount: 8 + index, state: season })),
    ],
    ...extra,
  };
}

export function seasonAnswer(tmdbId: number, seasonNumber: number, state: State = 'get_this') {
  return {
    tmdbId,
    seasonNumber,
    name: `Season ${seasonNumber}`,
    overview: `The overview of season ${seasonNumber}.`,
    episodes: [
      { episodeNumber: 1, name: 'Pilot', overview: 'The first.' },
      { episodeNumber: 2, name: '', overview: '' },
    ],
    state,
  };
}

export interface TitleHousehold {
  movies?: Record<number, ReturnType<typeof movieAnswer>>;
  series?: Record<number, ReturnType<typeof seriesAnswer>>;
  seasons?: Record<string, ReturnType<typeof seasonAnswer>>;
  requests?: { results: unknown[] };
  /** Answers Get this: by default the fixed 202. */
  getThis?: (call: Call) => ResponseLike | Promise<ResponseLike>;
  /** Answers first when it returns something. */
  override?: (call: Call) => ResponseLike | Promise<ResponseLike> | undefined;
}

const MOVIE = new RegExp(`^GET ${API}/movie/(\\d+)$`);
const SERIES = new RegExp(`^GET ${API}/tv/(\\d+)$`);
const SEASON = new RegExp(`^GET ${API}/tv/(\\d+)/season/(\\d+)$`);
const GET_THIS = new RegExp(`^POST ${API}/(movie|tv)/(\\d+)/get$`);

/** A household answering Home and the title pages: any title not listed is made up from its ID. */
export function titleGateway(household: TitleHousehold = {}) {
  return homeGateway(
    homeHousehold((call) => {
      const own = household.override?.(call);
      if (own) return own;
      let match = MOVIE.exec(call.route);
      if (match) return answer(200, household.movies?.[Number(match[1])] ?? movieAnswer(Number(match[1])));
      match = SERIES.exec(call.route);
      if (match) return answer(200, household.series?.[Number(match[1])] ?? seriesAnswer(Number(match[1])));
      match = SEASON.exec(call.route);
      if (match) return answer(200, household.seasons?.[`${match[1]}:${match[2]}`] ?? seasonAnswer(Number(match[1]), Number(match[2])));
      if (call.route === `GET ${API}/requests`) return answer(200, household.requests ?? { results: [] });
      if (GET_THIS.test(call.route)) return household.getThis ? household.getThis(call) : answer(202, { status: 'accepted' });
      return undefined;
    }),
  );
}

type Node = NonNullable<ReturnType<typeof screen.queryAllByText>[number]>;
export const flat = (node: Node) => StyleSheet.flatten(node.props.style) ?? {};

export function only(found: Node[], what: string): Node {
  if (found.length !== 1) throw new Error(`expected one ${what}, found ${found.length}`);
  return found[0]!;
}

export const buttonNamed = (name: string | RegExp) => only(screen.queryAllByRole('button', { name }), `button "${String(name)}"`);
export const linkNamed = (name: string | RegExp) => only(screen.queryAllByRole('link', { name }), `link "${String(name)}"`);
export const checkboxNamed = (name: string) => only(screen.queryAllByRole('checkbox', { name }), `checkbox "${name}"`);

export async function pressNode(node: Node) {
  await fireEvent.press(node);
  await settle();
}

/** The checkboxes on screen: their names and whether each is checked. */
export function checkboxes(): string[] {
  return screen.queryAllByRole('checkbox').map((node) => `${String(node.props.accessibilityLabel)}${node.props.accessibilityState?.checked ? ' ✓' : ''}`);
}

/** What the status chips that screen readers hear say. */
export function spokenStatus(): string[] {
  return screen.queryAllByTestId('status-chip').map((node) => String(node.props.accessibilityLabel));
}

/** The text of the Get this message line ('' when it says nothing). */
export function getMessage(): string {
  const found = screen.queryAllByTestId('get-message');
  return found.length ? [found[0]!.props.children].flat().join('') : '';
}

/** The headings on screen, in order. */
export function headings(): string[] {
  return screen.queryAllByRole('header').map((node) => [node.props.children].flat().join('')).filter(Boolean);
}
