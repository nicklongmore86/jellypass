/**
 * The household app API (`/jellypass/app/v1`, docs/app-design.md "Native clients (contract)"), as the TV add-on calls it:
 * by absolute URL on the origin the add-on's own script came from, with Jellyfin web's token in `Authorization` and
 * nothing else that identifies the caller (no cookies: `credentials: 'omit'`), so the same calls work from another
 * origin once the API allows it. Answers are read leniently, as the contract asks of every client.
 */

export type HouseholdState = 'in_library' | 'get_this' | 'requested' | 'unavailable';
export type MediaType = 'movie' | 'tv';

/** The parts of a Card DTO the row shows. */
export interface Card {
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  state: HouseholdState;
}

export interface SeasonSummary {
  seasonNumber: number;
  name: string;
  episodeCount: number | null;
  state: HouseholdState;
}

/** The parts of a Movie or Series DTO the title view shows. `seasons` is empty for a movie. */
export interface Title extends Card {
  overview: string;
  backdropUrl: string | null;
  rating: number | null;
  genres: string[];
  runtime: number | null;
  /** Jellyfin's item, only when `play.url` is exactly this origin's own details page for it. */
  playItemId: string | null;
  seasons: SeasonSummary[];
}

/** A failure's status: 0 for no network, 502 for an answer that can't be read. */
export interface Failure {
  ok: false;
  status: number;
  /** For a `429`: how long the server asked to wait, in milliseconds, when it said (a number of seconds). */
  retryAfterMs?: number;
}
export type Answer = { ok: true; cards: Card[] } | Failure;
export type TitleAnswer = { ok: true; title: Title } | Failure;
/** The seasons (0 for a movie) of one title the household asked for that did not work out (`failed` in `GET /requests`). */
export type FailedAnswer = { ok: true; failed: number[] } | Failure;

/** A request's coarse status in `GET /requests`: nothing finer is ever sent. */
export type CoarseStatus = 'requested' | 'ready' | 'failed';

/** One of the household's requests (an entry of `GET /requests`), the fields My requests shows. */
export interface RequestEntry {
  /** Opaque; the cancel call's address. Empty for an entry whose id is not of the API's shape (it has no Cancel). */
  id: string;
  mediaType: MediaType;
  tmdbId: number;
  status: CoarseStatus;
  seasons: Array<{ seasonNumber: number; status: CoarseStatus }>;
  /** Whether the caller made any of the household's records for the title. */
  byYou: boolean;
  /** Whether the caller may cancel it now (`apiVersion` 2; a server before has none, so no Cancel is offered). */
  cancellable: boolean;
  /** The day (`YYYY-MM-DD`, UTC) the household last asked for it, when the server says. */
  requestedOn: string | undefined;
}
export type RequestsAnswer = { ok: true; entries: RequestEntry[] } | Failure;

const STATES: HouseholdState[] = ['in_library', 'get_this', 'requested', 'unavailable'];
/** The API's image URL patterns (Card.posterUrl, Card.backdropUrl); any other value is no image. */
const POSTER_URL = /^https:\/\/image\.tmdb\.org\/t\/p\/w342\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/;
const BACKDROP_URL = /^https:\/\/image\.tmdb\.org\/t\/p\/w780\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/;
/** Play.itemId's pattern. */
const ITEM_ID = /^[0-9a-f]{32}$/;
/** The most cards the row shows, from the list's first page. */
export const MAX_CARDS = 20;
/** The most requests My requests keeps from a list answer. */
export const MAX_REQUESTS = 500;
/** A request id's shape (the API's are 22 URL-safe characters; any of this shape is passed on, nothing else is). */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** One call: the response, or the failure. A `POST` sends `body` as JSON. */
async function call(fetcher: Fetch, origin: string, token: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ ok: true; response: Response } | Failure> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `MediaBrowser Token="${encodeURIComponent(token).replace(/"/g, '%22')}"`,
  };
  const init: RequestInit = { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', headers };
  if (signal) init.signal = signal;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetcher(`${origin}/jellypass/app/v1${path}`, init);
  } catch {
    return { ok: false, status: 0 };
  }
  if (response.ok) return { ok: true, response };
  const failure: Failure = { ok: false, status: response.status };
  const wait = response.status === 429 && response.headers ? Number(response.headers.get('retry-after')) : NaN;
  if (wait > 0 && wait <= 3600) failure.retryAfterMs = Math.ceil(wait * 1000);
  return failure;
}

/** A `GET`'s JSON object, or the failure. */
async function read(fetcher: Fetch, origin: string, token: string, path: string, signal?: AbortSignal): Promise<{ ok: true; body: Record<string, unknown> } | Failure> {
  const answer = await call(fetcher, origin, token, path, undefined, signal);
  if (!answer.ok) return answer;
  let body: unknown;
  try {
    body = await answer.response.json();
  } catch {
    return { ok: false, status: 502 };
  }
  return body && typeof body === 'object' ? { ok: true, body: body as Record<string, unknown> } : { ok: false, status: 502 };
}

