import { createAsked, type Asked } from './asked.js';
import { createHiddenOverlay, type HiddenOverlay } from './hidden.js';
import { createTitleCache, type TitleCache, type TitleDetails } from './titles.js';
import type { DiscoverList, HiddenList, MediaType, Me, Movie, Page, RequestEntry, RequestList, Season, Series, SourceKind, Sources } from './types.js';

export const API_PREFIX = '/jellypass/app/v1';
/** The revision of the contract that has hiding titles ("Not interested"); a server before it has none of it. */
export const HIDING_API_VERSION = 3;

/** The only failures the app tells apart, each with a fixed message (see render.ts); upstream text is never shown. */
export type ApiErrorKind = 'unauthorized' | 'rate_limited' | 'not_found' | 'unavailable' | 'offline' | 'hidden_limit_reached';

export class ApiError extends Error {
  public constructor(public readonly kind: ApiErrorKind) {
    super(kind);
  }
}

export interface ApiOptions {
  fetch: typeof fetch;
  /** The Jellyfin access token, read for each call. */
  token: () => string | undefined;
  /** The titles this member asked for in this page's life; shown as requested while the server catches up. */
  asked?: Asked;
  /** The titles My requests has named in this sign-in; forgotten with the overlay. */
  titles?: TitleCache;
  /** The titles this member hid or unhid in this page's life; forgotten with the overlay. */
  hidden?: HiddenOverlay;
}

export interface Api {
  me(signal?: AbortSignal): Promise<Me>;
  search(query: string, page: number, signal?: AbortSignal): Promise<Page>;
  discover(list: DiscoverList, signal?: AbortSignal): Promise<Page>;
  /** The networks and studios the API lists (no TMDB call). */
  sources(signal?: AbortSignal): Promise<Sources>;
  /**
   * A network's popular series or a studio's popular movies, one page at a time; with `list`, a network's films
   * (`films`) or its films and series mixed (`all`).
   */
  source(kind: SourceKind, id: number, page: number, signal?: AbortSignal, list?: 'all' | 'films'): Promise<Page>;
  movie(tmdbId: number, signal?: AbortSignal): Promise<Movie>;
  tv(tmdbId: number, signal?: AbortSignal): Promise<Series>;
  season(tmdbId: number, seasonNumber: number, signal?: AbortSignal): Promise<Season>;
  /** "Get this": resolves once the API accepted the call (it always answers the same), and says nothing about what follows. */
  getThis(mediaType: MediaType, tmdbId: number, seasons: readonly number[], signal?: AbortSignal): Promise<void>;
  requests(signal?: AbortSignal): Promise<RequestList>;
  /**
   * Cancels one of the caller's own requests (an entry of `requests()`): resolves once the API accepted the call, which
   * always answers the same and says nothing about what became of it. The title is then shown as available to get again.
   */
  cancelRequest(entry: Pick<RequestEntry, 'id' | 'mediaType' | 'tmdbId'>, signal?: AbortSignal): Promise<void>;
  /**
   * A title's name, year and poster for My requests: from the title's own answer (seen by the overlay), or, without a
   * call, from one read in the last ten minutes of this sign-in. Never its state.
   */
  requestTitle(mediaType: MediaType, tmdbId: number, signal?: AbortSignal): Promise<TitleDetails>;
  /**
   * "Not interested" (`hidden` true) or Unhide: resolves once the API has written it (it answers the same whether or
   * not the title already was hidden). Needs `apiVersion` 3 (see {@link HIDING_API_VERSION}); hiding past the member's
   * 2,000 is `hidden_limit_reached`. The change is shown at once on every list and card read afterwards.
   */
  setHidden(mediaType: MediaType, tmdbId: number, hidden: boolean, signal?: AbortSignal): Promise<void>;
  /** The member's own hidden titles, newest first, 50 a page (My requests' Hidden tab); IDs only. Needs `apiVersion` 3. */
  hiddenList(page: number, signal?: AbortSignal): Promise<HiddenList>;
  /** Forgets what this member just asked for (sign-out). */
  forgetAsked(): void;
}

function kindOf(status: number, hiding = false): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 409 && hiding) return 'hidden_limit_reached';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  return 'unavailable';
}

