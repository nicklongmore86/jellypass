// "Requested" right after Get this: the PWA's overlay (app/src/asked.ts) natively. The server records a Get this a
// moment after it accepts the call, so an answer read straight afterwards can still say `get_this`; for a short while
// the app shows what its member just asked for as requested instead.
//
// - In memory only: never written to the device, never sent. One store per signed-in session (SessionProvider), shared
//   by every tab's stack, so Home's cards and hero and the title pages read the overlaid state without a call.
// - A key (`movie:<id>`, `tv:<id>`, `tv:<id>:<season>`) is added only after a 2xx Get this, in the same session as
//   when it was sent: no sign-in move while the call was out (SessionProvider's getThis).
// - A key ends once the monotonic clock has run ASKED_TTL_MS or the wall clock has moved forward by that much (the
//   monotonic clock can pause while the device sleeps); a wall clock set back never stretches it. A timer set for the
//   earliest end drops every key whose time is up and tells the screens once, so a screen left open shows the server's
//   state again with no call; `recheck()` (the app coming back to the foreground, where a timer may have slept) does the
//   same at once.
// - A key is dropped as soon as a fresh answer from the server says anything but `get_this` for it.
// - The other way round, after an accepted Cancel (`withdraw`): the title, and every season of it, is shown as
//   `get_this` while the server (or the latest state it reported, `seen` below) still says `requested`, for the same
//   time and by the same clocks and timer; it ends as soon as a fresh answer says `get_this` for the title (the server
//   caught up), or the title is asked for again. A title that is in the library, or unavailable, is shown as it is.
// - Drawing (`state()` and the rest) only reads: a key whose time is up is shown as ended, but only the timer or
//   `recheck()` drops it and tells anyone.
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
  /**
   * The member's accepted Cancel of a request: its asked keys are dropped, and the title is shown as Get this while the
   * server still says requested (see above).
   */
  withdraw(mediaType: MediaType, tmdbId: number): void;
  /** Drops everything, the timer too. */
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
  /** Reads both clocks again now: drops the keys whose time is up (telling listeners once if any were) and sets the timer. */
  recheck(): void;
  /** Called after every add, seen, forget and key ended, for screens to draw the overlay again. */
  subscribe(listener: () => void): () => void;
  /** Changes with every add, seen, forget and key ended. */
  version(): number;
}

/** Where the overlay's one timer is set: the global setTimeout, or a test's own. */
export interface Timer {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const globalTimer: Timer = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const titleKey = (mediaType: MediaType, tmdbId: number): string => `${mediaType}:${tmdbId}`;
export const seasonKey = (tmdbId: number, seasonNumber: number): string => `tv:${tmdbId}:${seasonNumber}`;

const monotonic = (): number => performance.now();

export function createAsked(now: () => number = monotonic, wall: () => number = () => Date.now(), timer: Timer = globalTimer): Asked {
  let expires = new Map<string, { mono: number; wall: number }>();
  /** The titles (`movie:<id>`, `tv:<id>`) whose Cancel was accepted, covering the title's key and its seasons'. */
  let withdrawn = new Map<string, { mono: number; wall: number }>();
  /** Keys (the title's or a season's) whose withdrawal ended: the server said something but `requested` for them. */
  const over = new Set<string>();
  const endTitle = (title: string) => {
    for (const key of [...over]) if (key === title || key.startsWith(`${title}:`)) over.delete(key);
  };
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

  /** How long `since` has left, by whichever clock ends it first (a wall clock set back never counts). */
  const left = (since: { mono: number; wall: number }) => {
    const sinceWall = wall() - since.wall;
    return Math.min(ASKED_TTL_MS - (now() - since.mono), sinceWall > 0 ? ASKED_TTL_MS - sinceWall : Infinity);
  };

  let pending: unknown;
  let armed = false;
  /** Sets the one timer for the key that ends first, or none. */
  const schedule = () => {
    if (armed) timer.clear(pending);
    armed = false;
    if (expires.size === 0 && withdrawn.size === 0) return;
    let first = Infinity;
    for (const since of [...expires.values(), ...withdrawn.values()]) first = Math.min(first, left(since));
    armed = true;
    pending = timer.set(
      () => {
        armed = false;
        ended();
      },
      Math.max(0, first),
    );
  };
  /** Drops the keys whose time is up, tells listeners once if any were, and sets the timer for the next. */
  const ended = () => {
    let dropped = false;
    for (const map of [expires, withdrawn]) {
      for (const [key, since] of map) {
        if (left(since) <= 0) {
          map.delete(key);
          if (map === withdrawn) endTitle(key);
          dropped = true;
        }
      }
    }
    schedule();
    if (dropped) changed();
  };

  const asked: Asked = {
    add(mediaType, tmdbId, seasons) {
      const since = { mono: now(), wall: wall() };
      const key = titleKey(mediaType, tmdbId);
      withdrawn.delete(key);
      endTitle(key);
      expires.set(key, since);
      // A series is requested while any of its seasons is (as the server shows it once recorded).
      if (mediaType === 'tv') for (const season of seasons) expires.set(seasonKey(tmdbId, season), since);
      schedule();
      changed();
    },
    withdraw(mediaType, tmdbId) {
      const key = titleKey(mediaType, tmdbId);
      for (const asked of [...expires.keys()]) if (asked === key || asked.startsWith(`${key}:`)) expires.delete(asked);
      endTitle(key);
      withdrawn.set(key, { mono: now(), wall: wall() });
      schedule();
      changed();
    },
    forget() {
      if (armed) timer.clear(pending);
      armed = false;
      if (expires.size === 0 && withdrawn.size === 0 && latest.size === 0) return;
      expires = new Map();
      withdrawn = new Map();
      over.clear();
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
        // A withdrawal ends per key, for good, on any answer but requested.
        if (item.state !== 'requested' && withdrawn.has(key.split(':').slice(0, 2).join(':'))) over.add(key);
      };
      if ('results' in answer) for (const card of answer.results) note(titleKey(card.mediaType, card.tmdbId), card);
      else if ('mediaType' in answer) {
        note(titleKey(answer.mediaType, answer.tmdbId), answer);
        if (answer.mediaType === 'tv') for (const season of answer.seasons) note(seasonKey(answer.tmdbId, season.seasonNumber), season);
      } else note(seasonKey(answer.tmdbId, answer.seasonNumber), answer);
      schedule();
      changed();
    },
    state(key, reported, at) {
      const fresher = latest.get(key);
      const server = fresher && (at === undefined || fresher.at > at) ? fresher.state : reported;
      if (server === 'requested') {
        const cancelled = withdrawn.get(key.split(':').slice(0, 2).join(':'));
        return cancelled !== undefined && left(cancelled) > 0 && !over.has(key) ? 'get_this' : server;
      }
      if (server !== 'get_this') return server;
      const since = expires.get(key);
      return since !== undefined && left(since) > 0 ? 'requested' : server;
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
    recheck: () => ended(),
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
