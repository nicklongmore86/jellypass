// Search's fixed words and sizes, word for word as the PWA's search() (app/src/main.ts) and searchForm() and
// searchStatusText() (app/src/render.ts) have them. __tests__/search-text.test.ts fails if one drifts from the PWA's files.

/** The field's name for screen readers, its placeholder, and what is announced as results come and go. */
export const SEARCH_TEXT = {
  label: 'Search movies and series',
  placeholder: 'Movies and series',
  searching: 'Searching…',
  loaded: 'Results loaded.',
  more: 'More results loaded.',
} as const;

/** The paging button under a list, and its words while the next page loads. */
export const MORE_TEXT = { button: 'Load more', loading: 'Loading…' } as const;

/** The pause after the last keystroke before a search is sent: one call per pause, as the PWA. */
export const SEARCH_DEBOUNCE_MS = 300;
/** The API's longest query; the field takes no more. */
export const MAX_QUERY_LENGTH = 100;

/** What is searched for: the field's text, trimmed, at most MAX_QUERY_LENGTH characters ('' searches for nothing). */
export function searchQuery(raw: string): string {
  return raw.trim().slice(0, MAX_QUERY_LENGTH);
}

export function noResultsText(query: string): string {
  return `No results for “${query}”.`;
}

/** The narrowest window (the stylesheet's 21rem) that still has three columns of posters; below it, two. */
export const NARROW_WIDTH = 336;
/** From this window width (48rem), as many columns of at least MIN_TABLET_CARD as fit. */
export const TABLET_WIDTH = 768;
export const MIN_TABLET_CARD = 160;
/** The grid's gaps: 0.6rem between columns, 1rem between rows. */
export const GRID_GAP = { column: 9.6, row: 16 } as const;

/** How many columns of posters the results take: three on a phone, two on a very narrow one, more on a tablet. */
export function gridColumns(windowWidth: number, columnWidth: number): number {
  if (windowWidth >= TABLET_WIDTH) return Math.max(3, Math.floor((columnWidth + GRID_GAP.column) / (MIN_TABLET_CARD + GRID_GAP.column)));
  return windowWidth <= NARROW_WIDTH ? 2 : 3;
}

/** One poster's width in a grid of `columns` across `columnWidth`. */
export function gridCardWidth(columnWidth: number, columns: number): number {
  return Math.max(0, Math.floor((columnWidth - GRID_GAP.column * (columns - 1)) / columns));
}
