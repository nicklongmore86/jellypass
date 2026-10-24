/** The household app API's answers (`/jellypass/app/v1/*`), as src/app-api.ts documents them. Nothing else is read. */
export type MediaType = 'movie' | 'tv';
export type HouseholdState = 'unavailable' | 'in_library' | 'requested' | 'get_this';

export interface Me {
  name: string;
  household: string;
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

export type DiscoverList = 'trending' | 'popular-movies' | 'popular-tv' | 'upcoming';
