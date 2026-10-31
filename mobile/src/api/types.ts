// The household app API's answers (/jellypass/app/v1), as docs/app-api/v1.openapi.json describes them. Written by
// hand from the schema; __tests__/api-schema.test.ts fails when the two drift apart (a field, an enum value or an
// endpoint on one side only). The decoders in decode.ts are what make these types true at run time.

export const MEDIA_TYPES = ['movie', 'tv'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** The household's own view of a title. An unknown value decodes as `unavailable`. */
export const HOUSEHOLD_STATES = ['unavailable', 'in_library', 'requested', 'get_this'] as const;
export type HouseholdState = (typeof HOUSEHOLD_STATES)[number];

/** A household request's coarse status. An unknown value decodes as `requested`. */
export const COARSE_STATUSES = ['requested', 'ready', 'failed'] as const;
export type CoarseStatus = (typeof COARSE_STATUSES)[number];

/** The lists under /discover/{list}. */
export const DISCOVER_LISTS = [
  'trending',
  'trending-movies',
  'trending-tv',
  'popular-movies',
  'popular-tv',
  'new-movies',
  'upcoming',
  'upcoming-tv',
  'top-movies',
  'top-tv',
] as const;
export type DiscoverList = (typeof DISCOVER_LISTS)[number];

/** The error codes the API sends, each always with its own status. */
export const ERROR_CODES = ['app_access_disabled', 'invalid_request', 'unauthorized', 'not_found', 'household_not_found', 'hidden_limit_reached', 'too_many_requests', 'unavailable'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface Me {
  name: string;
  household: string;
  /** The v1 revision the server speaks; 0 when it does not say (3.1.1 and earlier). */
  apiVersion: number;
}

export interface Play {
  itemId: string;
  /** Exactly `<household origin>/web/#/details?id=<itemId>`: decode.ts drops any other. */
  url: string;
}

export interface Card {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string;
  /** An allowlisted TMDB poster URL (w342), or null: decode.ts drops any other. */
  posterUrl: string | null;
  /** An allowlisted TMDB backdrop URL (w780), or null. */
  backdropUrl: string | null;
  rating: number | null;
  state: HouseholdState;
  /** Only for `in_library`. */
  play: Play | null;
  /**
   * The caller hid it ("Not interested"): only ever true in search results and on title pages, as discovery lists leave
   * hidden titles out. False from a server before `apiVersion` 3, which has no hiding.
   */
  hidden: boolean;
}

export interface Page {
  page: number;
  nextPage: number | null;
  results: Card[];
}

export interface Movie extends Card {
  mediaType: 'movie';
  genres: string[];
  runtime: number | null;
}

export interface SeasonSummary {
  seasonNumber: number;
  name: string;
  episodeCount: number | null;
  state: HouseholdState;
}

export interface Series extends Card {
  mediaType: 'tv';
  genres: string[];
  /** The first episode's run time, in minutes. */
  runtime: number | null;
  seasons: SeasonSummary[];
}

export interface Episode {
  episodeNumber: number;
  name: string;
  overview: string;
}

export interface Season {
  tmdbId: number;
  seasonNumber: number;
  name: string;
  overview: string;
  episodes: Episode[];
  state: HouseholdState;
}

/** A network or studio JellyPass lists, with its TMDB logo (w300) or null. */
export interface Source {
  id: number;
  name: string;
  logoUrl: string | null;
}

export interface Network extends Source {
  /** Whether /discover/network/{id}/films and /all are offered for it. */
  hasFilms: boolean;
}

export interface Sources {
  networks: Network[];
  studios: Source[];
}

export interface RequestSeason {
  seasonNumber: number;
  status: CoarseStatus;
}

export interface Request {
  /** Opaque; only a list key. */
  id: string;
  mediaType: MediaType;
  tmdbId: number;
  status: CoarseStatus;
  /** Empty for a movie. */
  seasons: RequestSeason[];
  /** Whether the caller made any of the household's records for the title. */
  byYou: boolean;
  /** Whether the caller may cancel it now (`cancelRequest`); false from a server before `apiVersion` 2, which has no cancel. */
  cancellable: boolean;
  /** The day (`YYYY-MM-DD`) the household last asked for it; null from a server before `apiVersion` 2. */
  requestedOn: string | null;
}

export interface Requests {
  results: Request[];
}

/** The answer to hiding (`true`) or unhiding (`false`) a title, the same whether or not it was hidden. */
export interface Hidden {
  hidden: boolean;
}

export interface HiddenTitle {
  mediaType: MediaType;
  tmdbId: number;
  /** When the caller first hid it (ISO 8601, UTC). */
  hiddenAt: string;
}

/** A page of the caller's own hidden titles, newest first (`apiVersion` 3). */
export interface HiddenPage {
  page: number;
  nextPage: number | null;
  results: HiddenTitle[];
}

/** "Get this" always answers this, whatever happens to the title. */
export interface Accepted {
  status: 'accepted';
}
