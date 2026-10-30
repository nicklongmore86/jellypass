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

/**
 * The corner badge on a poster (StatusChip `overlay`): a compact pill over the image's top-left. Its text is 11 pt (Apple's
 * minimum) and grows with the system text size like all other text, never capped. A pill that grows past a small poster
 * would cover it, so {@link badgeFits} estimates from the card's width and the user's text scale whether the pill's longest
 * word fits on one line inside the poster; if it would not, the card draws the same chip below the image instead
 * (`below`), as ordinary scalable text that may wrap. The status is never dropped, and its full wording is in the card's
 * accessible name either way.
 * `badgeFits` is an estimate, not a guarantee: it uses a deliberately generous width per character (EM_PER_CHAR) so it errs
 * toward the below-image placement. Every number the pill's width is made of is here so __tests__/home-badge.test.ts uses
 * the same ones.
 */
export const POSTER_BADGE = {
  fontSize: 11,
  /** Distance from the poster's top and left edges. */
  inset: 5,
  /** Share of the poster's width the pill may take. */
  maxWidthRatio: 0.92,
  paddingLeft: 4,
  paddingRight: 5,
  border: 1,
  dot: 5,
  gap: 3,
} as const;

/** A bold sans-serif's average advance is about 0.55 em (SF Pro Bold on "Requested" and "In library" is nearer 0.5); 0.6 em leaves margin. */
export const BADGE_EM_PER_CHAR = 0.6;

/**
 * Whether the corner pill is estimated to fit `word` on one line inside a poster `cardWidth` wide at the text scale
 * `fontScale` (the width of the dot, gap, padding and border does not scale). An estimate: see {@link POSTER_BADGE}.
 */
export function badgeFits(cardWidth: number, fontScale: number, word: string): boolean {
  const chrome = POSTER_BADGE.paddingLeft + POSTER_BADGE.paddingRight + 2 * POSTER_BADGE.border + POSTER_BADGE.dot + POSTER_BADGE.gap;
  const room = POSTER_BADGE.maxWidthRatio * cardWidth - chrome;
  return word.length * BADGE_EM_PER_CHAR * POSTER_BADGE.fontSize * Math.max(1, fontScale) <= room;
}

/**
 * The row a "See all" page shows, by its list's name in the address: only the lists Home's rows show (under any filter),
 * the TV add-on's `#/jellypass/list/<list>`. Anything else is undefined, and its page is Not found without a call.
 */
export function seeAllRow(name: string | string[] | undefined): HomeRow | undefined {
  if (typeof name !== 'string') return undefined;
  for (const parts of Object.values(HOME_LAYOUT)) {
    const found = parts.find((part): part is HomeRow => part.part === 'row' && part.list === name);
    if (found) return found;
  }
  return undefined;
}

export function rowKey(part: HomeRow): string {
  return `row-${part.list}`;
}

export function networkKey(id: number): string {
  return `row-network-${id}`;
}

/**
 * Where a sideways row of `count` items, each `item` wide with `gap` between them, comes to rest in a `viewport` that
 * wide: with an item centred, but for the ends, where the first item sits at the row's start and the last at its end.
 * A centred stop within half a step of either end is left out, so a row never rests a sliver short of its start or
 * end. Nothing when the row fits whole, as there is nowhere to scroll.
 */
export function snapOffsets(count: number, item: number, gap: number, viewport: number): number[] | undefined {
  const end = count * item + Math.max(0, count - 1) * gap - viewport;
  if (count < 2 || viewport <= 0 || end <= 0) return undefined;
  const step = item + gap;
  const offsets = [0];
  for (let at = 1; at < count - 1; at += 1) {
    const centred = at * step - (viewport - item) / 2;
    if (centred - offsets.at(-1)! >= step / 2 && end - centred >= step / 2) offsets.push(centred);
  }
  offsets.push(end);
  return offsets;
}

/** The stop nearest `x`: where a row let go at `x` comes to rest. */
export function nearestStop(offsets: readonly number[], x: number): number {
  return offsets.reduce((best, offset) => (Math.abs(offset - x) < Math.abs(best - x) ? offset : best), offsets[0] ?? 0);
}

/** A sideways row's shape: `count` items, each `item` wide, `gap` apart, in a `viewport` that wide. */
export interface RowShape {
  count: number;
  item: number;
  gap: number;
  viewport: number;
}

/**
 * Where a row resting near `x` should rest once its shape changes (the device turned, or an iPad's split view
 * resized): at its start or end if it was there, else at the new stop nearest where the same card is now centred.
 * Nothing when the row now fits whole.
 */
export function resnapOffset(x: number, before: RowShape, after: RowShape): number | undefined {
  const next = snapOffsets(after.count, after.item, after.gap, after.viewport);
  if (!next) return undefined;
  const previous = snapOffsets(before.count, before.item, before.gap, before.viewport);
  if (!previous) return 0;
  const at = previous.indexOf(nearestStop(previous, x));
  if (at === 0) return 0;
  if (at === previous.length - 1) return next.at(-1)!;
  const card = Math.round((previous[at]! + (before.viewport - before.item) / 2) / (before.item + before.gap));
  return nearestStop(next, card * (after.item + after.gap) - (after.viewport - after.item) / 2);
}

/**
 * Where a row puts item `index` fully in view: centred if it fits the viewport, else at the viewport's start, kept
 * within the row's ends. Nothing when the row fits whole.
 */
export function revealOffset({ count, item, gap, viewport }: RowShape, index: number): number | undefined {
  const end = count * item + Math.max(0, count - 1) * gap - viewport;
  if (count < 1 || viewport <= 0 || end <= 0) return undefined;
  const start = index * (item + gap);
  return Math.min(end, Math.max(0, item <= viewport ? start - (viewport - item) / 2 : start));
}