export function createApi(options: ApiOptions): Api {
  const asked = options.asked ?? createAsked();
  const titles = options.titles ?? createTitleCache();
  const hidden = options.hidden ?? createHiddenOverlay();
  // Bumped each time the titles are forgotten: a title read before is not kept for whoever is signed in after.
  let titlesEpoch = 0;
  function forget(): void {
    asked.forget();
    titles.forget();
    hidden.forget();
    titlesEpoch += 1;
  }
  // The overlay belongs to whoever holds this token and this /me identity: any other (or none) starts it empty.
  let owner: string | undefined;
  let identity: string | undefined;
  function sync(token: string | undefined): void {
    if (token === owner) return;
    forget();
    owner = token;
    identity = undefined;
  }
  /** Applies the overlay to an answer, first making sure it still belongs to the member who is signed in now. */
  const seen = <T>(apply: (value: T) => T) => (value: T): T => {
    sync(options.token());
    return apply(value);
  };
  async function call(path: string, init: { body?: unknown; method?: 'DELETE'; hiding?: boolean }, signal?: AbortSignal): Promise<Response> {
    const token = options.token();
    sync(token);
    if (!token) throw new ApiError('unauthorized');
    let response: Response;
    try {
      response = await options.fetch(`${API_PREFIX}${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: {
          Accept: 'application/json',
          Authorization: `MediaBrowser Token="${encodeURIComponent(token).replace(/"/g, '%22')}"`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        // The API is no-store; the app asks for the same, sends no cookies and keeps nothing.
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError('offline');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // A refused sign-in is nobody's: whatever was shown as requested for it is dropped.
      if (response.status === 401) {
        forget();
        identity = undefined;
      }
      throw new ApiError(kindOf(response.status, init.hiding));
    }
    return response;
  }

  async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await call(path, {}, signal);
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError('unavailable');
    }
  }

  /** A read, as of when it began: what the member hid or unhid after that is told over its answer (see {@link HiddenOverlay}). */
  const read = async <T>(fetchIt: (began: number) => Promise<T>, apply: (value: T, began: number) => T): Promise<T> => {
    const began = hidden.begin();
    const value = await fetchIt(began);
    sync(options.token());
    return apply(value, began);
  };
  const movie = (tmdbId: number, signal?: AbortSignal) =>
    read(() => get<Movie>(`/movie/${tmdbId}`, signal), (value, began) => hidden.flagged(asked.movie(value), began));
  const tv = (tmdbId: number, signal?: AbortSignal) =>
    read(() => get<Series>(`/tv/${tmdbId}`, signal), (value, began) => hidden.flagged(asked.series(value), began));

  return {
    me: async (signal) => {
      const me = await get<Me>('/me', signal);
      sync(options.token());
      // Another member (or household) never sees this one's overlay; /me names the member and the household.
      const now = `${me.household}\n${me.name}`;
      if (identity !== undefined && identity !== now) forget();
      identity = now;
      return me;
    },
    search: (query, page, signal) =>
      read(() => get<Page>(`/search?q=${encodeURIComponent(query)}&page=${page}`, signal), (value, began) => hidden.flaggedPage(asked.page(value), began)),
    discover: (list, signal) => read(() => get<Page>(`/discover/${list}`, signal), (value, began) => hidden.list(asked.page(value), began)),
    sources: (signal) => get<Sources>('/discover/sources', signal),
    source: (kind, id, page, signal, list) =>
      read(() => get<Page>(`/discover/${kind}/${id}${list ? `/${list}` : ''}${page > 1 ? `?page=${page}` : ''}`, signal), (value, began) => hidden.list(asked.page(value), began)),
    movie,
    tv,
    season: (tmdbId, seasonNumber, signal) => get<Season>(`/tv/${tmdbId}/season/${seasonNumber}`, signal).then(seen(asked.season)),
    getThis: async (mediaType, tmdbId, seasons, signal) => {
      const before = options.token();
      // A movie sends an empty object, a series the seasons asked for; the answer is the same fixed 202 either way.
      const response = await call(`/${mediaType}/${tmdbId}/get`, { body: mediaType === 'tv' ? { seasons } : {} }, signal);
      await response.body?.cancel().catch(() => undefined);
      // Only an accepted call (a 2xx; anything else threw above) is shown as requested while the server records it.
      // ... and only for the member who asked: not if the sign-in changed while the call was out.
      sync(options.token());
      if (before !== undefined && owner === before) asked.add(mediaType, tmdbId, seasons);
    },
    requests: (signal) => get<RequestList>('/requests', signal),
    cancelRequest: async (entry, signal) => {
      const before = options.token();
      const response = await call(`/requests/${encodeURIComponent(entry.id)}/cancel`, { body: {} }, signal);
      await response.body?.cancel().catch(() => undefined);
      // Only an accepted call, and only for the member who made it: not if the sign-in changed while the call was out.
      sync(options.token());
      if (before !== undefined && owner === before) asked.withdraw(entry.mediaType, entry.tmdbId);
    },
    setHidden: async (mediaType, tmdbId, value, signal) => {
      const before = options.token();
      const response = await call(`/hidden/${mediaType}/${tmdbId}`, value ? { body: {}, hiding: true } : { method: 'DELETE' }, signal);
      await response.body?.cancel().catch(() => undefined);
      // Only an accepted call, and only for the member who made it: not if the sign-in changed while the call was out.
      sync(options.token());
      if (before !== undefined && owner === before) hidden.set(mediaType, tmdbId, value);
    },
    hiddenList: (page, signal) => get<HiddenList>(`/hidden${page > 1 ? `?page=${page}` : ''}`, signal),
    requestTitle: async (mediaType, tmdbId, signal) => {
      sync(options.token());
      // A kept title is used as it is: its state is not handed to the overlay again.
      const kept = titles.get(mediaType, tmdbId);
      if (kept) return kept;
      const epoch = titlesEpoch;
      const found = mediaType === 'tv' ? await tv(tmdbId, signal) : await movie(tmdbId, signal);
      const details: TitleDetails = { title: found.title, year: found.year, mediaType, posterUrl: found.posterUrl };
      // Kept only for the sign-in that read it: not if it changed (or was forgotten) while the call was out.
      sync(options.token());
      if (epoch === titlesEpoch) titles.set({ ...details, tmdbId });
      return details;
    },
    forgetAsked: () => forget(),
  };
}

