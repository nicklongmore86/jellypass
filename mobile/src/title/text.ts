// The title pages' fixed words, word for word as the PWA's app/src/render.ts has them: Get this and its outcomes, the
// notes beside a status, the facts under a title and the seasons' words. __tests__/title-text.test.ts fails if one
// drifts from the PWA's file. Nothing here depends on an answer but the DTO fields it is given.
import type { ApiErrorKind } from '../api/errors';
import type { Movie, Series } from '../api/types';

/** Get this words. The confirmation is one fixed sentence: nothing about the answer changes it, or tells what followed. */
export const GET_THIS_TEXT = {
  button: 'Get this',
  sending: 'Sending…',
  chooseSeasons: 'Choose the seasons you want',
  chooseBelow: 'Choose the seasons you want below.',
  selectAll: 'Select all',
  clearAll: 'Clear all',
  confirmation: "Thanks — we'll get this for your household.",
  failedNote: 'Ask your JellyPass admin to try again.',
  rate_limited: 'Too many tries, try again in a few minutes.',
  offline: "You're offline. Check your connection, then try again.",
  unavailable: "We couldn't send that just now. Try again in a moment.",
} as const;

export type GetThisError = 'rate_limited' | 'offline' | 'unavailable';

/** The fixed message for a Get this that was not accepted (`unauthorized` never gets here: it signs the member out). */
export function getThisError(kind: ApiErrorKind): GetThisError {
  if (kind === 'too_many_requests') return 'rate_limited';
  if (kind === 'network') return 'offline';
  return 'unavailable';
}

/** What a title in the household's state says besides its pill; a state with a button needs none. */
export const STATE_NOTES = {
  unavailable: "This title can't be requested.",
  requested: 'Check My requests to follow it.',
} as const;

export const PLAY_TEXT = 'Play';
export const SEASONS_TEXT = { heading: 'Seasons', none: 'No seasons listed.', noEpisodes: 'No episodes listed.' } as const;

export function playLabel(title: string): string {
  return `${PLAY_TEXT} ${title}`;
}

/** "1 h 58 min", "45 min", or nothing. */
export function runtimeText(minutes: number | null): string {
  if (!minutes || minutes < 1) return '';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} h${rest ? ` ${rest} min` : ''}` : `${rest} min`;
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A movie's run time, or how many seasons a series has (specials are not a season). */
export function lengthText(title: Movie | Series): string {
  const seasons = title.mediaType === 'tv' ? title.seasons.filter((season) => season.seasonNumber >= 1).length : 0;
  return seasons > 0 ? counted(seasons, 'season', 'seasons') : runtimeText(title.runtime);
}

export function episodesText(count: number | null): string {
  return count === null ? '' : counted(count, 'episode', 'episodes');
}

export function seasonName(name: string, seasonNumber: number): string {
  return name || `Season ${seasonNumber}`;
}

export function episodeTitle(episodeNumber: number, name: string): string {
  return `${episodeNumber}. ${name || `Episode ${episodeNumber}`}`;
}
