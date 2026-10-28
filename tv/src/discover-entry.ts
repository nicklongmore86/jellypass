import { DISCOVER_TEXT } from './discover-model.js';
import { headerSearch } from './jellyfin-web.js';
import type { SessionWatch } from './session-watch.js';

/**
 * The only way into the Discover page: a compass button in Jellyfin web's header, immediately before Search, in the TV and
 * the desktop layout (docs/tv-addon.md, "The Discover page"). It is drawn only while someone is signed in to this origin
 * and Jellyfin's header is as `headerSearch` expects; otherwise it is not drawn, and then there is no way in (there is no
 * heading link, end card or other fallback). It is a plain `<button>` in Jellyfin's own header-button classes (taken from
 * the Search button's own, so its focus ring, size and hover are Jellyfin's in each layout), so Jellyfin web's focus manager
 * moves to it and from it; no key is handled here. Jellyfin web draws its header once, so the button is checked on every
 * page change and put back if it was lost, and removed on sign-out (or another member, who is then drawn their own).
 */

/** Material Design's "explore" icon (a compass), as the toolbar's icons are drawn (a 24 by 24 path). */
const EXPLORE_PATH = 'M12 10.9c-.61 0-1.1.49-1.1 1.1s.49 1.1 1.1 1.1c.61 0 1.1-.49 1.1-1.1s-.49-1.1-1.1-1.1zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm2.19 12.19L6 18l3.81-8.19L18 6l-3.81 8.19z';

/** On the button, so it is found again and never drawn twice. */
export const ENTRY_ATTRIBUTE = 'data-jellypass-tv-discover-entry';

export class DiscoverEntry {
  readonly #document: Document;
  readonly #watch: SessionWatch;
  readonly #open: () => void;

  public constructor(document: Document, watch: SessionWatch, open: () => void) {
    this.#document = document;
    this.#watch = watch;
    this.#open = open;
  }

  /** Called on every page change. */
  public update(): void {
    const session = this.#watch.current();
    const found = this.#document.querySelectorAll(`[${ENTRY_ATTRIBUTE}]`);
    const header = session ? headerSearch(this.#document) : undefined;
    if (header && found.length === 1) {
      const [button] = Array.prototype.slice.call(found) as Element[];
      if (button && button.parentNode === header.right && button.nextElementSibling === header.search && button.getAttribute(ENTRY_ATTRIBUTE) === session?.userId) return;
    }
    for (let i = 0; i < found.length; i += 1) {
      const old = found[i] as Element;
      if (old.parentNode) old.parentNode.removeChild(old);
    }
    if (!session || !header) return;
    const button = this.#document.createElement('button');
    button.setAttribute('type', 'button');
    // Jellyfin's own header button, as its Search button is (its `show-focus` on a TV, the toolbar's emotion classes on the desktop),
    // with nothing of Search's own or of a state it is in (`hide`, `Mui-disabled`).
    const own = header.search.className.split(/\s+/).filter((name) => name && name !== 'headerSearchButton' && name !== 'hide' && name.indexOf('Mui-') !== 0);
    button.className = own.concat(header.kind === 'toolbar' ? ['jellypass-tv-discover-entry'] : []).join(' ');
    button.setAttribute(ENTRY_ATTRIBUTE, session.userId);
    button.setAttribute('title', DISCOVER_TEXT.title);
    button.setAttribute('aria-label', DISCOVER_TEXT.title);
    if (header.kind === 'toolbar' && header.icon) {
      // The toolbar's own icon element (its size and colour), drawing the compass.
      const icon = header.icon.cloneNode(true) as Element;
      icon.removeAttribute('data-testid');
      (icon.querySelector('path') as Element).setAttribute('d', EXPLORE_PATH);
      button.appendChild(icon);
    } else {
      const icon = this.#document.createElement('span');
      icon.className = 'material-icons explore';
      icon.setAttribute('aria-hidden', 'true');
      button.appendChild(icon);
    }
    button.addEventListener('click', () => {
      // Another member, or no one, signed in since it was drawn: it opens nothing.
      const now = this.#watch.current();
      if (now && now.userId === session.userId) this.#open();
    });
    header.right.insertBefore(button, header.search);
  }
}