/** The only sign-in failures the app tells apart, each with a fixed message (see render.ts); upstream text is never shown. */
export type SignInErrorKind = 'invalid' | 'rate_limited' | 'unavailable' | 'offline' | 'storage';

export class SignInError extends Error {
  public constructor(public readonly kind: SignInErrorKind) {
    super(kind);
  }
}

/** A household member the gateway lists on this host, as Jellyfin's own profile picker would. */
export interface Profile {
  id: string;
  name: string;
  /** False for a member marked passwordless: one tap signs in, as in Jellyfin web. */
  hasPassword: boolean;
}

export interface SignInResult {
  token: string;
  userId: string;
  serverId: string;
}

export interface SignInApiOptions {
  fetch: typeof fetch;
  deviceId: () => string;
  /** A short device name for Jellyfin's device list (letters and digits only). */
  deviceName: string;
}

export interface SignInApi {
  profiles(signal?: AbortSignal): Promise<Profile[]>;
  signIn(username: string, password: string, signal?: AbortSignal): Promise<SignInResult>;
  /** Revokes `token` at Jellyfin, as Jellyfin web's own sign-out does. Best effort: never throws. */
  signOut(token: string): Promise<void>;
}

/** The client name and version Jellyfin lists with the session; the version is this sign-in client's, not the release's. */
const CLIENT_NAME = 'JellyPass';
const CLIENT_VERSION = '1.0';
const SIGN_OUT_TIMEOUT_MS = 5000;
const MAX_PROFILES = 200;
const MAX_NAME_LENGTH = 256;

function signInKind(status: number): SignInErrorKind {
  if (status === 401 || status === 403) return 'invalid';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

/**
 * Sign-in through the household gateway on this origin, with the same calls Jellyfin web makes: GET /Users/Public and
 * POST /Users/AuthenticateByName. The gateway scopes the first to the household and rate-limits and scopes the second.
 */
export function createSignInApi(options: SignInApiOptions): SignInApi {
  const base = { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' } as const;

  async function call(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    try {
      return await options.fetch(path, { ...base, ...init, ...(signal ? { signal } : {}) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new SignInError('offline');
    }
  }

  return {
    async profiles(signal) {
      const response = await call('/Users/Public', { headers: { Accept: 'application/json' } }, signal);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SignInError(response.status === 429 ? 'rate_limited' : 'unavailable');
      }
      let list: unknown;
      try {
        list = await response.json();
      } catch {
        throw new SignInError('unavailable');
      }
      if (!Array.isArray(list)) throw new SignInError('unavailable');
      const profiles: Profile[] = [];
      for (const entry of list.slice(0, MAX_PROFILES)) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { Id: id, Name: name, HasPassword: hasPassword } = entry as Record<string, unknown>;
        if (typeof id !== 'string' || !id || typeof name !== 'string' || !name || name.length > MAX_NAME_LENGTH) continue;
        profiles.push({ id, name, hasPassword: hasPassword !== false });
      }
      return profiles;
    },

    async signIn(username, password, signal) {
      const header = [
        `Client="${CLIENT_NAME}"`,
        `Device="${options.deviceName}"`,
        `DeviceId="${options.deviceId()}"`,
        `Version="${CLIENT_VERSION}"`,
      ].join(', ');
      const response = await call('/Users/AuthenticateByName', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `MediaBrowser ${header}` },
        body: JSON.stringify({ Username: username, Pw: password }),
      }, signal);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SignInError(signInKind(response.status));
      }
      let answer: unknown;
      try {
        answer = await response.json();
      } catch {
        throw new SignInError('unavailable');
      }
      const record = (typeof answer === 'object' && answer !== null ? answer : {}) as Record<string, unknown>;
      const user = (typeof record['User'] === 'object' && record['User'] !== null ? record['User'] : {}) as Record<string, unknown>;
      const token = record['AccessToken'];
      const userId = user['Id'];
      const serverId = record['ServerId'];
      if (typeof token !== 'string' || !token || typeof userId !== 'string' || !userId || typeof serverId !== 'string' || !serverId) {
        throw new SignInError('unavailable');
      }
      return { token, userId, serverId };
    },

    async signOut(token) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), SIGN_OUT_TIMEOUT_MS);
      try {
        const response = await options.fetch('/Sessions/Logout', {
          ...base,
          method: 'POST',
          headers: { Authorization: `MediaBrowser Token="${encodeURIComponent(token).replace(/"/g, '%22')}"` },
          signal: abort.signal,
        });
        await response.body?.cancel().catch(() => undefined);
      } catch {
        // Offline or Jellyfin down: the sign-in is still removed from this browser.
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
