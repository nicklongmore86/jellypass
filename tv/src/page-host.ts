/**
 * A page host inside Jellyfin web for JellyPass pages at `#/jellypass/...` (docs/tv-addon.md, "The page host").
 *
 * Jellyfin web has no route extension point, but its route table ends in a "page not found" route
 * (`components/router/FallbackRoute.tsx`, the same in the TV and the desktop layout): a real Jellyfin page,
 * `<div id="fallbackPage" data-role="page" class="page mainAnimatedPage libraryPage">`, under Jellyfin's own header. An
 * unknown hash such as `#/jellypass/about` lands on it. The host fills that page, so Jellyfin's header, its Back and
 * Home buttons, its history, its focus manager and its scrolling all apply, and the add-on handles no key.
 *
 * Everything it reads from Jellyfin web is here: `#fallbackPage` (a `[data-role=page].page`, not `hide`), its
 * `data-title` (read by `scripts/libraryMenu.js` on `pageshow`) and the header's `.skinHeader .pageTitle` (set as
 * libraryMenu's `setTitle` does). If any of it is not as expected nothing is drawn and Jellyfin's page is left alone.
 */

/** Hash paths the host serves are under this prefix. */
export const HOST_PREFIX = '/jellypass/';
/** On `<html>` while a registered route is current: the stylesheet hides Jellyfin's "Page not found" under it. */
export const HOSTING_CLASS = 'jellypass-tv-hosting';
/** On the element a page draws into, inside Jellyfin's page. */
export const PAGE_ATTR = 'data-jellypass-tv-page';
/** On an element of a page that focus returns to on Back, with a key unique within the page. */
export const FOCUS_ATTR = 'data-jellypass-tv-focus';
/** On the Back button the host puts at the top of a JellyPass page in the desktop layout. */
export const BACK_ATTR = 'data-jellypass-tv-back';
/** How many pages' last focus is remembered (in memory only). */
const FOCUS_MEMORY = 20;

/** What a page's render function is given. */
export interface PageContext {
  document: Document;
  /** Empty and in Jellyfin's page; the page draws into it and nowhere else. */
  container: HTMLElement;
  /** The values of the pattern's `:name` segments, decoded. */
  params: { [name: string]: string };
  /** Sets Jellyfin's header title (and the document's) once the page knows it; ignored after the page is left. */
  setTitle(title: string): void;
  /**
   * The page has drawn what it focuses on its own: focus goes to what had it when the page was last left (a
   * `FOCUS_ATTR` key), else to `fallback`; not once the member has pressed anything on this page, whose focus is theirs.
   */
  focus(fallback: HTMLElement | null): void;
}

/** What a page's render function returns. */
export interface PageView {
  /** Set as Jellyfin's header title (and the document's). */
  title: string;
  /** Called when the page is left, before its container goes. */
  cleanup?: () => void;
  /** Focused when the page was not left from an element with a `FOCUS_ATTR` key. */
  focus?: HTMLElement | null;
}

export type PageRender = (context: PageContext) => PageView;

interface Route {
  segments: string[];
  render: PageRender;
}

interface Active {
  hash: string;
  page: Element;
  container: HTMLElement;
  cleanup: (() => void) | undefined;
  /** Focus is put right again once, after Jellyfin's own `pageshow` work (its auto-focus) is done. */
  focusPending: boolean;
  /** The member has pressed a key or the pointer on this page: what the page focuses later is not theirs to take. */
  acted: boolean;
  /** Jellyfin's `data-title` for its page, put back (with the header and document title it implies) when the host leaves. */
  priorTitle: string | null;
  view: PageView;
  /** The Back button's bar, with the sign-in generation it was drawn under: after a change it is replaced, and the old one is inert. */
  backBar?: HTMLElement | undefined;
  backGeneration?: number | undefined;
}

/** The path of a `#/jellypass/...` hash (without its query), or undefined. */
export function hostPath(hash: string): string | undefined {
  if (!hash.startsWith('#/')) return undefined;
  const query = hash.indexOf('?');
  const path = query < 0 ? hash.slice(1) : hash.slice(1, query);
  return path.startsWith(HOST_PREFIX) && path.length > HOST_PREFIX.length ? path : undefined;
}

function match(route: Route, path: string): { [name: string]: string } | undefined {
  const parts = path.split('/').slice(1);
  if (parts.length !== route.segments.length) return undefined;
  const params: { [name: string]: string } = {};
  for (let i = 0; i < parts.length; i += 1) {
    const want = route.segments[i] as string;
    const got = parts[i] as string;
    if (want.charAt(0) === ':') {
      if (!got) return undefined;
      try {
        params[want.slice(1)] = decodeURIComponent(got);
      } catch {
        return undefined;
      }
    } else if (want !== got) {
      return undefined;
    }
  }
  return params;
}

