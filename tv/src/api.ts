/**
 * The household app API (`/jellypass/app/v1`, docs/app-design.md "Native clients (contract)"), as the TV add-on calls it:
 * by absolute URL on the origin the add-on's own script came from, with Jellyfin web's token in `Authorization` and
 * nothing else that identifies the caller (no cookies: `credentials: 'omit'`), so the same calls work from another
 * origin once the API allows it. Answers are read leniently, as the contract asks of every client.
 */

export type HouseholdState = 'in_library' | 'get_this' | 'requested' | 'unavailable';

/** The parts of a Card DTO the row shows. */
export interface Card {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  state: HouseholdState;
}

export type Answer = { ok: true; cards: Card[] } | { ok: false; status: number };

const STATES: HouseholdState[] = ['in_library', 'get_this', 'requested', 'unavailable'];
/** The API's poster URL pattern (Card.posterUrl); any other value is no poster. */
const POSTER_URL = /^https:\/\/image\.tmdb\.org\/t\/p\/w342\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/;
/** The most cards the row shows, from the list's first page. */
export const MAX_CARDS = 20;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** `GET /discover/trending` (first page): one call. A network failure is status 0. */
export async function trending(fetcher: Fetch, origin: string, token: string): Promise<Answer> {
  let response: Response;
  try {
    response = await fetcher(`${origin}/jellypass/app/v1/discover/trending`, {
      method: 'GET',
      credentials: 'omit',
      headers: {
        Accept: 'application/json',
        Authorization: `MediaBrowser Token="${encodeURIComponent(token).replace(/"/g, '%22')}"`,
      },
    });
  } catch {
    return { ok: false, status: 0 };
  }
  if (!response.ok) return { ok: false, status: response.status };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, status: 502 };
  }
  const results = body && typeof body === 'object' ? (body as { results?: unknown }).results : undefined;
  if (!Array.isArray(results)) return { ok: false, status: 502 };
  const cards: Card[] = [];
  for (const entry of results) {
    const card = cardOf(entry);
    if (card) cards.push(card);
    if (cards.length === MAX_CARDS) break;
  }
  return { ok: true, cards };
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
    state: STATES.indexOf(state as HouseholdState) >= 0 ? state as HouseholdState : 'unavailable',
  };
}
