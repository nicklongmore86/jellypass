import type { ApiErrorKind, Profile, SignInErrorKind } from './api.js';
import { icon } from './icons.js';
import type { Card, CoarseStatus, HouseholdState, Movie, Page, RequestEntry, Season, SeasonSummary, Series, Source, SourceKind } from './types.js';

/**
 * Rendering: DTOs in, DOM out. Everything shown is a fixed string or a DTO field set with `textContent`; nothing is
 * ever parsed as HTML, so a title cannot inject markup. A function takes the document to build in, so the same code
 * runs in the browser and under a test DOM.
 */

const TMDB_IMAGE = /^https:\/\/image\.tmdb\.org\/t\/p\/(?:w342|w780|w1280)\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/;
/** Network and studio logos: TMDB's own files at the one width the API sends, and nothing else. */
const TMDB_LOGO = /^https:\/\/image\.tmdb\.org\/t\/p\/w300\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/;
const ITEM_ID = /^[A-Za-z0-9-]{1,64}$/;

export const STATE_LABELS: Record<HouseholdState, string> = {
  in_library: 'Ready to watch',
  get_this: 'Available to get',
  unavailable: "Can't request",
  requested: 'Requested',
};

/** The coarse status of a request in "My requests" (and of a title the household asked for that failed). */
export const REQUEST_LABELS: Record<CoarseStatus, string> = {
  requested: 'Requested',
  ready: 'Ready to watch',
  failed: "We couldn't get this",
};

/** "Get this" words. The confirmation is one fixed sentence: nothing about the answer changes it, or tells what followed. */
export const GET_THIS_TEXT = {
  button: 'Get this',
  sending: 'Sending…',
  chooseSeasons: 'Choose the seasons you want',
  chooseBelow: 'Choose the seasons you want below.',
  selectAll: 'Select all',
  clearAll: 'Clear all',
  confirmation: "Thanks — we'll get this for your household.",
  failedNote: 'Ask your JellyPass admin to try again.',
  rate_limited: 'Too many tries, try again in a few minutes.',
  offline: "You're offline. Check your connection, then try again.",
  unavailable: "We couldn't send that just now. Try again in a moment.",
} as const;

export const ERROR_TEXT: Record<ApiErrorKind, { title: string; body: string }> = {
  unauthorized: { title: 'Sign in to continue', body: 'Your Jellyfin sign-in is missing or has expired.' },
  rate_limited: { title: 'Too many requests', body: 'Wait a minute, then try again.' },
  unavailable: { title: "Can't load this right now", body: 'Something went wrong. Try again in a moment.' },
  not_found: { title: 'Not found', body: "We couldn't find that title." },
  offline: { title: "You're offline", body: 'Check your connection, then try again.' },
};

export const SIGNIN_ERROR_TEXT: Record<SignInErrorKind, string> = {
  invalid: "That didn't work. Check your password and try again.",
  rate_limited: 'Too many attempts. Wait a few minutes, then try again.',
  unavailable: "Can't sign in right now. Try again in a moment.",
  offline: 'Check your connection, then try again.',
  storage: "Can't keep your sign-in on this device. Allow site data for this page in your browser settings, then try again.",
};

/** The name form's own fixed text: its refusal cannot say whether the name or the password was wrong. */
export const SIGNIN_NAME_TEXT = {
  missing: 'Enter your name.',
  invalid: "That didn't work. Check your name and password and try again.",
} as const;

/**
 * Marks the one `<h1>` whose text the header also shows (main.ts copies it there): Search, My requests, Account and the
 * detail pages. On the first three the page's own heading is then visually hidden (still the screen's heading for
 * assistive technology and focus); on a detail page it stays as the title block.
 */
export const HEADER_TITLE = 'data-header-title';
/** The app's version, filled in by the build from package.json. */
export const APP_VERSION = '__APP_VERSION__';

export const TMDB_NOTICE = 'This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.';

interface ElementOptions {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  options: ElementOptions = {},
  children: Array<Node | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
  for (const child of children) if (child) node.append(child);
  return node;
}

/** An image URL the API returned, only if it is one of TMDB's allowlisted poster or backdrop URLs. */
export function safeImageUrl(url: unknown): string | undefined {
  return typeof url === 'string' && TMDB_IMAGE.test(url) ? url : undefined;
}

/** A logo URL the API returned, only if it is one of TMDB's allowlisted logo URLs. */
/**
 * How far a row must scroll to show a focused card fully. A card that fits the row's snapport (the list less its end
 * gutter) is centred, which is where its mandatory snap settles; a wider one is aligned to the snapport's start instead,
 * so its leading edge is never clipped (a centred oversized card would hang out of both sides).
 */
export function rowFocusShift(card: { left: number; right: number }, view: { left: number; width: number }, padEnd: number): number {
  const port = Math.max(0, view.width - (Number.isFinite(padEnd) ? padEnd : 0));
  if (card.right - card.left > port) return card.left - view.left;
  return (card.left + card.right) / 2 - (view.left + port / 2);
}

export function safeLogoUrl(url: unknown): string | undefined {
  return typeof url === 'string' && TMDB_LOGO.test(url) ? url : undefined;
}

/**
 * A Play link, only if it is exactly the household host's own Jellyfin details page for the item the API named. The
 * API builds it the same way; checking again here means a link can never point anywhere else.
 */
export function safePlayUrl(play: Card['play'], origin: string): string | undefined {
  if (!play || typeof play.itemId !== 'string' || !ITEM_ID.test(play.itemId)) return undefined;
  const expected = `${origin}/web/#/details?id=${play.itemId}`;
  return play.url === expected ? expected : undefined;
}

export function requestBadge(doc: Document, status: CoarseStatus): HTMLElement {
  const known = Object.hasOwn(REQUEST_LABELS, status);
  return el(doc, 'span', { class: `badge badge-request-${known ? status : 'failed'}`, text: known ? REQUEST_LABELS[status] : REQUEST_LABELS.failed });
}

function stateLabel(state: HouseholdState): string {
  return Object.hasOwn(STATE_LABELS, state) ? STATE_LABELS[state] : STATE_LABELS.unavailable;
}

/**
 * A card's status chip is a sibling of its link, so the link's name carries the status itself ("Title, 2024 · Movie, Ready
 * to watch") and the chip is hidden from assistive technology: said once, in the name.
 */
function cardStatusBadge(doc: Document, state: HouseholdState): HTMLElement {
  const badge = stateBadge(doc, state);
  badge.setAttribute('aria-hidden', 'true');
  return badge;
}

function cardName(card: Card, facts: string): string {
  return [card.title, facts, stateLabel(card.state)].filter(Boolean).join(', ');
}

export function stateBadge(doc: Document, state: HouseholdState): HTMLElement {
  const label = stateLabel(state);
  return el(doc, 'span', { class: `badge badge-${Object.hasOwn(STATE_LABELS, state) ? state : 'unavailable'}`, text: label });
}

/** The `<img>` for an allowlisted TMDB poster URL, or nothing. */
function posterImage(doc: Document, url: string | null | undefined, alt: string, loading: 'lazy' | 'eager'): HTMLElement | undefined {
  const src = safeImageUrl(url);
  return src ? el(doc, 'img', { attrs: { src, alt, width: '342', height: '513', loading, decoding: 'async' } }) : undefined;
}

function poster(doc: Document, url: string | null, alt: string, size: 'card' | 'detail' | 'thumb'): HTMLElement {
  const frame = el(doc, 'div', { class: `poster poster-${size}` });
  const image = posterImage(doc, url, alt, size === 'detail' ? 'eager' : 'lazy');
  // No image: the frame keeps its shape, so nothing shifts.
  if (image) frame.append(image);
  else frame.classList.add('poster-empty');
  return frame;
}

export function href(card: Pick<Card, 'mediaType' | 'tmdbId'>): string {
  return `#/${card.mediaType}/${card.tmdbId}`;
}

export function playButton(doc: Document, card: Pick<Card, 'play' | 'title'>, origin: string, className = 'button'): HTMLElement | undefined {
  const url = safePlayUrl(card.play, origin);
  if (!url) return undefined;
  return el(doc, 'a', { class: className, text: 'Play', attrs: { href: url, rel: 'noopener', 'aria-label': `Play ${card.title}` } });
}

/** How a row draws its titles: poster cards, or the large landscape backdrop cards. */
export type RowVariant = 'poster' | 'backdrop';

/** A poster card: poster with its status chip at the top-left, then the title and "year · Movie/Series". Play lives on the detail page. */
export function cardItem(doc: Document, card: Card): HTMLElement {
  const facts = [card.year ?? '', card.mediaType === 'tv' ? 'Series' : 'Movie'].filter(Boolean).join(' · ');
  const link = el(doc, 'a', { class: 'card-link', attrs: { href: href(card), 'aria-label': cardName(card, facts) } }, [
    poster(doc, card.posterUrl, '', 'card'),
    el(doc, 'span', { class: 'card-title', text: card.title }),
    el(doc, 'span', { class: 'card-meta', text: facts }),
  ]);
  return el(doc, 'li', { class: 'card' }, [link, cardStatusBadge(doc, card.state)]);
}

