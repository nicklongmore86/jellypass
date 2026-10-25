import type { ApiErrorKind, Profile, SignInErrorKind } from './api.js';
import type { Card, CoarseStatus, HouseholdState, Movie, Page, RequestEntry, Season, SeasonSummary, Series } from './types.js';

/**
 * Rendering: DTOs in, DOM out. Everything shown is a fixed string or a DTO field set with `textContent`; nothing is
 * ever parsed as HTML, so a title cannot inject markup. A function takes the document to build in, so the same code
 * runs in the browser and under a test DOM.
 */

const TMDB_IMAGE = /^https:\/\/image\.tmdb\.org\/t\/p\/(?:w342|w780)\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/;
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

export function stateBadge(doc: Document, state: HouseholdState): HTMLElement {
  const label = Object.hasOwn(STATE_LABELS, state) ? STATE_LABELS[state] : STATE_LABELS.unavailable;
  return el(doc, 'span', { class: `badge badge-${Object.hasOwn(STATE_LABELS, state) ? state : 'unavailable'}`, text: label });
}

function poster(doc: Document, url: string | null, alt: string, size: 'card' | 'detail'): HTMLElement {
  const frame = el(doc, 'div', { class: `poster poster-${size}` });
  const src = safeImageUrl(url);
  if (src) {
    frame.append(el(doc, 'img', { attrs: { src, alt, width: '342', height: '513', loading: size === 'card' ? 'lazy' : 'eager', decoding: 'async' } }));
  } else {
    // No image: the frame keeps its shape, so nothing shifts.
    frame.classList.add('poster-empty');
  }
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

export function cardItem(doc: Document, card: Card, origin: string): HTMLElement {
  const link = el(doc, 'a', { class: 'card-link', attrs: { href: href(card) } }, [
    poster(doc, card.posterUrl, '', 'card'),
    el(doc, 'span', { class: 'card-title', text: card.title }),
    el(doc, 'span', { class: 'card-meta', text: [card.year ?? '', card.mediaType === 'tv' ? 'Series' : 'Movie'].filter(Boolean).join(' · ') }),
  ]);
  const play = card.state === 'in_library' ? playButton(doc, card, origin, 'button button-small') : undefined;
  return el(doc, 'li', { class: 'card' }, [link, stateBadge(doc, card.state), play]);
}

export function cardList(doc: Document, cards: readonly Card[], origin: string, className: string): HTMLElement {
  return el(doc, 'ul', { class: className }, cards.map((card) => cardItem(doc, card, origin)));
}

/** A discover row: a heading and a horizontally scrolling list, reachable and scrollable from the keyboard. */
export function titleRow(doc: Document, id: string, heading: string, page: Page, origin: string): HTMLElement {
  const list = cardList(doc, page.results, origin, 'row-list');
  list.setAttribute('tabindex', '0');
  list.setAttribute('aria-labelledby', `${id}-heading`);
  const section = el(doc, 'section', { class: 'row' }, [el(doc, 'h2', { class: 'row-heading', text: heading, attrs: { id: `${id}-heading` } })]);
  section.append(page.results.length ? list : el(doc, 'p', { class: 'muted', text: 'Nothing to show here right now.' }));
  return section;
}

export function skeletonRow(doc: Document): HTMLElement {
  const cards = Array.from({ length: 6 }, () =>
    el(doc, 'li', { class: 'card skeleton-card' }, [el(doc, 'div', { class: 'poster poster-card skeleton' }), el(doc, 'span', { class: 'skeleton skeleton-line' })]),
  );
  return el(doc, 'section', { class: 'row', attrs: { 'aria-hidden': 'true' } }, [
    el(doc, 'div', { class: 'skeleton skeleton-heading' }),
    el(doc, 'ul', { class: 'row-list' }, cards),
  ]);
}

export function skeletonDetail(doc: Document): HTMLElement {
  return el(doc, 'div', { class: 'detail', attrs: { 'aria-hidden': 'true' } }, [
    el(doc, 'div', { class: 'backdrop skeleton' }),
    el(doc, 'div', { class: 'skeleton skeleton-heading' }),
    el(doc, 'div', { class: 'skeleton skeleton-line' }),
    el(doc, 'div', { class: 'skeleton skeleton-block' }),
  ]);
}

export function runtimeText(minutes: number | null): string {
  if (!minutes || minutes < 1) return '';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} h${rest ? ` ${rest} min` : ''}` : `${rest} min`;
}

function metaLine(doc: Document, title: Movie | Series): HTMLElement {
  const parts: Array<string | HTMLElement> = [];
  if (title.year) parts.push(String(title.year));
  const runtime = runtimeText(title.runtime);
  if (runtime) parts.push(runtime);
  if (typeof title.rating === 'number') {
    parts.push(el(doc, 'span', { text: `★ ${title.rating.toFixed(1)}`, attrs: { 'aria-label': `TMDB rating ${title.rating.toFixed(1)} out of 10` } }));
  }
  const line = el(doc, 'p', { class: 'meta' });
  parts.forEach((part, index) => {
    if (index) line.append(doc.createTextNode(' · '));
    line.append(part);
  });
  return line;
}

export function stateNote(doc: Document, state: HouseholdState): HTMLElement | undefined {
  if (state === 'unavailable') return el(doc, 'p', { class: 'muted', text: "This title can't be requested." });
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

interface Choice {
  season: number;
  label: string;
}

/**
 * The "Get this" button, with a season picker for a series. While a call is in flight the button is disabled; the
 * answer is the same fixed confirmation whatever followed, and each failure has its own fixed words.
 */
export function getThisControl(doc: Document, subject: string, choices: Choice[], extras: GetThisExtras): HTMLElement | undefined {
  const message = el(doc, 'p', { class: 'get-message', attrs: { role: 'status', tabindex: '-1' } });
  if (extras.confirmed) message.textContent = GET_THIS_TEXT.confirmation;
  const box = el(doc, 'div', { class: 'get-this' });
  const onGet = extras.onGet;
  if (!onGet || choices.length === 0) return extras.confirmed ? el(doc, 'div', { class: 'get-this' }, [message]) : undefined;
  const picking = extras.pick === true && choices.length > 0;
  const boxes = picking
    ? choices.map((choice) => el(doc, 'input', { attrs: { type: 'checkbox', value: String(choice.season) } }))
    : [];
  const button = el(doc, 'button', {
    class: 'button',
    text: GET_THIS_TEXT.button,
    attrs: { type: 'button', 'aria-label': `${GET_THIS_TEXT.button}: ${subject}` },
  });
  const only = choices.filter((choice) => choice.season > 0).map((choice) => choice.season);
  const chosen = (): number[] => (picking ? boxes.filter((box) => box.checked).map((box) => Number(box.value)) : only);
  const update = () => {
    button.disabled = picking && chosen().length === 0;
  };
  update();
  let fieldsetNode: HTMLElement | undefined;
  if (picking) {
    const fieldset = el(doc, 'fieldset', { class: 'get-seasons' }, [
      el(doc, 'legend', { text: GET_THIS_TEXT.chooseSeasons }),
      ...choices.map((choice, index) => el(doc, 'label', { class: 'choice' }, [boxes[index], el(doc, 'span', { text: choice.label })])),
    ]);
    for (const input of boxes) input.addEventListener('change', update);
    fieldsetNode = fieldset;
    box.append(fieldset);
  }
  button.addEventListener('click', () => {
    if (button.disabled) return;
    const seasons = chosen();
    button.disabled = true;
    for (const input of boxes) input.disabled = true;
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
      fieldsetNode?.remove();
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
      for (const input of boxes) input.disabled = false;
      update();
    });
  });
  box.append(button, message);
  return box;
}

/** A movie or series page. A series also lists its seasons, each with the household's state for it. */
export function titleDetail(doc: Document, title: Movie | Series, origin: string, extras: GetThisExtras = {}): HTMLElement {
  const backdrop = safeImageUrl(title.backdropUrl);
  const own = extras.asked?.has(0) || extras.failed?.has(0) ? undefined : title.state === 'get_this' && title.mediaType === 'movie' ? [{ season: 0, label: '' }] : undefined;
  const failedSeason = (season: SeasonSummary) => season.state === 'get_this' && extras.failed?.has(season.seasonNumber) === true;
  const seasonChoices = title.mediaType === 'tv'
    ? title.seasons.filter((season) => season.state === 'get_this' && season.seasonNumber >= 1 && !extras.asked?.has(season.seasonNumber) && !failedSeason(season))
      .map((season) => ({ season: season.seasonNumber, label: season.name || `Season ${season.seasonNumber}` }))
    : [];
  const control = getThisControl(doc, title.title, own ?? seasonChoices, { ...extras, pick: title.mediaType === 'tv' });
  const failedMovie = title.state === 'get_this' && title.mediaType === 'movie' && extras.failed?.has(0) === true;
  const failedAny = failedMovie || (title.mediaType === 'tv' && title.seasons.some(failedSeason));
  const actions = el(doc, 'div', { class: 'actions' }, [
    failedMovie ? requestBadge(doc, 'failed') : stateBadge(doc, title.state),
    title.state === 'in_library' ? playButton(doc, title, origin) : undefined,
  ]);
  const genres = title.genres.length
    ? el(doc, 'ul', { class: 'genres', attrs: { 'aria-label': 'Genres' } }, title.genres.map((genre) => el(doc, 'li', { text: genre })))
    : undefined;
  const head = el(doc, 'div', { class: 'detail-head' }, [
    poster(doc, title.posterUrl, `Poster for ${title.title}`, 'detail'),
    el(doc, 'div', { class: 'detail-text' }, [
      el(doc, 'h1', { class: 'screen-title', text: title.title, attrs: { tabindex: '-1' } }),
      metaLine(doc, title),
      genres,
      actions,
      stateNote(doc, title.state),
      failedAny ? failedNote(doc) : undefined,
      control,
    ]),
  ]);
  const backdropFrame = el(doc, 'div', { class: 'backdrop' });
  if (backdrop) backdropFrame.append(el(doc, 'img', { attrs: { src: backdrop, alt: '', width: '780', height: '439', decoding: 'async' } }));
  const detail = el(doc, 'article', { class: 'detail' }, [
    backdropFrame,
    head,
    title.overview ? el(doc, 'p', { class: 'overview', text: title.overview }) : undefined,
  ]);
  if (title.mediaType === 'tv') detail.append(seasonList(doc, title, extras.failed));
  return detail;
}

/** A title the household asked for that failed is not asked for again from here: the backend holds the failed record. */
function failedNote(doc: Document): HTMLElement {
  return el(doc, 'p', { class: 'muted failed-note', text: GET_THIS_TEXT.failedNote });
}

export function seasonList(doc: Document, series: Series, failed?: ReadonlySet<number>): HTMLElement {
  const items = series.seasons.map((season: SeasonSummary) => {
    const count = season.episodeCount === null ? '' : `${season.episodeCount} ${season.episodeCount === 1 ? 'episode' : 'episodes'}`;
    return el(doc, 'li', { class: 'season' }, [
      el(doc, 'a', { class: 'season-link', attrs: { href: `#/tv/${series.tmdbId}/season/${season.seasonNumber}` } }, [
        el(doc, 'span', { class: 'season-name', text: season.name || `Season ${season.seasonNumber}` }),
        el(doc, 'span', { class: 'card-meta', text: count }),
      ]),
      season.state === 'get_this' && failed?.has(season.seasonNumber) ? requestBadge(doc, 'failed') : stateBadge(doc, season.state),
    ]);
  });
  return el(doc, 'section', { class: 'seasons' }, [
    el(doc, 'h2', { class: 'row-heading', text: 'Seasons' }),
    items.length ? el(doc, 'ul', { class: 'season-list' }, items) : el(doc, 'p', { class: 'muted', text: 'No seasons listed.' }),
  ]);
}

