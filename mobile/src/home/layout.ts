// What Home shows under each filter, in order: the PWA's HOME_LAYOUT (app/src/main.ts). The first row is also the
// hero's source. Only the eager rows are asked for at once (with /discover/sources); everything below waits until it
// comes near the screen, so a first load makes the calls docs/app-api/fetch-budget.json allows and no more
// (__tests__/home-budget.test.tsx pins them). Movies and TV ask for lists of their own kind: a mixed page is never
// filtered on the phone, which would leave rows half empty.
import type { DiscoverList } from '../api/types';
import type { water } from '../theme';
import type { HomeFilter, SourceList } from './text';

export type RowVariant = 'poster' | 'backdrop';

/** One discover row; `eager` rows are asked for at once, the others as they near the screen. */
export interface HomeRow {
  part: 'row';
  list: DiscoverList;
  heading: string;
  variant: RowVariant;
  eager: boolean;
}
/** Discover rows, and the places where the services' rows, the studios' strip and the JustWatch credit go. */
export type HomePart = HomeRow | { part: 'networks' } | { part: 'studios' } | { part: 'credit' };

const row = (list: DiscoverList, heading: string, variant: RowVariant, eager: boolean): HomeRow => ({ part: 'row', list, heading, variant, eager });

export const HOME_LAYOUT: Record<HomeFilter, readonly HomePart[]> = {
  all: [
    row('trending', 'Trending', 'poster', true),
    row('popular-movies', 'Popular movies', 'backdrop', true),
    row('popular-tv', 'Popular series', 'backdrop', true),
    row('new-movies', 'New movie releases', 'backdrop', true),
    row('upcoming', 'Upcoming movies', 'poster', false),
    row('upcoming-tv', 'Upcoming series', 'poster', false),
    { part: 'networks' },
    { part: 'studios' },
    { part: 'credit' },
  ],
  movies: [
    row('trending-movies', 'Trending movies', 'poster', true),
    row('popular-movies', 'Popular movies', 'backdrop', true),
    row('new-movies', 'New movie releases', 'backdrop', true),
    row('upcoming', 'Upcoming movies', 'poster', true),
    { part: 'networks' },
    { part: 'studios' },
    { part: 'credit' },
  ],
  tv: [
    row('trending-tv', 'Trending series', 'poster', true),
    row('popular-tv', 'Popular series', 'backdrop', true),
    row('upcoming-tv', 'Upcoming series', 'poster', true),
    { part: 'networks' },
  ],
};

/** What a service's row lists under each filter: its films and series mixed, its films, or its series. */
export const NETWORK_LIST: Record<HomeFilter, SourceList> = { all: 'all', movies: 'films', tv: 'series' };

/** The waterline colour of each allowlisted network's row, by its TMDB ID (the PWA's NETWORK_ACCENTS). */
export const NETWORK_ACCENTS: Readonly<Record<number, keyof typeof water>> = {
  213: 'netflix',
  2739: 'disney',
  2552: 'apple',
  1024: 'prime',
  3186: 'hbo',
  453: 'hulu',
  4330: 'paramount',
  3353: 'peacock',
};

/** How far below (or above) the screen a lazy row starts loading, so it is usually there by the time it scrolls in. */
export const LAZY_MARGIN = 400;

/** The hero shows the first few titles of the first row, from the answer Home already has. */
export const HERO_MAX = 5;

/** From this window width (the stylesheet's 48rem) Home is laid out for a tablet: more cards in view, a wider hero. */
export const TABLET_WIDTH = 768;

export function rowKey(part: HomeRow): string {
  return `row-${part.list}`;
}

export function networkKey(id: number): string {
  return `row-network-${id}`;
}
