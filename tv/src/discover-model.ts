import type { DiscoverCard, DiscoverList, DiscoverNetwork, HouseholdState, NetworkList } from './api.js';

/**
 * What the Discover page shows and how it chooses, as the household app's Home does (app/src/main.ts `HOME_LAYOUT`, the
 * status words of app/src/render.ts), with the same words. Nothing here reads anything but what it is given: no call,
 * no storage, no document. The page itself (hero, rows, chips) is a later change; this is its data.
 */

/** The page's route on the page host, and the address a link opens it at; a service's and a studio's page hang off it. */
export const DISCOVER_PATH = '/jellypass/discover';
export const DISCOVER_HASH = '#/jellypass/discover';
/** A service's and a studio's page, on the page host (`:id` is the API's number), and the addresses a link opens them at. */
export const SERVICE_PATH = '/jellypass/service/:id';
export const STUDIO_PATH = '/jellypass/studio/:id';
export const serviceHash = (id: number): string => `#/jellypass/service/${id}`;
export const studioHash = (id: number): string => `#/jellypass/studio/${id}`;

/** The kind chips: the app's All / Movies / TV (a chip shows other lists, it does not filter the loaded ones). */
export type DiscoverFilter = 'all' | 'movies' | 'tv';
export const DISCOVER_FILTERS: ReadonlyArray<DiscoverFilter> = ['all', 'movies', 'tv'];

/**
 * How many cards a row keeps on a TV. The API's pages hold 20, which is two full screens of posters (about nine and a
 * half fit at 1080p) and, on a 2019 set with about 1 GB, too many decoded images (a w342 poster is about 0.7 MB). 14 is
 * a screen and a half: the member can see that more is coming, a service's own page has the rest, and the hero's five
 * slides come from the first row's first five.
 */
export const DISCOVER_ROW_CARDS = 14;
/** How many slides the hero has (the app's `HERO_MAX`), taken from the first row's first cards that have a backdrop (the app draws a slide without one; a full-bleed TV hero would be empty). */
export const HERO_SLIDES = 5;

export interface DiscoverRow {
  part: 'row';
  list: DiscoverList;
  heading: string;
  variant: 'poster' | 'backdrop';
  /** Asked for when the page opens; otherwise when the row comes near the screen. */
  eager: boolean;
}
export type DiscoverPart = DiscoverRow | { part: 'networks' } | { part: 'studios' } | { part: 'credit' };

const row = (list: DiscoverList, heading: string, variant: DiscoverRow['variant'], eager: boolean): DiscoverRow => ({ part: 'row', list, heading, variant, eager });

/**
 * The page's parts per chip, in order: the app's Home layout (a test pins the two together). `networks` is the services'
 * rows, `studios` the logo strip, `credit` the JustWatch line. The app shows the studios and the credit on All and Movies.
 */