export function cardList(doc: Document, cards: readonly Card[], className: string, variant: RowVariant = 'poster'): HTMLElement {
  return el(doc, 'ul', { class: className }, cards.map((card) => (variant === 'backdrop' ? backdropCardItem(doc, card) : cardItem(doc, card))));
}

/** The same TMDB backdrop file at the two widths the app uses; a phone's browser picks one by its own width and density. */
const BACKDROP_URL = /^(https:\/\/image\.tmdb\.org\/t\/p\/)w(?:780|1280)(\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp))$/;

/** A backdrop `<img>` (never a CSS `url()`), only for an allowlisted TMDB URL. w780 is the fallback `src`, w1280 the sharper candidate. */
function backdropImage(
  doc: Document,
  url: string | null | undefined,
  className: string,
  loading: 'lazy' | 'eager',
  sizes = '100vw',
): HTMLElement | undefined {
  const src = safeImageUrl(url);
  if (!src) return undefined;
  const attrs: Record<string, string> = { src, alt: '', width: '780', height: '439', loading, decoding: 'async' };
  const parts = BACKDROP_URL.exec(src);
  if (parts) {
    const small = `${parts[1]}w780${parts[2]}`;
    const large = `${parts[1]}w1280${parts[2]}`;
    attrs['src'] = small;
    attrs['srcset'] = `${small} 780w, ${large} 1280w`;
    attrs['sizes'] = sizes;
  }
  return el(doc, 'img', { class: className, attrs });
}

export const HERO_TEXT = {
  label: 'Trending now',
  /** The carousel's name under Home's Movies and TV filters. */
  labels: { all: 'Trending now', movies: 'Trending movies', tv: 'Trending series' },
  previous: 'Previous title',
  next: 'Next title',
} as const;
/** The hero shows the first few titles of the first Home row, from the answer Home already has. */
export const HERO_MAX = 5;

/** The "★ 7.8" text of a TMDB rating, with the source named where there is room. */
function ratingText(rating: number): string {
  return `★ ${rating.toFixed(1)}`;
}

function ratingLabel(rating: number): string {
  return `TMDB rating ${rating.toFixed(1)} out of 10`;
}

/** What a backdrop card's `sizes` says: nearly a phone's width, or about a third of a wide screen's, as the stylesheet lays it out. */
const BACKDROP_CARD_SIZES = '(min-width: 48rem) 36vw, 92vw';

/** "2024 · ★ 7.8 TMDB": the year and the rating, whichever the title has. */
function backdropMeta(card: Card): string {
  return [card.year ? String(card.year) : '', typeof card.rating === 'number' ? `${ratingText(card.rating)} TMDB` : ''].filter(Boolean).join(' · ');
}

/**
 * A large landscape card: the title's backdrop (a poster when it has none, a plain gradient when it has neither) as a
 * rounded 16:9 image with the status chip at its top-left, and the title and "year · ★ rating" below it, on the page's
 * own colour: no text is ever drawn over a picture. The whole card is the link. Every image is lazy: these rows start
 * below the hero.
 */
export function backdropCardItem(doc: Document, card: Card): HTMLElement {
  const backdrop = backdropImage(doc, card.backdropUrl, 'backdrop-img', 'lazy', BACKDROP_CARD_SIZES);
  const image = backdrop ?? posterImage(doc, card.posterUrl, '', 'lazy');
  if (!backdrop && image) image.classList.add('backdrop-img');
  const meta = backdropMeta(card);
  const link = el(doc, 'a', { class: 'card-link backdrop-link', attrs: { href: href(card), 'aria-label': cardName(card, meta) } }, [
    el(doc, 'span', { class: 'backdrop-frame' }, [image]),
    el(doc, 'span', { class: 'backdrop-text' }, [
      el(doc, 'span', { class: 'card-title', text: card.title }),
      meta ? el(doc, 'span', { class: 'card-meta', text: meta }) : undefined,
    ]),
  ]);
  return el(doc, 'li', { class: 'card card-backdrop' }, [link, cardStatusBadge(doc, card.state)]);
}

/** The hero card's image: the whole card is 4:5 on a phone, so a phone asks for what fits its width less the page's gutters. */
const HERO_SIZES = '(min-width: 75rem) 1100px, calc(100vw - 2rem)';

function heroSlide(doc: Document, card: Card, index: number, total: number): HTMLElement {
  const media = el(doc, 'div', { class: 'hero-media' });
  const image = backdropImage(doc, card.backdropUrl, 'hero-img', index === 0 ? 'eager' : 'lazy', HERO_SIZES);
  if (image) media.append(image);
  const facts = el(doc, 'p', { class: 'hero-facts' });
  if (card.year) facts.append(el(doc, 'span', { class: 'hero-year', text: String(card.year) }));
  if (typeof card.rating === 'number') {
    facts.append(el(doc, 'span', { class: 'hero-rating', text: `${ratingText(card.rating)} TMDB`, attrs: { 'aria-label': ratingLabel(card.rating) } }));
  }
  facts.append(stateBadge(doc, card.state));
  return el(doc, 'div', {
    class: 'hero-slide',
    attrs: { role: 'group', 'aria-roledescription': 'slide', 'aria-label': `${index + 1} of ${total}` },
  }, [
    el(doc, 'div', { class: 'hero-card' }, [
      media,
      el(doc, 'div', { class: 'hero-panel' }, [
        el(doc, 'p', { class: 'hero-title' }, [el(doc, 'a', { class: 'hero-link', text: card.title, attrs: { href: href(card) } })]),
        facts,
        card.overview ? el(doc, 'p', { class: 'hero-overview', text: card.overview }) : undefined,
      ]),
    ]),
  ]);
}

/**
 * Home's hero: the first few trending titles, one inset rounded card per slide in a CSS scroll-snap track, each with its
 * text in a navy panel. It never moves by itself. Swiping works as it does in any scroller; the Previous and Next buttons
 * and the round bubbles under the card (each a labelled button) do the same for those who cannot swipe, and scroll
 * smoothly unless the member prefers reduced motion.
 */
export function heroCarousel(doc: Document, cards: readonly Card[], filter: HomeFilter = 'all'): HTMLElement | undefined {
  const shown = cards.slice(0, HERO_MAX);
  if (shown.length === 0) return undefined;
  const slides = shown.map((card, index) => heroSlide(doc, card, index, shown.length));
  const track = el(doc, 'div', { class: 'hero-track' }, slides);
  const section = el(doc, 'section', { class: 'hero', attrs: { 'aria-roledescription': 'carousel', 'aria-label': HERO_TEXT.labels[filter] } }, [track]);
  if (shown.length === 1) return section;

  const live = el(doc, 'span', { class: 'visually-hidden', attrs: { 'aria-live': 'polite' } });
  const dots = shown.map((card, index) => {
    const dot = el(doc, 'button', {
      class: 'hero-dot',
      attrs: { type: 'button', 'aria-label': `Show title ${index + 1} of ${shown.length}: ${card.title}` },
    });
    if (index === 0) dot.setAttribute('aria-current', 'true');
    dot.addEventListener('click', () => goTo(index));
    return dot;
  });
  const nav = (name: 'prev' | 'next', label: string, step: number) => {
    const button = el(doc, 'button', { class: `hero-nav hero-${name}`, attrs: { type: 'button', 'aria-label': label } }, [icon(doc, name)]);
    button.addEventListener('click', () => goTo((current + step + shown.length) % shown.length));
    return button;
  };
  let current = 0;
  const show = (index: number) => {
    if (index === current) return;
    current = index;
    dots.forEach((dot, at) => {
      if (at === index) dot.setAttribute('aria-current', 'true');
      else dot.removeAttribute('aria-current');
    });
    live.textContent = `Showing ${index + 1} of ${shown.length}: ${(shown[index] as Card).title}`;
  };
  const reduced = () => doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  function goTo(index: number): void {
    track.scrollTo?.({ left: index * track.clientWidth, behavior: reduced() ? 'auto' : 'smooth' });
    show(index);
  }
  // Swiping moves the track; the dot follows whichever slide is mostly in view.
  track.addEventListener('scroll', () => {
    const width = track.clientWidth;
    if (width > 0) show(Math.min(shown.length - 1, Math.max(0, Math.round(track.scrollLeft / width))));
  }, { passive: true });

  section.append(
    el(doc, 'div', { class: 'hero-controls' }, [nav('prev', HERO_TEXT.previous, -1), el(doc, 'div', { class: 'hero-dots' }, dots), nav('next', HERO_TEXT.next, 1)]),
    live,
  );
  return section;
}