export class PageHost {
  private routes: Route[] = [];
  private active: Active | undefined;
  /** The hash and page a render failed on: not tried again there, and Jellyfin's page is shown as it is. */
  private failed: { hash: string; page: Element } | undefined;
  private focusKeys = new Map<string, string>();

  /**
   * `back` is what the Back button does (history back, or Home when the member has come from nowhere in Jellyfin); without
   * it no page has the button. The button is only for the desktop layout, whose toolbar has no Back (the TV layout has
   * Jellyfin's own header Back and the remote). `generation` is the sign-in generation (SessionWatch.snapshot): a Back
   * button works only under the one it was drawn under.
   */
  constructor(private readonly document: Document, private readonly currentHash: () => string, private readonly back?: () => void, private readonly generation: () => number = () => 0) {}

  /** Registers a page for a path pattern under `/jellypass/`, such as `/jellypass/about` or `/jellypass/title/:id`. */
  register(pattern: string, render: PageRender): void {
    if (!pattern.startsWith(HOST_PREFIX)) throw new Error('a page lives under /jellypass/');
    this.routes.push({ segments: pattern.split('/').slice(1), render });
  }

  /** Brings the page in step with the hash and Jellyfin's page: called on a hash change and as Jellyfin's page changes. */
  update(): void {
    const hash = this.currentHash();
    const path = hostPath(hash);
    let params: { [name: string]: string } | undefined;
    let route: Route | undefined;
    if (path !== undefined) {
      for (const candidate of this.routes) {
        params = match(candidate, path);
        if (params) {
          route = candidate;
          break;
        }
      }
    }
    const page = this.fallbackPage();
    const active = this.active;
    if (active && (!route || active.hash !== hash || active.page !== page || !active.page.contains(active.container))) this.leave();
    if (!route || !params) {
      this.failed = undefined;
      this.hosting(false);
      return;
    }
    if (this.failed && (this.failed.hash !== hash || this.failed.page !== page)) this.failed = undefined;
    if (this.failed) {
      this.hosting(false);
      return;
    }
    // Set before Jellyfin's page exists, so its "Page not found" is never drawn; not while that page is not as expected
    // (the stylesheet checks its shape too), so then Jellyfin's page is shown as it is.
    this.hosting(Boolean(page) || !this.document.getElementById('fallbackPage'));
    if (this.active) this.refreshBack(this.active);
    if (!page || this.active) return;
    this.open(page, hash, route, params);
  }

  /** A `focusin` anywhere: the focus inside the page is remembered, so Back returns to it. */
  focusIn(event: Event): void {
    const active = this.active;
    const target = event.target as Element | null;
    if (!active || !target || !active.container.contains(target)) return;
    // Until the correction has run or the member has pressed something, focus inside the page is Jellyfin's own
    // auto-focus: it neither cancels the correction nor replaces the remembered element.
    if (active.focusPending) return;
    const key = (target as Element).closest ? (target as Element).closest(`[${FOCUS_ATTR}]`) : null;
    const value = key && active.container.contains(key) ? key.getAttribute(FOCUS_ATTR) : null;
    if (value === null) return;
    this.focusKeys.delete(active.hash);
    this.focusKeys.set(active.hash, value);
    if (this.focusKeys.size > FOCUS_MEMORY) {
      const oldest = this.focusKeys.keys().next();
      if (!oldest.done) this.focusKeys.delete(oldest.value);
    }
  }

  /** A key or pointer press by the member: from here focus inside the page is theirs, to be remembered. */
  userInput(): void {
    if (!this.active) return;
    // A press is the likeliest next thing after a session change that moved no element: the old Back button goes now.
    this.refreshBack(this.active);
    this.active.focusPending = false;
    this.active.acted = true;
  }

  /** Jellyfin web's `pageshow` on its page (its own work, auto-focus included, is done after this): focus is put right. */
  pageShown(event: Event): void {
    const active = this.active;
    if (!active || event.target !== active.page || !active.focusPending) return;
    setTimeout(() => {
      if (this.active === active && active.focusPending) {
        active.focusPending = false;
        this.restoreFocus(active);
      }
    }, 0);
  }

  /** Jellyfin's page for an unknown route, if it is there and has the shape the host relies on. */
  private fallbackPage(): Element | null {
    const page = this.document.getElementById('fallbackPage');
    if (!page || page.getAttribute('data-role') !== 'page' || !page.classList.contains('page') || page.classList.contains('hide')) return null;
    return page;
  }

