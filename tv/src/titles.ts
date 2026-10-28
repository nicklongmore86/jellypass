import type { MediaType } from './api.js';

/** How long My requests reuses a title's name, year and poster before reading the title again. */
export const TITLE_CACHE_TTL_MS = 10 * 60 * 1000;
/** At most this many titles are kept; the one used least recently goes first. */
export const TITLE_CACHE_SIZE = 300;

/** What My requests shows of a title: never its state, which comes from `GET /requests` and the overlay. */
export interface TitleDetails {
  title: string;
  year: number | null;
  posterUrl: string | null;
}

/**
 * The titles My requests has named for the member signed in, so coming back to it reads only `GET /requests` (and any
 * title it has not named yet): the app's title cache (app/src/titles.ts, #89). In memory only: never stored, never sent;
 * forgotten by whoever sees the sign-in end or change. An entry is used for {@link TITLE_CACHE_TTL_MS} on both the
 * monotonic and the wall clock (so a sleep ends it); a wall clock set back ends it too.
 */
export class TitleCache {
  readonly #now: () => number;
  readonly #wall: () => number;
  // A Map keeps insertion order: a title used again is moved to the end, and the first one is the least recently used.
  #entries = new Map<string, { details: TitleDetails; mono: number; wall: number }>();

  public constructor(now: () => number, wall: () => number) {
    this.#now = now;
    this.#wall = wall;
  }

  public get(mediaType: MediaType, tmdbId: number): TitleDetails | undefined {
    const key = `${mediaType}:${tmdbId}`;
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    const mono = this.#now() - entry.mono;
    const sinceWall = this.#wall() - entry.wall;
    if (mono < 0 || mono >= TITLE_CACHE_TTL_MS || sinceWall < 0 || sinceWall >= TITLE_CACHE_TTL_MS) return undefined;
    this.#entries.set(key, entry);
    return entry.details;
  }

  public set(mediaType: MediaType, tmdbId: number, details: TitleDetails): void {
    const key = `${mediaType}:${tmdbId}`;
    this.#entries.delete(key);
    this.#entries.set(key, { details, mono: this.#now(), wall: this.#wall() });
    while (this.#entries.size > TITLE_CACHE_SIZE) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  public forget(): void {
    this.#entries = new Map();
  }
}
