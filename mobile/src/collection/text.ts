// A collection's words (a film series, from a film's page; server `apiVersion` 6) and "Get all missing seasons" on a
// series page. Nothing here depends on an answer but the fields it is given. A collection's films are asked for one
// "Get this" each, in order; when one is refused the rest are not sent, and the page says which were and which were not.
import type { CollectionFilm } from '../api/types';

/** The first server revision with collections: below it a film's page shows no collection link. */
export const COLLECTIONS_API_VERSION = 6;

export const COLLECTION_TEXT = {
  films: 'Films',
  none: 'No films listed.',
  chooseFilms: 'Choose the films you want',
  getAll: 'Get all missing films',
  notReleased: 'Not released yet',
  chooseBelow: 'Choose the films you want below.',
} as const;

/** "Get all missing seasons": the same one request as Select all, then Get this. */
export const ALL_SEASONS_TEXT = 'Get all missing seasons';

/** A film's link to its collection: "Part of The Synthetic Collection". */
export function partOfText(name: string): string {
  return `Part of ${name}`;
}

/** The send button: "Get all missing films" while the films chosen are the ones chosen at first, else "Get selected (N)". */
export function getFilmsLabel(chosen: number, allMissing: boolean): string {
  return allMissing ? COLLECTION_TEXT.getAll : `Get selected (${chosen})`;
}

function titles(films: readonly Pick<CollectionFilm, 'title'>[]): string {
  return films.map((film) => film.title).join(', ');
}

/** "Asked for: A, B." */
export function askedForText(films: readonly Pick<CollectionFilm, 'title'>[]): string {
  return `Asked for: ${titles(films)}.`;
}

/** "Not asked for: C, D." */
export function notAskedForText(films: readonly Pick<CollectionFilm, 'title'>[]): string {
  return `Not asked for: ${titles(films)}.`;
}