export const DISCOVER_LAYOUT: Readonly<Record<DiscoverFilter, ReadonlyArray<DiscoverPart>>> = {
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

/** What a service's row lists under each chip: its films and series mixed, its films, or its series. */
export const NETWORK_LIST_FOR: Readonly<Record<DiscoverFilter, NetworkList>> = { all: 'all', movies: 'films', tv: 'series' };

/** The list a service's row asks for under a chip: a service with no films listed has its series only. */
export function networkListFor(filter: DiscoverFilter, network: Pick<DiscoverNetwork, 'hasFilms'>): NetworkList {
  return network.hasFilms ? NETWORK_LIST_FOR[filter] : 'series';
}

/** The services whose rows a chip shows: on Movies only those with films. */
export function networksFor(filter: DiscoverFilter, networks: ReadonlyArray<DiscoverNetwork>): DiscoverNetwork[] {
  return networks.filter((network) => filter !== 'movies' || network.hasFilms);
}

/**
 * The calls opening the page under a chip makes, in the order the budget file lists them (as `GET /discover/...`
 * paths, sorted): `atOnce` is every eager row and the sources, `belowTheFold` the lazy rows and each service's row,
 * once they have come near the screen. `back` is what coming back to the page from a title makes: none, the answers
 * are kept (discover-data.ts).
 */
export function plannedCalls(filter: DiscoverFilter, networks: ReadonlyArray<DiscoverNetwork>): { atOnce: string[]; belowTheFold: string[]; back: string[] } {
  const rows = DISCOVER_LAYOUT[filter].filter((part): part is DiscoverRow => part.part === 'row');
  const atOnce = rows.filter((part) => part.eager).map((part) => `GET /discover/${part.list}`);
  atOnce.push('GET /discover/sources');
  const belowTheFold = rows.filter((part) => !part.eager).map((part) => `GET /discover/${part.list}`);
  for (const network of networksFor(filter, networks)) {
    const list = networkListFor(filter, network);
    belowTheFold.push(`GET /discover/network/${network.id}${list === 'series' ? '' : `/${list}`}`);
  }
  return { atOnce: atOnce.sort(), belowTheFold: belowTheFold.sort(), back: [] };
}

/**
 * A title's state as the household's own view words it: the words are fixed. They are the app's status pills' (app/src/render.ts)
 * except for a title in the library, which the app calls "Ready to watch" (a pill on a title page, next to Play) and the Discover
 * page, whose cards stand beside titles that are not, calls "In your library" (the owner's choice).
 */
export const STATE_LABELS: Readonly<Record<HouseholdState, string>> = {
  in_library: 'In your library',
  requested: 'Requested',
  get_this: 'Available to get',
  unavailable: "Can't request",
};

/**
 * The badge a card carries: the state's short words (`word`; `label` is the sentence), and a `tone` for the colour that goes with them (the words are always
 * there, so the colour is never the only sign). The state is the one the API gave for the caller's household, with
 * nothing of another household's or of any member's own in it.
 */
export function badgeOf(state: HouseholdState): { label: string; word: string; tone: 'owned' | 'pending' | 'open' | 'closed' } {
  switch (state) {
    case 'in_library': return { label: STATE_LABELS.in_library, word: BADGE_WORDS.in_library, tone: 'owned' };
    case 'requested': return { label: STATE_LABELS.requested, word: BADGE_WORDS.requested, tone: 'pending' };
    case 'get_this': return { label: STATE_LABELS.get_this, word: BADGE_WORDS.get_this, tone: 'open' };
    default: return { label: STATE_LABELS.unavailable, word: BADGE_WORDS.unavailable, tone: 'closed' };
  }
}

/**
 * What the badge on a card says: the state in one or two short words, so the badge stays a small pill in the corner like
 * Jellyfin web's own indicators (the sentence {@link STATE_LABELS} is the card's accessible name, which a screen reader reads
 * instead of the card's contents). The words are always there, and the colour goes with them.
 */
export const BADGE_WORDS: Readonly<Record<HouseholdState, string>> = {
  in_library: 'In library',
  requested: 'Requested',
  get_this: 'Get this',
  unavailable: "Can't get",
};

/**
 * Whether "New only" hides a card: the titles already in the library and those the household has asked for.
 * What is left is what can still be got (and what cannot be requested, which the chip does not touch).
 */
export function isHeld(card: Pick<DiscoverCard, 'state'>): boolean {
  return card.state === 'in_library' || card.state === 'requested';
}

/** A row's cards for the TV: those the chip leaves (hiding comes first, so a row stays as full as the page allows), at most {@link DISCOVER_ROW_CARDS}. */
export function rowCards<T extends Pick<DiscoverCard, 'state'>>(cards: ReadonlyArray<T>, hideHeld = false): T[] {
  const kept: T[] = [];
  for (const card of cards) {
    if (hideHeld && isHeld(card)) continue;
    kept.push(card);
    if (kept.length === DISCOVER_ROW_CARDS) break;
  }
  return kept;
}

/**
 * The hero's slides: the first row's first cards with a backdrop to draw, at most {@link HERO_SLIDES}. `skip` leaves a card out
 * ("New only": the next ones with a backdrop fill its place, from the same answer).
 */
export function heroCards(cards: ReadonlyArray<DiscoverCard>, skip?: (card: DiscoverCard) => boolean): DiscoverCard[] {
  const slides: DiscoverCard[] = [];
  for (const card of cards) {
    if (!card.backdropUrl || (skip && skip(card))) continue;
    slides.push(card);
    if (slides.length === HERO_SLIDES) break;
  }
  return slides;
}

/** The notice the page ends with (the app's `TMDB_NOTICE`, required wherever TMDB's data is shown). */
export const TMDB_NOTICE = 'This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.';

/** The line under the services' rows (the app's `SOURCE_TEXT.justWatch`): a service's films are TMDB's where-to-watch data, which is JustWatch's. */
export const JUSTWATCH_NOTE = 'Where to watch: US streaming availability from JustWatch, via TMDB.';

/** The page's fixed words (the app's where it has them). */
export const DISCOVER_TEXT = {
  title: 'Discover',
  kicker: 'Trending now',
  heroLabel: 'Trending now',
  view: 'View',
  previous: 'Previous title',
  next: 'Next title',
  chips: 'Show',
  filters: { all: 'All', movies: 'Movies', tv: 'TV' } as Readonly<Record<DiscoverFilter, string>>,
  hideHeld: 'New only',
  hideHeldName: "New only: show only titles you don't have or haven't requested",
  studios: 'Studios',
  nothing: 'Nothing to show here.',
  nothingLeft: "You already have everything here.",
  retry: 'Try again',
  movie: 'Movie',
  series: 'Series',
  /** The link in a service's heading says where it goes; a studio's tile is named as the app names it. */
  seeAll: (heading: string): string => `${heading}, see all`,
  studioMovies: (name: string): string => `${name} movies`,
  /** A service's row: the app's `SOURCE_TEXT.heading` for a network (its list under the chip is not named, as the app's heading for All and Series is not). */
  networkHeading: (name: string): string => `Popular on ${name}`,
} as const;

/** A service's list as its tab is named, and the words of a service's and a studio's page (the app's `SOURCE_TEXT`). */
export const SOURCE_TEXT = {
  lists: { all: 'All', series: 'Series', films: 'Films' } as Readonly<Record<NetworkList, string>>,
  listsLabel: 'Show',
  loadMore: 'Load more',
  loading: 'Loading…',
  moreLoaded: 'More results loaded.',
  /** The page's heading: a service's by the list it shows, or "<studio> movies". */
  heading: (kind: 'service' | 'studio', name: string, list: NetworkList = 'all'): string => {
    if (kind === 'studio') return `${name} movies`;
    return `${list === 'films' ? 'Films on' : list === 'series' ? 'Series on' : 'Popular on'} ${name}`;
  },
} as const;

/** The lists a service's page offers: all three when the API lists its films, else its series only (the app's rule). */
export function listsOf(network: Pick<DiscoverNetwork, 'hasFilms'>): ReadonlyArray<NetworkList> {
  return network.hasFilms ? ['all', 'series', 'films'] : ['series'];
}

/** A service's or studio's number as the page takes it from an address: digits without a leading zero, up to ten of them; anything else has no page. */
export function sourceId(text: string): number | undefined {
  return /^[1-9]\d{0,9}$/.test(text) ? Number(text) : undefined;
}