/** `GET /discover/trending` (first page): one call. */
export async function trending(fetcher: Fetch, origin: string, token: string): Promise<Answer> {
  return cardsOf(await read(fetcher, origin, token, '/discover/trending'));
}

/** The longest search the API takes (`q`, 1 to 100 characters). */
export const MAX_QUERY = 100;

/** `GET /search?q=&page=1` (first page only): one call, which `signal` can cancel. */
export async function search(fetcher: Fetch, origin: string, token: string, query: string, signal?: AbortSignal): Promise<Answer> {
  if (!query || query.length > MAX_QUERY) return { ok: false, status: 400 };
  return cardsOf(await read(fetcher, origin, token, `/search?q=${encodeURIComponent(query)}&page=1`, signal));
}

/** The cards of a list answer's first page, at most MAX_CARDS. */
function cardsOf(answer: { ok: true; body: Record<string, unknown> } | Failure): Answer {
  if (!answer.ok) return answer;
  const results = answer.body.results;
  if (!Array.isArray(results)) return { ok: false, status: 502 };
  const cards: Card[] = [];
  for (const entry of results) {
    const card = cardOf(entry);
    if (card) cards.push(card);
    if (cards.length === MAX_CARDS) break;
  }
  return { ok: true, cards };
}

/** `GET /movie/{id}` or `GET /tv/{id}`: one call. */
export async function title(fetcher: Fetch, origin: string, token: string, mediaType: MediaType, tmdbId: number): Promise<TitleAnswer> {
  const answer = await read(fetcher, origin, token, `/${mediaType}/${tmdbId}`);
  if (!answer.ok) return answer;
  const found = titleOf(answer.body, origin);
  return found && found.mediaType === mediaType && found.tmdbId === tmdbId ? { ok: true, title: found } : { ok: false, status: 502 };
}

/** `GET /requests`, read only for one title's failed seasons (0 for a movie): one call. */
export async function failedSeasons(fetcher: Fetch, origin: string, token: string, mediaType: MediaType, tmdbId: number): Promise<FailedAnswer> {
  const answer = await read(fetcher, origin, token, '/requests');
  if (!answer.ok) return answer;
  const results = answer.body.results;
  if (!Array.isArray(results)) return { ok: false, status: 502 };
  for (const value of results) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (entry.mediaType !== mediaType || entry.tmdbId !== tmdbId) continue;
    if (mediaType === 'movie') return { ok: true, failed: entry.status === 'failed' ? [0] : [] };
    const failed: number[] = [];
    for (const season of Array.isArray(entry.seasons) ? entry.seasons : []) {
      const { seasonNumber, status } = (season && typeof season === 'object' ? season : {}) as Record<string, unknown>;
      if (typeof seasonNumber === 'number' && status === 'failed') failed.push(seasonNumber);
    }
    return { ok: true, failed };
  }
  return { ok: true, failed: [] };
}

/** `GET /requests`: one call. */
export async function requests(fetcher: Fetch, origin: string, token: string): Promise<RequestsAnswer> {
  const answer = await read(fetcher, origin, token, '/requests');
  if (!answer.ok) return answer;
  const results = answer.body.results;
  if (!Array.isArray(results)) return { ok: false, status: 502 };
  const entries: RequestEntry[] = [];
  for (const value of results) {
    const entry = requestOf(value);
    if (entry) entries.push(entry);
    if (entries.length === MAX_REQUESTS) break;
  }
  return { ok: true, entries };
}

/**
 * `POST /requests/{id}/cancel`: one call, which the add-on never repeats by itself. Any `2xx` is accepted and its body is
 * not read: the API answers the same whatever it does. An id that is not of the API's shape is not sent.
 */
export async function cancelRequest(fetcher: Fetch, origin: string, token: string, id: string): Promise<{ ok: true } | Failure> {
  if (!REQUEST_ID.test(id)) return { ok: false, status: 400 };
  const answer = await call(fetcher, origin, token, `/requests/${encodeURIComponent(id)}/cancel`, {});
  return answer.ok ? { ok: true } : answer;
}

/**
 * `POST /movie/{id}/get` or `POST /tv/{id}/get` with the seasons asked for: one call, which the add-on never repeats by
 * itself. Any `2xx` is accepted and its body is not read: the API answers the same whatever it does.
 */
export async function getThis(fetcher: Fetch, origin: string, token: string, mediaType: MediaType, tmdbId: number, seasons: number[]): Promise<{ ok: true } | Failure> {
  const answer = await call(fetcher, origin, token, `/${mediaType}/${tmdbId}/get`, mediaType === 'tv' ? { seasons } : {});
  return answer.ok ? { ok: true } : answer;
}

