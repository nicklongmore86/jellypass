// Search's and My requests' tests: a household that answers searches (a page of synthetic titles named after the
// query, example.test addresses and TMDB-shaped image URLs only) and the household's requests, on top of the title
// pages' household, and small queries that never print the component tree.
import { act, fireEvent, screen, within } from '@testing-library/react-native';

import type { ResponseLike } from '../../src/api/client';
import { SEARCH_TEXT } from '../../src/search/text';
import { API } from './home';
import { answer, settle, type Call } from './household';
import { only, titleGateway, type TitleHousehold } from './title';

const STATES = ['get_this', 'in_library', 'unavailable', 'requested'] as const;

/** Page `page` of `query`'s results: `count` titles, films and series in turn, each ID unique to its page. */
export function searchAnswer(query: string, page = 1, { count = 20, last = 3 }: { count?: number; last?: number } = {}) {
  return {
    page,
    nextPage: count > 0 && page < last ? page + 1 : null,
    results: Array.from({ length: count }, (_, index) => {
      const n = (page - 1) * 20 + index + 1;
      return {
        mediaType: index % 2 ? 'tv' : 'movie',
        tmdbId: 3000 + n,
        title: `${query} ${n}`,
        year: 2010 + (index % 10),
        overview: `The overview of ${query} ${n}.`,
        posterUrl: `https://image.tmdb.org/t/p/w342/search-${n}.jpg`,
        backdropUrl: null,
        rating: null,
        state: STATES[index % 4],
        play: null,
      };
    }),
  };
}

/** A search's query and page, from its URL. */
export function searchOf(call: Call): { q: string; page: number } | undefined {
  if (call.route !== `GET ${API}/search`) return undefined;
  const params = new URLSearchParams(call.url.slice(call.url.indexOf('?') + 1));
  return { q: params.get('q') ?? '', page: Number(params.get('page')) };
}

export interface SearchHousehold extends TitleHousehold {
  /** Answers a search; by default searchAnswer(q, page). */
  search?: (q: string, page: number, call: Call) => ResponseLike | Promise<ResponseLike>;
}

/** Home, the title pages, searches and the requests. */
export function searchGateway(household: SearchHousehold = {}) {
  return titleGateway({
    ...household,
    override: (call) => {
      const own = household.override?.(call);
      if (own) return own;
      const search = searchOf(call);
      if (!search) return undefined;
      return household.search ? household.search(search.q, search.page, call) : answer(200, searchAnswer(search.q, search.page));
    },
  });
}

/** The searches made, as `q@page`. */
export function searches(calls: readonly Call[]): string[] {
  return calls.map(searchOf).flatMap((search) => (search ? [`${search.q}@${search.page}`] : []));
}

export function field() {
  return only(screen.queryAllByLabelText(SEARCH_TEXT.label), 'search field');
}

/** Types into the search field (no pause after it). */
export async function typeQuery(text: string) {
  await fireEvent.changeText(field(), text);
  await settle();
}

/** The keyboard's Search key. */
export async function submitQuery() {
  await fireEvent(field(), 'submitEditing');
  await settle();
}

/** Lets `ms` pass on the fake clock the router's test renderer runs on. */
export async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
}

/** The names of the result cards on screen, in order (none when there is no grid). */
export function resultNames(): string[] {
  const grids = screen.queryAllByTestId('search-grid');
  if (grids.length === 0) return [];
  return within(only(grids, 'results grid'))
    .queryAllByRole('link')
    .map((node) => String(node.props.accessibilityLabel));
}

/** A request as GET /requests lists it. */
export function requestEntry(id: string, mediaType: 'movie' | 'tv', tmdbId: number, status: 'requested' | 'ready' | 'failed', extra: Record<string, unknown> = {}) {
  return { id: id.padEnd(22, 'A'), mediaType, tmdbId, status, seasons: [], byYou: true, ...extra };
}