/** The hero while Home loads: a card of the same shape. */
export function skeletonHero(doc: Document): HTMLElement {
  return el(doc, 'div', { class: 'hero hero-skeleton', attrs: { 'aria-hidden': 'true' } }, [
    el(doc, 'div', { class: 'skeleton hero-skeleton-card' }),
  ]);
}

/**
 * The colour of a row heading's short "waterline" underline: a service's brand colour (a tasteful approximation, never its
 * logo), or the app's own cyan with its small purple end-cap for everything else. Purely decorative: the heading's
 * words say what the row is, and the line is a pseudo-element, so assistive technology never meets it. Each is a class
 * (`water-<name>`) whose colour is a custom property in the stylesheet, so the page carries no inline style.
 */
export type RowAccent = 'default' | 'netflix' | 'disney' | 'apple' | 'prime' | 'hbo' | 'hulu' | 'paramount' | 'peacock';
export const ROW_ACCENTS: readonly RowAccent[] = ['default', 'netflix', 'disney', 'apple', 'prime', 'hbo', 'hulu', 'paramount', 'peacock'];
/** The accent of each allowlisted network's row, by its TMDB ID (see TMDB_NETWORKS in src/tmdb.ts). */
export const NETWORK_ACCENTS: Readonly<Record<number, RowAccent>> = {
  213: 'netflix', 2739: 'disney', 2552: 'apple', 1024: 'prime', 3186: 'hbo', 453: 'hulu', 4330: 'paramount', 3353: 'peacock',
};

function accentClass(accent: RowAccent | undefined): string {
  return accent && accent !== 'default' ? ` water-${accent}` : '';
}

/** Home's filter: everything, only films, or only series. */
export type HomeFilter = 'all' | 'movies' | 'tv';
export const HOME_FILTERS: readonly HomeFilter[] = ['all', 'movies', 'tv'];
export const HOME_TEXT = {
  label: 'Show',
  filters: { all: 'All', movies: 'Movies', tv: 'TV' },
  shown: { all: 'All shown.', movies: 'Movies shown.', tv: 'TV shown.' },
} as const;

/** The address of Home under a filter: All has none (`#/`), the others say so in the query (`?kind=movies`, `?kind=tv`). */
export function homeHref(filter: HomeFilter): string {
  return filter === 'all' ? '#/' : `#/?kind=${filter}`;
}

/**
 * Home's All | Movies | TV control: a radio group of real buttons (one choice, shown ticked and tinted), the chosen one `aria-checked`
 * and the only one in the tab order (arrow keys, Home and End move and choose; see main.ts). It is a row of outlined chips
 * that sticks under the header while Home scrolls.
 */
export function homeSwitch(doc: Document, selected: HomeFilter, panelId: string): HTMLElement {
  const buttons = HOME_FILTERS.map((filter) => el(doc, 'button', {
    class: 'segment',
    text: HOME_TEXT.filters[filter],
    attrs: {
      type: 'button',
      role: 'radio',
      id: `home-filter-${filter}`,
      'data-filter': filter,
      'aria-checked': String(filter === selected),
      'aria-controls': panelId,
      tabindex: filter === selected ? '0' : '-1',
    },
  }));
  // The tick is drawn on every chip and shown (by the stylesheet) only on the chosen one; it is hidden from assistive technology.
  for (const button of buttons) button.prepend(icon(doc, 'check'));
  return el(doc, 'div', { class: 'home-switch' }, [
    el(doc, 'div', { class: 'segmented segmented-home', attrs: { role: 'radiogroup', 'aria-label': HOME_TEXT.label } }, buttons),
  ]);
}

/** A discover row: a heading and a horizontally scrolling list, reachable and scrollable from the keyboard. */
export function titleRow(doc: Document, id: string, heading: string, page: Page, variant: RowVariant = 'poster', accent?: RowAccent): HTMLElement {
  const list = cardList(doc, page.results, variant === 'backdrop' ? 'row-list row-list-backdrop' : 'row-list', variant);
  list.setAttribute('tabindex', '0');
  list.setAttribute('aria-labelledby', `${id}-heading`);
  const section = el(doc, 'section', { class: 'row' }, [el(doc, 'h2', { class: `row-heading${accentClass(accent)}`, text: heading, attrs: { id: `${id}-heading` } })]);
  section.append(page.results.length ? list : el(doc, 'p', { class: 'muted', text: 'Nothing to show here right now.' }));
  return section;
}

/** The words of the network and studio rows and pages. */
export const SOURCE_TEXT = {
  studios: 'Studios',
  /** A network row's lead-in words by what the row lists: Home's All, or its Movies and TV filters. */
  networkPrefix: { all: 'Popular on', films: 'Films on', series: 'Series on' },
  heading: (kind: SourceKind, name: string, list: SourceList = 'all') => {
    if (kind === 'studio') return `${name} movies`;
    return `${list === 'films' ? 'Films on' : list === 'series' ? 'Series on' : 'Popular on'} ${name}`;
  },
  /** A network page's three lists, as its segmented control names them. */
  lists: { all: 'All', series: 'Series', films: 'Films' },
  listsLabel: 'Show',
  /** JustWatch's credit, wherever a service's films (TMDB's where-to-watch data, from JustWatch) are shown. */
  justWatch: 'Where to watch: US streaming availability from JustWatch, via TMDB.',
} as const;

/**
 * A network's lists: its popular series and the films its streaming service has in the US, mixed (`all`, Home's row and
 * the page's first tab), or either alone.
 */
export type SourceList = 'all' | 'series' | 'films';
export const SOURCE_LISTS: readonly SourceList[] = ['all', 'series', 'films'];

/** A network's or studio's page; a network's Series or Films tab says so in the address (`?kind=`), All does not. */
export function sourceHref(kind: SourceKind, source: Pick<Source, 'id'>, list: SourceList = 'all'): string {
  return `#/${kind}/${source.id}${kind === 'network' && list !== 'all' ? `?kind=${list}` : ''}`;
}

/** JustWatch's credit for where-to-watch data, as one line of muted text. */
export function justWatchNote(doc: Document): HTMLElement {
  return el(doc, 'p', { class: 'muted source-note', text: SOURCE_TEXT.justWatch });
}

/**
 * A network's or studio's logo on its light tile (TMDB's logos are drawn for a light background), or its name as text
 * when the API sent no allowlisted logo. `alt` is the name, or empty where the name is already said next to it.
 */
export function sourceLogo(doc: Document, source: Source, alt: string, loading: 'lazy' | 'eager' = 'lazy'): HTMLElement {
  const src = safeLogoUrl(source.logoUrl);
  const tile = el(doc, 'span', { class: 'logo-tile' });
  if (src) tile.append(el(doc, 'img', { class: 'logo-img', attrs: { src, alt, width: '300', height: '100', loading, decoding: 'async' } }));
  else tile.append(el(doc, 'span', { class: 'logo-text', text: source.name, ...(alt ? {} : { attrs: { 'aria-hidden': 'true' } }) }));
  return tile;
}

/**
 * A network's row: the heading is a link to the network's own page and reads "Popular on <name>", the name given by the
 * logo's text alternative; then the same scrolling list as any discover row (a network's: its series and films mixed,
 * each card saying which it is).
 */
export function sourceRow(
  doc: Document,
  id: string,
  kind: SourceKind,
  source: Source,
  page: Page,
  list: SourceList = 'all',
  accent?: RowAccent,
): HTMLElement {
  const link = el(doc, 'a', { class: 'row-heading-link', attrs: { href: sourceHref(kind, source, list) } }, [
    kind === 'network' ? el(doc, 'span', { text: SOURCE_TEXT.networkPrefix[list] }) : undefined,
    sourceLogo(doc, source, source.name),
    kind === 'studio' ? el(doc, 'span', { text: 'movies' }) : undefined,
    icon(doc, 'next'),
  ]);
  const section = titleRow(doc, id, '', page, 'poster', accent);
  const heading = section.querySelector('h2') as HTMLElement;
  heading.classList.add('row-heading-source');
  heading.replaceChildren(link);
  return section;
}

/** The studios as a strip of logo links, each to the studio's own page. No title is fetched for it. */
export function studioStrip(doc: Document, id: string, studios: readonly Source[]): HTMLElement {
  const items = studios.map((studio) =>
    el(doc, 'li', { class: 'logo-card' }, [
      el(doc, 'a', { class: 'logo-link', attrs: { href: sourceHref('studio', studio), 'aria-label': SOURCE_TEXT.heading('studio', studio.name) } }, [
        sourceLogo(doc, studio, ''),
      ]),
    ]));
  const list = el(doc, 'ul', { class: 'logo-list', attrs: { tabindex: '0', 'aria-labelledby': `${id}-heading` } }, items);
  return el(doc, 'section', { class: 'row' }, [el(doc, 'h2', { class: 'row-heading', text: SOURCE_TEXT.studios, attrs: { id: `${id}-heading` } }), list]);
}

