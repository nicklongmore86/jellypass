import { Asked } from './asked.js';
import { isHomeShown } from './jellyfin-web.js';
import { HomeRow } from './row.js';
import { TitleView } from './title.js';

/**
 * The JellyPass TV add-on's entry (docs/tv-addon.md): one classic script that the household gateway adds to Jellyfin
 * web's page, built by scripts/build-tv.mjs to ES2017 for the TVs' Chromium 63. It waits for Jellyfin web's Home and adds
 * the JellyPass row to it; a card opens the JellyPass title view over Home. It calls only the household app API, on the
 * origin this script was loaded from.
 */

/** The stylesheet's built (fingerprinted) name, next to this script; written in by scripts/build-tv.mjs. */
declare const __JELLYPASS_TV_CSS__: string;

const MARKER = 'data-jellypass-tv';
/** How long page changes are gathered before the row checks Home again, in milliseconds. */
const SETTLE_MS = 50;

function start(): void {
  const scope = window as unknown as Window & { __jellypassTv?: boolean };
  // One add-on per page, whatever loaded it twice.
  if (scope.__jellypassTv) return;
  scope.__jellypassTv = true;
  const script = (document.currentScript ?? document.querySelector(`script[${MARKER}]`)) as HTMLScriptElement | null;
  const source = script?.getAttribute('src');
  if (!source) return;
  let base: URL;
  try {
    base = new URL(source, location.href);
  } catch {
    return;
  }
  const stylesheet = document.createElement('link');
  stylesheet.setAttribute('rel', 'stylesheet');
  stylesheet.setAttribute('href', new URL(__JELLYPASS_TV_CSS__, base.href).href);
  stylesheet.setAttribute(MARKER, '');
  document.head.appendChild(stylesheet);

  const api = { get ApiClient() { return (window as unknown as { ApiClient?: unknown }).ApiClient; }, fetch: (url: string, init: RequestInit) => window.fetch(url, init) };
  // What the member just asked for: in memory only, shared by the row and the title view.
  const asked = new Asked(() => Date.now());
  const title: TitleView = new TitleView(document, api, base.origin, asked, {
    changed: () => safely(() => row.update()),
    restoreFocus: (mediaType, tmdbId) => safely(() => row.focusCard(mediaType, tmdbId)),
    navigate: (hash) => {
      location.hash = hash;
    },
  });
  const row: HomeRow = new HomeRow(document, api, base.origin, asked, (card) => safely(() => title.open(card)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      safely(() => title.update());
      safely(() => row.update());
    }, SETTLE_MS);
  };
  new MutationObserver(settle).observe(document.body ?? document.documentElement, { childList: true, subtree: true });
  document.addEventListener('viewshow', (event) => {
    if (isHomeShown(event)) safely(() => row.homeShown());
    // Jellyfin web went to another page (its own Back, a menu, a link): the view goes with Home.
    else safely(() => title.close(false));
  }, true);
  // Back closes the view before Jellyfin web's own handler (on window, bubbling) sees it.
  document.addEventListener('keydown', (event) => safely(() => title.key(event)), true);
  document.addEventListener('focusin', (event) => safely(() => title.focusIn(event)), true);
  row.update();
}

/** Never lets the add-on break Jellyfin web: on any surprise it simply is not there. */
function safely(run: () => void): void {
  try {
    run();
  } catch {
    // Nothing is logged: a message could carry what the page holds.
  }
}

safely(start);
