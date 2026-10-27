// The titles My requests has named in this sign-in, the PWA's title cache (app/src/titles.ts) natively: shown again (the
// tab focused, Try again, pull to refresh), the screen reads GET /requests and only the titles it has not named yet.
//
// - In memory only: never written to the device, never sent. One cache per signed-in session (SessionProvider),
//   forgotten with the overlay on sign-out, a 401 and any change of household, member or token.
// - Keyed by kind and TMDB ID (`movie:<id>`, `tv:<id>`). Only what the entry shows of its title is kept (name, year,
//   poster), never its state: statuses come from /requests, and a kept title is not seen by the overlay again.
// - An entry is used for TITLE_CACHE_TTL_MS on both the monotonic and the wall clock (a sleep ends it); a wall clock set
//   back ends it too. At most TITLE_CACHE_SIZE are kept, the one used least recently going first.
import type { Card, MediaType } from '../api/types';
import { titleKey } from '../title/asked';

/** How long a title's name, year and poster are reused before the title is read again. */
export const TITLE_CACHE_TTL_MS = 10 * 60 * 1000;
export const TITLE_CACHE_SIZE = 300;

export type TitleDetails = Pick<Card, 'title' | 'year' | 'posterUrl'>;

export interface TitleCache {
  get(mediaType: MediaType, tmdbId: number): TitleDetails | undefined;
  set(mediaType: MediaType, tmdbId: number, details: TitleDetails): void;
  forget(): void;
}

const monotonic = (): number => performance.now();

export function createTitleCache(now: () => number = monotonic, wall: () => number = () => Date.now()): TitleCache {
  // A Map keeps insertion order: a title used again is moved to the end, and the first one is the least recently used.
  let entries = new Map<string, { details: TitleDetails; mono: number; wall: number }>();
  return {
    get(mediaType, tmdbId) {
      const key = titleKey(mediaType, tmdbId);
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      const sinceMono = now() - entry.mono;
      const sinceWall = wall() - entry.wall;
      if (sinceMono < 0 || sinceMono >= TITLE_CACHE_TTL_MS || sinceWall < 0 || sinceWall >= TITLE_CACHE_TTL_MS) return undefined;
      entries.set(key, entry);
      return entry.details;
    },
    set(mediaType, tmdbId, { title, year, posterUrl }) {
      const key = titleKey(mediaType, tmdbId);
      entries.delete(key);
      entries.set(key, { details: { title, year, posterUrl }, mono: now(), wall: wall() });
      while (entries.size > TITLE_CACHE_SIZE) entries.delete(entries.keys().next().value as string);
    },
    forget() {
      entries = new Map();
    },
  };
}
