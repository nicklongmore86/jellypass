// "Requested" right after Get this: the PWA's overlay (app/src/asked.ts) natively. The server records a Get this a
// moment after it accepts the call, so an answer read straight afterwards can still say `get_this`; for a short while
// the app shows what its member just asked for as requested instead.
//
// - In memory only: never written to the device, never sent. One store per signed-in session (SessionProvider), shared
//   by every tab's stack, so Home's cards and hero and the title pages read the overlaid state without a call.
// - A key (`movie:<id>`, `tv:<id>`, `tv:<id>:<season>`) is added only after a 2xx Get this, in the same session as
//   when it was sent: no sign-in move while the call was out (SessionProvider's getThis).
// - A key ends once the monotonic clock has run ASKED_TTL_MS or the wall clock has moved forward by that much (the
//   monotonic clock can pause while the device sleeps); a wall clock set back never stretches it.
// - A key is dropped as soon as the server says anything but `get_this` for it.
// - Beside the keys asked for, the latest state the server reported for each key (`seen`): every fresh answer (a title
//   page, a season page, a Home row) is seen once, as it arrives, and numbered in order. An answer drawn again later (a
//   Home row kept from before) shows the state of a fresher answer for the same key if there is one, so a title opened
//   again and found requested (or in the library) is not drawn back to Available to get on Home once its key is dropped.
// - Everything (both) is forgotten on sign-out, a 401, and any change of household, member or token.
import type { Card, HouseholdState, MediaType, Movie, Page, Season, Series } from '../api/types';

/** How long a title the member just asked for is shown as requested before the server's own answer is trusted alone. */
export const ASKED_TTL_MS = 2 * 60 * 1000;

export interface Asked {
  /** The member's accepted Get this: a series also marks the seasons asked for. */
  add(mediaType: MediaType, tmdbId: number, seasons: readonly number[]): void;
  forget(): void;
  /** A fresh answer from the server, just arrived: its states become the latest for their keys. */
  seen(answer: Page | Movie | Series | Season): void;
  /**
   * The state to show for `key`, given the server's in an answer seen as number `at` (undefined: never seen, so any seen
   * answer is fresher).
   */
  state(key: string, server: HouseholdState, at?: number): HouseholdState;
  card<T extends Card>(card: T): T;
  page(page: Page): Page;
  movie(movie: Movie): Movie;
  series(series: Series): Series;
  season(season: Season): Season;
  /** Called after every add, seen and forget, for screens to draw the overlay again. */
  subscribe(listener: () => void): () => void;
  /** Changes with every add, seen and forget. */
  version(): number;
}

export const titleKey = (mediaType: MediaType, tmdbId: number): string => `${mediaType}:${tmdbId}`;
export const seasonKey = (tmdbId: number, seasonNumber: number): string => `tv:${tmdbId}:${seasonNumber}`;

const monotonic = (): number => performance.now();

export function createAsked(now: () => number = monotonic, wall: () => number = () => Date.now()): Asked {
  let expires = new Map<string, { mono: number; wall: number }>();
  /** The latest state the server reported for each key, and the number of the answer that said it. */
  let latest = new Map<string, { state: HouseholdState; at: number }>();
  /** The number each seen answer's card or season was given. */
  let numbers = new WeakMap<object, number>();
  /** Counts the answers seen: never goes back, not even on forget. */
  let answers = 0;
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
      if (expires.size === 0 && latest.size === 0) return;
      expires = new Map();
      latest = new Map();
      numbers = new WeakMap();
      changed();
    },
    seen(answer) {
      const at = ++answers;
      const note = (key: string, item: { state: HouseholdState }) => {
        latest.set(key, { state: item.state, at });
        numbers.set(item, at);
        if (item.state !== 'get_this') expires.delete(key);
      };
      if ('results' in answer) for (const card of answer.results) note(titleKey(card.mediaType, card.tmdbId), card);
      else if ('mediaType' in answer) {
        note(titleKey(answer.mediaType, answer.tmdbId), answer);
        if (answer.mediaType === 'tv') for (const season of answer.seasons) note(seasonKey(answer.tmdbId, season.seasonNumber), season);
      } else note(seasonKey(answer.tmdbId, answer.seasonNumber), answer);
      changed();
    },
    state(key, reported, at) {
      const fresher = latest.get(key);
      const server = fresher && (at === undefined || fresher.at > at) ? fresher.state : reported;
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
      const state = asked.state(titleKey(card.mediaType, card.tmdbId), card.state, numbers.get(card));
      return state === card.state ? card : { ...card, state };
    },
    page: (page) => ({ ...page, results: page.results.map((card) => asked.card(card)) }),
    movie: (movie) => asked.card(movie),
    series: (series) => ({
      ...asked.card(series),
      seasons: series.seasons.map((season) => ({
        ...season,
        state: asked.state(seasonKey(series.tmdbId, season.seasonNumber), season.state, numbers.get(season)),
      })),
    }),
    season: (season) => ({ ...season, state: asked.state(seasonKey(season.tmdbId, season.seasonNumber), season.state, numbers.get(season)) }),
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
