// Home's fixed words, word for word as the PWA's app/src/render.ts and app/src/main.ts have them: the status words,
// the filters, the hero's controls, the rows' headings and the fixed error messages. __tests__/home-text.test.ts fails
// if one drifts from the PWA's files.
import type { ApiErrorKind } from '../api/errors';
import type { Card, CoarseStatus, HouseholdState } from '../api/types';

/** A title's status for the household, as a word next to a dot. An unknown state is decoded as `unavailable`. */
export const STATE_LABELS: Record<HouseholdState, string> = {
  in_library: 'Ready to watch',
  get_this: 'Available to get',
  unavailable: "Can't request",
  requested: 'Requested',
};

/**
 * A poster's corner badge: the state in one or two short words so it stays a small single-line pill (the TV add-on's
 * BADGE_WORDS, tv/src/discover-model.ts, which __tests__/home-text.test.ts checks). The full {@link STATE_LABELS} wording
 * stays the card's accessible name.
 */
export const BADGE_WORDS: Record<HouseholdState, string> = {
  in_library: 'In library',
  requested: 'Requested',
  get_this: 'Get this',
  unavailable: "Can't get",
};

/** The coarse status of a request in "My requests" (and of a title the household asked for that failed). */
export const REQUEST_LABELS: Record<CoarseStatus, string> = {
  requested: 'Requested',
  ready: 'Ready to watch',
  failed: "We couldn't get this",
};

/** The PWA's ERROR_TEXT. The message depends only on the kind of failure, never on anything in an answer. */
export const ERROR_TEXT = {
  rate_limited: { title: 'Too many requests', body: 'Wait a minute, then try again.' },
  unavailable: { title: "Can't load this right now", body: 'Something went wrong. Try again in a moment.' },
  not_found: { title: 'Not found', body: "We couldn't find that title." },
  offline: { title: "You're offline", body: 'Check your connection, then try again.' },
} as const;
export type ErrorText = keyof typeof ERROR_TEXT;

/** The PWA's wording for an API client failure (`unauthorized` never gets here: it signs the member out). */
export function errorText(kind: ApiErrorKind): ErrorText {
  if (kind === 'too_many_requests') return 'rate_limited';
  if (kind === 'network') return 'offline';
  if (kind === 'not_found') return 'not_found';
  return 'unavailable';
}

export const RETRY_TEXT = 'Try again';
export const EMPTY_ROW_TEXT = 'Nothing to show here right now.';

/** Home's filter: everything, only films, or only series. */
export type HomeFilter = 'all' | 'movies' | 'tv';
export const HOME_FILTERS: readonly HomeFilter[] = ['all', 'movies', 'tv'];
export const HOME_TEXT = {
  label: 'Show',
  filters: { all: 'All', movies: 'Movies', tv: 'TV' },
  shown: { all: 'All shown.', movies: 'Movies shown.', tv: 'TV shown.' },
  hide: {
    label: 'New only',
    /** The chip's accessible name: the short label says little to a screen reader on its own. */
    name: "New only: show only titles you don't have or haven't requested",
    on: 'Hiding what you have.', off: 'Showing what you have.',
  },
} as const;

export const HERO_TEXT = {
  /** The carousel's name under each filter. */
  labels: { all: 'Trending now', movies: 'Trending movies', tv: 'Trending series' },
  previous: 'Previous title',
  next: 'Next title',
} as const;

/** The words of the network and studio rows. */
export const SOURCE_TEXT = {
  studios: 'Studios',
  /** A network row's lead-in words by what the row lists: Home's All, or its Movies and TV filters. */
  networkPrefix: { all: 'Popular on', films: 'Films on', series: 'Series on' },
  /** JustWatch's credit, wherever a service's films (TMDB's where-to-watch data, from JustWatch) are shown. */
  justWatch: 'Where to watch: US streaming availability from JustWatch, via TMDB.',
  /** A network page's three lists, as its tabs name them, and the tabs' own name. */
  lists: { all: 'All', series: 'Series', films: 'Films' },
  listsLabel: 'Show',
} as const;

/** A network's lists: its films and series mixed (`all`), or either alone. */
export type SourceList = 'all' | 'series' | 'films';
export const SOURCE_LISTS: readonly SourceList[] = ['all', 'series', 'films'];

export function studioName(name: string): string {
  return `${name} movies`;
}

/** A network's or studio's page heading: "Popular on", "Series on" or "Films on" the network, or "<studio> movies". */
export function sourceHeading(kind: 'network' | 'studio', name: string, list: SourceList = 'all'): string {
  return kind === 'studio' ? studioName(name) : `${SOURCE_TEXT.networkPrefix[list]} ${name}`;
}

/** A studio's tile on Home, as a link: "Pixar, studio". */
export function studioLinkName(name: string): string {
  return `${name}, studio`;
}

/** The link beside a service row's heading on Home, to its page: "See all Popular on Netflix". */
export function networkLinkName(prefix: string, name: string): string {
  return `See all ${prefix} ${name}`;
}

export function stateLabel(state: HouseholdState): string {
  return Object.hasOwn(STATE_LABELS, state) ? STATE_LABELS[state] : STATE_LABELS.unavailable;
}

export function badgeWord(state: HouseholdState): string {
  return Object.hasOwn(BADGE_WORDS, state) ? BADGE_WORDS[state] : BADGE_WORDS.unavailable;
}

/** "★ 7.8 TMDB", as the PWA draws a rating. */
export function ratingText(rating: number): string {
  return `★ ${rating.toFixed(1)} TMDB`;
}

/** What a screen reader says for a rating, in place of the star. */
export function ratingLabel(rating: number): string {
  return `TMDB rating ${rating.toFixed(1)} out of 10`;
}

/** "2024 · Movie" under a poster card. */
export function posterMeta(card: Pick<Card, 'year' | 'mediaType'>): string {
  return [card.year ? String(card.year) : '', card.mediaType === 'tv' ? 'Series' : 'Movie'].filter(Boolean).join(' · ');
}

/** "2024 · ★ 7.8 TMDB" under a backdrop card: the year and the rating, whichever the title has. */
export function backdropMeta(card: Pick<Card, 'year' | 'rating'>): string {
  return [card.year ? String(card.year) : '', typeof card.rating === 'number' ? ratingText(card.rating) : ''].filter(Boolean).join(' · ');
}

/**
 * A card's accessible name: its title, year and rating, then its status, each said once ("Dune, 2021, TMDB rating 7.8
 * out of 10, Ready to watch"). A poster card also says whether it is a movie or a series, as its text does.
 */
export function cardName(card: Pick<Card, 'title' | 'year' | 'rating' | 'state' | 'mediaType'>, kind = false): string {
  return [
    card.title,
    card.year ? String(card.year) : '',
    kind ? (card.mediaType === 'tv' ? 'Series' : 'Movie') : '',
    typeof card.rating === 'number' ? ratingLabel(card.rating) : '',
    stateLabel(card.state),
  ]
    .filter(Boolean)
    .join(', ');
}

/** The hero's overview: the start of it, cut at a word, so the card stays short at any text size without a line limit. */
export const OVERVIEW_CHARS = 160;
export function shortOverview(overview: string, max = OVERVIEW_CHARS): string {
  const text = overview.trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}
