import type { MediaType } from './types.js';

/** How long My requests reuses a title's name, year and poster before reading the title again. */
export const TITLE_CACHE_TTL_MS = 10 * 60 * 1000;
/** At most this many titles are kept; the one used least recently goes first. */
export const TITLE_CACHE_SIZE = 300;

/** What My requests shows of a title: never its state, which comes from /requests and the overlay. */
export interface TitleDetails {
  title: string;
  year: number | null;
  mediaType: MediaType;
  posterUrl: string | null;
}

/**
 * The titles My requests has named in this sign-in, so coming back to it reads only /requests (and any title it has not
 * named yet). In memory only: never stored, never sent; forgotten with the overlay (sign-out, a 401, another token,
 * member or household). An entry is used for {@link TITLE_CACHE_TTL_MS} on both the monotonic and the wall clock (as
 * the overlay's keys are, so a sleep ends it); a wall clock set back ends it too.
 */
export interface TitleCache {
  get(mediaType: MediaType, tmdbId: number): TitleDetails | undefined;
  set(details: TitleDetails & { tmdbId: number }): void;
  forget(): void;
}

export function createTitleCache(now: () => number = () => performance.now(), wall: () => number = () => Date.now()): TitleCache {
  // A Map keeps insertion order: a title used again is moved to the end, and the first one is the least recently used.
  let entries = new Map<string, { details: TitleDetails; mono: number; wall: number }>();
  const key = (mediaType: MediaType, tmdbId: number) => `${mediaType}:${tmdbId}`;
  return {
    get(mediaType, tmdbId) {
      const at = key(mediaType, tmdbId);
      const entry = entries.get(at);
      if (!entry) return undefined;
      entries.delete(at);
      const mono = now() - entry.mono;
      const sinceWall = wall() - entry.wall;
      if (mono < 0 || mono >= TITLE_CACHE_TTL_MS || sinceWall < 0 || sinceWall >= TITLE_CACHE_TTL_MS) return undefined;
      entries.set(at, entry);
      return entry.details;
    },
    set({ tmdbId, title, year, mediaType, posterUrl }) {
      const at = key(mediaType, tmdbId);
      entries.delete(at);
      entries.set(at, { details: { title, year, mediaType, posterUrl }, mono: now(), wall: wall() });
      while (entries.size > TITLE_CACHE_SIZE) entries.delete(entries.keys().next().value as string);
    },
    forget: () => { entries = new Map(); },
  };
}
