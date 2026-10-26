// Where a title's pages open: on the stack of the tab the member opened it from (Home, Search or My requests), so the
// tab bar keeps that tab and Back leads back to where they were. Each of those tabs has the same three routes.
import type { Card } from '../api/types';
import type { TabSpec } from './tabs';

export type TitleTab = Exclude<TabSpec['name'], 'account'>;

/** A movie's or series' page on `tab`'s stack: `/search/movie/<id>`, `/requests/tv/<id>`, … */
export function titlePath(tab: TitleTab, card: Pick<Card, 'mediaType' | 'tmdbId'>): string {
  return `/${tab}/${card.mediaType}/${card.tmdbId}`;
}

/** A season's page on `tab`'s stack. */
export function seasonPath(tab: TitleTab, tmdbId: number, seasonNumber: number): string {
  return `/${tab}/tv/${tmdbId}/season/${seasonNumber}`;
}
