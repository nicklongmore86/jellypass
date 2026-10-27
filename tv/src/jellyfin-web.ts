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

/** Whether `event` (a `viewshow`, which Jellyfin web dispatches on each page as it is shown) is Home being shown. */
export function isHomeShown(event: Event): boolean {
  const target = event.target as Element | null;
  return Boolean(target && target.id === 'indexPage');
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
  /** What `cardBuilder` adds on a TV: the focus ring and zoom its CSS draws. */
  cardTv: 'show-focus show-animation',
} as const;

/**
 * Jellyfin web's own details page for an item, as its router's hash route (the address the API's `play.url` names). Set
 * as `location.hash` on the page Jellyfin web is running in, it opens there, with its own player: no reload, no new page.
 */
export function detailsHash(itemId: string): string {
  return `#/details?id=${itemId}`;
}