  private hosting(on: boolean): void {
    const root = this.document.documentElement;
    if (on) root.classList.add(HOSTING_CLASS);
    else root.classList.remove(HOSTING_CLASS);
  }

  private open(page: Element, hash: string, route: Route, params: { [name: string]: string }): void {
    const container = this.document.createElement('div');
    container.setAttribute(PAGE_ATTR, '');
    page.appendChild(container);
    let view: PageView;
    try {
      view = route.render({
        document: this.document,
        container,
        params,
        setTitle: (title) => {
          const now = this.active;
          if (now && now.container === container) this.setTitle(now.page, title);
        },
        focus: (fallback) => {
          const now = this.active;
          if (!now || now.container !== container) return;
          now.view.focus = fallback;
          if (!now.acted) this.restoreFocus(now);
        },
      });
    } catch {
      container.remove();
      this.failed = { hash, page };
      this.hosting(false);
      return;
    }
    const active: Active = { hash, page, container, cleanup: view.cleanup, focusPending: true, acted: false, priorTitle: page.getAttribute('data-title'), view };
    this.active = active;
    this.drawBack(active);
    this.setTitle(page, view.title);
    this.restoreFocus(active);
    // Our own focus above is not the member moving it.
    active.focusPending = true;
  }

  /** The Back button, first in the page, once: nowhere in the TV layout, and not again if the page has it already. */
  private drawBack(active: Active): void {
    const back = this.back;
    if (!back || this.document.documentElement.classList.contains('layout-tv')) return;
    if (active.container.querySelector(`[${BACK_ATTR}]`)) return;
    const generation = this.generation();
    const bar = this.document.createElement('div');
    bar.className = 'jellypass-tv-back-bar padded-left padded-right';
    const button = this.document.createElement('button');
    button.type = 'button';
    button.className = 'emby-button jellypass-tv-back';
    button.setAttribute(BACK_ATTR, '');
    button.setAttribute(FOCUS_ATTR, 'back');
    button.setAttribute('aria-label', 'Back');
    button.textContent = 'Back';
    // Only the page on show answers, under the session it was drawn in: a button kept from a page since left, or from
    // before a sign-out, another member or a new token, does nothing.
    button.addEventListener('click', () => {
      if (this.active === active && active.backGeneration === generation && this.generation() === generation) back();
    });
    bar.appendChild(button);
    active.container.insertBefore(bar, active.container.firstChild);
    active.backBar = bar;
    active.backGeneration = generation;
  }

  /** The session changed under the page on show: its Back button is taken away and drawn again for the new one. */
  private refreshBack(active: Active): void {
    if (!active.backBar || active.backGeneration === this.generation()) return;
    active.backBar.remove();
    active.backBar = undefined;
    active.backGeneration = undefined;
    this.drawBack(active);
  }

  private leave(): void {
    const active = this.active;
    this.active = undefined;
    if (!active) return;
    try {
      if (active.cleanup) active.cleanup();
    } catch {
      // A page's cleanup must not stop Jellyfin web going on.
    }
    active.container.remove();
    // Jellyfin web reuses its fallback page on a location change and its `pageshow` work does not run again, so what the
    // host set is put back as Jellyfin's `pageshow` would set it. A page Jellyfin removed is left to Jellyfin.
    if (this.fallbackPage() === active.page) {
      if (active.priorTitle === null) active.page.removeAttribute('data-title');
      else {
        active.page.setAttribute('data-title', active.priorTitle);
        this.setHeader(active.priorTitle);
      }
    }
  }

  private restoreFocus(active: Active): void {
    const wanted = this.focusKeys.get(active.hash);
    let target: HTMLElement | null | undefined;
    if (wanted !== undefined) {
      const keyed = active.container.querySelectorAll(`[${FOCUS_ATTR}]`);
      for (let i = 0; i < keyed.length; i += 1) {
        if ((keyed[i] as Element).getAttribute(FOCUS_ATTR) === wanted) {
          target = keyed[i] as HTMLElement;
          break;
        }
      }
    }
    target = target || active.view.focus;
    if (target && active.container.contains(target)) target.focus();
  }

  /** The header's title as Jellyfin web's `libraryMenu.setTitle` sets it, on its page too, so its `pageshow` agrees. */
  private setTitle(page: Element, title: string): void {
    page.setAttribute('data-title', title);
    this.setHeader(title);
  }

  private setHeader(title: string): void {
    const heading = this.document.querySelector('.skinHeader .pageTitle') as HTMLElement | null;
    if (heading) {
      heading.classList.remove('pageTitleWithLogo');
      heading.classList.remove('pageTitleWithDefaultLogo');
      heading.style.backgroundImage = '';
      heading.textContent = title;
    }
    this.document.title = title;
  }
}
