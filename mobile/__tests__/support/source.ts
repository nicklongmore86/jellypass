// The network and studio pages' tests: a household whose network and studio lists answer synthetic pages by page number
// (example.test addresses and TMDB-shaped image URLs only), on top of Home's and the title pages' household, so the app
// can start on Home and open a page from there; and a way to hold an answer back, for a late one. Queries never print
// the component tree.
import { screen } from '@testing-library/react-native';

import type { ResponseLike } from '../../src/api/client';
import { API } from './home';
import { answer, type Call } from './household';
import { titleGateway, type TitleHousehold } from './title';

const STATES = ['get_this', 'in_library', 'unavailable', 'requested'] as const;

/** A network's or studio's list call: which (`network-213-all`, `studio-2`, …) and the page asked for. */
export function sourceOf(call: Call): { list: string; page: number } | undefined {
  const match = new RegExp(`^GET ${API}/discover/(network|studio)/(\\d+)(?:/(films|all))?$`).exec(call.route);
  if (!match) return undefined;
  const page = Number(new URLSearchParams(call.url.includes('?') ? call.url.slice(call.url.indexOf('?') + 1) : '').get('page') ?? 1);
  const list = match[1] === 'studio' ? `studio-${match[2]}` : `network-${match[2]}-${match[3] ?? 'series'}`;
  return { list, page };
}

/** Page `page` of `list`: `count` titles named after it, each ID unique to its page, then no more after `last`. */
export function sourceAnswer(list: string, page = 1, { count = 20, last = 3 }: { count?: number; last?: number } = {}) {
  return {
    page,
    nextPage: count > 0 && page < last ? page + 1 : null,
    results: Array.from({ length: count }, (_, index) => {
      const n = (page - 1) * 20 + index + 1;
      const tv = list.endsWith('-series') || (list.endsWith('-all') && index % 2 === 1);
      return {
        mediaType: tv ? 'tv' : 'movie',
        tmdbId: 5000 + n,
        title: `${list} ${n}`,
        year: 2015 + (index % 8),
        overview: `The overview of ${list} ${n}.`,
        posterUrl: `https://image.tmdb.org/t/p/w342/source-${n}.jpg`,
        backdropUrl: null,
        rating: null,
        state: STATES[index % 4],
        play: null,
      };
    }),
  };
}

export interface SourceHousehold extends TitleHousehold {
  /** Answers a network's or studio's list; by default sourceAnswer(list, page). */
  source?: (list: string, page: number, call: Call) => ResponseLike | Promise<ResponseLike> | undefined;
}

export function sourceGateway(household: SourceHousehold = {}) {
  return titleGateway({
    ...household,
    override: (call) => {
      const own = household.override?.(call);
      if (own) return own;
      const source = sourceOf(call);
      if (!source) return undefined;
      return household.source?.(source.list, source.page, call) ?? answer(200, sourceAnswer(source.list, source.page));
    },
  });
}

/** An answer held back until the test lets it go. */
export function held() {
  let release: (response: ResponseLike) => void = () => undefined;
  const promise = new Promise<ResponseLike>((resolve) => {
    release = resolve;
  });
  return { promise, release: (response: ResponseLike) => release(response) };
}

/** The names of the grid's cards, in order. */
export function gridNames(): string[] {
  const grid = screen.queryAllByTestId('source-grid')[0];
  if (!grid) return [];
  return screen.queryAllByRole('link').filter((node) => {
    for (let at = node.parent; at; at = at.parent) if (at === grid) return true;
    return false;
  }).map((node) => String(node.props.accessibilityLabel));
}

/** The tabs on screen: each name, with a tick for the selected one. */
export function tabs(): string[] {
  return screen
    .queryAllByRole('tab')
    .filter((node) => String(node.props.testID ?? '').startsWith('source-tab-'))
    .map((node) => `${String(node.props.accessibilityLabel)}${node.props.accessibilityState?.selected ? ' ✓' : ''}`);
}