/**
 * A network's or studio's page heading: its logo (decorative: the heading says the name) and "Popular on <name>"
 * ("Series on" or "Films on" on a network's Series or Films tab), or "<studio> movies".
 */
export function sourceHeading(doc: Document, kind: SourceKind, source: Source, list: SourceList = 'all'): HTMLElement {
  return el(doc, 'div', { class: 'source-head' }, [
    sourceLogo(doc, source, '', 'eager'),
    el(doc, 'h1', { class: 'screen-title', text: SOURCE_TEXT.heading(kind, source.name, list), attrs: { tabindex: '-1' } }),
  ]);
}

/**
 * A network page's All | Series | Films control: an ARIA tab list of real buttons, the selected one `aria-selected` and
 * the only one in the tab order (arrow keys, Home and End move between them; see main.ts). Each controls `panelId`.
 */
export function sourceTabs(doc: Document, id: string, panelId: string, selected: SourceList): HTMLElement {
  const tabs = SOURCE_LISTS.map((list) => el(doc, 'button', {
    class: 'segment',
    text: SOURCE_TEXT.lists[list],
    attrs: {
      type: 'button',
      role: 'tab',
      id: `${id}-${list}`,
      'data-list': list,
      'aria-selected': String(list === selected),
      'aria-controls': panelId,
      tabindex: list === selected ? '0' : '-1',
    },
  }));
  return el(doc, 'div', { class: 'segmented', attrs: { role: 'tablist', 'aria-label': SOURCE_TEXT.listsLabel } }, tabs);
}

export function skeletonRow(doc: Document, variant: RowVariant = 'poster'): HTMLElement {
  const backdrop = variant === 'backdrop';
  const cards = Array.from({ length: backdrop ? 3 : 6 }, () =>
    backdrop
      ? el(doc, 'li', { class: 'card card-backdrop skeleton-card' }, [el(doc, 'div', { class: 'backdrop-frame skeleton' }), el(doc, 'span', { class: 'skeleton skeleton-line' })])
      : el(doc, 'li', { class: 'card skeleton-card' }, [el(doc, 'div', { class: 'poster poster-card skeleton' }), el(doc, 'span', { class: 'skeleton skeleton-line' })]),
  );
  return el(doc, 'section', { class: 'row', attrs: { 'aria-hidden': 'true' } }, [
    el(doc, 'div', { class: 'skeleton skeleton-heading' }),
    el(doc, 'ul', { class: backdrop ? 'row-list row-list-backdrop' : 'row-list' }, cards),
  ]);
}

/** The search results' shape: three columns of posters. */
export function skeletonGrid(doc: Document): HTMLElement {
  const cards = Array.from({ length: 6 }, () =>
    el(doc, 'li', { class: 'card skeleton-card' }, [el(doc, 'div', { class: 'poster poster-card skeleton' }), el(doc, 'span', { class: 'skeleton skeleton-line' })]),
  );
  return el(doc, 'ul', { class: 'skeleton-grid', attrs: { 'aria-hidden': 'true' } }, cards);
}

/** "My requests" while it loads: a thumbnail and two lines per entry. */
export function skeletonRequests(doc: Document): HTMLElement {
  const items = Array.from({ length: 4 }, () =>
    el(doc, 'li', { class: 'skeleton-request' }, [
      el(doc, 'div', { class: 'skeleton skeleton-thumb' }),
      el(doc, 'div', { class: 'skeleton-lines' }, [el(doc, 'span', { class: 'skeleton skeleton-line' }), el(doc, 'span', { class: 'skeleton skeleton-line' })]),
    ]),
  );
  return el(doc, 'ul', { class: 'request-list', attrs: { 'aria-hidden': 'true' } }, items);
}

/** A detail page while it loads: the backdrop card, then the title, chips, the one action and the overview. */
export function skeletonDetail(doc: Document): HTMLElement {
  return el(doc, 'div', { class: 'detail detail-skeleton', attrs: { 'aria-hidden': 'true' } }, [
    el(doc, 'div', { class: 'detail-hero skeleton' }),
    el(doc, 'div', { class: 'detail-main' }, [
      el(doc, 'div', { class: 'skeleton skeleton-title' }),
      el(doc, 'div', { class: 'skeleton skeleton-line skeleton-chips' }),
      el(doc, 'div', { class: 'skeleton skeleton-action' }),
      el(doc, 'div', { class: 'skeleton skeleton-block' }),
    ]),
  ]);
}

