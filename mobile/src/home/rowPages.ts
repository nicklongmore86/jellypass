// The page a Home row showed, handed to its "See all" page (src/screens/ListScreen.tsx) as the member opens it, so the
// grid draws at once from what the row already has and asks for nothing: the TV add-on's kept first page
// (tv/src/discover-source.ts). Home puts the row's page when its See all link is pressed; the page takes it once, as it
// opens. A page opened by its address finds none and asks for its first page.
//
// In memory only: never written to the device. One per signed-in session (SessionProvider), forgotten with it.
import type { DiscoverList, Page } from '../api/types';

export interface RowPages {
  put(list: DiscoverList, page: Page): void;
  /** The page put for `list`, once: a second take finds nothing. */
  take(list: DiscoverList): Page | undefined;
  forget(): void;
}

export function createRowPages(): RowPages {
  let pages = new Map<DiscoverList, Page>();
  return {
    put(list, page) {
      pages.set(list, page);
    },
    take(list) {
      const page = pages.get(list);
      pages.delete(list);
      return page;
    },
    forget() {
      pages = new Map();
    },
  };
}