/** An unknown status reads as the one that says it did not work out, as the app's pills do. */
function coarseOf(value: unknown): CoarseStatus {
  return value === 'requested' || value === 'ready' ? value : 'failed';
}

/** A `GET /requests` entry's shown fields, or undefined for one without a title to name. */
function requestOf(value: unknown): RequestEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;
  const { id, mediaType, tmdbId, status, seasons, byYou, cancellable, requestedOn } = entry;
  if ((mediaType !== 'movie' && mediaType !== 'tv') || typeof tmdbId !== 'number' || !Number.isInteger(tmdbId) || tmdbId < 1) return undefined;
  const shown: Array<{ seasonNumber: number; status: CoarseStatus }> = [];
  if (mediaType === 'tv' && Array.isArray(seasons)) {
    for (const season of seasons.slice(0, 100)) {
      const { seasonNumber, status: seasonStatus } = (season && typeof season === 'object' ? season : {}) as Record<string, unknown>;
      if (typeof seasonNumber === 'number' && Number.isInteger(seasonNumber) && seasonNumber >= 0) shown.push({ seasonNumber, status: coarseOf(seasonStatus) });
    }
  }
  const known = typeof id === 'string' && REQUEST_ID.test(id);
  return {
    id: known ? id : '',
    mediaType,
    tmdbId,
    status: coarseOf(status),
    seasons: shown,
    byYou: byYou === true,
    cancellable: known && cancellable === true,
    requestedOn: typeof requestedOn === 'string' && requestedOn.length <= 10 ? requestedOn : undefined,
  };
}

function stateOf(value: unknown): HouseholdState {
  return STATES.indexOf(value as HouseholdState) >= 0 ? value as HouseholdState : 'unavailable';
}

/** A Card DTO's shown fields, or undefined for an entry without a title to show. An unknown state is `unavailable`. */
function cardOf(value: unknown): Card | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;
  const { mediaType, tmdbId, title, year, posterUrl, state } = entry;
  if ((mediaType !== 'movie' && mediaType !== 'tv') || typeof tmdbId !== 'number' || typeof title !== 'string' || !title) return undefined;
  return {
    mediaType,
    tmdbId,
    title: title.slice(0, 300),
    year: typeof year === 'number' && year >= 0 && year <= 9999 ? Math.floor(year) : null,
    posterUrl: typeof posterUrl === 'string' && POSTER_URL.test(posterUrl) ? posterUrl : null,
    state: stateOf(state),
  };
}

/** A Movie or Series DTO's shown fields. Play is kept only when it is exactly `origin`'s own details page for the item. */
function titleOf(value: Record<string, unknown>, origin: string): Title | undefined {
  const card = cardOf(value);
  if (!card) return undefined;
  const { overview, backdropUrl, rating, genres, runtime, play, seasons } = value;
  const link = (play && typeof play === 'object' ? play : {}) as Record<string, unknown>;
  const itemId = typeof link.itemId === 'string' && ITEM_ID.test(link.itemId) && link.url === `${origin}/web/#/details?id=${link.itemId}` ? link.itemId : null;
  const shownSeasons: SeasonSummary[] = [];
  if (card.mediaType === 'tv' && Array.isArray(seasons)) {
    for (const season of seasons.slice(0, 100)) {
      if (!season || typeof season !== 'object') continue;
      const entry = season as Record<string, unknown>;
      const number = entry.seasonNumber;
      if (typeof number !== 'number' || number < 0 || Math.floor(number) !== number) continue;
      shownSeasons.push({
        seasonNumber: number,
        name: typeof entry.name === 'string' ? entry.name.slice(0, 200) : '',
        episodeCount: typeof entry.episodeCount === 'number' && entry.episodeCount >= 0 ? Math.floor(entry.episodeCount) : null,
        state: stateOf(entry.state),
      });
    }
  }
  return {
    mediaType: card.mediaType,
    tmdbId: card.tmdbId,
    title: card.title,
    year: card.year,
    posterUrl: card.posterUrl,
    state: card.state,
    overview: typeof overview === 'string' ? overview.slice(0, 2000) : '',
    backdropUrl: typeof backdropUrl === 'string' && BACKDROP_URL.test(backdropUrl) ? backdropUrl : null,
    rating: typeof rating === 'number' && rating >= 0 && rating <= 10 ? rating : null,
    genres: Array.isArray(genres) ? genres.filter((genre): genre is string => typeof genre === 'string' && genre.length > 0).slice(0, 10).map((genre) => genre.slice(0, 60)) : [],
    runtime: typeof runtime === 'number' && runtime > 0 ? Math.floor(runtime) : null,
    playItemId: itemId,
    seasons: shownSeasons,
  };
}