export function runtimeText(minutes: number | null): string {
  if (!minutes || minutes < 1) return '';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} h${rest ? ` ${rest} min` : ''}` : `${rest} min`;
}

/** The detail page's chip row: year, runtime (a movie) or "N seasons" (a series), and the TMDB rating. */
function detailChips(doc: Document, title: Movie | Series): HTMLElement | undefined {
  const chips: HTMLElement[] = [];
  if (title.year) chips.push(el(doc, 'li', { class: 'chip', text: String(title.year) }));
  const seasons = title.mediaType === 'tv' ? title.seasons.filter((season) => season.seasonNumber >= 1).length : 0;
  const length = seasons > 0 ? `${seasons} ${seasons === 1 ? 'season' : 'seasons'}` : runtimeText(title.runtime);
  if (length) chips.push(el(doc, 'li', { class: 'chip', text: length }));
  if (typeof title.rating === 'number') {
    chips.push(el(doc, 'li', { class: 'chip chip-rating', text: `${ratingText(title.rating)} TMDB`, attrs: { 'aria-label': ratingLabel(title.rating) } }));
  }
  return chips.length ? el(doc, 'ul', { class: 'chips', attrs: { 'aria-label': 'Details' } }, chips) : undefined;
}

/** What a title in the household's state says besides its pill; a state with a button needs none. */
export const STATE_NOTES = {
  unavailable: "This title can't be requested.",
  requested: 'Check My requests to follow it.',
} as const;

export function stateNote(doc: Document, state: HouseholdState): HTMLElement | undefined {
  if (state === 'unavailable' || state === 'requested') return el(doc, 'p', { class: 'muted', text: STATE_NOTES[state] });
  return undefined;
}

/**
 * `accepted` once the call was accepted and the screen redrawn; `refresh_failed` when it was accepted but the screen
 * could not be read again. `onAccepted` runs the moment the call is accepted, before the screen is read again.
 */
export type GetThisHandler = (seasons: number[], onAccepted: () => void) => Promise<'accepted' | 'refresh_failed' | ApiErrorKind>;

/** What a "Get this" control needs from the screen that shows it. */
export interface GetThisExtras {
  /** Asks for the given seasons (empty for a movie). Never rejects: it resolves to `accepted` or the kind of failure. */
  onGet?: GetThisHandler;
  /** The confirmation to show at once, after a screen was redrawn for a title that was just asked for. */
  confirmed?: boolean;
  /** Seasons (0 for a movie) just asked for on this screen: not offered again until the screen is left. */
  asked?: ReadonlySet<number>;
  /** Offer the seasons as a picker (a series page); a season page asks for its own season only. */
  pick?: boolean;
  /** Seasons (0 for a movie) of a title still not held that the household asked for and could not get. */
  failed?: ReadonlySet<number>;
  /** Loads the screen again (for the retry shown when an accepted call's screen could not be read again). */
  onReload?: () => void;
}

/** A season page also draws its series' backdrop, when the series could be read. */
export interface DetailExtras extends GetThisExtras {
  backdropUrl?: string | null | undefined;
}

interface Choice {
  season: number;
  label: string;
}

/** The pieces of a "Get this" control: the action goes under the title; a series puts the checkboxes in its season cards. */
export interface GetThisParts {
  /** The one full-width button, its hint, and the status line that says what happened. */
  action: HTMLElement;
  /** The season checkboxes by season number (a series page only), real checkboxes the screen places in its season cards. */
  boxes: Map<number, HTMLInputElement>;
  /** Checks or clears every season's box and nothing else: it asks for nothing. Only when there is more than one to pick. */
  selectAll?: HTMLButtonElement;
}

/**
 * The "Get this" button, with checkboxes for the seasons of a series. While a call is in flight the button is disabled;
 * the answer is the same fixed confirmation whatever followed, and each failure has its own fixed words.
 */
export function getThisParts(doc: Document, subject: string, choices: Choice[], extras: GetThisExtras): GetThisParts | undefined {
  const message = el(doc, 'p', { class: 'get-message', attrs: { role: 'status', tabindex: '-1' } });
  if (extras.confirmed) message.textContent = GET_THIS_TEXT.confirmation;
  const box = el(doc, 'div', { class: 'get-this' });
  const boxes = new Map<number, HTMLInputElement>();
  const onGet = extras.onGet;
  if (!onGet || choices.length === 0) return extras.confirmed ? { action: el(doc, 'div', { class: 'get-this' }, [message]), boxes } : undefined;
  const picking = extras.pick === true;
  if (picking) {
    for (const choice of choices) {
      boxes.set(choice.season, el(doc, 'input', { attrs: { type: 'checkbox', value: String(choice.season) } }));
    }
  }
  const inputs = [...boxes.values()];
  const button = el(doc, 'button', {
    class: 'button button-primary',
    text: GET_THIS_TEXT.button,
    attrs: { type: 'button', 'aria-label': `${GET_THIS_TEXT.button}: ${subject}` },
  });
  const hint = el(doc, 'p', { class: 'muted get-hint', text: GET_THIS_TEXT.chooseBelow, attrs: picking ? {} : { hidden: '' } });
  const only = choices.filter((choice) => choice.season > 0).map((choice) => choice.season);
  const chosen = (): number[] => (picking ? inputs.filter((input) => input.checked).map((input) => Number(input.value)) : only);
  const selectAll = picking && inputs.length > 1
    ? el(doc, 'button', { class: 'button button-small button-secondary select-all', text: GET_THIS_TEXT.selectAll, attrs: { type: 'button' } })
    : undefined;
  const update = () => {
    button.disabled = picking && chosen().length === 0;
    hint.hidden = !picking || chosen().length > 0;
    if (selectAll) selectAll.textContent = inputs.every((input) => input.checked) ? GET_THIS_TEXT.clearAll : GET_THIS_TEXT.selectAll;
  };
  update();
  for (const input of inputs) input.addEventListener('change', update);
  // Select all only moves the checkmarks; "Get this" is still the one thing that asks, and it asks exactly as before.
  selectAll?.addEventListener('click', () => {
    const next = !inputs.every((input) => input.checked);
    for (const input of inputs) if (!input.disabled) input.checked = next;
    update();
  });
  button.addEventListener('click', () => {
    if (button.disabled) return;
    const seasons = chosen();
    button.disabled = true;
    for (const input of inputs) input.disabled = true;
    if (selectAll) selectAll.disabled = true;
    button.textContent = GET_THIS_TEXT.sending;
    button.setAttribute('aria-busy', 'true');
    message.className = 'get-message';
    message.textContent = '';
    let accepted = false;
    void onGet(seasons, () => {
      // The call was accepted: the confirmation is shown at once, whatever the screen read afterwards does. Nothing
      // here can send again.
      accepted = true;
      message.className = 'get-message';
      message.textContent = GET_THIS_TEXT.confirmation;
      button.remove();
      hint.remove();
      selectAll?.remove();
      for (const input of inputs) input.remove();
      message.focus({ preventScroll: true });
    }).then((outcome) => {
      // Accepted: the screen is redrawn with the confirmation. Unauthorized: the screen is replaced by the sign-in state.
      if (outcome === 'unauthorized') return;
      if (outcome === 'refresh_failed') {
        box.append(el(doc, 'p', { class: 'muted get-refresh', text: ERROR_TEXT.unavailable.body }));
        if (extras.onReload) {
          const retry = el(doc, 'button', { class: 'button', text: 'Try again', attrs: { type: 'button' } });
          retry.addEventListener('click', extras.onReload);
          box.append(retry);
        }
        return;
      }
      if (outcome === 'accepted' || accepted) return;
      message.className = 'get-message get-error';
      message.textContent = outcome === 'rate_limited' ? GET_THIS_TEXT.rate_limited : outcome === 'offline' ? GET_THIS_TEXT.offline : GET_THIS_TEXT.unavailable;
      button.textContent = GET_THIS_TEXT.button;
      button.removeAttribute('aria-busy');
      for (const input of inputs) input.disabled = false;
      if (selectAll) selectAll.disabled = false;
      update();
    });
  });
  box.append(button);
  if (picking) box.append(hint);
  box.append(message);
  return { action: box, boxes, ...(selectAll ? { selectAll } : {}) };
}

/** The title's backdrop as an inset rounded card (nothing drawn over it); a plain navy gradient when a title has none. */
function detailHero(doc: Document, backdropUrl: string | null | undefined): HTMLElement {
  const frame = el(doc, 'div', { class: 'detail-hero' });
  const image = backdropImage(doc, backdropUrl, 'hero-img', 'eager', DETAIL_SIZES);
  if (image) frame.append(image);
  return frame;
}
const DETAIL_SIZES = '(min-width: 64rem) 960px, calc(100vw - 2rem)';

/** The status pill, its note, and the one action: Play (in the library) or Get this (available to get), never both as primaries. */
function detailAction(doc: Document, play: HTMLElement | undefined, parts: GetThisParts | undefined): HTMLElement | undefined {
  // A series partly held can still ask for the rest: then Play is the primary and Get this steps back to the outlined style.
  if (play && parts) parts.action.querySelector('button')?.classList.replace('button-primary', 'button-secondary');
  return play || parts ? el(doc, 'div', { class: 'detail-action' }, [play, parts?.action]) : undefined;
}

/** A movie or series page. A series also lists its seasons, each with the household's state for it. */
export function titleDetail(doc: Document, title: Movie | Series, origin: string, extras: GetThisExtras = {}): HTMLElement {
  const own = extras.asked?.has(0) || extras.failed?.has(0) ? undefined : title.state === 'get_this' && title.mediaType === 'movie' ? [{ season: 0, label: '' }] : undefined;
  const failedSeason = (season: SeasonSummary) => season.state === 'get_this' && extras.failed?.has(season.seasonNumber) === true;
  const seasonChoices = title.mediaType === 'tv'
    ? title.seasons.filter((season) => season.state === 'get_this' && season.seasonNumber >= 1 && !extras.asked?.has(season.seasonNumber) && !failedSeason(season))
      .map((season) => ({ season: season.seasonNumber, label: season.name || `Season ${season.seasonNumber}` }))
    : [];
  const parts = getThisParts(doc, title.title, own ?? seasonChoices, { ...extras, pick: title.mediaType === 'tv' });
  const failedMovie = title.state === 'get_this' && title.mediaType === 'movie' && extras.failed?.has(0) === true;
  const failedAny = failedMovie || (title.mediaType === 'tv' && title.seasons.some(failedSeason));
  const play = title.state === 'in_library' ? playButton(doc, title, origin, 'button button-primary') : undefined;
  const genres = title.genres.length
    ? el(doc, 'ul', { class: 'genres', attrs: { 'aria-label': 'Genres' } }, title.genres.map((genre) => el(doc, 'li', { text: genre })))
    : undefined;
  const head = el(doc, 'div', { class: 'detail-head detail-head-poster' }, [
    poster(doc, title.posterUrl, `Poster for ${title.title}`, 'detail'),
    el(doc, 'div', { class: 'detail-text' }, [
      el(doc, 'h1', { class: 'screen-title detail-title', text: title.title, attrs: { tabindex: '-1', [HEADER_TITLE]: '' } }),
      detailChips(doc, title),
      genres,
      el(doc, 'div', { class: 'actions' }, [failedMovie ? requestBadge(doc, 'failed') : stateBadge(doc, title.state)]),
      stateNote(doc, title.state),
      failedAny ? failedNote(doc) : undefined,
      detailAction(doc, play, parts),
    ]),
  ]);
  const main = el(doc, 'div', { class: 'detail-main' }, [
    head,
    title.overview ? el(doc, 'p', { class: 'overview', text: title.overview }) : undefined,
  ]);
  if (title.mediaType === 'tv') main.append(seasonList(doc, title, extras.failed, parts));
  return el(doc, 'article', { class: 'detail' }, [detailHero(doc, title.backdropUrl), main]);
}

/** A title the household asked for that failed is not asked for again from here: the backend holds the failed record. */
function failedNote(doc: Document): HTMLElement {
  return el(doc, 'p', { class: 'muted failed-note', text: GET_THIS_TEXT.failedNote });
}

/**
 * The seasons as cards: name, episode count and the state's pill, a link to the season, and, for a season the
 * household can ask for, a round selection control that is still a real checkbox. Those checkboxes and their legend
 * share one fieldset, so the group is announced as one.
 */
export function seasonList(doc: Document, series: Series, failed?: ReadonlySet<number>, parts?: GetThisParts): HTMLElement {
  const items = series.seasons.map((season: SeasonSummary) => {
    const count = season.episodeCount === null ? '' : `${season.episodeCount} ${season.episodeCount === 1 ? 'episode' : 'episodes'}`;
    const name = season.name || `Season ${season.seasonNumber}`;
    const input = parts?.boxes.get(season.seasonNumber);
    return el(doc, 'li', { class: `season${input ? ' season-pick' : ''}` }, [
      el(doc, 'a', { class: 'season-link', attrs: { href: `#/tv/${series.tmdbId}/season/${season.seasonNumber}` } }, [
        el(doc, 'span', { class: 'season-name', text: name }),
        el(doc, 'span', { class: 'card-meta', text: count }),
      ]),
      season.state === 'get_this' && failed?.has(season.seasonNumber) ? requestBadge(doc, 'failed') : stateBadge(doc, season.state),
      input ? el(doc, 'label', { class: 'choice' }, [input, el(doc, 'span', { class: 'visually-hidden', text: name })]) : undefined,
    ]);
  });
  const list = items.length ? el(doc, 'ul', { class: 'season-list' }, items) : el(doc, 'p', { class: 'muted', text: 'No seasons listed.' });
  const picking = parts !== undefined && parts.boxes.size > 0;
  return el(doc, 'section', { class: 'seasons' }, [
    el(doc, 'h2', { class: 'row-heading', text: 'Seasons' }),
    picking
      ? el(doc, 'fieldset', { class: 'get-seasons' }, [el(doc, 'legend', { text: GET_THIS_TEXT.chooseSeasons }), parts?.selectAll, list])
      : list,
  ]);
}

