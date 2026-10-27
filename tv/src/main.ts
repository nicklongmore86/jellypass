import { isHomeShown } from './jellyfin-web.js';
import { HomeRow } from './row.js';

/**
 * The JellyPass TV add-on's entry (docs/tv-addon.md): one classic script that the household gateway adds to Jellyfin
 * web's page, built by scripts/build-tv.mjs to ES2017 for the TVs' Chromium 63. It waits for Jellyfin web's Home and adds
 * the JellyPass row to it. It calls only the household app API, on the origin this script was loaded from.
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

  const row = new HomeRow(document, { get ApiClient() { return (window as unknown as { ApiClient?: unknown }).ApiClient; }, fetch: (url, init) => window.fetch(url, init) }, base.origin);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      safely(() => row.update());
    }, SETTLE_MS);
  };
  new MutationObserver(settle).observe(document.body ?? document.documentElement, { childList: true, subtree: true });
  document.addEventListener('viewshow', (event) => {
    if (isHomeShown(event)) safely(() => row.homeShown());
  }, true);
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
