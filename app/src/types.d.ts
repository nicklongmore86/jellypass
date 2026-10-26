/** The household app API's answers (`/jellypass/app/v1/*`), as src/app-api.ts documents them. Nothing else is read. */
export type MediaType = 'movie' | 'tv';
export type HouseholdState = 'unavailable' | 'in_library' | 'requested' | 'get_this';

export interface Me {
  name: string;
  household: string;
  /** The revision of the v1 contract the server speaks (not read by the app). */
  apiVersion: number;
}

export interface Play {
  itemId: string;
  url: string;
}

export interface Card {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  rating: number | null;
  state: HouseholdState;
  play: Play | null;
}

export interface Page {
  page: number;
  nextPage: number | null;
  results: Card[];
}

export interface SeasonSummary {
  seasonNumber: number;
  name: string;
  episodeCount: number | null;
  state: HouseholdState;
}

export interface Movie extends Card {
  mediaType: 'movie';
  genres: string[];
  runtime: number | null;
}

export interface Series extends Card {
  mediaType: 'tv';
  genres: string[];
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

export type DiscoverList =
  | 'trending' | 'trending-movies' | 'trending-tv' | 'popular-movies' | 'popular-tv' | 'new-movies' | 'upcoming' | 'upcoming-tv'
  | 'top-movies' | 'top-tv';

/** A network's popular series, or a studio's popular movies. */
export type SourceKind = 'network' | 'studio';

/** A network or studio the API lists (an allowlist kept by JellyPass), with its TMDB logo. */
export interface Source {
  id: number;
  name: string;
  logoUrl: string | null;
}

/** A network, and whether its streaming service's films can be listed (US where-to-watch data). */
export interface Network extends Source {
  hasFilms: boolean;
}

export interface Sources {
  networks: Network[];
  studios: Source[];
}

/** A request's coarse status in `GET /requests`: nothing finer is ever sent. */
export type CoarseStatus = 'requested' | 'ready' | 'failed';

export interface RequestEntry {
  /** Opaque; used only as a list key. */
  id: string;
  mediaType: MediaType;
  tmdbId: number;
  status: CoarseStatus;
  seasons: Array<{ seasonNumber: number; status: CoarseStatus }>;
  /** Whether the caller made any of the household's records for the title. */
  byYou: boolean;
}

export interface RequestList {
  results: RequestEntry[];
}