export function seasonView(doc: Document, season: Season, seriesTitle: string | undefined, extras: DetailExtras = {}): HTMLElement {
  const back = el(doc, 'a', { class: 'back', text: seriesTitle ? `← ${seriesTitle}` : '← Series', attrs: { href: `#/tv/${season.tmdbId}` } });
  const name = season.name || `Season ${season.seasonNumber}`;
  const episodes = season.episodes.map((episode) =>
    el(doc, 'li', { class: 'episode' }, [
      el(doc, 'h3', { class: 'episode-title', text: `${episode.episodeNumber}. ${episode.name || `Episode ${episode.episodeNumber}`}` }),
      episode.overview ? el(doc, 'p', { class: 'muted', text: episode.overview }) : undefined,
    ]),
  );
  const failedHere = season.state === 'get_this' && extras.failed?.has(season.seasonNumber) === true;
  const parts = getThisParts(
    doc,
    [seriesTitle, name].filter(Boolean).join(' '),
    season.state === 'get_this' && season.seasonNumber >= 1 && !extras.asked?.has(season.seasonNumber) && !extras.failed?.has(season.seasonNumber)
      ? [{ season: season.seasonNumber, label: name }] : [],
    extras,
  );
  const count = season.episodes.length;
  const text = el(doc, 'div', { class: 'detail-text' }, [
    back,
    el(doc, 'h1', { class: 'screen-title detail-title', text: name, attrs: { tabindex: '-1', [HEADER_TITLE]: '' } }),
    count ? el(doc, 'ul', { class: 'chips', attrs: { 'aria-label': 'Details' } }, [el(doc, 'li', { class: 'chip', text: `${count} ${count === 1 ? 'episode' : 'episodes'}` })]) : undefined,
    el(doc, 'div', { class: 'actions' }, [failedHere ? requestBadge(doc, 'failed') : stateBadge(doc, season.state)]),
    stateNote(doc, season.state),
    failedHere ? failedNote(doc) : undefined,
    detailAction(doc, undefined, parts),
  ]);
  return el(doc, 'article', { class: 'detail season-view' }, [
    detailHero(doc, extras.backdropUrl),
    el(doc, 'div', { class: 'detail-main' }, [
      el(doc, 'div', { class: 'detail-head' }, [text]),
      season.overview ? el(doc, 'p', { class: 'overview', text: season.overview }) : undefined,
      episodes.length ? el(doc, 'ol', { class: 'episode-list' }, episodes) : el(doc, 'p', { class: 'muted', text: 'No episodes listed.' }),
    ]),
  ]);
}


export const REQUESTS_TEXT = {
  title: 'My requests',
  empty: 'Nothing requested yet. Press Get this on a title to ask for it.',
  loading: 'Loading title…',
  titleMissing: 'Title unavailable',
  byYou: 'Asked for by you',
  byOther: 'Asked for by someone in your household',
} as const;

/**
 * A series request's seasons as text, in order, a run of three or more as a range: "Season 1", "Seasons 1, 3",
 * "Seasons 1–3, 5".
 */
export function requestSeasonsText(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((left, right) => left - right);
  if (sorted.length === 1) return `Season ${sorted[0]}`;
  const parts: string[] = [];
  for (let start = 0; start < sorted.length; ) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] as number) + 1) end += 1;
    if (end - start >= 2) parts.push(`${sorted[start]}–${sorted[end]}`);
    else parts.push(...sorted.slice(start, end + 1).map(String));
    start = end + 1;
  }
  return `Seasons ${parts.join(', ')}`;
}

/**
 * Where a request shows its status, so it is shown once: one pill for the entry (a movie, a series of one season, or
 * seasons that all share one status, listed as text on the meta line), or else one pill per season and none for the
 * entry. When the seasons share a status, that status is the pill, even if the request's own overall status differs.
 */
export function requestPills(entry: Pick<RequestEntry, 'status' | 'seasons'>): { status: CoarseStatus | undefined; seasonsText: string; perSeason: boolean } {
  const shared = new Set(entry.seasons.map((season) => season.status));
  if (entry.seasons.length === 0) return { status: entry.status, seasonsText: '', perSeason: false };
  if (shared.size === 1) return { status: entry.seasons[0]?.status, seasonsText: requestSeasonsText(entry.seasons.map((season) => season.seasonNumber)), perSeason: false };
  return { status: undefined, seasonsText: '', perSeason: true };
}

/** My requests' filters: status, kind and "Asked by me". They only choose which of the list's entries are shown. */
export type RequestStatusFilter = 'all' | CoarseStatus;
export type RequestKindFilter = 'all' | 'movie' | 'tv';
export interface RequestFilter {
  status: RequestStatusFilter;
  kind: RequestKindFilter;
  byYou: boolean;
}
export const REQUEST_STATUS_FILTERS: readonly RequestStatusFilter[] = ['all', 'requested', 'ready', 'failed'];
export const REQUEST_KIND_FILTERS: readonly RequestKindFilter[] = ['all', 'movie', 'tv'];
export const NO_REQUEST_FILTER: Readonly<RequestFilter> = { status: 'all', kind: 'all', byYou: false };

export const REQUEST_FILTER_TEXT = {
  statusLabel: 'Status',
  kindLabel: 'Type',
  whoLabel: 'Who',
  status: { all: 'All', requested: 'Requested', ready: 'Ready to watch', failed: "Couldn't get this" },
  kind: { all: 'All', movie: 'Films', tv: 'Series' },
  byYou: 'Asked by me',
  showAll: 'Show all requests',
  more: 'More may match — Load more to look further.',
} as const;

export function requestFilterActive(filter: RequestFilter): boolean {
  return filter.status !== 'all' || filter.kind !== 'all' || filter.byYou;
}

/**
 * The statuses an entry shows (see {@link requestPills}): its one pill, or each season's pill when the seasons differ,
 * plus the entry's own "failed" when the admin note is under the entry rather than under a season. A series matches a
 * status filter if any status it shows is that status, so a series with Season 1 ready and Season 2 requested is in
 * both Ready to watch and Requested.
 */
export function requestStatuses(entry: Pick<RequestEntry, 'status' | 'seasons'>): CoarseStatus[] {
  const pills = requestPills(entry);
  if (pills.status) return [pills.status];
  const seen = new Set<CoarseStatus>(entry.seasons.map((season) => season.status));
  if (entry.status === 'failed') seen.add('failed');
  return [...seen];
}

/** Whether an entry passes every part of the filter; no part reads anything but the entry (no calls). */
export function matchesRequestFilter(entry: Pick<RequestEntry, 'status' | 'seasons' | 'mediaType' | 'byYou'>, filter: RequestFilter): boolean {
  if (filter.kind !== 'all' && entry.mediaType !== filter.kind) return false;
  if (filter.byYou && !entry.byYou) return false;
  return filter.status === 'all' || requestStatuses(entry).includes(filter.status);
}

/** What My requests says when a filter leaves nothing, for that combination; `more` when unnamed requests are still to load. */
export function requestFilterEmptyText(filter: RequestFilter, more = false): string {
  const noun = filter.kind === 'movie' ? 'films' : filter.kind === 'tv' ? 'series' : 'requests';
  const status = filter.status === 'requested' ? ' still requested' : filter.status === 'ready' ? ' ready to watch' : filter.status === 'failed' ? " we couldn't get" : '';
  const who = filter.byYou ? `${status ? ',' : ''} asked for by you` : '';
  return [`No ${noun}${status}${who}.`, more ? REQUEST_FILTER_TEXT.more : ''].filter(Boolean).join(' ');
}

/**
 * My requests' filters: two groups of toggle buttons (Status, Type) and an "Asked by me" toggle, in the Home chips' look
 * (the chosen chip is tinted, outlined and ticked). Each group is named; the chosen chip is `aria-pressed`.
 */
