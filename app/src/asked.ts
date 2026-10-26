import type { Card, HouseholdState, MediaType, Movie, Page, Season, Series } from './types.js';

/** How long a title the member just asked for is shown as requested before the server's own answer is trusted alone. */
export const ASKED_TTL_MS = 2 * 60 * 1000;

/**
 * What this member asked for in this page's life, in memory only: never stored, never sent. The server records a
 * "Get this" a moment after it accepts the call, so an answer read right afterwards can still say `get_this`. A key
 * (`movie:<id>`, `tv:<id>`, `tv:<id>:<season>`) is added only after the API accepted the call, lives
 * {@link ASKED_TTL_MS}, and is dropped as soon as the server says anything but `get_this` for it.
 */
export interface Asked {
  /** The member's accepted "Get this": a series also marks the seasons asked for. */
  add(mediaType: MediaType, tmdbId: number, seasons: readonly number[]): void;
  forget(): void;
  /** The state to show for `key`, given the server's. */
  state(key: string, server: HouseholdState): HouseholdState;
  card<T extends Card>(card: T): T;
  page(page: Page): Page;
  movie(movie: Movie): Movie;
  series(series: Series): Series;
  season(season: Season): Season;
}

export function createAsked(now: () => number = Date.now): Asked {
  let expires = new Map<string, number>();
  const titleKey = (mediaType: MediaType, tmdbId: number) => `${mediaType}:${tmdbId}`;

  const asked: Asked = {
    add(mediaType, tmdbId, seasons) {
      const until = now() + ASKED_TTL_MS;
      const key = titleKey(mediaType, tmdbId);
      expires.set(key, until);
      // A series is requested while any of its seasons is (as the server shows it once recorded).
      if (mediaType === 'tv') for (const season of seasons) expires.set(`${key}:${season}`, until);
    },
    forget: () => { expires = new Map(); },
    state(key, server) {
      if (server !== 'get_this') {
        expires.delete(key);
        return server;
      }
      const until = expires.get(key);
      if (until === undefined) return server;
      if (until <= now()) {
        expires.delete(key);
        return server;
      }
      return 'requested';
    },
    card: (card) => ({ ...card, state: asked.state(titleKey(card.mediaType, card.tmdbId), card.state) }),
    page: (page) => ({ ...page, results: page.results.map((card) => asked.card(card)) }),
    movie: (movie) => asked.card(movie),
    series: (series) => ({
      ...asked.card(series),
      seasons: series.seasons.map((season) => ({ ...season, state: asked.state(`tv:${series.tmdbId}:${season.seasonNumber}`, season.state) })),
    }),
    season: (season) => ({ ...season, state: asked.state(`tv:${season.tmdbId}:${season.seasonNumber}`, season.state) }),
  };
  return asked;
}
