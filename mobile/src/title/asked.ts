// "Requested" right after Get this: the PWA's overlay (app/src/asked.ts) natively. The server records a Get this a
// moment after it accepts the call, so an answer read straight afterwards can still say `get_this`; for a short while
// the app shows what its member just asked for as requested instead.
//
// - In memory only: never written to the device, never sent. One store per signed-in session (SessionProvider), shared
//   by every tab's stack, so Home's cards and hero and the title pages read the overlaid state without a call.
// - A key (`movie:<id>`, `tv:<id>`, `tv:<id>:<season>`) is added only after a 2xx Get this, with the token unchanged
//   while the call was out (SessionProvider's getThis).
// - A key ends once the monotonic clock has run ASKED_TTL_MS or the wall clock has moved forward by that much (the
//   monotonic clock can pause while the device sleeps); a wall clock set back never stretches it.
// - A key is dropped as soon as the server says anything but `get_this` for it.
// - Everything is forgotten on sign-out, a 401, and any change of household, member or token.
import type { Card, HouseholdState, MediaType, Movie, Page, Season, Series } from '../api/types';

/** How long a title the member just asked for is shown as requested before the server's own answer is trusted alone. */
export const ASKED_TTL_MS = 2 * 60 * 1000;

export interface Asked {
  /** The member's accepted Get this: a series also marks the seasons asked for. */
  add(mediaType: MediaType, tmdbId: number, seasons: readonly number[]): void;
  forget(): void;
  /** The state to show for `key`, given the server's. */
  state(key: string, server: HouseholdState): HouseholdState;
  card<T extends Card>(card: T): T;
  page(page: Page): Page;
  movie(movie: Movie): Movie;
  series(series: Series): Series;
  season(season: Season): Season;
  /** Called after every add and forget, for screens to draw the overlay again. */
  subscribe(listener: () => void): () => void;
  /** Changes with every add and forget. */
  version(): number;
}

export const titleKey = (mediaType: MediaType, tmdbId: number): string => `${mediaType}:${tmdbId}`;
export const seasonKey = (tmdbId: number, seasonNumber: number): string => `tv:${tmdbId}:${seasonNumber}`;

const monotonic = (): number => performance.now();

export function createAsked(now: () => number = monotonic, wall: () => number = () => Date.now()): Asked {
  let expires = new Map<string, { mono: number; wall: number }>();
  let count = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    count += 1;
    for (const listener of [...listeners]) listener();
  };

  const asked: Asked = {
    add(mediaType, tmdbId, seasons) {
      const since = { mono: now(), wall: wall() };
      const key = titleKey(mediaType, tmdbId);
      expires.set(key, since);
      // A series is requested while any of its seasons is (as the server shows it once recorded).
      if (mediaType === 'tv') for (const season of seasons) expires.set(seasonKey(tmdbId, season), since);
      changed();
    },
    forget() {
      if (expires.size === 0) return;
      expires = new Map();
      changed();
    },
    state(key, server) {
      if (server !== 'get_this') {
        expires.delete(key);
        return server;
      }
      const since = expires.get(key);
      if (since === undefined) return server;
      const sinceWall = wall() - since.wall;
      if (now() - since.mono >= ASKED_TTL_MS || (sinceWall > 0 && sinceWall >= ASKED_TTL_MS)) {
        expires.delete(key);
        return server;
      }
      return 'requested';
    },
    card: (card) => {
      const state = asked.state(titleKey(card.mediaType, card.tmdbId), card.state);
      return state === card.state ? card : { ...card, state };
    },
    page: (page) => ({ ...page, results: page.results.map((card) => asked.card(card)) }),
    movie: (movie) => asked.card(movie),
    series: (series) => ({
      ...asked.card(series),
      seasons: series.seasons.map((season) => ({ ...season, state: asked.state(seasonKey(series.tmdbId, season.seasonNumber), season.state) })),
    }),
    season: (season) => ({ ...season, state: asked.state(seasonKey(season.tmdbId, season.seasonNumber), season.state) }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => count,
  };
  return asked;
}