export function requestFilterBar(doc: Document, filter: RequestFilter): HTMLElement {
  const chip = (group: string, value: string, label: string, pressed: boolean): HTMLElement => {
    const button = el(doc, 'button', { class: 'segment', text: label, attrs: { type: 'button', 'data-filter-group': group, 'data-filter': value, 'aria-pressed': String(pressed) } });
    button.prepend(icon(doc, 'check'));
    return button;
  };
  const group = (name: string, label: string, chips: HTMLElement[]) =>
    el(doc, 'div', { class: 'segmented segmented-requests', attrs: { role: 'group', 'aria-label': label, 'data-filter-group': name } }, chips);
  return el(doc, 'div', { class: 'request-filters' }, [
    group('status', REQUEST_FILTER_TEXT.statusLabel, REQUEST_STATUS_FILTERS.map((value) => chip('status', value, REQUEST_FILTER_TEXT.status[value], filter.status === value))),
    group('kind', REQUEST_FILTER_TEXT.kindLabel, REQUEST_KIND_FILTERS.map((value) => chip('kind', value, REQUEST_FILTER_TEXT.kind[value], filter.kind === value))),
    group('who', REQUEST_FILTER_TEXT.whoLabel, [chip('byYou', 'byYou', REQUEST_FILTER_TEXT.byYou, filter.byYou)]),
  ]);
}

/**
 * One of the household's requests. The title text is filled in afterwards (the list carries only a TMDB ID), with
 * {@link setRequestTitle}; until then, and if it cannot be loaded, the entry still shows its status. A status is shown
 * once (see {@link requestPills}), with the admin note under it where it did not work out.
 */
export function requestItem(doc: Document, entry: RequestEntry): HTMLElement {
  const pills = requestPills(entry);
  const seasons = pills.perSeason
    ? entry.seasons.map((season) =>
        el(doc, 'li', { class: 'request-season' }, [
          el(doc, 'span', { text: `Season ${season.seasonNumber}` }),
          requestBadge(doc, season.status),
          season.status === 'failed' ? failedNote(doc) : undefined,
        ]),
      )
    : [];
  // The note sits under the entry's pill, or under each failed season's; a failed entry with no failed season among
  // differing ones (never sent) still says so once.
  const noteHere = pills.status ? pills.status === 'failed' : entry.status === 'failed' && !entry.seasons.some((season) => season.status === 'failed');
  const kind = [entry.mediaType === 'tv' ? 'Series' : 'Movie', pills.seasonsText].filter(Boolean).join(' · ');
  const thumb = poster(doc, null, '', 'thumb');
  thumb.classList.add('request-thumb');
  return el(doc, 'li', { class: 'request' }, [
    thumb,
    el(doc, 'a', { class: 'request-link', attrs: { href: href(entry) } }, [
      el(doc, 'span', { class: 'card-title', text: REQUESTS_TEXT.loading }),
      el(doc, 'span', { class: 'card-meta', text: kind, attrs: { 'data-kind': kind } }),
    ]),
    pills.status ? requestBadge(doc, pills.status) : undefined,
    el(doc, 'p', { class: 'muted request-who', text: entry.byYou ? REQUESTS_TEXT.byYou : REQUESTS_TEXT.byOther }),
    seasons.length ? el(doc, 'ul', { class: 'request-seasons', attrs: { 'aria-label': 'Seasons' } }, seasons) : undefined,
    noteHere ? failedNote(doc) : undefined,
  ]);
}

export function setRequestTitle(
  item: HTMLElement,
  title: { title: string; year: number | null; mediaType: 'movie' | 'tv'; posterUrl?: string | null } | undefined,
): void {
  const name = item.querySelector('.card-title');
  const meta = item.querySelector('.card-meta');
  if (!name || !meta) return;
  name.textContent = title?.title || REQUESTS_TEXT.titleMissing;
  // "2024 · Movie", or "2027 · Series · Season 1" with the seasons the entry put there.
  if (title) meta.textContent = [title.year ?? '', meta.getAttribute('data-kind') || (title.mediaType === 'tv' ? 'Series' : 'Movie')].filter(Boolean).join(' · ');
  // The thumbnail is the same TMDB poster (w342) the title page uses, only if it is an allowlisted URL.
  const frame = item.querySelector('.request-thumb');
  const image = title ? posterImage(ownerOf(item), title.posterUrl, '', 'lazy') : undefined;
  if (frame && image && !frame.querySelector('img')) {
    frame.classList.remove('poster-empty');
    frame.append(image);
  }
}

function ownerOf(node: Node): Document {
  return node.ownerDocument as Document;
}

/** A fixed error state: the message depends only on the kind of failure, never on any text from a response. */
export function errorState(doc: Document, kind: ApiErrorKind, onRetry?: () => void): HTMLElement {
  const text = Object.hasOwn(ERROR_TEXT, kind) ? ERROR_TEXT[kind] : ERROR_TEXT.unavailable;
  const box = el(doc, 'div', { class: 'notice', attrs: { role: 'alert' } }, [
    el(doc, 'h1', { class: 'screen-title', text: text.title, attrs: { tabindex: '-1' } }),
    el(doc, 'p', { text: text.body }),
  ]);
  if (kind === 'unauthorized') {
    box.append(el(doc, 'a', { class: 'button', text: 'Sign in with Jellyfin', attrs: { href: '/web/' } }));
    box.append(el(doc, 'p', { class: 'muted', text: 'After signing in, come back to JellyPass from your home screen or by opening this address again.' }));
  } else if (onRetry && kind !== 'not_found') {
    const retry = el(doc, 'button', { class: 'button', text: 'Try again', attrs: { type: 'button' } });
    retry.addEventListener('click', onRetry);
    box.append(retry);
  }
  return box;
}

/** What the Account screen shows of the signed-in member; `onSignOut` is run by its Sign out button. */
export interface AccountInfo {
  me?: { name: string; household: string } | undefined;
  onSignOut: (button: HTMLButtonElement) => void;
}

/** The "name · household" line of the Account card. */
export function accountText(me: { name: string; household: string } | undefined): string {
  return me ? [me.name, me.household].filter(Boolean).join(' · ') : 'Signed in';
}

/** The member's card: who is signed in and the Sign out button (the only place to sign out). */
function accountGroup(doc: Document, account: AccountInfo): HTMLElement {
  const out = el(doc, 'button', { class: 'button button-secondary', text: 'Sign out', attrs: { id: 'signout', type: 'button' } });
  out.addEventListener('click', () => account.onSignOut(out));
  return el(doc, 'section', { class: 'group account', attrs: { 'aria-labelledby': 'account-heading' } }, [
    el(doc, 'h2', { class: 'group-label', text: 'Account', attrs: { id: 'account-heading' } }),
    el(doc, 'div', { class: 'inset-card' }, [el(doc, 'p', { class: 'account-name', text: accountText(account.me) }), out]),
  ]);
}

/** Where Sign out was: once signed out, Account says so and points back to the sign-in on Home. */
function signedOutGroup(doc: Document): HTMLElement {
  return el(doc, 'section', { class: 'group account-out', attrs: { 'aria-labelledby': 'account-heading' } }, [
    el(doc, 'h2', { class: 'group-label', text: 'Account', attrs: { id: 'account-heading' } }),
    el(doc, 'div', { class: 'inset-card' }, [
      el(doc, 'p', { class: 'account-name', text: "You're signed out." }),
      el(doc, 'a', { class: 'button', text: 'Sign in', attrs: { href: '#/' } }),
    ]),
  ]);
}

/**
 * The Account tab: who is signed in with Sign out (or the way back in), then "About & credits": what JellyPass is, the
 * TMDB logo and its exact notice, JustWatch's credit and the app's version. The old About address leads here.
 */
export function accountView(doc: Document, account?: AccountInfo, signedOut = false): HTMLElement {
  return el(doc, 'article', { class: 'about account-screen' }, [
    el(doc, 'h1', { class: 'screen-title visually-hidden', text: 'Account', attrs: { tabindex: '-1', [HEADER_TITLE]: '' } }),
    account ? accountGroup(doc, account) : signedOut ? signedOutGroup(doc) : undefined,
    el(doc, 'section', { class: 'group', attrs: { 'aria-labelledby': 'credits-heading' } }, [
      el(doc, 'h2', { class: 'group-label', text: 'About & credits', attrs: { id: 'credits-heading' } }),
      el(doc, 'div', { class: 'inset-card credits' }, [
        el(doc, 'p', { text: 'JellyPass is your household’s way to browse what is in your Jellyfin library and to find more to watch.' }),
        el(doc, 'a', { class: 'tmdb-logo-link', attrs: { href: 'https://www.themoviedb.org/', rel: 'noopener noreferrer', 'aria-label': 'The Movie Database (TMDB)' } }, [
          el(doc, 'img', { class: 'tmdb-logo', attrs: { src: 'tmdb-logo.svg', alt: 'TMDB logo', width: '273', height: '36' } }),
        ]),
        el(doc, 'p', { text: TMDB_NOTICE }),
        el(doc, 'p', { class: 'muted' }, [
          doc.createTextNode('Titles, overviews and images come from '),
          el(doc, 'a', { text: 'themoviedb.org', attrs: { href: 'https://www.themoviedb.org/', rel: 'noopener noreferrer' } }),
          doc.createTextNode('.'),
        ]),
        el(doc, 'p', { class: 'muted justwatch-credit' }, [
          doc.createTextNode('Which films each streaming service has (US availability only, the same for every household) comes from '),
          el(doc, 'a', { text: 'JustWatch', attrs: { href: 'https://www.justwatch.com/', rel: 'noopener noreferrer' } }),
          doc.createTextNode(', through TMDB.'),
        ]),
        el(doc, 'p', { class: 'muted app-version', text: `JellyPass ${APP_VERSION}` }),
      ]),
    ]),
  ]);
}

