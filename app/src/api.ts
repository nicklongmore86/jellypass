import { createAsked, type Asked } from './asked.js';
import type { DiscoverList, MediaType, Me, Movie, Page, RequestList, Season, Series, SourceKind, Sources } from './types.js';

export const API_PREFIX = '/jellypass/app/v1';

/** The only failures the app tells apart, each with a fixed message (see render.ts); upstream text is never shown. */
export type ApiErrorKind = 'unauthorized' | 'rate_limited' | 'not_found' | 'unavailable' | 'offline';

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
  /** Forgets what this member just asked for (sign-out). */
  forgetAsked(): void;
}

function kindOf(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  return 'unavailable';
}

export function createApi(options: ApiOptions): Api {
  const asked = options.asked ?? createAsked();
  // The overlay belongs to whoever holds this token and this /me identity: any other (or none) starts it empty.
  let owner: string | undefined;
  let identity: string | undefined;
  function sync(token: string | undefined): void {
    if (token === owner) return;
    asked.forget();
    owner = token;
    identity = undefined;
  }
  /** Applies the overlay to an answer, first making sure it still belongs to the member who is signed in now. */
  const seen = <T>(apply: (value: T) => T) => (value: T): T => {
    sync(options.token());
    return apply(value);
  };
  async function call(path: string, init: { body?: unknown }, signal?: AbortSignal): Promise<Response> {
    const token = options.token();
    sync(token);
    if (!token) throw new ApiError('unauthorized');
    let response: Response;
    try {
      response = await options.fetch(`${API_PREFIX}${path}`, {
        method: init.body === undefined ? 'GET' : 'POST',
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
        asked.forget();
        identity = undefined;
      }
      throw new ApiError(kindOf(response.status));
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

  return {
    me: async (signal) => {
      const me = await get<Me>('/me', signal);
      sync(options.token());
      // Another member (or household) never sees this one's overlay; /me names the member and the household.
      const now = `${me.household}\n${me.name}`;
      if (identity !== undefined && identity !== now) asked.forget();
      identity = now;
      return me;
    },
    search: (query, page, signal) => get<Page>(`/search?q=${encodeURIComponent(query)}&page=${page}`, signal).then(seen(asked.page)),
    discover: (list, signal) => get<Page>(`/discover/${list}`, signal).then(seen(asked.page)),
    sources: (signal) => get<Sources>('/discover/sources', signal),
    source: (kind, id, page, signal, list) =>
      get<Page>(`/discover/${kind}/${id}${list ? `/${list}` : ''}${page > 1 ? `?page=${page}` : ''}`, signal).then(seen(asked.page)),
    movie: (tmdbId, signal) => get<Movie>(`/movie/${tmdbId}`, signal).then(seen(asked.movie)),
    tv: (tmdbId, signal) => get<Series>(`/tv/${tmdbId}`, signal).then(seen(asked.series)),
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
    forgetAsked: () => asked.forget(),
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
