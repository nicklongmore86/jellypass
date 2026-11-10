/**
 * The collection page's address and words (docs/tv-addon.md, "Collections"): a film series (TMDB's collection) as a page
 * of Jellyfin web at `#/jellypass/collection/<id>`, reached only from a film's title page (`Movie.collection`, sent by a
 * server with `apiVersion` 6). Kept apart from the page itself so the title page can link to it.
 */

export const COLLECTION_PATH = '/jellypass/collection/:id';
export function collectionHash(id: number): string {
  return `#/jellypass/collection/${id}`;
}

/** Every fixed string the collection page (and the title page's link to it) shows. */
export const COLLECTION_TEXT = {
  partOf: (name: string): string => `Part of ${name}`,
  films: 'Films',
  chooseFilms: 'Choose the films you want',
  getAll: 'Get all missing films',
  getSelected: (count: number): string => `Get selected (${count})`,
  notReleased: 'Not released yet',
  comingOn: (date: string): string => `Not released yet · ${date}`,
  noFilms: 'No films listed.',
  asked: (titles: string[]): string => `Asked for: ${titles.join(', ')}.`,
  notAsked: (titles: string[]): string => `Not asked for: ${titles.join(', ')}.`,
  pick: (title: string): string => `Choose ${title}`,
} as const;