export function seasonView(doc: Document, season: Season, seriesTitle: string | undefined, extras: GetThisExtras = {}): HTMLElement {
  const back = el(doc, 'a', { class: 'back', text: seriesTitle ? `← ${seriesTitle}` : '← Series', attrs: { href: `#/tv/${season.tmdbId}` } });
  const episodes = season.episodes.map((episode) =>
    el(doc, 'li', { class: 'episode' }, [
      el(doc, 'h3', { class: 'episode-title', text: `${episode.episodeNumber}. ${episode.name || `Episode ${episode.episodeNumber}`}` }),
      episode.overview ? el(doc, 'p', { class: 'muted', text: episode.overview }) : undefined,
    ]),
  );
  return el(doc, 'article', { class: 'detail season-view' }, [
    back,
    el(doc, 'h1', { class: 'screen-title', text: season.name || `Season ${season.seasonNumber}`, attrs: { tabindex: '-1' } }),
    el(doc, 'div', { class: 'actions' }, [season.state === 'get_this' && extras.failed?.has(season.seasonNumber) ? requestBadge(doc, 'failed') : stateBadge(doc, season.state)]),
    stateNote(doc, season.state),
    season.state === 'get_this' && extras.failed?.has(season.seasonNumber) ? failedNote(doc) : undefined,
    getThisControl(
      doc,
      [seriesTitle, season.name || `Season ${season.seasonNumber}`].filter(Boolean).join(' '),
      season.state === 'get_this' && season.seasonNumber >= 1 && !extras.asked?.has(season.seasonNumber) && !extras.failed?.has(season.seasonNumber)
        ? [{ season: season.seasonNumber, label: season.name || `Season ${season.seasonNumber}` }] : [],
      extras,
    ),
    season.overview ? el(doc, 'p', { class: 'overview', text: season.overview }) : undefined,
    episodes.length ? el(doc, 'ol', { class: 'episode-list' }, episodes) : el(doc, 'p', { class: 'muted', text: 'No episodes listed.' }),
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
 * One of the household's requests. The title text is filled in afterwards (the list carries only a TMDB ID), with
 * {@link setRequestTitle}; until then, and if it cannot be loaded, the entry still shows its status.
 */
export function requestItem(doc: Document, entry: RequestEntry): HTMLElement {
  const seasons = entry.seasons.map((season) =>
    el(doc, 'li', { class: 'request-season' }, [el(doc, 'span', { text: `Season ${season.seasonNumber}` }), requestBadge(doc, season.status)]),
  );
  return el(doc, 'li', { class: 'request' }, [
    el(doc, 'a', { class: 'request-link', attrs: { href: href(entry) } }, [
      el(doc, 'span', { class: 'card-title', text: REQUESTS_TEXT.loading }),
      el(doc, 'span', { class: 'card-meta', text: entry.mediaType === 'tv' ? 'Series' : 'Movie' }),
    ]),
    requestBadge(doc, entry.status),
    el(doc, 'p', { class: 'muted request-who', text: entry.byYou ? REQUESTS_TEXT.byYou : REQUESTS_TEXT.byOther }),
    seasons.length ? el(doc, 'ul', { class: 'request-seasons', attrs: { 'aria-label': 'Seasons' } }, seasons) : undefined,
  ]);
}

export function setRequestTitle(item: HTMLElement, title: { title: string; year: number | null; mediaType: 'movie' | 'tv' } | undefined): void {
  const name = item.querySelector('.card-title');
  const meta = item.querySelector('.card-meta');
  if (!name || !meta) return;
  name.textContent = title?.title || REQUESTS_TEXT.titleMissing;
  if (title) meta.textContent = [title.year ?? '', title.mediaType === 'tv' ? 'Series' : 'Movie'].filter(Boolean).join(' · ');
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

export function aboutView(doc: Document): HTMLElement {
  return el(doc, 'article', { class: 'about' }, [
    el(doc, 'h1', { class: 'screen-title', text: 'About & credits', attrs: { tabindex: '-1' } }),
    el(doc, 'p', { text: 'JellyPass is your household’s way to browse what is in your Jellyfin library and to find more to watch.' }),
    el(doc, 'section', { class: 'credits' }, [
      el(doc, 'h2', { class: 'row-heading', text: 'Credits' }),
      el(doc, 'a', { class: 'tmdb-logo-link', attrs: { href: 'https://www.themoviedb.org/', rel: 'noopener noreferrer', 'aria-label': 'The Movie Database (TMDB)' } }, [
        el(doc, 'img', { class: 'tmdb-logo', attrs: { src: 'tmdb-logo.svg', alt: 'TMDB logo', width: '273', height: '36' } }),
      ]),
      el(doc, 'p', { text: TMDB_NOTICE }),
      el(doc, 'p', { class: 'muted' }, [
        doc.createTextNode('Titles, overviews and images come from '),
        el(doc, 'a', { text: 'themoviedb.org', attrs: { href: 'https://www.themoviedb.org/', rel: 'noopener noreferrer' } }),
        doc.createTextNode('.'),
      ]),
    ]),
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