/** The search field: a capsule with its magnifier inside, the label visible to assistive technology only. */
export function searchForm(doc: Document, input: HTMLInputElement): HTMLFormElement {
  return el(doc, 'form', { class: 'search-form', attrs: { role: 'search' } }, [
    el(doc, 'label', { class: 'visually-hidden', text: 'Search movies and series', attrs: { for: 'q' } }),
    el(doc, 'div', { class: 'search-field' }, [icon(doc, 'search'), input]),
  ]);
}

export function searchStatusText(count: number, query: string): string {
  return count === 0 ? `No results for “${query}”.` : '';
}

/** The sign-in screen's heading and intro; `expired` when a sign-in the app held was refused. */
function signInHeading(doc: Document, title: string, intro: string): Node[] {
  return [
    el(doc, 'h1', { class: 'screen-title', text: title, attrs: { tabindex: '-1' } }),
    el(doc, 'p', { class: 'muted', text: intro }),
  ];
}

/** Jellyfin web's own sign-in, kept as a way in when the app's cannot be used. */
function jellyfinFallback(doc: Document): HTMLElement {
  return el(doc, 'p', { class: 'muted signin-fallback' }, [
    el(doc, 'a', { text: 'Open Jellyfin to sign in', attrs: { href: '/web/' } }),
  ]);
}

/** A fixed-text message line that screen readers announce when its text changes. */
export function signInMessage(doc: Document, id: string): HTMLElement {
  return el(doc, 'p', { class: 'form-error', attrs: { id, role: 'alert' } });
}

/** The household's profiles, each a button of at least a thumb's size; the first letter stands in for a picture. */
export function profilePicker(
  doc: Document,
  profiles: Profile[],
  options: { expired: boolean; onChoose: (profile: Profile, button: HTMLButtonElement) => void; onName: () => void },
): { root: HTMLElement; message: HTMLElement } {
  const message = signInMessage(doc, 'signin-message');
  const list = el(doc, 'ul', { class: 'profiles' });
  for (const profile of profiles) {
    const button = el(doc, 'button', { class: 'profile', attrs: { type: 'button' } }, [
      el(doc, 'span', { class: 'avatar', text: Array.from(profile.name)[0]?.toUpperCase() ?? '?', attrs: { 'aria-hidden': 'true' } }),
      el(doc, 'span', { class: 'profile-name', text: profile.name }),
    ]);
    button.addEventListener('click', () => options.onChoose(profile, button));
    list.append(el(doc, 'li', {}, [button]));
  }
  // Jellyfin leaves hidden members off the list; they, and anyone who prefers to, sign in by name.
  const byName = el(doc, 'button', { class: 'button button-secondary', text: 'Sign in with a different name', attrs: { type: 'button' } });
  byName.addEventListener('click', options.onName);
  const root = el(doc, 'section', { class: 'signin', attrs: { 'data-screen': 'signin' } }, [
    ...signInHeading(doc, 'Sign in', options.expired ? 'Your sign-in has expired. Choose your profile to sign in again.' : 'Choose your profile to sign in.'),
    list,
    message,
    el(doc, 'div', { class: 'form-actions' }, [byName]),
    jellyfinFallback(doc),
  ]);
  return { root, message };
}

/**
 * Sign-in by name and password: for a member the picker does not list (Jellyfin's hidden users), or when it lists
 * nobody. The gateway signs in only this household's members, and answers any other name as it answers a wrong password.
 * The password may be empty, for a member marked passwordless. `onBack` (the picker) only when it lists someone.
 */
export function nameForm(
  doc: Document,
  options: { expired: boolean; onSubmit: (username: string, password: string) => void; onBack?: () => void },
): { root: HTMLElement; form: HTMLFormElement; username: HTMLInputElement; input: HTMLInputElement; submit: HTMLButtonElement; message: HTMLElement } {
  const message = signInMessage(doc, 'signin-message');
  const username = el(doc, 'input', {
    attrs: {
      id: 'username', name: 'username', type: 'text', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off',
      spellcheck: 'false', enterkeyhint: 'next', required: '', maxlength: '256', 'aria-describedby': 'signin-message',
    },
  });
  const input = el(doc, 'input', {
    attrs: { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', enterkeyhint: 'go', maxlength: '256', 'aria-describedby': 'signin-message' },
  });
  const submit = el(doc, 'button', { class: 'button', text: 'Sign in', attrs: { type: 'submit' } });
  const actions = el(doc, 'div', { class: 'form-actions' }, [submit]);
  if (options.onBack) {
    const back = el(doc, 'button', { class: 'button button-secondary', text: 'Choose a profile', attrs: { type: 'button' } });
    back.addEventListener('click', options.onBack);
    actions.append(back);
  }
  const form = el(doc, 'form', { class: 'signin-form', attrs: { novalidate: '' } }, [
    el(doc, 'label', { text: 'Name', attrs: { for: 'username' } }),
    username,
    el(doc, 'label', { text: 'Password', attrs: { for: 'password' } }),
    input,
    message,
    actions,
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // As in the password step, the password is held by nothing but the one call that sends it.
    const password = input.value;
    input.value = '';
    options.onSubmit(username.value, password);
  });
  const root = el(doc, 'section', { class: 'signin', attrs: { 'data-screen': 'signin' } }, [
    ...signInHeading(doc, 'Sign in', options.expired ? 'Your sign-in has expired. Enter your name and password to sign in again.' : 'Enter your Jellyfin name and password.'),
    form,
    jellyfinFallback(doc),
  ]);
  return { root, form, username, input, submit, message };
}

/** The password step for one profile. The username rides along as a hidden, read-only field so a password manager can match it. */
export function passwordForm(
  doc: Document,
  profile: Profile,
  options: { onSubmit: (password: string) => void; onBack: () => void },
): { root: HTMLElement; form: HTMLFormElement; input: HTMLInputElement; submit: HTMLButtonElement; message: HTMLElement } {
  const message = signInMessage(doc, 'signin-message');
  const input = el(doc, 'input', {
    attrs: { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', enterkeyhint: 'go', required: '', maxlength: '256', 'aria-describedby': 'signin-message' },
  });
  const username = el(doc, 'input', {
    class: 'visually-hidden',
    attrs: { name: 'username', type: 'text', autocomplete: 'username', value: profile.name, readonly: '', tabindex: '-1', 'aria-hidden': 'true' },
  });
  const submit = el(doc, 'button', { class: 'button', text: 'Sign in', attrs: { type: 'submit' } });
  const back = el(doc, 'button', { class: 'button button-secondary', text: 'Choose another profile', attrs: { type: 'button' } });
  back.addEventListener('click', options.onBack);
  const form = el(doc, 'form', { class: 'signin-form', attrs: { novalidate: '' } }, [
    username,
    el(doc, 'label', { text: 'Password', attrs: { for: 'password' } }),
    input,
    message,
    el(doc, 'div', { class: 'form-actions' }, [submit, back]),
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // The field is emptied as it is read, so the password is held by nothing but the one call that sends it.
    const password = input.value;
    input.value = '';
    options.onSubmit(password);
  });
  const root = el(doc, 'section', { class: 'signin', attrs: { 'data-screen': 'signin' } }, [
    ...signInHeading(doc, `Sign in as ${profile.name}`, 'Enter your Jellyfin password.'),
    form,
    jellyfinFallback(doc),
  ]);
  return { root, form, input, submit, message };
}

/** The sign-in screen when the profiles could not be loaded. */
export function signInUnavailable(doc: Document, kind: SignInErrorKind, onRetry: () => void): HTMLElement {
  const retry = el(doc, 'button', { class: 'button', text: 'Try again', attrs: { type: 'button' } });
  retry.addEventListener('click', onRetry);
  return el(doc, 'section', { class: 'signin', attrs: { 'data-screen': 'signin' } }, [
    ...signInHeading(doc, 'Sign in', SIGNIN_ERROR_TEXT[Object.hasOwn(SIGNIN_ERROR_TEXT, kind) ? kind : 'unavailable']),
    retry,
    jellyfinFallback(doc),
  ]);
}
