/**
 * Everything the TV add-on reads from Jellyfin web, in one place: these are Jellyfin web's internals, not a public API,
 * so a Jellyfin web upgrade is checked here first (see docs/tv-addon.md, "Jellyfin web coupling"). Checked against
 * Jellyfin web 10.11.11's built bundle (the one jellyfin-tizen builds use) and served by Jellyfin 10.11.3 in the tests.
 * Anything missing or shaped otherwise reads as "not there", so the add-on draws nothing rather than break the page.
 */

/** The parts of Jellyfin web's global `ApiClient` (jellyfin-apiclient) the add-on calls, each optional until checked. */
interface ApiClientLike {
  accessToken?: () => unknown;
  serverAddress?: () => unknown;
  getCurrentUserId?: () => unknown;
}

/** Who is signed in to Jellyfin web, and where: read afresh for every use, never kept. */
export interface Session {
  /** The origin of the server Jellyfin web is signed in to. */
  origin: string;
  /** Jellyfin web's own access token for it. */
  token: string;
  userId: string;
}

/**
 * Jellyfin web's current session, from `window.ApiClient` (set by Jellyfin web's ServerConnections on every sign-in and
 * server change), or undefined when no one is signed in or it is not there. The token is only ever passed on to one
 * request's header: it is never stored, logged or put in the page.
 */
export function currentSession(scope: { ApiClient?: unknown }): Session | undefined {
  const client = scope.ApiClient as ApiClientLike | undefined;
  if (!client || typeof client.accessToken !== 'function' || typeof client.serverAddress !== 'function' || typeof client.getCurrentUserId !== 'function') {
    return undefined;
  }
  try {
    const token = client.accessToken();
    const address = client.serverAddress();
    const userId = client.getCurrentUserId();
    if (typeof token !== 'string' || !token || typeof address !== 'string' || typeof userId !== 'string' || !userId) return undefined;
    return { origin: new URL(address).origin, token, userId };
  } catch {
    return undefined;
  }
}

/**
 * Home's sections, once Jellyfin web has laid them out: its home page (`#indexPage`, kept in the page while hidden, with
 * `hide` then) holds the Home tab (`#homeTab`), whose `.sections` element gets `homeSectionsContainer` and its
 * `.verticalSection.section0` … placeholders all at once when the sections are loaded. Undefined until then, and while
 * Home is not the page shown.
 */
export function homeSections(document: Document): { container: Element; first: Element } | undefined {
  const page = document.getElementById('indexPage');
  if (!page || page.classList.contains('hide')) return undefined;
  const container = page.querySelector('#homeTab .homeSectionsContainer');
  const first = container?.querySelector('.verticalSection.section0');
  return container && first && first.parentNode === container ? { container, first } : undefined;
}

/**
 * Jellyfin web's Search page, once it is shown: `#searchPage` (the legacy app's `routes/search.tsx`, the same in the TV
 * and the desktop layout), a `[data-role=page].page` that is not `hide`, whose `#searchTextInput` holds the query as the
 * member typed it (a controlled input: Jellyfin web debounces it by 500 ms before it lists results). Undefined unless
 * the page and the input are as expected, so a Jellyfin web that has changed them gets no row.
 */
export function searchPage(document: Document): { page: Element; input: HTMLInputElement } | undefined {
  const page = document.getElementById('searchPage');
  if (!page || page.getAttribute('data-role') !== 'page' || !page.classList.contains('page') || page.classList.contains('hide')) return undefined;
  const input = page.querySelector('.searchFields input#searchTextInput') as HTMLInputElement | null;
  return input && typeof input.value === 'string' ? { page, input } : undefined;
}

/** Whether `event` (a `viewshow`) is Jellyfin web's Search page being shown. */
export function isSearchShown(event: Event): boolean {
  const target = event.target as Element | null;
  return Boolean(target && target.id === 'searchPage');
}

/** Whether `event` (a `viewshow`, which Jellyfin web dispatches on each page as it is shown) is Home being shown. */
export function isHomeShown(event: Event): boolean {
  const target = event.target as Element | null;
  return Boolean(target && target.id === 'indexPage');
}

/** Where the add-on's header button goes: in front of Jellyfin web's Search button, in whichever header the layout shows. */
export interface HeaderSearch {
  /** `legacy`: the TV layout's header (and the 10.11 the Samsung app bundles). `toolbar`: the desktop layout's React toolbar of 12.x. */
  kind: 'legacy' | 'toolbar';
  right: Element;
  search: Element;
  /** The toolbar's Search icon (an `<svg>` with one `<path>`), whose look the button's icon takes. */
  icon: Element | undefined;
}

/**
 * Jellyfin web's header, where its Search button is (checked against 12.3 and 10.11.3, docs/tv-addon.md, "The Discover page"):
 * - the TV layout shows the legacy header (`scripts/libraryMenu.js` `renderHeader`): `.skinHeader .headerRight` with the Search
 *   button (`button.headerSearchButton`, a direct child), not hidden. This is also what the Samsung app's 10.11 draws;
 * - the desktop layout of 12.x hides that header (it is 0 by 0) and shows a React/MUI toolbar (`header.MuiAppBar-root`), whose
 *   right-hand actions are a box holding the SyncPlay and Cast buttons and the Search link, `a[aria-label=Search][href="#/search"]`.
 *   A button put there is not React's, so React leaves it alone while it re-renders around it; it is put back if the toolbar is
 *   drawn again.
 * Undefined if the header of the layout is not as that (no fall back to the other one), so a Jellyfin web that has changed it gets no button.
 */
export function headerSearch(document: Document): HeaderSearch | undefined {
  // The layout decides which header is the visible one, and only that one is read: if its Search cannot be matched there is
  // no button, never a fall back to the other header (the desktop layout's legacy header is in the page but hidden).
  if (!document.documentElement.classList.contains('layout-tv')) {
    const link = document.querySelector('header.MuiAppBar-root a.MuiIconButton-root[aria-label="Search"][href="#/search"]');
    if (!link) return undefined;
    const parent = link.parentNode;
    const icons = link.querySelectorAll('svg');
    const paths = icons.length === 1 ? (icons[0] as Element).querySelectorAll('path') : [];
    return parent && parent.nodeType === 1 && paths.length === 1 ? { kind: 'toolbar', right: parent as Element, search: link, icon: icons[0] as Element } : undefined;
  }
  const search = document.querySelector('.skinHeader .headerRight > button.headerSearchButton');
  const right = search ? search.parentNode : null;
  if (!search || !right || right.nodeType !== 1 || search.classList.contains('hide')) return undefined;
  return { kind: 'legacy', right: right as Element, search, icon: undefined };
}

/**
 * Whether Jellyfin web's own header shows a Back button, in whichever header is drawn (checked against 12.3 and 10.11.3):
 * - the legacy header (`scripts/libraryMenu.js`, the TV layout's, and 10.11's in every layout): `.skinHeader .headerBackButton`,
 *   which `libraryMenu` un-hides (`hide`) on each page when its router can go back;
 * - the React/MUI toolbar of 12.x's desktop layout (`header.MuiAppBar-root`): a button holding MUI's `ArrowBack` icon
 *   (`svg[data-testid=ArrowBackIcon]`), drawn only in Jellyfin's own apps (`window.NativeShell`, the iOS and Android apps),
 *   not in a browser.
 * A button counts only while it takes up room on the screen: 12.x's desktop layout keeps the legacy header in the page, not
 * hidden by class but inside a `display: none` box. Anything not as that reads as no Back, so the add-on keeps its own.
 */
export function headerBackShown(document: Document): boolean {
  const legacy = document.querySelector('.skinHeader .headerBackButton');
  if (legacy && !legacy.classList.contains('hide') && onScreen(legacy)) return true;
  const icons = document.querySelectorAll('header.MuiAppBar-root button svg[data-testid="ArrowBackIcon"]');
  for (let i = 0; i < icons.length; i += 1) {
    const button = (icons[i] as Element).closest('button');
    if (button && onScreen(button)) return true;
  }
  return false;
}

function onScreen(element: Element): boolean {
  if (typeof element.getBoundingClientRect !== 'function') return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

/**
 * Class names Jellyfin web's focus manager and layout read, used on the row so its d-pad navigation drives it: a
 * section (`verticalSection`, with its heading classes, so the row lines up with Home's own), and `focuscontainer-x` on
 * the list, so Left and Right stay in the row and Up and Down leave it, as in Home's own rows. The cards are plain
 * `<button>`s in Jellyfin web's card markup (`card`, `cardBox`, `cardScalable`, `cardPadder`, `cardImageContainer`,
 * `cardText`, as its `cardBuilder` writes them, so its sizes, type and `:focus` ring apply), which the focus manager
 * moves between by their place on the screen; Jellyfin web's scroll manager scrolls
 * the one focused into view on a TV.
 */
export const JELLYFIN_CLASSES = {
  section: 'verticalSection',
  headingContainer: 'sectionTitleContainer sectionTitleContainer-cards padded-left',
  heading: 'sectionTitle sectionTitle-cards',
  row: 'focuscontainer-x',
  /** Jellyfin web's own portrait card in a row (its width follows the screen), as `cardBuilder` names it. */
  card: 'card overflowPortraitCard card-hoverable',
  /** Its backdrop (landscape) card in a row, which the Discover page's wide rows use. */
  cardBackdrop: 'card overflowBackdropCard card-hoverable',
  /** What `cardBuilder` adds on a TV: the focus ring and zoom its CSS draws. */
  cardTv: 'show-focus show-animation',
  /**
   * What Jellyfin web's `emby-itemscontainer` adds to a row's list on a TV (`ItemsContainer.tsx`, `itemsContainer-tv`): its card
   * sizes for a TV are keyed on `.itemsContainer-tv > .overflowPortraitCard` (15.6vw) and `> .overflowBackdropCard` (23.5vw),
   * where a row without it gets the desktop's (`card.scss`). It is not `itemsContainer`, which Jellyfin's pages call `.pause()` on.
   */
  rowTv: 'itemsContainer-tv',
  /** Jellyfin web's wrapping grid (the library pages' `vertical-wrap`), and its card in it, which sizes by a share of the grid's width. */
  grid: 'vertical-wrap',
  cardGrid: 'card portraitCard card-hoverable',
} as const;

/** The classes of a row's (or a grid's) list on a TV or not: Jellyfin web's own, so its card sizes apply. */
export function listClasses(base: string, tv: boolean): string {
  return tv ? `${base} ${JELLYFIN_CLASSES.rowTv}` : base;
}

/**
 * Jellyfin web's own details page for an item, as its router's hash route (the address the API's `play.url` names). Set
 * as `location.hash` on the page Jellyfin web is running in, it opens there, with its own player: no reload, no new page.
 */
export function detailsHash(itemId: string): string {
  return `#/details?id=${itemId}`;
}
